import { describe, it, expect } from "vitest";
import { applyFilters, toProductMap } from "./filter.js";
import { filtersSchema } from "./schema.js";
import type { NormalizedProduct } from "@beacon/shared";

function prod(over: Partial<NormalizedProduct> & { handle: string }): NormalizedProduct {
  return {
    title: over.handle,
    url: `https://x/${over.handle}`,
    vendor: null,
    productType: null,
    tags: [],
    minPrice: null,
    available: true,
    ...over,
  };
}

const f = (over: Record<string, unknown>) => filtersSchema.parse(over);

describe("applyFilters", () => {
  const products = [
    prod({ handle: "reveries-1", title: "The Reveries Batch 1", vendor: "The Reveries", productType: "Whiskey", tags: ["new"], minPrice: 120 }),
    prod({ handle: "t8ke-1", title: "T8KE Pick", vendor: "SharedPour", productType: "Bourbon", tags: ["pick"], minPrice: 60 }),
    prod({ handle: "sold", title: "Reveries Sold", available: false, minPrice: 999 }),
  ];

  it("titleContains keeps only matches (case-insensitive)", () => {
    const out = applyFilters(products, f({ titleContains: ["reveries"] }));
    expect(out.map((p) => p.handle)).toEqual(["reveries-1", "sold"]);
  });

  it("titleExcludes removes matches", () => {
    const out = applyFilters(products, f({ titleExcludes: ["sold"] }));
    expect(out.map((p) => p.handle)).toEqual(["reveries-1", "t8ke-1"]);
  });

  it("vendorIs / productType match exactly", () => {
    expect(applyFilters(products, f({ vendorIs: ["The Reveries"] })).map((p) => p.handle)).toEqual(["reveries-1"]);
    expect(applyFilters(products, f({ productType: ["Bourbon"] })).map((p) => p.handle)).toEqual(["t8ke-1"]);
  });

  it("tags match any", () => {
    expect(applyFilters(products, f({ tags: ["pick"] })).map((p) => p.handle)).toEqual(["t8ke-1"]);
  });

  it("availableOnly drops sold-out", () => {
    expect(applyFilters(products, f({ availableOnly: true })).map((p) => p.handle)).toEqual(["reveries-1", "t8ke-1"]);
  });

  it("price range filters on minPrice", () => {
    expect(applyFilters(products, f({ minPriceDollars: 100 })).map((p) => p.handle)).toEqual(["reveries-1", "sold"]);
    expect(applyFilters(products, f({ maxPriceDollars: 100 })).map((p) => p.handle)).toEqual(["t8ke-1"]);
  });

  it("no filters keeps everything", () => {
    expect(applyFilters(products, f({})).length).toBe(3);
  });
});

describe("toProductMap", () => {
  it("keys products by handle", () => {
    const map = toProductMap([prod({ handle: "a" }), prod({ handle: "b" })]);
    expect(Object.keys(map).sort()).toEqual(["a", "b"]);
  });
});
