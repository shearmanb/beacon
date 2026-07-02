import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { diagnoseSite } from "./diagnose.js";
import { siteDefinitionSchema, type SiteDefinition } from "./schema.js";
import type { AdapterDeps } from "./sources/types.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler;
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function restSite(withFallback: boolean): SiteDefinition {
  return siteDefinitionSchema.parse({
    id: "t",
    name: "T",
    source: {
      kind: "shopify_rest",
      baseUrl: base,
      ...(withFallback
        ? { storefrontFallback: { domain: "x.myshopify.com", accessTokenRef: "sp_token", endpoint: `${base}/api/graphql` } }
        : {}),
    },
  });
}

const deps: AdapterDeps = { resolveSecret: (ref) => (ref === "sp_token" ? "tok-abc" : undefined) };

describe("diagnoseSite", () => {
  it("reports a healthy primary channel as not blocked", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ products: [{ handle: "a" }] }));
    };
    const report = await diagnoseSite(restSite(false), deps);
    expect(report.blocked).toBe(false);
    expect(report.steps).toHaveLength(1);
    expect(report.steps[0]!.ok).toBe(true);
    expect(report.steps[0]!.detail).toContain("1 product(s)");
  });

  it("diagnoses an IP-level block with a working Storefront fallback", async () => {
    handler = (req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/api/graphql")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { shop: { name: "Shared Pour" } } }));
        return;
      }
      res.writeHead(403); // REST blocked for old AND fresh identity
      res.end("blocked");
    };
    const report = await diagnoseSite(restSite(true), deps);
    expect(report.blocked).toBe(true);
    // REST → fresh-identity retry → Storefront fallback = 3 steps.
    expect(report.steps.map((s) => s.ok)).toEqual([false, false, true]);
    expect(report.verdict).toContain("blocked at REST");
    expect(report.verdict).toContain("self-heals");
  });

  it("says so plainly when fully blocked and no fallback is configured", async () => {
    handler = (_req, res) => {
      res.writeHead(403);
      res.end("blocked");
    };
    const report = await diagnoseSite(restSite(false), deps);
    expect(report.blocked).toBe(true);
    expect(report.steps).toHaveLength(2);
    expect(report.verdict).toContain("no Storefront fallback");
  });

  it("classifies a non-block failure (500) as an outage, not a block", async () => {
    handler = (_req, res) => {
      res.writeHead(500);
      res.end("boom");
    };
    const report = await diagnoseSite(restSite(true), deps);
    expect(report.blocked).toBe(false);
    expect(report.verdict).toContain("not bot protection");
  });
});
