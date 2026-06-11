// Shared guard for strategies whose fetch returned 0 products while the
// previous state still tracks some. Preserves the previous product map (so a
// transient empty response never wipes state and re-fires every product as
// new_product on recovery) and escalates with a one-time site_reset alert
// once the empty result has persisted for `threshold` consecutive checks.
// Returns null when there were no previous products — callers fall through
// to their normal diff path.
export function emptyFetchGuard({ site, previousState, prevProducts, threshold = 1, note = "" }) {
  const prevCount = Object.keys(prevProducts).length;
  if (prevCount === 0) return null;

  const emptyStreak = (previousState?.emptyStreak ?? 0) + 1;
  // Legacy flag: shopify_storefront used to track this as collectionEmpty.
  const alreadySent = previousState?.emptyAlertSent === true || previousState?.collectionEmpty === true;
  const alertNow = emptyStreak >= threshold && !alreadySent;

  console.warn(
    `[${site.name}] Fetch returned 0 products but state has ${prevCount} — ` +
    `preserving state (empty streak: ${emptyStreak})`
  );

  return {
    state: {
      lastChecked: new Date().toISOString(),
      productCount: prevCount,
      products: prevProducts,
      emptyStreak,
      emptyAlertSent: alreadySent || alertNow,
    },
    alerts: alertNow
      ? [
          {
            type: "site_reset",
            product: {
              title: site.name,
              url: site.url,
              vendor: null,
              minPrice: null,
              available: false,
              image: null,
              note,
            },
          },
        ]
      : [],
  };
}
