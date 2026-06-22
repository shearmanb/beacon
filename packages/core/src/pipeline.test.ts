import { describe, it, expect } from "vitest";
import { runSiteCheck, type SiteState } from "./pipeline.js";
import { siteDefinitionSchema, type SiteDefinition } from "./schema.js";
import type { FetchResult, SourceAdapter } from "./sources/types.js";
import type { NormalizedProduct } from "@beacon/shared";

function site(over: Record<string, unknown> = {}): SiteDefinition {
  return siteDefinitionSchema.parse({
    id: "t",
    name: "Test Site",
    source: { kind: "shopify_rest", baseUrl: "https://x.com" },
    alerts: { onNew: true, onRestock: true, onSoldOut: true, onSiteReset: true },
    ...over,
  });
}

function prod(handle: string, available: boolean): NormalizedProduct {
  return { handle, title: handle, url: `https://x.com/products/${handle}`, tags: [], available, minPrice: 10 };
}

/** A canned adapter that returns a fixed FetchResult — no network. */
function stub(result: FetchResult): SourceAdapter {
  return { kind: "shopify_rest", fetch: async () => result };
}

describe("runSiteCheck", () => {
  it("emits new_product alerts for products not in previous state", async () => {
    const result = await runSiteCheck(
      site(),
      { lastChecked: "2026-06-22T00:00:00Z", products: { a: prod("a", true) } },
      stub({ kind: "products", products: [prod("a", true), prod("b", true)], pageCount: 1 }),
    );
    expect(result.alerts).toEqual([{ type: "new_product", product: prod("b", true) }]);
    expect(Object.keys(result.state.products ?? {}).sort()).toEqual(["a", "b"]);
    expect(result.state.productCount).toBe(2);
  });

  it("applies site filters before diffing", async () => {
    const result = await runSiteCheck(
      site({ filters: { titleContains: ["keep"] } }),
      undefined,
      stub({ kind: "products", products: [prod("keep-me", true), prod("drop-me", true)], pageCount: 1 }),
    );
    // "keep-me" title contains "keep"; "drop-me" filtered out.
    expect(Object.keys(result.state.products ?? {})).toEqual(["keep-me"]);
  });

  it("ticks lastChecked and emits nothing on not_modified", async () => {
    const prev: SiteState = {
      lastChecked: "2026-06-22T00:00:00Z",
      products: { a: prod("a", true) },
      httpValidators: { etag: '"v1"', lastModified: null },
    };
    const result = await runSiteCheck(site(), prev, stub({ kind: "not_modified", validators: prev.httpValidators }));
    expect(result.alerts).toEqual([]);
    expect(result.state.products).toEqual(prev.products);
    expect(result.state.lastChecked).not.toBe(prev.lastChecked);
  });

  it("empty-guard preserves products and stays silent below threshold", async () => {
    const result = await runSiteCheck(
      site(),
      { lastChecked: "2026-06-22T00:00:00Z", products: { a: prod("a", true) } },
      stub({ kind: "products", products: [], pageCount: 1 }),
    );
    expect(result.alerts).toEqual([]); // streak 1 < threshold 3
    expect(result.state.products).toEqual({ a: prod("a", true) });
    expect(result.state.emptyStreak).toBe(1);
  });

  it("empty-guard fires site_reset once the streak reaches the threshold", async () => {
    const result = await runSiteCheck(
      site(),
      { lastChecked: "2026-06-22T00:00:00Z", products: { a: prod("a", true) }, emptyStreak: 2 },
      stub({ kind: "products", products: [], pageCount: 1 }),
    );
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]!.type).toBe("site_reset");
    expect(result.state.products).toEqual({ a: prod("a", true) }); // preserved
    expect(result.state.emptyAlertSent).toBe(true);
  });

  it("fires site_reset on an open -> blocked signal transition", async () => {
    const result = await runSiteCheck(
      site(),
      { lastChecked: "2026-06-22T00:00:00Z", pageReset: false },
      stub({ kind: "signal", signal: { kind: "blocked", reason: "password wall" } }),
    );
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]!.type).toBe("site_reset");
    expect(result.state.pageReset).toBe(true);
  });

  it("clears a signal silently on recovery", async () => {
    const result = await runSiteCheck(
      site(),
      { lastChecked: "2026-06-22T00:00:00Z", pageReset: true, resetAlertSent: true },
      stub({ kind: "signal", signal: { kind: "open" } }),
    );
    expect(result.alerts).toEqual([]);
    expect(result.state.pageReset).toBe(false);
    expect(result.state.resetAlertSent).toBe(false);
  });
});
