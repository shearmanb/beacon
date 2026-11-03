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
            descriptionHtml: "<p>Barrel #5160</p><p>Nose: caramel</p>",
            onlineStoreUrl: "https://sharedpour.com/products/reveries-batch-1",
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
    expect(r1.pageUrl).toBe("https://sharedpour.com/products/reveries-batch-1");
    expect(r1.details).toBe("Barrel #5160\nNose: caramel");
    const r0 = result.products.find((p) => p.handle === "reveries-batch-0")!;
    expect(r0.available).toBe(false);
    expect(r0.pageUrl).toBeNull();
    expect(r0.details).toBeNull();
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

describe("shopifyGraphqlAdapter — channel scope (every product in the sales channel)", () => {
  const node = (i: number, extra: Record<string, unknown> = {}) => ({
    title: `T8KE x Bottle ${i}`,
    handle: `bottle-${i}`,
    vendor: i % 2 ? "Penelope" : "The Reveries",
    productType: "Bourbon",
    availableForSale: true,
    priceRange: { minVariantPrice: { amount: "99.99" } },
    ...extra,
  });
  const page = (nodes: unknown[], hasNextPage: boolean, endCursor: string | null = null) =>
    JSON.stringify({ data: { products: { pageInfo: { hasNextPage, endCursor }, nodes } } });
  const channelSite = (extra: Record<string, unknown> = {}) =>
    makeSite({ scope: "channel", collectionId: undefined, defaults: undefined, productUrl: "https://t8ke.com/private-selections/purchase-t8ke-releases/", ...extra });

  it("queries the root product list newest-first with the token, and keeps each product's own vendor", async () => {
    handler = () => respond(page([node(1), node(2)], false));
    const result = await shopifyGraphqlAdapter.fetch(channelSite(), {}, deps);
    if (result.kind !== "products") throw new Error("expected products");
    const sent = JSON.parse(lastRequest!.body) as { query: string; variables: { cursor: string | null } };
    expect(sent.query).toContain("products(first: 250");
    expect(sent.query).toContain("sortKey: CREATED_AT, reverse: true");
    expect(sent.query).not.toContain("collection(id:");
    expect(sent.variables.cursor).toBeNull();
    expect(lastRequest?.headers["x-shopify-storefront-access-token"]).toBe("tok-123");
    expect(result.products.map((p) => p.vendor)).toEqual(["Penelope", "The Reveries"]);
    expect(result.products[0]!.url).toBe("https://t8ke.com/private-selections/purchase-t8ke-releases/");
    expect(result.emptyGuardThreshold).toBe(3);
  });

  it("follows the cursor across pages and stops at maxProducts", async () => {
    const cursors: (string | null)[] = [];
    handler = () => {
      const { variables } = JSON.parse(lastRequest!.body) as { variables: { cursor: string | null } };
      cursors.push(variables.cursor);
      if (variables.cursor == null) respond(page([node(1), node(2)], true, "c1"));
      else respond(page([node(3)], true, "c2")); // more exists, but the cap stops us
    };
    const result = await shopifyGraphqlAdapter.fetch(channelSite({ maxProducts: 3 }), {}, deps);
    if (result.kind !== "products") throw new Error("expected products");
    expect(cursors).toEqual([null, "c1"]);
    expect(result.products.map((p) => p.handle)).toEqual(["bottle-1", "bottle-2", "bottle-3"]);
    // The second page only asked for what was left under the cap.
    expect((JSON.parse(lastRequest!.body) as { query: string }).query).toContain("products(first: 1");
  });

  it("stops when the channel has no further page", async () => {
    let calls = 0;
    handler = () => {
      calls += 1;
      respond(page([node(1)], false, "c1"));
    };
    await shopifyGraphqlAdapter.fetch(channelSite(), {}, deps);
    expect(calls).toBe(1);
  });

  it("throws on an unexpected channel response so the worker's error path handles it", async () => {
    handler = () => respond(JSON.stringify({ errors: [{ message: "Access denied" }] }));
    await expect(shopifyGraphqlAdapter.fetch(channelSite(), {}, deps)).rejects.toThrow(/unexpected structure/);
  });

  it("embed scope is the default and is unchanged (configured vendor still wins)", async () => {
    expect((makeSite().source as { scope?: string }).scope).toBeUndefined();
    handler = () => respond(collectionResponse([{ ...node(1), vendor: "Someone Else" }]));
    const result = await shopifyGraphqlAdapter.fetch(makeSite(), {}, deps);
    if (result.kind !== "products") throw new Error("expected products");
    expect(lastRequest?.body).toContain("collection(id:");
    expect(result.products[0]!.vendor).toBe("The Reveries");
  });
});
