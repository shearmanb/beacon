// Post-extraction, source-agnostic product filter. Ported from
// shopify_collection.js applyFilters, but operating on canonical
// NormalizedProduct fields (minPrice/available already resolved) so the same
// filter works for every source.

import type { NormalizedProduct } from "@beacon/shared";
import type { Filters } from "./schema.js";

export function applyFilters(products: NormalizedProduct[], f: Filters): NormalizedProduct[] {
  return products.filter((p) => {
    const title = p.title.toLowerCase();
    if (f.titleContains.length && !f.titleContains.some((t) => title.includes(t.toLowerCase()))) {
      return false;
    }
    if (f.titleExcludes.length && f.titleExcludes.some((t) => title.includes(t.toLowerCase()))) {
      return false;
    }
    if (f.vendorIs.length && !(p.vendor != null && f.vendorIs.includes(p.vendor))) return false;
    if (f.productType.length && !(p.productType != null && f.productType.includes(p.productType))) {
      return false;
    }
    if (f.tags.length && !f.tags.some((t) => p.tags.includes(t))) return false;
    if (f.availableOnly && !p.available) return false;
    if (f.minPriceDollars != null && (p.minPrice == null || p.minPrice < f.minPriceDollars)) {
      return false;
    }
    if (f.maxPriceDollars != null && (p.minPrice == null || p.minPrice > f.maxPriceDollars)) {
      return false;
    }
    return true;
  });
}

export function toProductMap(products: NormalizedProduct[]): Record<string, NormalizedProduct> {
  const map: Record<string, NormalizedProduct> = {};
  for (const p of products) map[p.handle] = p;
  return map;
}
