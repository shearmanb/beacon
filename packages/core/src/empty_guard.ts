// Guard for sources whose fetch returned 0 products while the previous state
// still tracks some. Preserves the previous product map (so a transient empty
// response never wipes state and re-fires every product as new on recovery) and
// escalates with a site_reset alert once the empty result has persisted for
// `threshold` consecutive checks; while empty it re-fires every 24 h.
// Returns null when there were no previous products — callers fall through to
// their normal diff path. Ported from lib/empty_guard.js.

import type { Alert, NormalizedProduct } from "@beacon/shared";
import { sourceUrl, type SiteDefinition } from "./schema.js";
import type { SiteCheckResult, SiteState } from "./pipeline.js";

const REALERT_MS = 24 * 3_600_000;

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
  const dueForRealert = alreadySent && lastAlertAt != null && Date.now() - lastAlertAt >= REALERT_MS;
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
              ? `Still empty after ${emptyStreak} consecutive checks (daily reminder).\n${note}`
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
      emptyStreak,
      emptyAlertSent: alreadySent || alertNow,
      emptyAlertAt: alertNow
        ? new Date().toISOString()
        : lastAlertAt != null
          ? new Date(lastAlertAt).toISOString()
          : null,
    },
    alerts,
  };
}
