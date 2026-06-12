import { https, conditionalHeaders, extractValidators } from "../lib/fetch.js";
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
  const { products, notModified, validators, pageCount } = await fetchAllProducts(site, previousState);
  const prevProducts = previousState?.products ?? {};

  // 304 on the (single) page — catalog is byte-identical, nothing to diff.
  if (notModified) {
    return {
      state: { ...previousState, lastChecked: new Date().toISOString() },
      alerts: [],
    };
  }

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
      pageCount,
      httpValidators: validators,
    },
    alerts,
  };
}

async function fetchAllProducts(site, previousState) {
  const base = site.url.replace(/\/$/, "");
  const extraParams = site.collectionParams ? `&${site.collectionParams}` : "";
  const all = [];
  let page = 1;
  let validators = null;

  // Conditional GET only when the whole catalog fit one page last check —
  // a 304 on page 1 then proves nothing changed anywhere. Multi-page
  // catalogs can change on later pages without touching page 1's ETag,
  // so those always fetch in full.
  const singlePage = previousState?.pageCount === 1 && previousState?.httpValidators;

  while (true) {
    if (page > 1) await sleep(300 + Math.floor(Math.random() * 500));
    const url = `${base}/products.json?limit=250&page=${page}${extraParams}`;
    const res = await https(url, {
      withResponse: true,
      headers: page === 1 && singlePage ? conditionalHeaders(previousState.httpValidators) : {},
    });
    if (res.status === 304) {
      return { products: [], notModified: true, validators: previousState.httpValidators, pageCount: 1 };
    }
    if (page === 1) validators = extractValidators(res.headers);
    const json = JSON.parse(res.body);
    const batch = json.products ?? [];
    all.push(...batch);
    if (batch.length < 250) break;
    page++;
  }

  return { products: all, notModified: false, validators, pageCount: page };
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

