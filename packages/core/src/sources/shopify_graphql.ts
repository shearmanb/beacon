// shopify_graphql adapter — Shopify Storefront GraphQL API. Watches a published
// collection, a single product (Buy Button single-product embeds), or — with
// `scope: "channel"` — every product in the token's sales channel, newest first
// (drops that are embedded on some page but never reach products.json).
// The access token is resolved from the secrets layer via deps.resolveSecret
// (never inline in config — the legacy config.json committed it in plaintext).
//
// Self-heal (R2): with `discoverEmbedFrom` set, the adapter reads the live Buy
// Button embed (type + id) off the shop page's `ShopifyBuyInit` block, so it
// follows the shop when it swaps collection<->product or changes id — instead
// of querying a dead id forever and nagging with site_reset. The page is
// re-read at most every `discoverEveryMinutes` (every check while imminent):
// the Storefront call is the cheap, WAF-free part of a check, the page load is
// not, so the two are decoupled (2026-11-13).

import { httpGet, httpPost } from "@beacon/fetch";
import { htmlToText, type NormalizedProduct } from "@beacon/shared";
import type { SourceOf } from "../schema.js";
import type { AdapterDeps, FetchResult, PrevState, SourceAdapter } from "./types.js";

interface StorefrontNode {
  title: string;
  handle: string;
  vendor?: string | null;
  productType?: string | null;
  availableForSale: boolean;
  priceRange?: { minVariantPrice?: { amount?: string } };
  featuredImage?: { url?: string };
  descriptionHtml?: string | null;
  onlineStoreUrl?: string | null;
}

type Embed = { type: "collection" | "product"; id: string };

// descriptionHtml (not the flat `description`) keeps the line breaks between
// tasting-note sections; these watches are ≤50 products so the size is fine.
// onlineStoreUrl is the product's own page on the store's primary domain (null
// when the product isn't published to the Online Store channel).
const NODE_FIELDS =
  "title handle vendor productType availableForSale priceRange { minVariantPrice { amount } } featuredImage { url } descriptionHtml onlineStoreUrl";

// Channel scope pages through the root product list 250 at a time (the
// Storefront API's max page size), newest first, so a fresh drop is always on
// page 1 and the per-check cost stays one request for a normal-sized channel.
const CHANNEL_PAGE_SIZE = 250;
const DEFAULT_CHANNEL_MAX = 250;
// A collection embed is read newest-first in one request, so a big collection
// (t8ke.com's purchase page lists years of barrels) always has a fresh drop on
// the page; anything past the cap falls off harmlessly (diff alerts on presence).
const COLLECTION_PAGE_SIZE = 250;
const DEFAULT_DISCOVER_EVERY_MIN = 10;

const EMPTY_NOTE =
  "Storefront API returned 0 products. The shop embed may have switched to a new " +
  "Shopify collection ID. Check View Source for the new id: value in ShopifyBuyInit.";

function endpointFor(src: SourceOf<"shopify_graphql">): string {
  return src.endpoint ?? `https://${src.domain}/api/${src.apiVersion}/graphql.json`;
}

function normalize(node: StorefrontNode, src: SourceOf<"shopify_graphql">): NormalizedProduct {
  const amount = node.priceRange?.minVariantPrice?.amount;
  const url = src.productUrl ?? `https://${src.domain}`;
  return {
    handle: node.handle,
    title: node.title,
    // Configured defaults win (an embed watch is one brand); otherwise use the
    // product's own vendor/type — a channel roster mixes brands.
    vendor: src.defaults?.vendor ?? node.vendor ?? null,
    productType: src.defaults?.productType ?? node.productType ?? null,
    tags: [],
    minPrice: amount ? parseFloat(amount) : null,
    available: !!node.availableForSale,
    image: node.featuredImage?.url ?? null,
    url,
    details: htmlToText(node.descriptionHtml),
    pageUrl: node.onlineStoreUrl && node.onlineStoreUrl !== url ? node.onlineStoreUrl : null,
  };
}

