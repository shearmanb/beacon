import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { openStore, type BeaconStore } from "@beacon/db";
import { extractStorefrontCreds, maybeHarvestFallbacks } from "./harvest.js";
import type { RunContext } from "./run.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler;
let server: Server;
let base: string;
let store: BeaconStore;

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(async () => {
  store = await openStore({ url: ":memory:" });
});
afterEach(() => {
  store.close();
});

const TOKEN = "0123456789abcdef0123456789abcdef";

describe("extractStorefrontCreds", () => {
  it("finds token + myshopify domain in theme JS", () => {
    const html = `<script>var c = { storefrontAccessToken: "${TOKEN}", shop: "some-shop.myshopify.com" };</script>`;
    expect(extractStorefrontCreds(html)).toEqual({ token: TOKEN, domain: "some-shop.myshopify.com" });
  });

  it("finds the accessToken JSON shape too, and returns null when incomplete", () => {
    const html = `{"accessToken":"${TOKEN}"} window.Shopify = { shop: "x-y.myshopify.com" }`;
    expect(extractStorefrontCreds(html)).toEqual({ token: TOKEN, domain: "x-y.myshopify.com" });
    expect(extractStorefrontCreds("<html>no creds here</html>")).toBeNull();
  });
});

describe("maybeHarvestFallbacks", () => {
  function ctx(): RunContext {
    return { store, dryRun: false, log: () => {} };
  }

  it("harvests, verifies, stores the secret, and arms the fallback", async () => {
    handler = (req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/api/graphql")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { shop: { name: "Fountain Inn" } } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<script>storefrontAccessToken:"${TOKEN}"; shop:"fountain.myshopify.com"</script>`);
    };
    await store.sites.upsert({ id: "fi", name: "Fountain Inn", source: { kind: "shopify_rest", baseUrl: base } });
    const rows = await store.sites.list();

    const out = await maybeHarvestFallbacks(ctx(), rows, { verifyEndpoint: `${base}/api/graphql` });
    expect(out).toHaveLength(1);
    expect(out[0]!.armed).toBe(true);

    const def = (await store.sites.get("fi"))!.definition;
    const src = def.source as { storefrontFallback?: { domain: string; accessTokenRef: string } };
    expect(src.storefrontFallback?.domain).toBe("fountain.myshopify.com");
    expect((await store.secrets.all())["fi_storefront_token"]).toBe(TOKEN);
    // Token never lands inside the definition itself.
    expect(JSON.stringify(def)).not.toContain(TOKEN);
  });

  it("throttles to one attempt per day and skips already-armed sites", async () => {
    let pageHits = 0;
    handler = (_req, res) => {
      pageHits += 1;
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>no creds</html>"); // harvest finds nothing
    };
    await store.sites.upsert({ id: "fi", name: "Fountain Inn", source: { kind: "shopify_rest", baseUrl: base } });
    await store.sites.upsert({
      id: "armed",
      name: "Already Armed",
      source: { kind: "shopify_rest", baseUrl: base, storefrontFallback: { domain: "a.myshopify.com", accessTokenRef: "r" } },
    });
    const rows = await store.sites.list();

    const first = await maybeHarvestFallbacks(ctx(), rows, {});
    expect(first).toHaveLength(1); // only the un-armed site was attempted
    expect(first[0]!.armed).toBe(false);
    const again = await maybeHarvestFallbacks(ctx(), rows, {});
    expect(again).toHaveLength(0); // throttled by the daily stamp
    expect(pageHits).toBe(1);
  });
});
