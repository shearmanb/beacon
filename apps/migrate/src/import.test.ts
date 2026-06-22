import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openStore, type BeaconStore } from "@beacon/db";
import { runSiteCheck, type FetchResult, type SourceAdapter } from "@beacon/core";
import type { NormalizedProduct } from "@beacon/shared";
import { runImport, type ImportSummary } from "./import.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

let store: BeaconStore;
let summary: ImportSummary;

beforeAll(async () => {
  store = await openStore({ url: ":memory:" });
  summary = await runImport(store, REPO_ROOT);
});
afterAll(() => store.close());

function stubReturning(products: NormalizedProduct[]): SourceAdapter {
  const result: FetchResult = { kind: "products", products, pageCount: 1 };
  return { kind: "shopify_rest", fetch: async () => result };
}

describe("runImport against the real legacy data", () => {
  it("imports every config site with no validation failures", () => {
    expect(summary.sitesFailed).toEqual([]);
    expect(summary.sites).toBe(8);
  });

  it("maps each legacy strategy to the right source kind", async () => {
    const kindOf = async (id: string) => (await store.sites.get(id))?.definition.source.kind;
    expect(await kindOf("sharedpour_t8ke")).toBe("shopify_rest");
    expect(await kindOf("reveries_official")).toBe("shopify_graphql");
    expect(await kindOf("reveries_site_status")).toBe("http_status");
    expect(await kindOf("russells_reserve_limited")).toBe("custom");
  });

  it("splits a collection URL into baseUrl + collectionPath", async () => {
    const t8ke = await store.sites.get("sharedpour_t8ke");
    const src = t8ke!.definition.source;
    expect(src.kind).toBe("shopify_rest");
    if (src.kind === "shopify_rest") {
      expect(src.baseUrl).toBe("https://sharedpour.com");
      expect(src.collectionPath).toBe("/collections/t8ke");
    }
  });

  it("pulls the Storefront token out into secrets (not the definition)", async () => {
    const secrets = await store.secrets.all();
    expect(secrets["reveries_official_storefront_token"]).toBeTruthy();
    const def = (await store.sites.get("reveries_official"))!.definition;
    if (def.source.kind === "shopify_graphql") {
      expect(def.source.accessTokenRef).toBe("reveries_official_storefront_token");
      expect(JSON.stringify(def.source)).not.toContain(secrets["reveries_official_storefront_token"]!);
    }
  });

  it("preserves product baselines and history/schedules/ignored/reminders", async () => {
    expect(summary.states).toBeGreaterThanOrEqual(6);
    expect(summary.products).toBeGreaterThan(40);
    expect(summary.history).toBeGreaterThan(0);
    expect(await store.history.count()).toBe(summary.history);
    expect(summary.schedules).toBeGreaterThanOrEqual(4);
    expect(summary.ignored).toBeGreaterThan(0);
    expect(summary.reminders).toBeGreaterThanOrEqual(2);
  });

  it("produces ZERO alerts when a site re-checks against its imported baseline (no flood)", async () => {
    const def = (await store.sites.get("sharedpour_t8ke"))!.definition;
    const state = await store.state.load("sharedpour_t8ke");
    expect(state).toBeDefined();
    const products = Object.values(state!.products ?? {}) as NormalizedProduct[];
    expect(products.length).toBeGreaterThan(0);

    const result = await runSiteCheck(def, state, stubReturning(products));
    expect(result.alerts).toEqual([]); // baseline preserved -> nothing looks new
  });
});