/**
 * Read the live Shopify Buy Button embed (type + numeric id) from a shop page's
 * inline `ShopifyBuyInit` block, e.g. `ui.createComponent('product', { id: '900…' })`.
 * Returns the FIRST product/collection component found (the main embed) — cart /
 * toggle components carry no product id and are skipped by the type alternation.
 */
export function parseShopifyBuyEmbed(html: string): Embed | null {
  const m = html.match(
    /createComponent\(\s*['"](product|collection)['"]\s*,\s*\{[\s\S]{0,200}?\bid:\s*['"](\d+)['"]/i,
  );
  if (!m) return null;
  return { type: m[1]!.toLowerCase() as "collection" | "product", id: m[2]! };
}

type Post = (query: string, variables?: Record<string, unknown>) => Promise<string>;

/**
 * Channel scope: every product published to the token's sales channel, newest
 * first, up to `maxProducts`. A product that falls off the end of the cap is
 * harmless — diff() only alerts on what is present, never on absence.
 */
async function fetchChannel(src: SourceOf<"shopify_graphql">, post: Post): Promise<StorefrontNode[]> {
  const max = src.maxProducts ?? DEFAULT_CHANNEL_MAX;
  const out: StorefrontNode[] = [];
  let cursor: string | null = null;
  while (out.length < max) {
    const first = Math.min(CHANNEL_PAGE_SIZE, max - out.length);
    const query =
      `query($cursor: String) { products(first: ${first}, after: $cursor, sortKey: CREATED_AT, reverse: true) ` +
      `{ pageInfo { hasNextPage endCursor } nodes { ${NODE_FIELDS} } } }`;
    const body = await post(query, { cursor });
    const data = JSON.parse(body) as {
      data?: { products?: { nodes?: StorefrontNode[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };
    };
    const page = data?.data?.products;
    if (!page || !Array.isArray(page.nodes)) {
      throw new Error(`Storefront API returned unexpected structure: ${body.slice(0, 200)}`);
    }
    out.push(...page.nodes);
    if (!page.pageInfo?.hasNextPage || !page.pageInfo.endCursor) break;
    cursor = page.pageInfo.endCursor;
  }
  return out;
}

function configEmbed(src: SourceOf<"shopify_graphql">): Embed | null {
  if (src.productId) return { type: "product", id: src.productId };
  if (src.collectionId) return { type: "collection", id: src.collectionId };
  return null;
}

export const shopifyGraphqlAdapter: SourceAdapter = {
  kind: "shopify_graphql",
  async fetch(site, prev: PrevState, deps?: AdapterDeps): Promise<FetchResult> {
    const src = site.source as SourceOf<"shopify_graphql">;
    const token = deps?.resolveSecret?.(src.accessTokenRef);
    if (!token) {
      throw new Error(`Missing Storefront token for accessTokenRef "${src.accessTokenRef}"`);
    }

    if (src.scope === "channel") {
      const post: Post = async (query, variables) =>
        (
          await httpPost(endpointFor(src), JSON.stringify({ query, variables }), {
            headers: { "X-Shopify-Storefront-Access-Token": token },
            signal: deps?.signal,
          })
        ).body;
      const nodes = await fetchChannel(src, post);
      return {
        kind: "products",
        products: nodes.map((n) => normalize(n, src)),
        // A whole sales channel going empty is never a normal state, but one
        // blank answer can be a hiccup — page after 3 in a row.
        emptyGuardThreshold: 3,
        emptyGuardNote:
          `Storefront API returned 0 products for the whole ${src.domain} sales channel. ` +
          "The access token may have been revoked or the channel unpublished — check the token in Shopify (Apps → Buy Button / Headless).",
      };
    }

    // Resolve which embed to watch. If discovery is on, read the current Buy
    // Button embed off the shop page; fall back to the last-known discovered
    // embed (persisted), then static config — so a page hiccup (wall up, timeout)
    // never loses the target or fails the check.
    const prevEmbed = prev["discoveredEmbed"] as Embed | undefined;
    let embed = configEmbed(src);
    const lastDiscovery = typeof prev["embedDiscoveredAt"] === "string" ? Date.parse(prev["embedDiscoveredAt"]) : NaN;
    const discoveryFresh =
      !!prevEmbed && !site.imminent && Date.now() - lastDiscovery < (src.discoverEveryMinutes ?? DEFAULT_DISCOVER_EVERY_MIN) * 60_000;
    let embedDiscoveredAt = discoveryFresh ? (prev["embedDiscoveredAt"] as string) : new Date().toISOString();
    if (discoveryFresh) {
      embed = prevEmbed;
    } else if (src.discoverEmbedFrom) {
      try {
        const page = await httpGet(src.discoverEmbedFrom, { withResponse: true, signal: deps?.signal });
        embed = parseShopifyBuyEmbed(page.body) ?? prevEmbed ?? embed;
      } catch {
        embed = prevEmbed ?? embed;
        // A failed page read is not a discovery: retry on the next check.
        embedDiscoveredAt = (prev["embedDiscoveredAt"] as string | undefined) ?? "";
      }
    }
    if (!embed) {
      throw new Error("shopify_graphql: no productId/collectionId configured and none discovered");
    }

    const query =
      embed.type === "product"
        ? `{ product(id: "gid://shopify/Product/${embed.id}") { ${NODE_FIELDS} } }`
        : `{ collection(id: "gid://shopify/Collection/${embed.id}") { products(first: ${COLLECTION_PAGE_SIZE}, sortKey: CREATED, reverse: true) { nodes { ${NODE_FIELDS} } } } }`;

    const res = await httpPost(endpointFor(src), JSON.stringify({ query }), {
      headers: { "X-Shopify-Storefront-Access-Token": token },
      signal: deps?.signal,
    });
    const data = JSON.parse(res.body) as {
      data?: {
        collection?: { products?: { nodes?: StorefrontNode[] } } | null;
        product?: StorefrontNode | null;
      };
    };

    let nodes: StorefrontNode[];
    if (embed.type === "product") {
      // A missing `data` object is a real API error (auth/malformed) — throw so the
      // worker's error path handles it. A null `product` (deleted/unpublished id)
      // is just empty and self-heals via discovery next check.
      if (!data || typeof data.data !== "object" || data.data === null) {
        throw new Error(`Storefront API returned unexpected structure: ${res.body.slice(0, 200)}`);
      }
      nodes = data.data.product ? [data.data.product] : [];
    } else {
      const cn = data?.data?.collection?.products?.nodes;
      if (!Array.isArray(cn)) {
        throw new Error(`Storefront API returned unexpected structure: ${res.body.slice(0, 200)}`);
      }
      nodes = cn;
    }

    const usingDiscovery = !!src.discoverEmbedFrom;
    return {
      kind: "products",
      products: nodes.map((n) => normalize(n, src)),
      // Persist the resolved embed so a later page hiccup can fall back to it.
      ...(usingDiscovery ? { stateExtras: { discoveredEmbed: embed, embedDiscoveredAt: embedDiscoveredAt || null } } : {}),
      // With discovery (or a single-product watch) an empty is transient and
      // self-heals, so don't nag after one blank; a static collection keeps the
      // legacy fire-after-first behaviour (a swapped id is rarely transient).
      emptyGuardThreshold: usingDiscovery || embed.type === "product" ? 3 : 1,
      emptyGuardNote: usingDiscovery
        ? `Storefront API returned 0 products for the watched ${embed.type} ${embed.id}. Beacon re-reads the live Buy Button embed from ${src.discoverEmbedFrom} every ${src.discoverEveryMinutes ?? DEFAULT_DISCOVER_EVERY_MIN} min, so a swapped embed self-heals; a lasting 0 means the shop currently lists nothing.`
        : EMPTY_NOTE,
    };
  },
};
