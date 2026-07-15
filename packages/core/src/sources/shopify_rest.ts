// shopify_rest adapter — ported from sites/shopify_collection.js. Paginates
// [baseUrl][collectionPath]/products.json?limit=250&page=N until a short page,
// and normalizes Shopify products into NormalizedProduct. Availability and
// minPrice are intrinsic to the Shopify variant shape, so they're computed here
// (not per-site config).

import { httpGet, httpPost, conditionalHeaders, extractValidators } from "@beacon/fetch";
import { sleep, type NormalizedProduct } from "@beacon/shared";
import type { SourceOf } from "../schema.js";
import type { AdapterDeps, FetchResult, PrevState, SourceAdapter } from "./types.js";

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

export const PAGE_LIMIT = 250; // exported so diagnose probes with the worker's real page size
// Hard cap on pagination (2c): a misconfigured or pathologically large catalog
// must not paginate "forever" and starve the loop. 20 pages = 5,000 products,
// well past any store we track. Hitting it is logged so it's visible.
const MAX_PAGES = 20;
// Statuses that mean "the endpoint is blocking us" (bot protection / rate limit)
// rather than "the endpoint is broken" — these trigger the Storefront fallback.
// 430 is Shopify's own bot-block status; 401/403 are WAF/challenge walls.
const BLOCKED_STATUSES = new Set([401, 403, 429, 430]);
// Storefront-fallback pagination cap: 8 × 250 = 2,000 products, same spirit as
// MAX_PAGES but tighter — the fallback is a secondary channel. Raised 4→8
// (2026-07): a root-catalog scan truncated at 1,000 returned a DIFFERENT roster
// than REST, so every channel flip made the missing products "reappear" and
// re-alert as new. GraphQL pages hit Shopify's own API domain (not the
// tar-pitting WAF), so the extra requests are cheap and safe.
const FALLBACK_MAX_PAGES = 8;
// Channel preference (feedback loop): after this many consecutive checks that
// had to use the fallback, stop LEADING with blocked REST — every lead-off REST
// attempt wastes the stall budget AND keeps hammering a host that already
// flagged us. Once preferred, REST is re-probed for recovery twice a day.
const PREFER_FALLBACK_AFTER = 3;
const REST_REPROBE_MS = 12 * 3_600_000;

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

/** Merge channel-preference telemetry into a products result. */
function withExtras(result: FetchResult, extras: Record<string, unknown>): FetchResult {
  return result.kind === "products" ? { ...result, stateExtras: { ...result.stateExtras, ...extras } } : result;
}

// httpGet's own per-request timers can give up on a silent tar-pit BEFORE the
// adapter's whole-fetch stall guard does — socket-idle (15s) / wall-clock
// deadline (30s) vs restStallMs (20s default). Those surface as status-less
// errors, which the failover logic must recognize as a stall too, or a silent
// tar-pit would never reach the Storefront fallback.
const NETWORK_STALL_RE = /socket idle timeout|deadline exceeded/i;

/**
 * Should a REST failure fail over to the Storefront channel as a *stall* (a
 * status-less block — the host accepted the connection but never answered)?
 * True when our whole-fetch stall guard tripped OR httpGet's own socket-idle /
 * deadline tripped first. False when the per-site budget aborted (no time left
 * for a fallback) or the error carried a real HTTP status (handled separately).
 */
export function isRestStall(err: unknown, opts: { stallFired: boolean; parentAborted: boolean }): boolean {
  if (opts.parentAborted) return false;
  if (opts.stallFired) return true;
  const status = (err as { statusCode?: number }).statusCode;
  if (status != null) return false;
  const message = err instanceof Error ? err.message : String(err);
  return NETWORK_STALL_RE.test(message);
}

