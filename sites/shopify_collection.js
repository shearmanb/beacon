import { https } from "../lib/fetch.js";
import { diff } from "../lib/diff.js";
import { sleep } from "../lib/utils.js";
import { emptyFetchGuard } from "../lib/empty_guard.js";

function getMinPrice(variants) {
  if (!variants?.length) return null;
  const prices = variants.map((v) => parseFloat(v.price)).filter((n) => !isNaN(n));
  return prices.length ? Math.min(...prices) : null;
}

function isAvailable(variants) {
  return variants?.some((v) => v.available) ?? false;
}

export async function checkSite(site, previousState) {
  const products = await fetchAllProducts(site);
  const prevProducts = previousState?.products ?? {};

  // Keyed on the *raw* fetch being empty, so a legitimate filter-miss
  // (empty filtered set from a non-empty fetch) is unaffected. After 3
  // consecutive empties the guard fires a one-time site_reset so a
  // permanently empty/broken collection can't stay silent forever.
  if (products.length === 0) {
    const guarded = emptyFetchGuard({
      site,
      previousState,
      prevProducts,
      threshold: 3,
      note:
        `products.json returned 0 products on 3 consecutive checks. Previous products are ` +
        `preserved. If the store is between waves this is expected — otherwise the ` +
        `collection URL may have changed.`,
    });
    if (guarded) return guarded;
  }

  const filtered = applyFilters(products, site.filters);
  const productMap = buildProductMap(filtered, site.url);
  const alerts = diff(prevProducts, productMap, site);

  return {
    state: {
      lastChecked: new Date().toISOString(),
      productCount: Object.keys(productMap).length,
      products: productMap,
    },
    alerts,
  };
}

async function fetchAllProducts(site) {
  const base = site.url.replace(/\/$/, "");
  const extraParams = site.collectionParams ? `&${site.collectionParams}` : "";
  const all = [];
  let page = 1;

  while (true) {
    if (page > 1) await sleep(300 + Math.floor(Math.random() * 500));
    const url = `${base}/products.json?limit=250&page=${page}${extraParams}`;
    const data = await https(url);
    const json = JSON.parse(data);
    const batch = json.products ?? [];
    all.push(...batch);
    if (batch.length < 250) break;
    page++;
  }

  return all;
}

function buildProductMap(products, siteUrl) {
  const base = new URL(siteUrl).origin;
  const map = {};

  for (const p of products) {
    const minPrice = getMinPrice(p.variants);
    const available = isAvailable(p.variants);
    const image = p.images?.[0]?.src ?? null;

    map[p.handle] = {
      handle: p.handle,
      title: p.title,
      vendor: p.vendor,
      productType: p.product_type,
      tags: p.tags ?? [],
      minPrice,
      available,
      image,
      url: `${base}/products/${p.handle}`,
    };
  }

  return map;
}

function applyFilters(products, filters) {
  if (!filters) return products;
  return products.filter((p) => {
    if (filters.titleContains?.length) {
      const title = p.title.toLowerCase();
      if (!filters.titleContains.some((t) => title.includes(t.toLowerCase()))) return false;
    }
    if (filters.titleExcludes?.length) {
      const title = p.title.toLowerCase();
      if (filters.titleExcludes.some((t) => title.includes(t.toLowerCase()))) return false;
    }
    if (filters.vendorIs?.length) {
      if (!filters.vendorIs.includes(p.vendor)) return false;
    }
    if (filters.productType?.length) {
      if (!filters.productType.includes(p.product_type)) return false;
    }
    if (filters.tags?.length) {
      const ptags = p.tags ?? [];
      if (!filters.tags.some((t) => ptags.includes(t))) return false;
    }
    if (filters.availableOnly) {
      if (!isAvailable(p.variants)) return false;
    }
    const minPrice = getMinPrice(p.variants);
    if (filters.minPriceDollars != null && (minPrice == null || minPrice < filters.minPriceDollars)) return false;
    if (filters.maxPriceDollars != null && (minPrice == null || minPrice > filters.maxPriceDollars)) return false;
    return true;
  });
}

