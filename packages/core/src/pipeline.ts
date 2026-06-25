// The shared pipeline: the stable middle/back every source feeds into. Takes a
// site + its previous state + an adapter, runs FETCH/EXTRACT via the adapter,
// then NORMALIZE → FILTER → DIFF (with empty-guard) → produce { state, alerts }.
// Signals (page-state probes) are handled by a separate state machine.

import { diff, type Alert, type NormalizedProduct, type ProductMap, type SiteSignal } from "@beacon/shared";
import type { HttpValidators } from "@beacon/fetch";
import { sourceUrl, type SiteDefinition } from "./schema.js";
import type { AdapterDeps, PrevState, SourceAdapter } from "./sources/types.js";
import { applyFilters, toProductMap } from "./filter.js";
import { emptyFetchGuard } from "./empty_guard.js";
import { assessYield } from "./drift_guard.js";

export interface SiteState {
  lastChecked: string | null;
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

const DEFAULT_EMPTY_GUARD_THRESHOLD = 3;
const DEFAULT_EMPTY_GUARD_NOTE =
  "Fetch returned 0 products on consecutive checks. Previous products are preserved. " +
  "If the store is between waves this is expected — otherwise the source URL/collection " +
  "may have changed.";

export async function runSiteCheck(
  site: SiteDefinition,
  prev: SiteState | undefined,
  adapter: SourceAdapter,
  deps?: AdapterDeps,
): Promise<SiteCheckResult> {
  const result = await adapter.fetch(site, (prev ?? {}) as PrevState, deps);
  const now = new Date().toISOString();

  if (result.kind === "not_modified") {
    return {
      state: { ...(prev ?? {}), lastChecked: now, httpValidators: result.validators ?? prev?.httpValidators },
      alerts: [],
    };
  }

  if (result.kind === "signal") {
    return runSignal(site, prev, result.signal, result.validators ?? null, now);
  }

  const prevProducts: ProductMap = (prev?.products as ProductMap | undefined) ?? {};

  // Keyed on the *raw* fetch being empty, so a legitimate filter-miss (empty
  // filtered set from a non-empty fetch) is unaffected.
  if (result.products.length === 0) {
    const guarded = emptyFetchGuard({
      site,
      prev,
      prevProducts,
      threshold: result.emptyGuardThreshold ?? DEFAULT_EMPTY_GUARD_THRESHOLD,
      note: result.emptyGuardNote ?? DEFAULT_EMPTY_GUARD_NOTE,
    });
    if (guarded) return guarded;
  }

  // Structure-drift guard (3a): a non-zero but anomalously small yield against a
  // healthy baseline likely means a broken parser. Preserve products + ping,
  // rather than wiping state and flooding on recovery. Returns null on healthy
  // yields, along with the baseline bookkeeping to carry forward.
  const yieldEval = assessYield({ site, prev, prevProducts, rawCount: result.products.length });
  if (yieldEval.drift) return yieldEval.drift;

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
      ...yieldEval.tracking,
    },
    alerts,
  };
}

// ── Signal state machine (page-state probes) ─────────────────────────────────
// Faithful to site_status_monitor.js: fires site_reset ONCE on the open->blocked
// transition (gated by alerts.onSiteReset), suppresses while it stays blocked,
// and clears silently on recovery. No periodic re-alert — that's the
// empty-guard's job, not this probe's.

function runSignal(
  site: SiteDefinition,
  prev: SiteState | undefined,
  signal: SiteSignal,
  validators: HttpValidators | null,
  now: string,
): SiteCheckResult {
  if (signal.kind === "open") {
    return {
      state: {
        ...(prev ?? {}),
        lastChecked: now,
        products: {},
        pageReset: false,
        resetAlertSent: false,
        resetReason: null,
        httpValidators: validators,
      },
      alerts: [],
    };
  }

  const alreadyAlerted = prev?.resetAlertSent === true;
  const fire = !alreadyAlerted && site.alerts.onSiteReset;
  const alerts: Alert[] = fire
    ? [
        {
          type: "site_reset",
          product: {
            title: site.name,
            url: sourceUrl(site),
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
      products: {},
      pageReset: true,
      resetAlertSent: alreadyAlerted || fire,
      resetReason: signal.reason ?? "blocked",
      httpValidators: validators,
    },
    alerts,
  };
}

export function productMapFrom(products: NormalizedProduct[]): ProductMap {
  return toProductMap(products);
}
