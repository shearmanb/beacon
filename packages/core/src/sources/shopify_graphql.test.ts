import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { parseShopifyBuyEmbed, shopifyGraphqlAdapter } from "./shopify_graphql.js";
import { siteDefinitionSchema, type SiteDefinition } from "../schema.js";
import type { AdapterDeps } from "./types.js";

let respond: (body: string) => void;
let lastRequest: { headers: IncomingMessage["headers"]; body: string } | undefined;
let server: Server;
let endpoint: string;
let pageUrl: string;
// HTML the GET "shop page" serves (for discoverEmbedFrom tests).
let pageHtml = "";

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // GET = the shop page (discoverEmbedFrom); POST = the GraphQL endpoint.
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(pageHtml);
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      lastRequest = { headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      respond = (body: string) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      };
      handler(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  endpoint = `http://127.0.0.1:${port}/graphql`;
  pageUrl = `http://127.0.0.1:${port}/shop`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let handler: (res: ServerResponse) => void;

function makeSite(sourceOverrides: Record<string, unknown> = {}): SiteDefinition {
  return siteDefinitionSchema.parse({
    id: "reveries_official",
    name: "The Reveries Official Shop",
    source: {
      kind: "shopify_graphql",
      domain: "shared-pour.myshopify.com",
      accessTokenRef: "reveries_storefront_token",
      collectionId: "367215214747",
      endpoint,
      productUrl: "https://www.thereveries.co/shop",
      defaults: { vendor: "The Reveries", productType: "Whiskey" },
      ...sourceOverrides,
    },
  });
}

const deps: AdapterDeps = { resolveSecret: (ref) => (ref === "reveries_storefront_token" ? "tok-123" : undefined) };

function collectionResponse(nodes: unknown[]): string {
  return JSON.stringify({ data: { collection: { products: { nodes } } } });
}
function productResponse(node: unknown): string {
  return JSON.stringify({ data: { product: node } });
}

const NODE = {
  title: "Reveries Batch 12",
  handle: "reveries-batch-12",
  availableForSale: true,
  priceRange: { minVariantPrice: { amount: "129.99" } },
  featuredImage: { url: "https://img/r12.jpg" },
};

// A realistic ShopifyBuyInit block (matches thereveries.co/shop's embed).
const buyInitHtml = (type: "product" | "collection", id: string) => `
<div id='product-component-1782407812527'></div>
<script type="text/javascript">
(function () {
  function ShopifyBuyInit() {
    var client = ShopifyBuy.buildClient({
      domain: 'shared-pour.myshopify.com',
      storefrontAccessToken: '9238d5183f01462f5ba642447811ebb8',
    });
    ShopifyBuy.UI.onReady(client).then(function (ui) {
      ui.createComponent('${type}', {
        id: '${id}',
        node: document.getElementById('product-component-1782407812527'),
      });
    });
  }
})();
</script>`;

describe("parseShopifyBuyEmbed", () => {
  it("extracts a single-product embed id", () => {
    expect(parseShopifyBuyEmbed(buyInitHtml("product", "9001382805659"))).toEqual({
      type: "product",
      id: "9001382805659",
    });
  });
  it("extracts a collection embed id", () => {
    expect(parseShopifyBuyEmbed(buyInitHtml("collection", "367215214747"))).toEqual({
      type: "collection",
      id: "367215214747",
    });
  });
  it("returns null when there is no product/collection component", () => {
    expect(parseShopifyBuyEmbed("<div>coming soon — enter password</div>")).toBeNull();
    // a cart/toggle component (no product id) must not match
    expect(parseShopifyBuyEmbed("ui.createComponent('cart', { node: x });")).toBeNull();
  });
});

describe("shopifyGraphqlAdapter", () => {
  it("normalizes collection nodes and sends the token header", async () => {
    handler = () =>
      respond(
        collectionResponse([
          {
            title: "Reveries Batch 1",
            handle: "reveries-batch-1",
            availableForSale: true,
            priceRange: { minVariantPrice: { amount: "129.99" } },
            featuredImage: { url: "https://img/r1.jpg" },
          },
          { title: "Reveries Batch 0", handle: "reveries-batch-0", availableForSale: false },
        ]),
      );

    const result = await shopifyGraphqlAdapter.fetch(makeSite(), {}, deps);
    expect(result.kind).toBe("products");
    if (result.kind !== "products") return;
    expect(lastRequest?.headers["x-shopify-storefront-access-token"]).toBe("tok-123");
    expect(lastRequest?.body).toContain("collection(id:");

    const r1 = result.products.find((p) => p.handle === "reveries-batch-1")!;
    expect(r1.available).toBe(true);
    expect(r1.minPrice).toBe(129.99);
    expect(r1.vendor).toBe("The Reveries");
    expect(r1.url).toBe("https://www.thereveries.co/shop");
    expect(result.products.find((p) => p.handle === "reveries-batch-0")!.available).toBe(false);
  });

  it("uses empty-guard threshold 1 for a static collection that returns nothing", async () => {
    handler = () => respond(collectionResponse([]));
    const result = await shopifyGraphqlAdapter.fetch(makeSite(), {}, deps);
    if (result.kind !== "products") throw new Error("expected products");
    expect(result.products).toHaveLength(0);
    expect(result.emptyGuardThreshold).toBe(1);
  });

  it("watches a single product by id when productId is set", async () => {
    handler = () => respond(productResponse(NODE));
    const result = await shopifyGraphqlAdapter.fetch(
      makeSite({ collectionId: undefined, productId: "9001382805659" }),
      {},
      deps,
    );
    if (result.kind !== "products") throw new Error("expected products");
    expect(lastRequest?.body).toContain('product(id: \\"gid://shopify/Product/9001382805659\\"');
    expect(result.products).toHaveLength(1);
    expect(result.products[0]!.handle).toBe("reveries-batch-12");
    expect(result.products[0]!.available).toBe(true);
    // single-product / discovery empties are transient → don't nag after one blank
    expect(result.emptyGuardThreshold).toBe(3);
  });

  it("treats a null product (deleted id) as empty, not an error", async () => {
    handler = () => respond(productResponse(null));
    const result = await shopifyGraphqlAdapter.fetch(makeSite({ productId: "1" }), {}, deps);
    if (result.kind !== "products") throw new Error("expected products");
    expect(result.products).toHaveLength(0);
  });

  it("self-heals: discovers the live embed off the shop page and follows it", async () => {
    pageHtml = buyInitHtml("product", "9001382805659");
    handler = () => respond(productResponse(NODE));
    const result = await shopifyGraphqlAdapter.fetch(
      makeSite({ discoverEmbedFrom: pageUrl }),
      {},
      deps,
    );
    if (result.kind !== "products") throw new Error("expected products");
    // discovery found a PRODUCT embed even though config still has a collectionId
    expect(lastRequest?.body).toContain('product(id: \\"gid://shopify/Product/9001382805659\\"');
    expect(result.products).toHaveLength(1);
    expect(result.stateExtras).toEqual({ discoveredEmbed: { type: "product", id: "9001382805659" } });
  });

  it("falls back to the last-known discovered embed when the page has no embed", async () => {
    pageHtml = "<html><body>Come back later — password protected</body></html>";
    handler = () => respond(productResponse(NODE));
    const result = await shopifyGraphqlAdapter.fetch(
      makeSite({ discoverEmbedFrom: pageUrl }),
      { discoveredEmbed: { type: "product", id: "555" } },
      deps,
    );
    if (result.kind !== "products") throw new Error("expected products");
    expect(lastRequest?.body).toContain('product(id: \\"gid://shopify/Product/555\\"');
  });

  it("throws when the access token cannot be resolved", async () => {
    handler = () => respond(collectionResponse([]));
    await expect(
      shopifyGraphqlAdapter.fetch(makeSite(), {}, { resolveSecret: () => undefined }),
    ).rejects.toThrow(/Missing Storefront token/);
  });

  it("throws on an unexpected response shape", async () => {
    handler = () => respond(JSON.stringify({ errors: [{ message: "bad" }] }));
    await expect(shopifyGraphqlAdapter.fetch(makeSite(), {}, deps)).rejects.toThrow(/unexpected structure/);
  });
});
