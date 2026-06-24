import { describe, it, expect } from "vitest";
import { buildAdapterDeps, siteDefinitionSchema, type FetchResult, type SiteDefinition, type SiteState, type SourceAdapter } from "@beacon/core";
import { HttpError } from "@beacon/fetch";
import type { NormalizedProduct } from "@beacon/shared";
import { processSite } from "./process-site.js";

function site(over: Record<string, unknown> = {}): SiteDefinition {
  return siteDefinitionSchema.parse({
    id: "t",
    name: "Test Site",
    source: { kind: "shopify_rest", baseUrl: "https://x.com" },
    alerts: { onNew: true, onRestock: true, onSoldOut: true, onSiteReset: true },
    ...over,
  });
}

function prod(handle: string, available: boolean): NormalizedProduct {
  return { handle, title: handle, url: `https://x.com/products/${handle}`, tags: [], available, minPrice: 10 };
}

function ok(products: NormalizedProduct[]): SourceAdapter {
  const result: FetchResult = { kind: "products", products, pageCount: 1 };
  return { kind: "shopify_rest", fetch: async () => result };
}
function fails(err: unknown): SourceAdapter {
  return { kind: "shopify_rest", fetch: async () => { throw err; } };
}

const deps = buildAdapterDeps();
const noneIgnored = new Set<string>();

describe("processSite", () => {
  it("emits new_product + restock against an existing baseline", async () => {
    const prev: SiteState = { lastChecked: "t", products: { a: prod("a", true), c: prod("c", false) } };
    const out = await processSite({ site: site(), prevState: prev, adapter: ok([prod("a", true), prod("b", true), prod("c", true)]), deps, ignored: noneIgnored });
    const types = out.events.map((e) => e.type).sort();
    expect(types).toEqual(["new_product", "restock"]);
    expect(out.ok).toBe(true);
    expect(out.newState.consecutiveErrors).toBe(0);
  });

  it("startup quiet mode: no prev state -> baseline event, no new_product alerts", async () => {
    const out = await processSite({ site: site(), prevState: undefined, adapter: ok([prod("a", true), prod("b", true)]), deps, ignored: noneIgnored });
    expect(out.events.map((e) => e.type)).toEqual(["baseline"]);
  });

  it("filters ignored handles out of alerts", async () => {
    const prev: SiteState = { lastChecked: "t", products: {} };
    const out = await processSite({ site: site(), prevState: prev, adapter: ok([prod("keep", true), prod("muted", true)]), deps, ignored: new Set(["muted"]) });
    expect(out.events.map((e) => e.product.handle)).toEqual(["keep"]);
  });

  it("emits site_recovered when a previously-erroring site succeeds", async () => {
    const prev: SiteState = { lastChecked: "t", products: { a: prod("a", true) }, errorAlertSent: true };
    const out = await processSite({ site: site(), prevState: prev, adapter: ok([prod("a", true)]), deps, ignored: noneIgnored });
    expect(out.events.map((e) => e.type)).toContain("site_recovered");
    expect(out.newState.errorAlertSent).toBe(false);
  });

  it("error path: increments consecutiveErrors and stays silent below threshold", async () => {
    const prev: SiteState = { lastChecked: "t", products: { a: prod("a", true) }, consecutiveErrors: 1 };
    const out = await processSite({ site: site(), prevState: prev, adapter: fails(new Error("network")), deps, ignored: noneIgnored });
    expect(out.ok).toBe(false);
    expect(out.newState.consecutiveErrors).toBe(2);
    expect(out.events).toEqual([]);
    expect(out.newState.products).toEqual(prev.products); // preserved
  });

  it("error path: fires site_error once the streak reaches the threshold", async () => {
    const prev: SiteState = { lastChecked: "t", consecutiveErrors: 4 };
    const out = await processSite({ site: site(), prevState: prev, adapter: fails(new Error("still down")), deps, ignored: noneIgnored });
    expect(out.newState.consecutiveErrors).toBe(5);
    expect(out.events.map((e) => e.type)).toEqual(["site_error"]);
    expect(out.newState.errorAlertSent).toBe(true);
  });

  it("imminent: fires site_error after just 2 failures and flags a block", async () => {
    const prev: SiteState = { lastChecked: "t", consecutiveErrors: 1 };
    const out = await processSite({
      site: site({ imminent: true }),
      prevState: prev,
      adapter: fails(new HttpError(403, "https://x.com")),
      deps,
      ignored: noneIgnored,
    });
    expect(out.newState.consecutiveErrors).toBe(2);
    expect(out.events.map((e) => e.type)).toEqual(["site_error"]);
    expect(out.events[0]!.product.note).toContain("blocked");
  });

  it("non-imminent: 2 failures stays silent (full threshold)", async () => {
    const prev: SiteState = { lastChecked: "t", consecutiveErrors: 1 };
    const out = await processSite({
      site: site(),
      prevState: prev,
      adapter: fails(new HttpError(403, "https://x.com")),
      deps,
      ignored: noneIgnored,
    });
    expect(out.newState.consecutiveErrors).toBe(2);
    expect(out.events).toEqual([]);
  });

  it("error path: a 403 sets an escalating cooldown", async () => {
    const prev: SiteState = { lastChecked: "t", cooldownLevel: 0 };
    const out = await processSite({ site: site(), prevState: prev, adapter: fails(new HttpError(403, "https://x.com")), deps, ignored: noneIgnored });
    expect(out.newState.cooldownLevel).toBe(1);
    expect(typeof out.newState.cooldownUntil).toBe("string");
  });
});
