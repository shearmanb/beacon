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
function okVia(products: NormalizedProduct[], via: string, viaReason: string): SourceAdapter {
  const result: FetchResult = { kind: "products", products, via, viaReason };
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

  it("error path: Shopify's 430 bot-block status also trips the cooldown", async () => {
    const prev: SiteState = { lastChecked: "t", cooldownLevel: 0 };
    const out = await processSite({ site: site(), prevState: prev, adapter: fails(new HttpError(430, "https://x.com")), deps, ignored: noneIgnored });
    expect(out.newState.cooldownLevel).toBe(1);
    expect(typeof out.newState.cooldownUntil).toBe("string");
  });

  it("error path: a status-less stall (tar-pit) trips the cooldown and reads as a block", async () => {
    const prev: SiteState = { lastChecked: "t", consecutiveErrors: 4, cooldownLevel: 0 };
    const out = await processSite({
      site: site(),
      prevState: prev,
      adapter: fails(new Error("Aborted fetching https://x.com/products.json?limit=250&page=1")),
      deps,
      ignored: noneIgnored,
    });
    expect(out.newState.cooldownLevel).toBe(1);
    expect(out.events.map((e) => e.type)).toEqual(["site_error"]);
    expect(out.events[0]!.product.note).toContain("tar-pit");
  });

  it("self_healed: fires ONCE with the why when a fallback channel engages", async () => {
    const prev: SiteState = { lastChecked: "t", products: { a: prod("a", true) } };
    const out = await processSite({
      site: site(),
      prevState: prev,
      adapter: okVia([prod("a", true)], "storefront_fallback", "products.json blocked with HTTP 403"),
      deps,
      ignored: noneIgnored,
    });
    const healed = out.events.filter((e) => e.type === "self_healed");
    expect(healed).toHaveLength(1);
    expect(healed[0]!.product.note).toContain("HTTP 403");
    expect(out.newState.fetchVia).toBe("storefront_fallback");
  });

  it("self_healed: silent while the fallback stays engaged (no re-ping per check)", async () => {
    const prev: SiteState = { lastChecked: "t", products: { a: prod("a", true) }, fetchVia: "storefront_fallback" };
    const out = await processSite({
      site: site(),
      prevState: prev,
      adapter: okVia([prod("a", true)], "storefront_fallback", "products.json blocked with HTTP 403"),
      deps,
      ignored: noneIgnored,
    });
    expect(out.events.filter((e) => e.type === "self_healed")).toHaveLength(0);
  });

  it("self_healed: fires a recovery note when the primary channel comes back", async () => {
    const prev: SiteState = { lastChecked: "t", products: { a: prod("a", true) }, fetchVia: "storefront_fallback" };
    const out = await processSite({ site: site(), prevState: prev, adapter: ok([prod("a", true)]), deps, ignored: noneIgnored });
    const healed = out.events.filter((e) => e.type === "self_healed");
    expect(healed).toHaveLength(1);
    expect(healed[0]!.product.note).toContain("Primary endpoint is reachable again");
    expect(out.newState.fetchVia).toBeNull();
  });
});

