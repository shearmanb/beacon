const strategies = {
  shopify_collection:   () => import("../sites/shopify_collection.js"),
  shopify_storefront:   () => import("../sites/shopify_storefront.js"),
  site_status_monitor:  () => import("../sites/site_status_monitor.js"),
};

export const strategyNames = Object.keys(strategies);

export async function loadStrategy(name) {
  const loader = strategies[name];
  if (!loader) throw new Error(`Unknown strategy: ${name}`);
  return loader();
}
