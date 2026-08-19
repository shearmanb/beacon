// Auction cost model — lives in @beacon/shared, NOT @beacon/core, because the
// dashboard's client components need it too and @beacon/core pulls in the fetch
// layer (node http) which can't be bundled for the browser. It used to be
// hand-copied into UnicornLots.tsx and UnicornBottles.tsx; three copies of a
// buy/no-buy formula is exactly the kind of thing that silently drifts.

export interface AuctionFees {
  buyerPremiumPct: number;
  salesTaxPct: number;
  shippingDollars: number;
}

/** Hammer price -> estimated delivered cost. Premium first, then tax on the
 *  premium-inclusive subtotal, then shipping (verified against the operator's
 *  own reference point: a $375 hammer lands at ~$500 delivered). */
export function estimateAllInDollars(hammerDollars: number, fees: AuctionFees): number {
  const withPremium = hammerDollars * (1 + fees.buyerPremiumPct / 100);
  return withPremium * (1 + fees.salesTaxPct / 100) + fees.shippingDollars;
}

// ── Lot title normalization (cross-auction identity) ─────────────────────────
// Auction lot ids are per-auction: the SAME bottle gets a brand-new id at every
// weekly rollover. Keying "have I already told you about this?" on the lot id
// therefore re-alerts the entire matched roster every week (Aug 10: 75 pings,
// 46 distinct bottles, one bottle sent 26 times). Normalized title is the only
// stable identity the feed gives us, so it's what the seen-memory and the
// ignore list key on.

/** Lowercase, strip the 🦄 prefix / punctuation / lot-number noise, collapse
 *  whitespace. Two listings of the same bottle normalize to the same string;
 *  a different vintage or size stays distinct (the digits survive). */
export function normalizeLotTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}]/gu, " ") // emoji (our own 🦄 prefix included)
    .replace(/\blot\s*#?\s*\d+\b/g, " ") // "Lot 412" — per-auction, not identity
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
