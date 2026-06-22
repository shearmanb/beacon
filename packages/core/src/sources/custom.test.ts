import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { customAdapter } from "./custom.js";
import { getAdapter } from "./registry.js";
import { buildAdapterDeps } from "../deps.js";
import { runSiteCheck } from "../pipeline.js";
import { siteDefinitionSchema, type SiteDefinition } from "../schema.js";
import type { PrevState } from "./types.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler;
let server: Server;
let base: string;

const CAMPARI_HTML = `
  <div><h3>Wild Turkey Generations</h3>
  <a class="sn_btn" href="/products/wt-generations/">Add to cart</a></div>
  <div><h3>Master's Keep</h3>
  <a class="sn_btn" href="/products/masters-keep/">See details</a></div>
`;

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeSite(): SiteDefinition {
  return siteDefinitionSchema.parse({
    id: "wild_turkey_limited",
    name: "Wild Turkey Limited",
    alerts: { onNew: true, onRestock: true, onSoldOut: false },
    source: { kind: "custom", extractorId: "campari_v1", url: `${base}/products/` },
  });
}

describe("customAdapter + campari_v1 (end to end)", () => {
  it("runs the registered extractor and returns normalized products", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(CAMPARI_HTML);
    };
    const result = await customAdapter.fetch(makeSite(), {}, buildAdapterDeps());
    if (result.kind !== "products") throw new Error("expected products");
    const byHandle = Object.fromEntries(result.products.map((p) => [p.handle, p]));
    expect(byHandle["wt-generations"]!.available).toBe(true);
    expect(byHandle["masters-keep"]!.available).toBe(false);
    expect(result.emptyGuardThreshold).toBe(3);
  });

  it("flows through getAdapter + runSiteCheck, diffing against previous state", async () => {
    handler = (_req, res) => {
      res.writeHead(200);
      res.end(CAMPARI_HTML);
    };
    const site = makeSite();
    const adapter = getAdapter(site.source.kind);
    // Previously, generations was info-only (sold out); now it's buyable -> restock.
    const prev = {
      lastChecked: "2026-06-22T00:00:00Z",
      products: {
        "wt-generations": {
          handle: "wt-generations",
          title: "Wild Turkey Generations",
          url: `${base}/products/wt-generations/`,
          tags: [],
          available: false,
        },
      },
    };
    const result = await runSiteCheck(site, prev, adapter, buildAdapterDeps());
    const types = result.alerts.map((a) => a.type).sort();
    expect(types).toEqual(["new_product", "restock"]); // masters-keep new (info), generations restock
  });

  it("short-circuits on 304", async () => {
    handler = (req, res) => {
      if (req.headers["if-none-match"] === '"v1"') {
        res.writeHead(304);
        res.end();
      } else {
        res.writeHead(200, { ETag: '"v1"' });
        res.end(CAMPARI_HTML);
      }
    };
    const prev: PrevState = { httpValidators: { etag: '"v1"', lastModified: null } };
    const result = await customAdapter.fetch(makeSite(), prev, buildAdapterDeps());
    expect(result.kind).toBe("not_modified");
  });

  it("throws for an unregistered extractorId", async () => {
    const site = siteDefinitionSchema.parse({
      id: "x",
      name: "X",
      source: { kind: "custom", extractorId: "does_not_exist", url: `${base}/` },
    });
    await expect(customAdapter.fetch(site, {}, buildAdapterDeps())).rejects.toThrow(/No custom extractor/);
  });
});
