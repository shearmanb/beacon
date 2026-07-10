// shopify_graphql adapter — Shopify Storefront GraphQL API. Watches either a
// published collection OR a single product (Buy Button single-product embeds).
// The access token is resolved from the secrets layer via deps.resolveSecret
// (never inline in config — the legacy config.json committed it in plaintext).
//
// Self-heal (R2): with `discoverEmbedFrom` set, the adapter reads the live Buy
// Button embed (type + id) off the shop page's `ShopifyBuyInit` block on every
// check, so it follows the shop when it swaps collection<->product or changes id
// — instead of querying a dead id forever and nagging with site_reset.

import { httpGet, httpPost } from "@beacon/fetch";
import type { NormalizedProduct } from "@beacon/shared";
import type { SourceOf } from "../schema.js";
import type { AdapterDeps, FetchResult, PrevState, SourceAdapter } from "./types.js";

interface StorefrontNode {
  title: string;
  handle: string;
  availableForSale: boolean;
  priceRange?: { minVariantPrice?: { amount?: string } };
  featuredImage?: { url?: string };
}

type Embed = { type: "collection" | "product"; id: string };

const NODE_FIELDS =
  "title handle availableForSale priceRange { minVariantPrice { amount } } featuredImage { url }";

const EMPTY_NOTE =
  "Storefront API returned 0 products. The shop embed may have switched to a new " +
  "Shopify collection ID. Check View Source for the new id: value in ShopifyBuyInit.";

function endpointFor(src: SourceOf<"shopify_graphql">): string {
  return src.endpoint ?? `https://${src.domain}/api/${src.apiVersion}/graphql.json`;
}

function normalize(node: StorefrontNode, src: SourceOf<"shopify_graphql">): NormalizedProduct {
  const amount = node.priceRange?.minVariantPrice?.amount;
  return {
    handle: node.handle,
    title: node.title,
    vendor: src.defaults?.vendor ?? null,
    productType: src.defaults?.productType ?? null,
    tags: [],
    minPrice: amount ? parseFloat(amount) : null,
    available: !!node.availableForSale,
    image: node.featuredImage?.url ?? null,
    url: src.productUrl ?? `https://${src.domain}`,
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

    // Resolve which embed to watch. If discovery is on, read the current Buy
    // Button embed off the shop page; fall back to the last-known discovered
    // embed (persisted), then static config — so a page hiccup (wall up, timeout)
    // never loses the target or fails the check.
    const prevEmbed = prev["discoveredEmbed"] as Embed | undefined;
    let embed = configEmbed(src);
    if (src.discoverEmbedFrom) {
      try {
        const page = await httpGet(src.discoverEmbedFrom, { withResponse: true, signal: deps?.signal });
        embed = parseShopifyBuyEmbed(page.body) ?? prevEmbed ?? embed;
      } catch {
        embed = prevEmbed ?? embed;
      }
    }
    if (!embed) {
      throw new Error("shopify_graphql: no productId/collectionId configured and none discovered");
    }

    const query =
      embed.type === "product"
        ? `{ product(id: "gid://shopify/Product/${embed.id}") { ${NODE_FIELDS} } }`
        : `{ collection(id: "gid://shopify/Collection/${embed.id}") { products(first: 50) { nodes { ${NODE_FIELDS} } } } }`;

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
      ...(usingDiscovery ? { stateExtras: { discoveredEmbed: embed } } : {}),
      // With discovery (or a single-product watch) an empty is transient and
      // self-heals, so don't nag after one blank; a static collection keeps the
      // legacy fire-after-first behaviour (a swapped id is rarely transient).
      emptyGuardThreshold: usingDiscovery || embed.type === "product" ? 3 : 1,
      emptyGuardNote: usingDiscovery
        ? `Storefront API returned 0 products for the watched ${embed.type} ${embed.id}. Beacon re-reads the live Buy Button embed from ${src.discoverEmbedFrom} each check, so a swapped embed self-heals; a lasting 0 means the shop currently lists nothing.`
        : EMPTY_NOTE,
    };
  },
};
