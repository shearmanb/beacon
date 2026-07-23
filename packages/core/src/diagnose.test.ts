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
        res.end(JSON.stringify({ data: { products: { nodes: [{ handle: "newest-pick" }] } } }));
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

  it("diagnoses a tar-pit (host hangs, no status) with per-step timeouts", async () => {
    handler = (req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/api/graphql")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { products: { nodes: [{ handle: "newest-pick" }] } } }));
        return;
      }
      // REST: hang forever — the step timeout must end it, not the whole budget.
    };
    const report = await diagnoseSite(restSite(true), deps, { stepTimeoutMs: 300 });
    expect(report.blocked).toBe(true);
    expect(report.steps.map((s) => s.ok)).toEqual([false, false, true]);
    expect(report.steps[0]!.detail).toContain("left hanging");
    expect(report.verdict).toContain("tar-pit");
    expect(report.verdict).toContain("self-heals");
  });

  it("reports the fallback 'not tested' (never 'failed') when the overall budget expires first", async () => {
    // Regression guard for the false verdict: REST is blocked (403 twice), then
    // the overall diagnosis budget dies while the Storefront fallback is still in
    // flight. The fallback was never exercised, so it must read as "not tested" —
    // NOT as "the fallback failed / fully blocked".
    handler = (req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/api/graphql")) {
        return; // fallback hangs — the budget will abort it mid-flight
      }
      res.writeHead(403); // REST blocked for old AND fresh identity (both fast)
      res.end("blocked");
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500); // overall budget, dies during the POST
    const report = await diagnoseSite(restSite(true), { ...deps, signal: controller.signal }, { stepTimeoutMs: 3000 });
    expect(report.steps.map((s) => s.ok)).toEqual([false, false, false]);
    expect(report.steps[2]!.detail).toContain("not tested");
    expect(report.blocked).toBe(true);
    expect(report.verdict).toContain("could NOT be tested");
    expect(report.verdict).not.toContain("fully blocked");
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

  // Blind-spot guard: a green page-1 probe must not end the diagnosis when the
  // checker's stored lastError names a deeper request (e.g. page 8 of a
  // full-catalog scan) — that exact URL is retested.
  it("retests the exact lastError URL and flags a deep-pagination block", async () => {
    handler = (req, res) => {
      const page = new URL(req.url ?? "/", base).searchParams.get("page");
      if (page === "8") {
        res.writeHead(430);
        res.end("blocked");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ products: [{ handle: "a" }] }));
    };
    const report = await diagnoseSite(restSite(false), deps, {
      lastError: `HTTP 430 for ${base}/products.json?limit=250&page=8`,
    });
    expect(report.blocked).toBe(true);
    expect(report.steps.map((s) => s.ok)).toEqual([true, false]);
    expect(report.verdict).toContain("page 8");
    expect(report.verdict).toContain("collectionPath");
  });

  it("reports full health when the previously-failing URL answers again", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ products: [{ handle: "a" }] }));
    };
    const report = await diagnoseSite(restSite(false), deps, {
      lastError: `HTTP 430 for ${base}/products.json?limit=250&page=8`,
    });
    expect(report.blocked).toBe(false);
    expect(report.steps.map((s) => s.ok)).toEqual([true, true]);
    expect(report.verdict).toContain("including the exact request that previously failed");
  });

  it("never retests a lastError URL pointing at a different host", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ products: [{ handle: "a" }] }));
    };
    const report = await diagnoseSite(restSite(false), deps, {
      lastError: "HTTP 430 for https://evil.example.com/products.json?limit=250&page=8",
    });
    expect(report.steps).toHaveLength(1);
    expect(report.blocked).toBe(false);
  });
});
