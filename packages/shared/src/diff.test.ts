import { describe, it, expect } from "vitest";
import { diff } from "./diff.js";
import type { NormalizedProduct, ProductMap } from "./types.js";

function p(handle: string, available: boolean, cta?: string): NormalizedProduct {
  return { handle, title: handle, url: `https://x/${handle}`, tags: [], available, ...(cta != null ? { cta } : {}) };
}

const ALL = { onNew: true, onRestock: true, onSoldOut: true };

describe("diff", () => {
  it("flags a new product when onNew", () => {
    const cur: ProductMap = { a: p("a", true) };
    const alerts = diff({}, cur, ALL);
    expect(alerts).toEqual([{ type: "new_product", product: cur.a }]);
  });

  it("suppresses new_product when onNew is false", () => {
    const alerts = diff({}, { a: p("a", true) }, { ...ALL, onNew: false });
    expect(alerts).toEqual([]);
  });

  it("flags restock on false -> true", () => {
    const prev: ProductMap = { a: p("a", false) };
    const cur: ProductMap = { a: p("a", true) };
    expect(diff(prev, cur, ALL)).toEqual([{ type: "restock", product: cur.a }]);
  });

  it("flags sold_out on true -> false", () => {
    const prev: ProductMap = { a: p("a", true) };
    const cur: ProductMap = { a: p("a", false) };
    expect(diff(prev, cur, ALL)).toEqual([{ type: "sold_out", product: cur.a }]);
  });

  it("emits nothing when availability is unchanged", () => {
    const prev: ProductMap = { a: p("a", true), b: p("b", false) };
    const cur: ProductMap = { a: p("a", true), b: p("b", false) };
    expect(diff(prev, cur, ALL)).toEqual([]);
  });

  it("respects individual gating flags", () => {
    const prev: ProductMap = { a: p("a", false), b: p("b", true) };
    const cur: ProductMap = { a: p("a", true), b: p("b", false) };
    expect(diff(prev, cur, { onNew: false, onRestock: true, onSoldOut: false })).toEqual([
      { type: "restock", product: cur.a },
    ]);
  });

  it("emits site_changed when the button text changes while still not buyable", () => {
    const prev: ProductMap = { a: p("a", false, "See details") };
    const cur: ProductMap = { a: p("a", false, "Reserve now") };
    const alerts = diff(prev, cur, ALL);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.type).toBe("site_changed");
    expect(alerts[0]!.product.handle).toBe("a");
    expect(alerts[0]!.product.note).toContain("Reserve now");
  });

  it("does NOT emit site_changed when the flip is already a restock", () => {
    const prev: ProductMap = { a: p("a", false, "See details") };
    const cur: ProductMap = { a: p("a", true, "Add to cart") };
    expect(diff(prev, cur, ALL).map((x) => x.type)).toEqual(["restock"]);
  });

  it("does NOT emit site_changed on the first check after deploy (no prior cta)", () => {
    const prev: ProductMap = { a: p("a", false) }; // old state carries no cta
    const cur: ProductMap = { a: p("a", false, "Add to cart") };
    expect(diff(prev, cur, ALL)).toEqual([]);
  });

  it("does NOT emit site_changed when the button text is unchanged", () => {
    const prev: ProductMap = { a: p("a", false, "See details") };
    const cur: ProductMap = { a: p("a", false, "See details") };
    expect(diff(prev, cur, ALL)).toEqual([]);
  });
});
