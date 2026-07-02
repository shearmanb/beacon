import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { shopifyRestAdapter } from "./shopify_rest.js";
import { siteDefinitionSchema, type SiteDefinition } from "../schema.js";
import type { PrevState } from "./types.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler;
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeSite(): SiteDefinition {
  return siteDefinitionSchema.parse({
    id: "t",
    name: "T",
    source: { kind: "shopify_rest", baseUrl: base },
  });
}

function shopifyProduct(handle: string, available: boolean, price: string) {
  return {
    handle,
    title: handle.toUpperCase(),
    vendor: "TestVendor",
    product_type: "Whiskey",
    tags: ["a", "b"],
    variants: [{ price, available }],
    images: [{ src: `https://img/${handle}.jpg` }],
  };
}

describe("shopifyRestAdapter", () => {
  it("returns normalized products from a single page", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ products: [shopifyProduct("a", true, "59.99"), shopifyProduct("b", false, "120.00")] }));
    };
    const result = await shopifyRestAdapter.fetch(makeSite(), {});
    expect(result.kind).toBe("products");
    if (result.kind !== "products") return;
    expect(result.pageCount).toBe(1);
    expect(result.products).toHaveLength(2);
    const a = result.products.find((p) => p.handle === "a")!;
    expect(a.available).toBe(true);
    expect(a.minPrice).toBe(59.99);
    expect(a.url).toBe(`${base}/products/a`);
    expect(a.image).toBe("https://img/a.jpg");
    expect(a.tags).toEqual(["a", "b"]);
    const b = result.products.find((p) => p.handle === "b")!;
    expect(b.available).toBe(false);
  });

  it("paginates until a short page", async () => {
    const full = Array.from({ length: 250 }, (_, i) => shopifyProduct(`p${i}`, true, "10.00"));
    handler = (req, res) => {
      const page = new URL(req.url ?? "", base).searchParams.get("page");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ products: page === "1" ? full : [shopifyProduct("last", true, "10.00")] }));
    };
    const result = await shopifyRestAdapter.fetch(makeSite(), {});
    expect(result.kind).toBe("products");
    if (result.kind !== "products") return;
    expect(result.pageCount).toBe(2);
    expect(result.products).toHaveLength(251);
  });

  it("extracts validators from the first-page response", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { ETag: '"v1"', "Content-Type": "application/json" });
      res.end(JSON.stringify({ products: [shopifyProduct("a", true, "10.00")] }));
    };
    const result = await shopifyRestAdapter.fetch(makeSite(), {});
    if (result.kind !== "products") throw new Error("expected products");
    expect(result.validators?.etag).toBe('"v1"');
  });

  it("sends conditional headers and short-circuits on 304 when last check was single-page", async () => {
    let sawIfNoneMatch: string | undefined;
    handler = (req, res) => {
      sawIfNoneMatch = req.headers["if-none-match"] as string | undefined;
      if (sawIfNoneMatch === '"v1"') {
        res.writeHead(304);
        res.end();
      } else {
        res.writeHead(200, { ETag: '"v1"' });
        res.end(JSON.stringify({ products: [shopifyProduct("a", true, "10.00")] }));
      }
    };
    const prev: PrevState = { pageCount: 1, httpValidators: { etag: '"v1"', lastModified: null } };
    const result = await shopifyRestAdapter.fetch(makeSite(), prev);
    expect(sawIfNoneMatch).toBe('"v1"');
    expect(result.kind).toBe("not_modified");
  });

  it("does NOT send conditional headers when last check was multi-page", async () => {
    let sawIfNoneMatch: string | undefined;
    handler = (req, res) => {
      sawIfNoneMatch = req.headers["if-none-match"] as string | undefined;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ products: [shopifyProduct("a", true, "10.00")] }));
    };
    const prev: PrevState = { pageCount: 2, httpValidators: { etag: '"v1"', lastModified: null } };
    await shopifyRestAdapter.fetch(makeSite(), prev);
    expect(sawIfNoneMatch).toBeUndefined();
  });
});

// ── Storefront fallback (self-healing failover) ──────────────────────────────

function makeFallbackSite(collectionPath?: string, restStallMs?: number): SiteDefinition {
  return siteDefinitionSchema.parse({
    id: "t",
    name: "T",
    source: {
      kind: "shopify_rest",
      baseUrl: base,
      ...(collectionPath ? { collectionPath } : {}),
      storefrontFallback: {
        domain: "x.myshopify.com",
        accessTokenRef: "sp_token",
        endpoint: `${base}/api/graphql`,
        ...(restStallMs != null ? { restStallMs } : {}),
      },
    },
  });
}

