import { request } from "node:https";
import { diff } from "../lib/diff.js";
import { emptyFetchGuard } from "../lib/empty_guard.js";

const API_VERSION = "2025-01";

function storefrontPost(domain, token, query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const req = request(
      {
        hostname: domain,
        path: `/api/${API_VERSION}/graphql.json`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          "X-Shopify-Storefront-Access-Token": token,
          Accept: "application/json",
        },
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          const err = new Error(`HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode; // worker uses this for 429/403 cooldowns
          reject(err);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.setTimeout(15000, () => req.destroy(new Error("Timeout")));
    req.write(body);
    req.end();
  });
}

export async function checkSite(site, previousState) {
  const prevProducts = previousState?.products ?? {};
  const { storefrontDomain, storefrontAccessToken, storefrontCollectionId } = site;

  const gid = `gid://shopify/Collection/${storefrontCollectionId}`;
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

  const data = await storefrontPost(storefrontDomain, storefrontAccessToken, query);
  const nodes = data?.data?.collection?.products?.nodes;

  if (!Array.isArray(nodes)) {
    throw new Error(`Storefront API returned unexpected structure: ${JSON.stringify(data).slice(0, 200)}`);
  }

  const productMap = {};
  for (const node of nodes) {
    productMap[node.handle] = {
      handle: node.handle,
      title: node.title,
      vendor: "The Reveries",
      productType: "Whiskey",
      tags: [],
      minPrice: node.priceRange?.minVariantPrice?.amount
        ? parseFloat(node.priceRange.minVariantPrice.amount)
        : null,
      available: node.availableForSale,
      image: node.featuredImage?.url ?? null,
      url: site.url,
    };
  }

  console.log(`[${site.name}] Storefront API: ${nodes.length} product(s)`);
  for (const p of Object.values(productMap)) {
    console.log(`  ${p.title}: ${p.available ? "AVAILABLE" : "SOLD OUT"}`);
  }

  // If the collection comes back empty but we had products before, the embed
  // was likely updated with a new collection ID. Fire a one-time Discord alert.
  if (nodes.length === 0) {
    const guarded = emptyFetchGuard({
      site,
      previousState,
      prevProducts,
      threshold: 1,
      note: `Storefront API returned 0 products. The shop embed may have switched to a new Shopify collection ID.\n_Check View Source on ${site.url} for the new id: value in ShopifyBuyInit._`,
    });
    if (guarded) return guarded;
  }

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

