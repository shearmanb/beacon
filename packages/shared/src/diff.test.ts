import { describe, it, expect } from "vitest";
import { diff } from "./diff.js";
import type { NormalizedProduct, ProductMap } from "./types.js";

function p(handle: string, available: boolean): NormalizedProduct {
  return { handle, title: handle, url: `https://x/${handle}`, tags: [], available };
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
});
