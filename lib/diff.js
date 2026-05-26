// Shared product diff logic used by all site strategies.
// Compares previous and current product maps and returns alerts.

export function diff(previous, current, site) {
  const alerts = [];
  for (const [handle, product] of Object.entries(current)) {
    if (!previous[handle]) {
      if (site.alertOnNewProduct) alerts.push({ type: "new_product", product });
    } else if (!previous[handle].available && product.available) {
      if (site.alertOnRestock) alerts.push({ type: "restock", product });
    } else if (previous[handle].available && !product.available) {
      if (site.alertOnSoldOut) alerts.push({ type: "sold_out", product });
    }
  }
  return alerts;
}
