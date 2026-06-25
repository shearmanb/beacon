// shopify_graphql adapter — ported from sites/shopify_storefront.js. Queries the
// Shopify Storefront GraphQL API for a published collection. The access token is
// resolved from the secrets layer via deps.resolveSecret (never inline in config
// — the legacy config.json committed the token in plaintext).

import { httpPost } from "@beacon/fetch";
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

export const shopifyGraphqlAdapter: SourceAdapter = {
  kind: "shopify_graphql",
  async fetch(site, _prev: PrevState, deps?: AdapterDeps): Promise<FetchResult> {
    const src = site.source as SourceOf<"shopify_graphql">;
    const token = deps?.resolveSecret?.(src.accessTokenRef);
    if (!token) {
      throw new Error(`Missing Storefront token for accessTokenRef "${src.accessTokenRef}"`);
    }

    const gid = `gid://shopify/Collection/${src.collectionId}`;
    const query = `{
      collection(id: "${gid}") {
        products(first: 50) {
          nodes {
            title
            handle
            availableForSale
            priceRange { minVariantPrice { amount } }
            featuredImage { url }
          }
        }
      }
    }`;

    const res = await httpPost(endpointFor(src), JSON.stringify({ query }), {
      headers: { "X-Shopify-Storefront-Access-Token": token },
      signal: deps?.signal,
    });
    const data = JSON.parse(res.body) as {
      data?: { collection?: { products?: { nodes?: StorefrontNode[] } } };
    };
    const nodes = data?.data?.collection?.products?.nodes;
    if (!Array.isArray(nodes)) {
      throw new Error(`Storefront API returned unexpected structure: ${res.body.slice(0, 200)}`);
    }

    return {
      kind: "products",
      products: nodes.map((n) => normalize(n, src)),
      // A swapped collection ID returns 0 — alert after the FIRST empty (the
      // legacy storefront used threshold 1), since this is rarely a transient.
      emptyGuardThreshold: 1,
      emptyGuardNote: EMPTY_NOTE,
    };
  },
};