const fallbackDeps = { resolveSecret: (ref: string) => (ref === "sp_token" ? "tok-abc" : undefined) };

function storefrontNode(handle: string, available: boolean, amount: string) {
  return {
    handle,
    title: handle.toUpperCase(),
    vendor: "TestVendor",
    productType: "Whiskey",
    tags: ["a"],
    availableForSale: available,
    priceRange: { minVariantPrice: { amount } },
    featuredImage: { url: `https://img/${handle}.jpg` },
  };
}

function graphqlHandler(onBody: (body: string, res: ServerResponse) => void): Handler {
  return (req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/api/graphql")) {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => onBody(body, res));
      return;
    }
    res.writeHead(403); // REST is blocked
    res.end("blocked");
  };
}

describe("shopifyRestAdapter storefront fallback", () => {
  it("fails over to the Storefront API when REST is blocked (403)", async () => {
    let sawToken: string | undefined;
    handler = (req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/api/graphql")) {
        sawToken = req.headers["x-shopify-storefront-access-token"] as string | undefined;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: {
              products: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [storefrontNode("rev-1", true, "129.00")],
              },
            },
          }),
        );
        return;
      }
      res.writeHead(403);
      res.end("blocked");
    };
    const result = await shopifyRestAdapter.fetch(makeFallbackSite(), {}, fallbackDeps);
    expect(result.kind).toBe("products");
    if (result.kind !== "products") return;
    expect(result.via).toBe("storefront_fallback");
    expect(sawToken).toBe("tok-abc");
    expect(result.products).toHaveLength(1);
    const p = result.products[0]!;
    expect(p.handle).toBe("rev-1");
    expect(p.available).toBe(true);
    expect(p.minPrice).toBe(129);
    expect(p.vendor).toBe("TestVendor");
    expect(p.url).toBe(`${base}/products/rev-1`); // links still point at the primary domain
    expect(result.validators).toBeNull(); // no stale cross-endpoint ETags
  });

  it("scopes the fallback query to the collection handle for collection sources", async () => {
    let sawQuery = "";
    handler = graphqlHandler((body, res) => {
      sawQuery = (JSON.parse(body) as { query: string }).query;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: {
            collection: {
              products: { pageInfo: { hasNextPage: false }, nodes: [storefrontNode("t8ke-1", false, "50.00")] },
            },
          },
        }),
      );
    });
    const result = await shopifyRestAdapter.fetch(makeFallbackSite("/collections/t8ke"), {}, fallbackDeps);
    expect(sawQuery).toContain('collection(handle: "t8ke")');
    if (result.kind !== "products") throw new Error("expected products");
    expect(result.products[0]!.handle).toBe("t8ke-1");
  });

  it("rethrows the ORIGINAL blocked error when the fallback also fails", async () => {
    handler = graphqlHandler((_body, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    await expect(shopifyRestAdapter.fetch(makeFallbackSite(), {}, fallbackDeps)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("throws the blocked error untouched when no fallback is configured", async () => {
    handler = (_req, res) => {
      res.writeHead(403);
      res.end("blocked");
    };
    await expect(shopifyRestAdapter.fetch(makeSite(), {}, fallbackDeps)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("fails over when REST stalls (tar-pit: connection accepted, never answered)", async () => {
    handler = (req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/api/graphql")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: { products: { pageInfo: { hasNextPage: false }, nodes: [storefrontNode("rev-1", true, "129.00")] } },
          }),
        );
        return;
      }
      // REST: hang forever — no status, no body. The stall guard must fire.
    };
    const result = await shopifyRestAdapter.fetch(makeFallbackSite(undefined, 300), {}, fallbackDeps);
    expect(result.kind).toBe("products");
    if (result.kind !== "products") return;
    expect(result.via).toBe("storefront_fallback");
    expect(result.viaReason).toContain("stalled");
    expect(result.products[0]!.handle).toBe("rev-1");
  });

  it("does NOT fall back on a non-blocked error (500)", async () => {
    let graphqlCalled = false;
    handler = (req, res) => {
      if (req.method === "POST") graphqlCalled = true;
      res.writeHead(500);
      res.end("server error");
    };
    await expect(shopifyRestAdapter.fetch(makeFallbackSite(), {}, fallbackDeps)).rejects.toMatchObject({
      statusCode: 500,
    });
    expect(graphqlCalled).toBe(false);
  });
});
