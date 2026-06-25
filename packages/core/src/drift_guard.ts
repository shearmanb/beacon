// Structure-drift guard (3a). The empty-guard only catches a *literal zero*
// fetch. But a source whose page template or API shape changed often doesn't go
// to zero — it returns a handful of garbage rows (a parser matching the wrong
// element, an API returning a truncated set). That silently (a) drops the real
// products from state and (b) can flood `new_product` on recovery. This guard
// generalizes the empty-guard to "this site normally returns ~N, now returns
// ≪N, repeatedly" → preserve the previous products, suppress the spurious diff,
// and ping the operator ONCE (re-armed daily) to investigate.
//
// Deliberately conservative to protect trust (a noisy self-heal is worse than
// none): it only engages once a site has shown a healthy baseline (MIN_BASELINE)
// and only after the drop persists for DRIFT_THRESHOLD consecutive checks. A
// legitimate wave selling down is gradual and recovers the baseline; a broken
// parser stays pinned low. Thresholds are constants here — promote to per-source
// config if a real site needs tuning.

import type { Alert, NormalizedProduct } from "@beacon/shared";
import { sourceUrl, type SiteDefinition } from "./schema.js";
import type { SiteCheckResult, SiteState } from "./pipeline.js";

const MIN_BASELINE = 8; // below this a site is "small"; drift detection stays off
const DROP_FRAC = 0.25; // suspect drift when raw yield ≤ 25% of baseline
const RECOVER_FRAC = 0.5; // streak resets once yield climbs back ≥ 50% of baseline
const DRIFT_THRESHOLD = 2; // consecutive suspect checks before alerting
const BASELINE_DECAY = 0.98; // slow decay so a permanently-smaller catalog re-baselines
const REALERT_MS = 24 * 3_600_000;

export interface YieldTracking {
  countBaseline: number;
  driftStreak: number;
  driftAlertSent: boolean;
  driftAlertAt: string | null;
}

export interface YieldAssessment {
  /** Present only when drift is confirmed — a ready-to-return preserve+alert result. */
  drift: SiteCheckResult | null;
  /** Baseline/streak bookkeeping to merge into the normal (non-drift) state. */
  tracking: YieldTracking;
}

export interface AssessYieldArgs {
  site: SiteDefinition;
  prev: SiteState | undefined;
  prevProducts: Record<string, NormalizedProduct>;
  /** Unfiltered fetch yield (result.products.length) — same signal the empty-guard keys on. */
  rawCount: number;
}

export function assessYield({ site, prev, prevProducts, rawCount }: AssessYieldArgs): YieldAssessment {
  const prevBaseline = (prev?.countBaseline as number | undefined) ?? 0;
  const prevStreak = (prev?.driftStreak as number | undefined) ?? 0;
  const prevAlertSent = prev?.driftAlertSent === true;
  const prevAlertAt = (prev?.driftAlertAt as string | undefined) ?? null;

  const suspect = prevBaseline >= MIN_BASELINE && rawCount <= prevBaseline * DROP_FRAC;

  if (!suspect) {
    // Healthy (or recovering): grow the baseline to new highs, decay it slowly
    // otherwise so a genuinely smaller catalog eventually stops being "drift".
    const recovered = rawCount >= prevBaseline * RECOVER_FRAC;
    const countBaseline = Math.max(rawCount, Math.floor(prevBaseline * BASELINE_DECAY));
    return {
      drift: null,
      tracking: {
        countBaseline,
        driftStreak: recovered ? 0 : prevStreak,
        driftAlertSent: false,
        driftAlertAt: null,
      },
    };
  }

  const driftStreak = prevStreak + 1;
  const lastAlertMs = prevAlertAt ? new Date(prevAlertAt).getTime() : null;
  const dueForRealert = prevAlertSent && lastAlertMs != null && Date.now() - lastAlertMs >= REALERT_MS;
  const fire = driftStreak >= DRIFT_THRESHOLD && (!prevAlertSent || dueForRealert);

  console.warn(
    `[${site.name}] Yield drift: raw fetch ${rawCount} vs baseline ${prevBaseline} ` +
      `(streak ${driftStreak}) — preserving ${Object.keys(prevProducts).length} products.`,
  );

  const tracking: YieldTracking = {
    countBaseline: prevBaseline, // hold the baseline; don't let the drop redefine "normal"
    driftStreak,
    driftAlertSent: prevAlertSent || fire,
    driftAlertAt: fire ? new Date().toISOString() : prevAlertAt,
  };

  const alerts: Alert[] = fire
    ? [
        {
          type: "site_changed",
          product: {
            title: site.name,
            url: sourceUrl(site),
            available: false,
            note:
              `Yield dropped to ${rawCount} (normally ~${prevBaseline}) for ${driftStreak} checks — ` +
              `the page template or API shape may have changed (parser likely broken). ` +
              `Previous products are preserved; verify the source.` +
              (dueForRealert ? " (daily reminder)" : ""),
          },
        },
      ]
    : [];

  return {
    drift: {
      state: {
        lastChecked: new Date().toISOString(),
        productCount: Object.keys(prevProducts).length,
        products: prevProducts,
        ...tracking,
      },
      alerts,
    },
    tracking,
  };
}
