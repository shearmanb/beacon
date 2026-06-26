import { describe, it, expect } from "vitest";
import { siteDefinitionSchema, validateSite, sourceSchema } from "./schema.js";

describe("siteDefinitionSchema", () => {
  it("parses a shopify_rest site and applies defaults", () => {
    const parsed = siteDefinitionSchema.parse({
      id: "sharedpour_t8ke",
      name: "SharedPour T8KE",
      schedule: "working_hours_heavy",
      intervalMinutes: 20,
      source: { kind: "shopify_rest", baseUrl: "https://sharedpour.com", collectionPath: "/collections/t8ke" },
    });
    expect(parsed.enabled).toBe(true); // default
    expect(parsed.alerts).toEqual({ onNew: true, onRestock: true, onSoldOut: false, onSiteReset: true });
    expect(parsed.filters.titleContains).toEqual([]);
    expect(parsed.filters.availableOnly).toBe(false);
    expect(parsed.source.kind).toBe("shopify_rest");
  });

  it("applies http_status content-change defaults to a definition that omits them", () => {
    // Mirrors what normalizeRows relies on: a stored definition predating the new
    // fields parses with the never-miss defaults (so the worker activates them
    // without a data migration).
    const parsed = sourceSchema.parse({
      kind: "http_status",
      url: "https://www.thereveries.co/shop",
      blockedWhen: { bodyMatchesAny: ["coming soon"] },
    });
    if (parsed.kind !== "http_status") throw new Error("expected http_status");
    expect(parsed.alertOnOpen).toBe(true);
    expect(parsed.watchContentChange).toBe(true);
    expect(parsed.contentChangeMinFrac).toBe(0);
    expect(parsed.blockedWhen.httpStatusIn).toEqual([401, 403]); // existing default
  });

  it("discriminates the source union by kind", () => {
    const html = sourceSchema.parse({
      kind: "html",
      url: "https://www.russellsreserve.com/en-us/our-products/",
      itemSelector: { kind: "cta_anchor", linkClassContains: "sn_btn", productUrlPattern: "/(products)/([^/]+)/?$" },
      title: { kind: "nearestPrecedingHeading" },
      availability: {
        availableWhen: { matchesAny: ["add to cart"] },
        unavailableWhen: { matchesAny: ["see details"] },
      },
    });
    expect(html.kind).toBe("html");
    if (html.kind === "html") expect(html.title.tag).toBe("h3"); // default
  });
});

describe("validateSite", () => {
  it("returns ok for a valid site", () => {
    const r = validateSite({
      id: "x",
      name: "X",
      source: { kind: "shopify_rest", baseUrl: "https://x.com" },
    });
    expect(r.ok).toBe(true);
    expect(r.site?.id).toBe("x");
  });

  it("returns a flat error for a bad source", () => {
    const r = validateSite({ id: "x", name: "X", source: { kind: "shopify_rest", baseUrl: "not-a-url" } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/baseUrl/);
  });

  it("rejects an unknown source kind", () => {
    const r = validateSite({ id: "x", name: "X", source: { kind: "carrier_pigeon", url: "https://x.com" } });
    expect(r.ok).toBe(false);
  });

  it("rejects a missing id", () => {
    expect(validateSite({ name: "X", source: { kind: "shopify_rest", baseUrl: "https://x.com" } }).ok).toBe(false);
  });
});
