import { request } from "node:https";

const API_VERSION = "2024-01";

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
          reject(new Error(`HTTP ${res.statusCode}`));
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

  const alerts = diff(prevProducts, productMap, site);

  return {
    state: {
      lastChecked: new Date().toISOString(),
      productCount: Object.keys(productMap).length,
      products: productMap,
      pageReset: false,
    },
    alerts,
  };
}

function diff(previous, current, site) {
  const alerts = [];
  for (const [handle, product] of Object.entries(current)) {
    if (!previous[handle]) {
      if (site.alertOnNewProduct) alerts.push({ type: "new_product", product });
    } else if (!previous[handle].available && product.available) {
      if (site.alertOnRestock) alerts.push({ type: "restock", product });
    } else if (previous[handle].available && !product.available) {
      if (site.alertOnSoldOut) alerts.push({ type: "sold_out", product });
    }
  }
  return alerts;
}
