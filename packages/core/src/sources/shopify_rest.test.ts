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
