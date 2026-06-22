// Product provenance — ported from worker.js annotateProducts. Carries
// firstSeen (powers the dashboard NEW badge) and prevPrice/priceChangedAt (the
// price-delta arrows) across checks. Deltas expire after 7 days. Mutates the
// current product map in place.

import type { NormalizedProduct } from "@beacon/shared";

const PRICE_DELTA_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type AnnotatedProduct = NormalizedProduct & {
  firstSeen?: string;
  prevPrice?: number | null;
  priceChangedAt?: string;
};

export function annotateProducts(
  prevProducts: Record<string, AnnotatedProduct> = {},
  products: Record<string, AnnotatedProduct> = {},
): void {
  const now = new Date().toISOString();
  for (const [handle, p] of Object.entries(products)) {
    const prev = prevProducts[handle];
    if (!prev) {
      p.firstSeen = now;
      continue;
    }
    if (prev.firstSeen) p.firstSeen = prev.firstSeen;
    if (prev.minPrice != null && p.minPrice != null && prev.minPrice !== p.minPrice) {
      p.prevPrice = prev.minPrice;
      p.priceChangedAt = now;
    } else if (
      prev.prevPrice != null &&
      prev.priceChangedAt &&
      Date.now() - new Date(prev.priceChangedAt).getTime() < PRICE_DELTA_TTL_MS
    ) {
      p.prevPrice = prev.prevPrice;
      p.priceChangedAt = prev.priceChangedAt;
    }
  }
}
