// Guard for sources whose fetch returned 0 products while the previous state
// still tracks some. Preserves the previous product map (so a transient empty
// response never wipes state and re-fires every product as new on recovery) and
// escalates with a site_reset alert once the empty result has persisted for
// `threshold` consecutive checks; while empty it re-fires on a backoff
// (24 h, 48 h, 96 h, then weekly). A shop that empties between drops is often
// the normal state — the 2026-09 review found daily reminders paging 10+ days
// running for reveries_official — so the reminder decays instead of nagging.
// Returns null when there were no previous products — callers fall through to
// their normal diff path. Ported from lib/empty_guard.js.

import type { Alert, NormalizedProduct } from "@beacon/shared";
import { sourceUrl, type SiteDefinition } from "./schema.js";
import type { SiteCheckResult, SiteState } from "./pipeline.js";

const REALERT_BASE_MS = 24 * 3_600_000;
const REALERT_MAX_MS = 7 * REALERT_BASE_MS;

/** Gap before the next reminder, given how many empty alerts already went out. */
export function emptyRealertMs(alertsSent: number): number {
  return Math.min(REALERT_BASE_MS * 2 ** Math.max(0, alertsSent - 1), REALERT_MAX_MS);
}

export interface EmptyGuardArgs {
  site: SiteDefinition;
  prev: SiteState | undefined;
  prevProducts: Record<string, NormalizedProduct>;
  threshold?: number;
  note?: string;
}

export function emptyFetchGuard({
  site,
  prev,
  prevProducts,
  threshold = 1,
  note = "",
}: EmptyGuardArgs): SiteCheckResult | null {
  const prevCount = Object.keys(prevProducts).length;
  if (prevCount === 0) return null;

  const emptyStreak = ((prev?.emptyStreak as number | undefined) ?? 0) + 1;
  const alreadySent = prev?.emptyAlertSent === true || prev?.collectionEmpty === true;
  // Legacy states have the sent flag but no timestamp; start their 24 h clock
  // now rather than re-alerting immediately on deploy.
  const lastAlertAt = prev?.emptyAlertAt
    ? new Date(prev.emptyAlertAt as string).getTime()
    : alreadySent
      ? Date.now()
      : null;
  const alertsSent = (prev?.emptyAlertCount as number | undefined) ?? (alreadySent ? 1 : 0);
  const dueForRealert =
    alreadySent && lastAlertAt != null && Date.now() - lastAlertAt >= emptyRealertMs(alertsSent);
  const alertNow = emptyStreak >= threshold && (!alreadySent || dueForRealert);

  console.warn(
    `[${site.name}] Fetch returned 0 products but state has ${prevCount} — ` +
      `preserving state (empty streak: ${emptyStreak})`,
  );

  const alerts: Alert[] = alertNow
    ? [
        {
          type: "site_reset",
          product: {
            title: site.name,
            url: sourceUrl(site),
            vendor: null,
            minPrice: null,
            available: false,
            image: null,
            note: dueForRealert
              ? `Still empty after ${emptyStreak} consecutive checks (reminder; next in ` +
                `${Math.round(emptyRealertMs(alertsSent + 1) / 3_600_000)} h).\n${note}`
              : note,
          },
        },
      ]
    : [];

  return {
    state: {
      lastChecked: new Date().toISOString(),
      productCount: prevCount,
      products: prevProducts,
      // The drift guard's healthy-yield memory: an empty spell must not erase it.
      countBaseline: prev?.countBaseline ?? null,
      emptyStreak,
      emptyAlertSent: alreadySent || alertNow,
      emptyAlertCount: alertNow ? alertsSent + 1 : alertsSent,
      emptyAlertAt: alertNow
        ? new Date().toISOString()
        : lastAlertAt != null
          ? new Date(lastAlertAt).toISOString()
          : null,
    },
    alerts,
  };
}
