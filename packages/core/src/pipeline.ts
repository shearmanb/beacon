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
    return runSignal(site, prev, result.signal, result.validators ?? null, now, result.contentHash, result.contentLen);
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
// One alert per check, decided by the transition between the previous and new
// page classification (open/blocked) plus a normalized content fingerprint:
//   open    -> blocked : site_reset  (wall went up — fire once, gated onSiteReset)
//   blocked -> open    : site_changed "wall lifted" (gated source.alertOnOpen)
//   same classification, fingerprint moved: site_changed "content changed"
//                        (gated source.watchContentChange; baseline-safe — needs
//                        a prior hash, so the first check after deploy is silent)
// This is the never-miss net for a password wall flipping to a live store: even
// if the wall was never classified as "blocked", the content change still fires.

function isMaterialChange(prevLen: number | undefined, newLen: number | undefined, minFrac: number): boolean {
  if (minFrac <= 0) return true; // any fingerprint change counts (never-miss default)
  if (prevLen == null || newLen == null || prevLen === 0) return true;
  return Math.abs(newLen - prevLen) / prevLen >= minFrac;
}

function lenNote(prevLen: number | undefined, newLen: number | undefined): string {
  return prevLen != null && newLen != null ? ` (≈${prevLen}→${newLen} chars)` : "";
}

function runSignal(
  site: SiteDefinition,
  prev: SiteState | undefined,
  signal: SiteSignal,
  validators: HttpValidators | null,
  now: string,
  contentHash?: string,
  contentLen?: number,
): SiteCheckResult {
  const newBlocked = signal.kind === "blocked";
  const prevBlocked = prev?.pageReset === true;
  const prevHash = prev?.contentHash as string | undefined;
  const prevLen = prev?.contentLen as number | undefined;

  // Only http_status emits signals; read its content-change knobs when present.
  const src = site.source.kind === "http_status" ? site.source : undefined;
  const alertOnOpen = src?.alertOnOpen ?? false;
  const watchContentChange = src?.watchContentChange ?? false;
  const minFrac = src?.contentChangeMinFrac ?? 0;

  const baseState: SiteState = {
    ...(prev ?? {}),
    lastChecked: now,
    products: {},
    httpValidators: validators,
    contentHash: contentHash ?? prevHash ?? null,
    contentLen: contentLen ?? prevLen ?? null,
  };
  const url = sourceUrl(site);

  // open -> blocked: wave reset (fire once).
  if (newBlocked && !prevBlocked) {
    const alreadyAlerted = prev?.resetAlertSent === true;
    const fire = !alreadyAlerted && site.alerts.onSiteReset;
    return {
      state: { ...baseState, pageReset: true, resetAlertSent: alreadyAlerted || fire, resetReason: signal.reason ?? "blocked" },
      alerts: fire
        ? [
            {
              type: "site_reset",
              product: {
                title: site.name,
                url,
                available: false,
                note: signal.reason ?? "Site appears blocked (password wall / coming-soon / 401-403).",
              },
            },
          ]
        : [],
    };
  }

  // blocked -> open: wall lifted. Previously silent — now the headline alert.
  if (!newBlocked && prevBlocked) {
    return {
      state: { ...baseState, pageReset: false, resetAlertSent: false, resetReason: null },
      alerts: alertOnOpen
        ? [
            {
              type: "site_changed",
              product: {
                title: site.name,
                url,
                available: true,
                note: `🟢 Wall lifted — ${site.name} is now OPEN. Check for bottles.`,
              },
            },
          ]
        : [],
    };
  }

  // Same classification (open->open or blocked->blocked): content-change net.
  const changed =
    watchContentChange &&
    contentHash != null &&
    prevHash != null &&
    contentHash !== prevHash &&
    isMaterialChange(prevLen, contentLen, minFrac);

  return {
    state: {
      ...baseState,
      pageReset: newBlocked,
      resetAlertSent: newBlocked ? prev?.resetAlertSent === true : false,
      resetReason: newBlocked ? (prev?.resetReason ?? signal.reason ?? "blocked") : null,
    },
    alerts: changed
      ? [
          {
            type: "site_changed",
            product: {
              title: site.name,
              url,
              available: !newBlocked,
              note: `Page content changed${lenNote(prevLen, contentLen)} at ${url} — check it.`,
            },
          },
        ]
      : [],
  };
}

export function productMapFrom(products: NormalizedProduct[]): ProductMap {
  return toProductMap(products);
}