// A host that rate-limits intermittently makes the channel ping-pong REST <->
// fallback. These guards keep that from paging on every flip and from
// re-alerting reappearing products as "new" (the overnight spam bug).
describe("channel-flap damping + reappearance guard", () => {
  const fallback = (products: NormalizedProduct[]) =>
    okVia(products, "storefront_fallback", "products.json blocked with HTTP 429");

  it("damps a repeat self_healed ping inside the 90-min gap (history-only)", async () => {
    const prev: SiteState = {
      lastChecked: "t",
      products: { a: prod("a", true) },
      lastSelfHealedPingAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    };
    const out = await processSite({ site: site(), prevState: prev, adapter: fallback([prod("a", true)]), deps, ignored: noneIgnored });
    const healed = out.events.filter((e) => e.type === "self_healed");
    expect(healed).toHaveLength(1);
    expect(healed[0]!.quiet).toBe(true);
    // A damped ping must NOT refresh the stamp — the gap is "at most one page
    // per 90 min", not a debounce that continuous flapping extends forever.
    expect(out.newState.lastSelfHealedPingAt).toBe(prev.lastSelfHealedPingAt);
  });

  it("sends (and stamps) a self_healed ping when the last one is outside the gap", async () => {
    const prev: SiteState = {
      lastChecked: "t",
      products: { a: prod("a", true) },
      lastSelfHealedPingAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    };
    const out = await processSite({ site: site(), prevState: prev, adapter: fallback([prod("a", true)]), deps, ignored: noneIgnored });
    const healed = out.events.filter((e) => e.type === "self_healed");
    expect(healed).toHaveLength(1);
    expect(healed[0]!.quiet).toBeFalsy();
    expect(out.newState.lastSelfHealedPingAt).not.toBe(prev.lastSelfHealedPingAt);
  });

  it("pins to the fallback after 3 via-flips in 6 h, with ONE explanatory ping", async () => {
    const now = Date.now();
    const prev: SiteState = {
      lastChecked: "t",
      products: { a: prod("a", true) },
      viaFlips: [new Date(now - 2 * 3_600_000).toISOString(), new Date(now - 1 * 3_600_000).toISOString()],
    };
    const out = await processSite({ site: site(), prevState: prev, adapter: fallback([prod("a", true)]), deps, ignored: noneIgnored });
    const healed = out.events.filter((e) => e.type === "self_healed");
    expect(healed).toHaveLength(1);
    expect(healed[0]!.product.note).toContain("flapping");
    expect(healed[0]!.quiet).toBeFalsy(); // the pin notice always pages
    expect(out.newState.preferFallback).toBe(true); // adapter now leads with the Storefront API
    expect(typeof out.newState.lastRestProbeAt).toBe("string"); // ~12 h until the REST re-probe
    expect((out.newState.viaFlips as string[]).length).toBe(3);
  });

  it("ignores flips older than the 6-h window (no premature pin)", async () => {
    const now = Date.now();
    const prev: SiteState = {
      lastChecked: "t",
      products: { a: prod("a", true) },
      viaFlips: [new Date(now - 8 * 3_600_000).toISOString(), new Date(now - 7 * 3_600_000).toISOString()],
    };
    const out = await processSite({ site: site(), prevState: prev, adapter: fallback([prod("a", true)]), deps, ignored: noneIgnored });
    expect(out.newState.preferFallback).toBeFalsy();
    expect((out.newState.viaFlips as string[]).length).toBe(1); // stale entries pruned
  });

  it("does not re-announce the pin when already pinned — a re-probe recovery pings normally", async () => {
    const now = Date.now();
    const prev: SiteState = {
      lastChecked: "t",
      products: { a: prod("a", true) },
      fetchVia: "storefront_fallback",
      preferFallback: true,
      viaFlips: [1, 2, 3].map((h) => new Date(now - h * 3_600_000).toISOString()),
      lastSelfHealedPingAt: new Date(now - 12 * 3_600_000).toISOString(),
    };
    const out = await processSite({ site: site(), prevState: prev, adapter: ok([prod("a", true)]), deps, ignored: noneIgnored });
    const healed = out.events.filter((e) => e.type === "self_healed");
    expect(healed).toHaveLength(1);
    expect(healed[0]!.product.note).toContain("Primary endpoint is reachable again");
    expect(healed[0]!.product.note).not.toContain("flapping");
  });

  it("suppresses new_product for a handle seen within 24 h — reappearance, not a launch", async () => {
    const prev: SiteState = {
      lastChecked: "t",
      products: { a: prod("a", true) }, // "x" was dropped by a partial fallback roster
      recentlySeen: { a: new Date().toISOString(), x: new Date(Date.now() - 45 * 60_000).toISOString() },
    };
    const out = await processSite({ site: site(), prevState: prev, adapter: ok([prod("a", true), prod("x", true)]), deps, ignored: noneIgnored });
    expect(out.events.filter((e) => e.type === "new_product")).toHaveLength(0);
    const note = out.events.find((e) => e.type === "baseline");
    expect(note?.product.note).toContain("reappeared");
    // The product itself is back in state, and the roster is re-stamped.
    expect(Object.keys(out.newState.products ?? {})).toContain("x");
    expect(Object.keys(out.newState.recentlySeen as Record<string, string>)).toEqual(
      expect.arrayContaining(["a", "x"]),
    );
  });

  it("still alerts new_product when the handle was last seen over 24 h ago (a real relist)", async () => {
    const prev: SiteState = {
      lastChecked: "t",
      products: { a: prod("a", true) },
      recentlySeen: { x: new Date(Date.now() - 25 * 3_600_000).toISOString() },
    };
    const out = await processSite({ site: site(), prevState: prev, adapter: ok([prod("a", true), prod("x", true)]), deps, ignored: noneIgnored });
    expect(out.events.map((e) => e.type)).toContain("new_product");
  });

  it("stamps the current roster into recentlySeen on every products check", async () => {
    const prev: SiteState = { lastChecked: "t", products: {} };
    const out = await processSite({ site: site(), prevState: prev, adapter: ok([prod("a", true)]), deps, ignored: noneIgnored });
    const seen = out.newState.recentlySeen as Record<string, string>;
    expect(Object.keys(seen)).toEqual(["a"]);
    expect(Date.parse(seen["a"]!)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("FREEZES recentlySeen on fallback checks — a long pinned period must not expire REST-only products", async () => {
    // "x" is invisible on the Storefront channel and its stamp is near expiry.
    // A fallback check must re-stamp it (absence there proves nothing), so a
    // REST recovery days later still counts as a reappearance, not a launch.
    const nearExpiry = new Date(Date.now() - 23 * 3_600_000).toISOString();
    const prev: SiteState = {
      lastChecked: "t",
      products: { a: prod("a", true) },
      fetchVia: "storefront_fallback", // steady on the fallback (no transition ping)
      recentlySeen: { a: new Date().toISOString(), x: nearExpiry },
    };
    const out = await processSite({ site: site(), prevState: prev, adapter: fallback([prod("a", true)]), deps, ignored: noneIgnored });
    const seen = out.newState.recentlySeen as Record<string, string>;
    expect(Object.keys(seen).sort()).toEqual(["a", "x"]);
    expect(Date.parse(seen["x"]!)).toBeGreaterThan(Date.parse(nearExpiry)); // refreshed, not decayed
  });

  it("still DECAYS recentlySeen under the authoritative REST channel", async () => {
    const stale = new Date(Date.now() - 25 * 3_600_000).toISOString();
    const prev: SiteState = {
      lastChecked: "t",
      products: { a: prod("a", true) },
      recentlySeen: { a: new Date().toISOString(), gone: stale },
    };
    const out = await processSite({ site: site(), prevState: prev, adapter: ok([prod("a", true)]), deps, ignored: noneIgnored });
    const seen = out.newState.recentlySeen as Record<string, string>;
    expect(Object.keys(seen)).toEqual(["a"]); // the stale entry is pruned
  });
});
