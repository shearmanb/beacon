// Central registry of site strategies, imported by both checker.js and worker.js.

const strategies = {
  shopify_collection: () => import("../sites/shopify_collection.js"),
  shopify_storefront: () => import("../sites/shopify_storefront.js"),
  reveries_squarespace: () => import("../sites/reveries_squarespace.js"),
  squarespace_json_monitor: () => import("../sites/squarespace_json_monitor.js"),
  html_text_monitor: () => import("../sites/html_text_monitor.js"),
};

export async function loadStrategy(name) {
  const loader = strategies[name];
  if (!loader) throw new Error(`Unknown strategy: ${name}`);
  return loader();
}
