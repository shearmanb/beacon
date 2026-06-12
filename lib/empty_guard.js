// Shared guard for strategies whose fetch returned 0 products while the
// previous state still tracks some. Preserves the previous product map (so a
// transient empty response never wipes state and re-fires every product as
// new_product on recovery) and escalates with a site_reset alert once the
// empty result has persisted for `threshold` consecutive checks. While the
// site stays empty the alert re-fires every 24 h — a silently swapped
// collection ID should nag, not go quiet forever after one alert.
// Returns null when there were no previous products — callers fall through
// to their normal diff path.
const REALERT_MS = 24 * 3_600_000;

export function emptyFetchGuard({ site, previousState, prevProducts, threshold = 1, note = "" }) {
  const prevCount = Object.keys(prevProducts).length;
  if (prevCount === 0) return null;

  const emptyStreak = (previousState?.emptyStreak ?? 0) + 1;
  // Legacy flag: shopify_storefront used to track this as collectionEmpty.
  const alreadySent = previousState?.emptyAlertSent === true || previousState?.collectionEmpty === true;
  // Legacy states have the sent flag but no timestamp; start their 24 h clock
  // now rather than re-alerting immediately on deploy.
  const lastAlertAt = previousState?.emptyAlertAt
    ? new Date(previousState.emptyAlertAt).getTime()
    : (alreadySent ? Date.now() : null);
  const dueForRealert = alreadySent && lastAlertAt != null && Date.now() - lastAlertAt >= REALERT_MS;
  const alertNow = emptyStreak >= threshold && (!alreadySent || dueForRealert);

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
      emptyAlertAt: alertNow
        ? new Date().toISOString()
        : (lastAlertAt != null ? new Date(lastAlertAt).toISOString() : null),
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
              note: dueForRealert
                ? `Still empty after ${emptyStreak} consecutive checks (daily reminder).\n${note}`
                : note,
            },
          },
        ]
      : [],
  };
}