export const shopifyRestAdapter: SourceAdapter = {
  kind: "shopify_rest",
  async fetch(site, prev: PrevState, deps?: AdapterDeps): Promise<FetchResult> {
    const src = site.source as SourceOf<"shopify_rest">;
    const origin = new URL(src.baseUrl).origin;
    const fb = src.storefrontFallback;
    const token = fb ? deps?.resolveSecret?.(fb.accessTokenRef) : null;

    // Channel preference (feedback loop): after PREFER_FALLBACK_AFTER
    // consecutive fallback checks, lead with the Storefront API instead of
    // wasting the stall budget re-poking blocked REST every check. REST is
    // re-probed for recovery every REST_REPROBE_MS, so flipping back is
    // automatic (and fires the self_healed recovery ping).
    const fallbackStreak = (prev["fallbackStreak"] as number | undefined) ?? 0;
    const preferFallback = prev["preferFallback"] === true && !!fb && !!token;
    const lastProbe = typeof prev["lastRestProbeAt"] === "string" ? Date.parse(prev["lastRestProbeAt"]) : 0;
    const restProbeDue = Date.now() - lastProbe >= REST_REPROBE_MS;

    let storefrontAlreadyFailed = false;
    if (preferFallback && !restProbeDue) {
      const reason =
        (prev["fetchViaReason"] as string | undefined) ??
        "REST paused after repeated blocks — Storefront API is the preferred channel (REST re-probed twice a day)";
      try {
        const result = await fetchViaStorefront(src, fb!, token!, origin, reason, deps);
        return withExtras(result, {
          preferFallback: true,
          fallbackStreak: fallbackStreak + 1,
          lastRestProbeAt: (prev["lastRestProbeAt"] as string | undefined) ?? null,
        });
      } catch (fbErr) {
        // Preferred channel broke — fall through to a full REST attempt below
        // (it may have recovered), rather than failing the check outright.
        storefrontAlreadyFailed = true;
        console.warn(`[${site.name}] Preferred Storefront channel failed (${(fbErr as Error).message}) — retrying REST.`);
      }
    }

    // Stall guard (armed only when a fallback is available): a tar-pitting host
    // never answers with a status — it leaves the connection hanging until the
    // worker's whole per-site budget dies ("Aborted fetching …"). Cap the REST
    // phase so there's budget left to actually run the fallback.
    let stallFired = false;
    const restController = fb && token ? new AbortController() : null;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let onParentAbort: (() => void) | null = null;
    if (restController) {
      stallTimer = setTimeout(() => {
        stallFired = true;
        restController.abort();
      }, fb!.restStallMs);
      if (deps?.signal) {
        if (deps.signal.aborted) restController.abort();
        else {
          onParentAbort = () => restController.abort();
          deps.signal.addEventListener("abort", onParentAbort, { once: true });
        }
      }
    }

    try {
      const restDeps = restController ? { ...deps, signal: restController.signal } : deps;
      const result = await fetchRest(src, prev, origin, restDeps);
      // REST answered — primary is (back to) healthy; clear the preference.
      return withExtras(result, { preferFallback: false, fallbackStreak: 0, lastRestProbeAt: new Date().toISOString() });
    } catch (err) {
      // Self-healing failover: a blocked REST endpoint retries via the token-
      // authenticated Storefront GraphQL API on the canonical myshopify.com
      // domain. "Blocked" is either an explicit status (403/429/430/401) or a
      // stall — no response inside restStallMs while the overall budget is
      // still alive (tar-pit bot mitigation). If the fallback also fails, the
      // ORIGINAL error is rethrown so the circuit breaker sees the real cause.
      const status = (err as { statusCode?: number }).statusCode;
      const blocked = status != null && BLOCKED_STATUSES.has(status);
      // Recognize a stall whether OUR guard fired or httpGet's own socket-idle/
      // deadline tripped first (a silent tar-pit) — otherwise the fallback never
      // engages on a host that just hangs the connection.
      const stalled = isRestStall(err, { stallFired, parentAborted: deps?.signal?.aborted === true });
      if (fb && token && !storefrontAlreadyFailed && (blocked || stalled)) {
        const reason = blocked
          ? `products.json blocked with HTTP ${status}`
          : `products.json stalled — the host accepted the connection but never answered (tar-pit, a bot-mitigation tactic)`;
        console.warn(`[${site.name}] ${reason} — failing over to Storefront API on ${fb.domain}.`);
        try {
          const result = await fetchViaStorefront(src, fb, token, origin, reason, deps);
          const streak = fallbackStreak + 1;
          return withExtras(result, {
            preferFallback: streak >= PREFER_FALLBACK_AFTER,
            fallbackStreak: streak,
            lastRestProbeAt: new Date().toISOString(),
          });
        } catch (fbErr) {
          console.warn(`[${site.name}] Storefront fallback also failed: ${(fbErr as Error).message}`);
        }
      }
      throw err;
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      if (onParentAbort && deps?.signal) deps.signal.removeEventListener("abort", onParentAbort);
    }
  },
};

async function fetchRest(
  src: SourceOf<"shopify_rest">,
  prev: PrevState,
  origin: string,
  deps?: AdapterDeps,
): Promise<FetchResult> {
  const base = src.baseUrl.replace(/\/$/, "");
  const collection = src.collectionPath ? `/${src.collectionPath.replace(/^\/|\/$/g, "")}` : "";
  const root = `${base}${collection}`;
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
      kind: "api", // products.json is a JSON/XHR call, not a page navigation (2g)
      signal: deps?.signal,
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
    if (page >= MAX_PAGES) {
      console.warn(`[${root}] Hit MAX_PAGES (${MAX_PAGES}) — stopping pagination at ${all.length} products.`);
      break;
    }
    page += 1;
  }

  return {
    kind: "products",
    products: all.map((p) => normalize(p, origin)),
    validators,
    pageCount: page,
    emptyGuardThreshold: 3,
    emptyGuardNote:
      "products.json returned 0 products on consecutive checks. Previous products " +
      "are preserved. If the store is between waves this is expected — otherwise the " +
      "collection URL may have changed.",
  };
}

