// shopify_rest adapter — ported from sites/shopify_collection.js. Paginates
// [baseUrl][collectionPath]/products.json?limit=250&page=N until a short page,
// and normalizes Shopify products into NormalizedProduct. Availability and
// minPrice are intrinsic to the Shopify variant shape, so they're computed here
// (not per-site config).

import { httpGet, conditionalHeaders, extractValidators } from "@beacon/fetch";
import { sleep, type NormalizedProduct } from "@beacon/shared";
import type { SourceOf } from "../schema.js";
import type { FetchResult, PrevState, SourceAdapter } from "./types.js";

interface ShopifyVariant {
  price?: string | number | null;
  available?: boolean;
}
interface ShopifyProduct {
  handle: string;
  title: string;
  vendor?: string | null;
  product_type?: string | null;
  tags?: string[] | string | null;
  variants?: ShopifyVariant[];
  images?: Array<{ src?: string | null }>;
}

const PAGE_LIMIT = 250;

function getMinPrice(variants: ShopifyVariant[] | undefined): number | null {
  if (!variants?.length) return null;
  const prices = variants
    .map((v) => parseFloat(String(v.price)))
    .filter((n) => !Number.isNaN(n));
  return prices.length ? Math.min(...prices) : null;
}

function isAvailable(variants: ShopifyVariant[] | undefined): boolean {
  return variants?.some((v) => v.available) ?? false;
}

function normalizeTags(tags: ShopifyProduct["tags"]): string[] {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === "string") return tags.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}

function normalize(p: ShopifyProduct, origin: string): NormalizedProduct {
  return {
    handle: p.handle,
    title: p.title,
    vendor: p.vendor ?? null,
    productType: p.product_type ?? null,
    tags: normalizeTags(p.tags),
    minPrice: getMinPrice(p.variants),
    available: isAvailable(p.variants),
    image: p.images?.[0]?.src ?? null,
    url: `${origin}/products/${p.handle}`,
  };
}

export const shopifyRestAdapter: SourceAdapter = {
  kind: "shopify_rest",
  async fetch(site, prev: PrevState): Promise<FetchResult> {
    const src = site.source as SourceOf<"shopify_rest">;
    const base = src.baseUrl.replace(/\/$/, "");
    const collection = src.collectionPath ? `/${src.collectionPath.replace(/^\/|\/$/g, "")}` : "";
    const root = `${base}${collection}`;
    const origin = new URL(base).origin;
    const extraParams = src.extraParams ? `&${src.extraParams}` : "";

    // Conditional GET only when the whole catalog fit one page last check — a
    // 304 on page 1 then proves nothing changed anywhere. Multi-page catalogs
    // can change on later pages without touching page 1's ETag, so they always
    // fetch in full.
    const singlePage = src.conditionalGet && prev.pageCount === 1 && !!prev.httpValidators;

    const all: ShopifyProduct[] = [];
    let page = 1;
    let validators = null;

    for (;;) {
      if (page > 1) await sleep(300 + Math.floor(Math.random() * 500));
      const url = `${root}/products.json?limit=${PAGE_LIMIT}&page=${page}${extraParams}`;
      const res = await httpGet(url, {
        withResponse: true,
        headers: page === 1 && singlePage ? conditionalHeaders(prev.httpValidators) : {},
      });
      if (res.status === 304) {
        return { kind: "not_modified", validators: prev.httpValidators };
      }
      if (page === 1) validators = extractValidators(res.headers);
      const json = JSON.parse(res.body) as { products?: ShopifyProduct[] };
      const batch = json.products ?? [];
      all.push(...batch);
      if (batch.length < PAGE_LIMIT) break;
      page += 1;
    }

    return {
      kind: "products",
      products: all.map((p) => normalize(p, origin)),
      validators,
      pageCount: page,
    };
  },
};
