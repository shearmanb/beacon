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
    }
  }
  return alerts;
}
