// Product diff ported from lib/diff.js. Compares previous and current product
// maps and returns alerts, gated by per-site alert flags (passed as DiffOptions
// rather than reading site fields directly, so it's reusable across sources).

import type { Alert, AlertProduct, DiffOptions, NormalizedProduct, ProductMap } from "./types.js";

/** Stamp how long after the store's own timestamp this alert was raised. The
 *  measurement behind every cadence decision: without it "check more often"
 *  is a guess. Sources that carry no timestamps simply get no lag. */
function withLag(product: NormalizedProduct, basis: "listed" | "updated", now: number): AlertProduct {
  const at = Date.parse((basis === "listed" ? product.listedAt : product.updatedAt) ?? "");
  // A timestamp in the future (clock skew, scheduled publish) proves nothing.
  if (!Number.isFinite(at) || at > now + 60_000) return product;
  return { ...product, lagSec: Math.max(0, Math.round((now - at) / 1000)), lagBasis: basis };
}

/** Beyond this a "lag" is not lateness: the product was listed long before it
 *  entered what this checker watches (added to a collection, wall lifted). */
export const LAG_PLAUSIBLE_MAX_SEC = 24 * 3600;

/** "45s", "3m 12s", "2h 05m" — or null when there is no meaningful lag to show. */
export function formatLag(lagSec: number | null | undefined): string | null {
  if (lagSec == null || !Number.isFinite(lagSec) || lagSec < 0 || lagSec > LAG_PLAUSIBLE_MAX_SEC) return null;
  if (lagSec < 60) return `${lagSec}s`;
  if (lagSec < 3600) return `${Math.floor(lagSec / 60)}m ${String(lagSec % 60).padStart(2, "0")}s`;
  return `${Math.floor(lagSec / 3600)}h ${String(Math.floor((lagSec % 3600) / 60)).padStart(2, "0")}m`;
}

export function diff(previous: ProductMap, current: ProductMap, opts: DiffOptions, now: number = Date.now()): Alert[] {
  const alerts: Alert[] = [];
  for (const [handle, product] of Object.entries(current)) {
    const prev = previous[handle];
    if (!prev) {
      if (opts.onNew) alerts.push({ type: "new_product", product: withLag(product, "listed", now) });
    } else if (!prev.available && product.available) {
      if (opts.onRestock) alerts.push({ type: "restock", product: withLag(product, "updated", now) });
    } else if (prev.available && !product.available) {
      if (opts.onSoldOut) alerts.push({ type: "sold_out", product });
    } else if (!product.available && prev.cta != null && product.cta != null && prev.cta !== product.cta) {
      // Availability didn't move and we still read it as not-buyable, but the
      // call-to-action TEXT changed — a language-agnostic safety net for buy
      // states a fixed word-list won't recognize (e.g. "See details" ->
      // "Reserve now"). Requires BOTH sides to have `cta`, so it never floods
      // the first check after a deploy (old state carries no cta).
      alerts.push({
        type: "site_changed",
        product: {
          handle: product.handle,
          title: product.title,
          url: product.url,
          note: `${product.title}: button changed from "${prev.cta}" to "${product.cta}" — may be buyable, check it.`,
        },
      });
    }
  }
  return alerts;
}
