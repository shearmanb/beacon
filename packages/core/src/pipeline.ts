// The shared pipeline: the stable middle/back every source feeds into. Takes a
// site + its previous state + an adapter, runs FETCH/EXTRACT via the adapter,
// then NORMALIZE → FILTER → DIFF (with empty-guard) → produce { state, alerts }.
// Signals (page-state probes) are handled by a separate state machine.

import { diff, type Alert, type NormalizedProduct, type ProductMap, type SiteSignal } from "@beacon/shared";
import type { HttpValidators } from "@beacon/fetch";
import type { SiteDefinition } from "./schema.js";
import type { PrevState, SourceAdapter } from "./sources/types.js";
import { applyFilters, toProductMap } from "./filter.js";
import { emptyFetchGuard } from "./empty_guard.js";

export interface SiteState {
  lastChecked: string;
  productCount?: number;
  products?: ProductMap;
  pageCount?: number;
  httpValidators?: HttpValidators | null;
  // Signal + guard bookkeeping (loosely typed — varies by source).
  [key: string]: unknown;
}

export interface SiteCheckResult {
  state: SiteState;
  alerts: Alert[];
}

const EMPTY_GUARD_THRESHOLD = 3;

export async function runSiteCheck(
  site: SiteDefinition,
  prev: SiteState | undefined,
  adapter: SourceAdapter,
): Promise<SiteCheckResult> {
  const result = await adapter.fetch(site, (prev ?? {}) as PrevState);
  const now = new Date().toISOString();

  if (result.kind === "not_modified") {
    return {
      state: { ...(prev ?? {}), lastChecked: now, httpValidators: result.validators ?? prev?.httpValidators },
      alerts: [],
    };
  }

  if (result.kind === "signal") {
    return runSignal(site, prev, result.signal, now);
  }

  const prevProducts: ProductMap = (prev?.products as ProductMap | undefined) ?? {};

  // Keyed on the *raw* fetch being empty, so a legitimate filter-miss (empty
  // filtered set from a non-empty fetch) is unaffected.
  if (result.products.length === 0) {
    const guarded = emptyFetchGuard({
      site,
      prev,
      prevProducts,
      threshold: EMPTY_GUARD_THRESHOLD,
      note:
        "Fetch returned 0 products on consecutive checks. Previous products are " +
        "preserved. If the store is between waves this is expected — otherwise the " +
        "source URL/collection may have changed.",
    });
    if (guarded) return guarded;
  }

  const filtered = applyFilters(result.products, site.filters);
  const productMap = toProductMap(filtered);
  const alerts = diff(prevProducts, productMap, {
    onNew: site.alerts.onNew,
    onRestock: site.alerts.onRestock,
    onSoldOut: site.alerts.onSoldOut,
  });

  return {
    state: {
      lastChecked: now,
      productCount: Object.keys(productMap).length,
      products: productMap,
      pageCount: result.pageCount,
      httpValidators: result.validators ?? null,
    },
    alerts,
  };
}

// ── Signal state machine (page-state probes) ─────────────────────────────────
// Fires site_reset once on open -> blocked, clears silently on recovery, and
// re-alerts every `realertEveryHours` while blocked. Ported from
// site_status_monitor.js's reset lifecycle; the http_status adapter (which emits
// the signal) lands in a later increment.

const SIGNAL_REALERT_MS = 24 * 3_600_000;

function runSignal(
  site: SiteDefinition,
  prev: SiteState | undefined,
  signal: SiteSignal,
  now: string,
): SiteCheckResult {
  const wasBlocked = prev?.pageReset === true;
  const alertSentAt = typeof prev?.resetAlertAt === "string" ? Date.parse(prev.resetAlertAt) : null;

  if (signal.kind === "open") {
    // Recovery (or steady-open): clear silently.
    return {
      state: { ...(prev ?? {}), lastChecked: now, pageReset: false, resetAlertSent: false, resetAlertAt: null },
      alerts: [],
    };
  }

  // Blocked. Fire once on transition, then re-fire every realert window.
  const dueForRealert =
    wasBlocked && alertSentAt != null && Date.now() - alertSentAt >= SIGNAL_REALERT_MS;
  const fire = !wasBlocked || dueForRealert;

  const alerts: Alert[] = fire && site.alerts.onSiteReset
    ? [
        {
          type: "site_reset",
          product: {
            title: site.name,
            url: "url" in site.source ? site.source.url : "",
            available: false,
            note: signal.reason ?? "Site appears blocked (password wall / coming-soon / 401-403).",
          },
        },
      ]
    : [];

  return {
    state: {
      ...(prev ?? {}),
      lastChecked: now,
      pageReset: true,
      resetAlertSent: fire || prev?.resetAlertSent === true,
      resetAlertAt: fire ? now : (prev?.resetAlertAt ?? null),
    },
    alerts,
  };
}

export function productMapFrom(products: NormalizedProduct[]): ProductMap {
  return toProductMap(products);
}
