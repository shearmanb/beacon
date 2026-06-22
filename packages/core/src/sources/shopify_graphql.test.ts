import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { shopifyGraphqlAdapter } from "./shopify_graphql.js";
import { siteDefinitionSchema, type SiteDefinition } from "../schema.js";
import type { AdapterDeps } from "./types.js";

let respond: (body: string) => void;
let lastRequest: { headers: IncomingMessage["headers"]; body: string } | undefined;
let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
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
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/graphql`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

let handler: (res: ServerResponse) => void;

function makeSite(): SiteDefinition {
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
    },
  });
}

const deps: AdapterDeps = { resolveSecret: (ref) => (ref === "reveries_storefront_token" ? "tok-123" : undefined) };

function graphResponse(nodes: unknown[]): string {
  return JSON.stringify({ data: { collection: { products: { nodes } } } });
}

describe("shopifyGraphqlAdapter", () => {
  it("normalizes storefront nodes and sends the token header", async () => {
    handler = (res) =>
      respond(
        graphResponse([
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

    const r1 = result.products.find((p) => p.handle === "reveries-batch-1")!;
    expect(r1.available).toBe(true);
    expect(r1.minPrice).toBe(129.99);
    expect(r1.vendor).toBe("The Reveries");
    expect(r1.productType).toBe("Whiskey");
    expect(r1.url).toBe("https://www.thereveries.co/shop");
    expect(r1.image).toBe("https://img/r1.jpg");
    expect(result.products.find((p) => p.handle === "reveries-batch-0")!.available).toBe(false);
  });

  it("uses empty-guard threshold 1 when the collection returns no products", async () => {
    handler = (res) => respond(graphResponse([]));
    const result = await shopifyGraphqlAdapter.fetch(makeSite(), {}, deps);
    if (result.kind !== "products") throw new Error("expected products");
    expect(result.products).toHaveLength(0);
    expect(result.emptyGuardThreshold).toBe(1);
  });

  it("throws when the access token cannot be resolved", async () => {
    handler = (res) => respond(graphResponse([]));
    await expect(shopifyGraphqlAdapter.fetch(makeSite(), {}, { resolveSecret: () => undefined })).rejects.toThrow(
      /Missing Storefront token/,
    );
  });

  it("throws on an unexpected response shape", async () => {
    handler = (res) => respond(JSON.stringify({ errors: [{ message: "bad" }] }));
    await expect(shopifyGraphqlAdapter.fetch(makeSite(), {}, deps)).rejects.toThrow(/unexpected structure/);
  });
});