// ── Storefront GraphQL fallback ──────────────────────────────────────────────
// The same roster via Shopify's token-authenticated Storefront API: a collection
// source queries collection(handle:); a store-root source queries products().
// The nodes carry vendor/productType/tags so the pipeline's filters keep working
// unchanged, and product URLs still point at the primary (custom) domain.

interface StorefrontNode {
  title: string;
  handle: string;
  vendor?: string | null;
  productType?: string | null;
  tags?: string[] | null;
  availableForSale: boolean;
  priceRange?: { minVariantPrice?: { amount?: string } };
  featuredImage?: { url?: string };
}
interface StorefrontPage {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
  nodes?: StorefrontNode[];
}

const NODE_FIELDS = `title handle vendor productType tags availableForSale
  priceRange { minVariantPrice { amount } } featuredImage { url }`;

function normalizeStorefront(n: StorefrontNode, origin: string): NormalizedProduct {
  const amount = n.priceRange?.minVariantPrice?.amount;
  return {
    handle: n.handle,
    title: n.title,
    vendor: n.vendor ?? null,
    productType: n.productType ?? null,
    tags: Array.isArray(n.tags) ? n.tags : [],
    minPrice: amount ? parseFloat(amount) : null,
    available: !!n.availableForSale,
    image: n.featuredImage?.url ?? null,
    url: `${origin}/products/${n.handle}`,
  };
}

async function fetchViaStorefront(
  src: SourceOf<"shopify_rest">,
  fb: NonNullable<SourceOf<"shopify_rest">["storefrontFallback"]>,
  token: string,
  origin: string,
  reason: string,
  deps?: AdapterDeps,
): Promise<FetchResult> {
  const endpoint = fb.endpoint ?? `https://${fb.domain}/api/${fb.apiVersion}/graphql.json`;
  const handleMatch = src.collectionPath?.match(/collections\/([^/?]+)/);
  const collectionHandle = handleMatch?.[1];

  const all: StorefrontNode[] = [];
  let truncated = false;
  let cursor: string | null = null;
  for (let page = 1; page <= FALLBACK_MAX_PAGES; page += 1) {
    if (page > 1) await sleep(300 + Math.floor(Math.random() * 500));
    const inner = `products(first: ${PAGE_LIMIT}, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ${NODE_FIELDS} }
    }`;
    const query = collectionHandle
      ? `query($cursor: String) { collection(handle: "${collectionHandle}") { ${inner} } }`
      : `query($cursor: String) { ${inner} }`;
    const res = await httpPost(endpoint, JSON.stringify({ query, variables: { cursor } }), {
      headers: { "X-Shopify-Storefront-Access-Token": token },
      signal: deps?.signal,
    });
    const json = JSON.parse(res.body) as {
      data?: { products?: StorefrontPage; collection?: { products?: StorefrontPage } | null };
    };
    const pageData = collectionHandle ? json.data?.collection?.products : json.data?.products;
    if (!Array.isArray(pageData?.nodes)) {
      throw new Error(`Storefront fallback returned unexpected structure: ${res.body.slice(0, 200)}`);
    }
    all.push(...pageData.nodes);
    if (!pageData.pageInfo?.hasNextPage || !pageData.pageInfo.endCursor) break;
    if (page === FALLBACK_MAX_PAGES) {
      // More pages exist but we've hit the fallback's tighter cap. A store-root
      // source (no collectionPath) that title-filters a big catalog can silently
      // MISS products past this point — surface it so the fix (scope to a
      // collection) is visible instead of a quiet blind spot: a console warning
      // for the logs AND a `fallbackTruncated` state flag the dashboard tile
      // renders as a ⚠ hint (a fresh REST check rebuilds state without the key,
      // so recovery clears it automatically).
      truncated = true;
      console.warn(
        `[storefront fallback] Reached the ${FALLBACK_MAX_PAGES}-page cap (${all.length} products) with more pages still available — ` +
          `a large catalog may be TRUNCATED here. Scope this source to a specific collectionPath so a check isn't a full-catalog scan.`,
      );
      break;
    }
    cursor = pageData.pageInfo.endCursor;
  }

  return {
    kind: "products",
    products: all.map((n) => normalizeStorefront(n, origin)),
    validators: null, // ETags are per-endpoint; force a fresh REST attempt next check
    via: "storefront_fallback",
    viaReason: reason,
    ...(truncated ? { stateExtras: { fallbackTruncated: true } } : {}),
    emptyGuardThreshold: 3,
    emptyGuardNote:
      "Storefront-API fallback returned 0 products on consecutive checks. Previous " +
      "products are preserved. If the store is between waves this is expected — " +
      "otherwise the collection handle may not exist on the Storefront channel.",
  };
}
