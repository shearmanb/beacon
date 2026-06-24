// Product diff ported from lib/diff.js. Compares previous and current product
// maps and returns alerts, gated by per-site alert flags (passed as DiffOptions
// rather than reading site fields directly, so it's reusable across sources).

import type { Alert, DiffOptions, ProductMap } from "./types.js";

export function diff(previous: ProductMap, current: ProductMap, opts: DiffOptions): Alert[] {
  const alerts: Alert[] = [];
  for (const [handle, product] of Object.entries(current)) {
    const prev = previous[handle];
    if (!prev) {
      if (opts.onNew) alerts.push({ type: "new_product", product });
    } else if (!prev.available && product.available) {
      if (opts.onRestock) alerts.push({ type: "restock", product });
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
