import { describe, expect, it } from "vitest";
import type { SiteRow } from "@beacon/db";
import type { SiteState } from "@beacon/core";
import type { NormalizedProduct } from "@beacon/shared";
import { countAllProducts, countLiveProducts, loadReveriesStock, type SiteCard } from "./stock";

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function product(overrides: Partial<NormalizedProduct> & { handle: string }): NormalizedProduct {
  return {
    title: overrides.handle,
    url: `https://sharedpour.com/products/${overrides.handle}`,
    vendor: null,
    tags: [],
    minPrice: 79.99,
    available: true,
    ...overrides,
  };
}

function site(
  id: string,
  opts: { enabled?: boolean; lastChecked?: string | null; products?: NormalizedProduct[] } = {},
): SiteCard {
  const row = { id, name: id, enabled: opts.enabled ?? true, sourceKind: "shopify_rest" } as SiteRow;
  const products = Object.fromEntries((opts.products ?? []).map((p) => [p.handle, p]));
  const state = { lastChecked: opts.lastChecked ?? iso(0), products } as SiteState;
  return { row, state };
}

describe("loadReveriesStock", () => {
  it("reproduces the 2026-08-31 bug fix: a disabled site's frozen bottle is never in-stock", () => {
    // "Average Joe's Ten Years Gone" — Beacon itself recorded this sold_out on
    // Aug 11, but the disabled browser-twin checker still had available: true.
    const cards = [
      site("sharedpour_browser", {
        enabled: false,
        lastChecked: iso(12 * 86_400_000),
        products: [product({ handle: "average-joes", title: "The Reveries Average Joe's", available: true })],
      }),
    ];
    const stock = loadReveriesStock(cards);
    expect(stock).toHaveLength(1);
    expect(stock[0].available).toBe(false);
    expect(stock[0].stale).toBe(true);
  });

  it("dedupes the same bottle seen by multiple checkers on one store, preferring the live one", () => {
    // Four checkers watched sharedpour.com with overlapping rosters pre-
    // consolidation — the same bottle must render once, not once per checker.
    const cards = [
      site("sharedpour_reveries", {
        enabled: false,
        lastChecked: iso(5 * 86_400_000),
        products: [product({ handle: "cask-in-point", title: "THE REVERIES Cask In Point", available: true })],
      }),
      site("sharedpour_t8ke_all", {
        enabled: true,
        lastChecked: iso(0),
        products: [product({ handle: "cask-in-point", title: "THE REVERIES Cask In Point", available: true })],
      }),
    ];
    const stock = loadReveriesStock(cards);
    expect(stock).toHaveLength(1);
    expect(stock[0].site).toBe("sharedpour_t8ke_all");
    expect(stock[0].available).toBe(true);
    expect(stock[0].stale).toBe(false);
  });

  it("keeps a stale bottle visible (as stale) when no live checker covers it", () => {
    const cards = [
      site("sharedpour_reveries", {
        enabled: false,
        lastChecked: iso(5 * 86_400_000),
        products: [product({ handle: "solo-handle", available: true })],
      }),
    ];
    const stock = loadReveriesStock(cards);
    expect(stock).toHaveLength(1);
    expect(stock[0].stale).toBe(true);
    expect(stock[0].available).toBe(false);
  });

  it("ignores non-Reveries products and non-Reveries sites", () => {
    const cards = [
      site("wild_turkey_limited", { products: [product({ handle: "wt-101", title: "Wild Turkey 101" })] }),
    ];
    expect(loadReveriesStock(cards)).toHaveLength(0);
  });

  it("matches by title on a non-Reveries-site listing (e.g. a third-party retailer)", () => {
    const cards = [
      site("sharedpour_t8ke_all", {
        products: [product({ handle: "x", title: "THE REVERIES: 8 Year Single Barrel" })],
      }),
    ];
    expect(loadReveriesStock(cards)).toHaveLength(1);
  });

  it("sorts in-stock first, then stale-last among the rest", () => {
    const cards = [
      site("reveries_official", {
        products: [
          product({ handle: "b-sold-out", title: "B sold out", available: false }),
          product({ handle: "a-in-stock", title: "A in stock", available: true }),
        ],
      }),
      site("sharedpour_reveries", {
        enabled: false,
        lastChecked: iso(5 * 86_400_000),
        products: [product({ handle: "c-stale", title: "C stale", available: true })],
      }),
    ];
    const stock = loadReveriesStock(cards);
    expect(stock.map((p) => p.handle)).toEqual(["a-in-stock", "b-sold-out", "c-stale"]);
  });
});

describe("countLiveProducts / countAllProducts", () => {
  it("excludes disabled/stale rosters from the live count but not the all count", () => {
    const cards = [
      site("a", { enabled: true, lastChecked: iso(0), products: [product({ handle: "1" }), product({ handle: "2" })] }),
      site("b", { enabled: false, lastChecked: iso(0), products: [product({ handle: "3" })] }),
    ];
    expect(countLiveProducts(cards)).toBe(2);
    expect(countAllProducts(cards)).toBe(3);
  });

  it("frozen count (all - live) is zero when every roster is live", () => {
    const cards = [site("a", { products: [product({ handle: "1" })] })];
    expect(countAllProducts(cards) - countLiveProducts(cards)).toBe(0);
  });
});
