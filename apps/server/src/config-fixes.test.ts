import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type BeaconStore } from "@beacon/db";
import { applyConfigFixes, CORRECTIONS, ONE_SHOTS } from "./config-fixes.js";

let store: BeaconStore;
const log = () => {};

beforeEach(async () => {
  store = await openStore({ url: ":memory:" });
});
afterEach(() => store.close());

describe("config fixes (boot-time config corrections)", () => {
  it("applies a correction idempotently across repeated boots", async () => {
    await store.secrets.set("reveries_official_storefront_token", "tok");
    await store.sites.upsert({
      id: "sp",
      name: "SharedPour",
      intervalMinutes: 20,
      source: { kind: "shopify_rest", baseUrl: "https://sharedpour.com" },
    });

    await applyConfigFixes(store, log);
    const first = await store.sites.get("sp");
    expect((first!.definition.source as Record<string, unknown>)["storefrontFallback"]).toMatchObject({
      domain: "shared-pour.myshopify.com",
    });

    // A second boot must not churn the definition.
    await applyConfigFixes(store, log);
    expect(await store.sites.get("sp")).toEqual(first);
  });

  it("runs a one-shot exactly once, even across many boots", async () => {
    await applyConfigFixes(store, log);
    expect(await store.meta.get("fix:amendment_cadence_20260716")).toBeDefined();

    // Operator later changes a schedule by hand; a redeploy must not undo it.
    await store.schedules.upsert("drop_windows", { label: "hand-edited", rules: [{ defaultInterval: 99 }] });
    await applyConfigFixes(store, log);
    expect((await store.schedules.all())["drop_windows"]!.label).toBe("hand-edited");
  });

  it("honors the legacy meta flag so a moved one-shot never re-runs in prod", async () => {
    // Prod already applied the cadence amendment under serve.ts's old key.
    await store.meta.set("amendment_cadence_20260716", "2026-07-16T00:00:00.000Z");
    await store.schedules.upsert("drop_windows", { label: "hand-edited", rules: [{ defaultInterval: 99 }] });

    await applyConfigFixes(store, log);
    expect((await store.schedules.all())["drop_windows"]!.label).toBe("hand-edited");
  });

  it("disables — never deletes or recreates — the exhausted browser twin", async () => {
    await store.sites.upsert({
      id: "sharedpour_browser",
      name: "SharedPour (browser twin)",
      intervalMinutes: 60,
      source: { kind: "browser", baseUrl: "https://sharedpour.com" },
    });
    await applyConfigFixes(store, log);
    const row = await store.sites.get("sharedpour_browser");
    expect(row).toBeDefined(); // config + state kept, so re-enabling is one click
    expect(row!.enabled).toBe(false);

    // And once the operator re-enables it, a later boot leaves it alone.
    await store.sites.setEnabled("sharedpour_browser", true);
    await applyConfigFixes(store, log);
    expect((await store.sites.get("sharedpour_browser"))!.enabled).toBe(true);
  });

  it("consolidates the sharedpour checkers into one watchlist without losing baselines", async () => {
    const mkSite = (id: string, name: string, titleContains: string[], extra: Record<string, unknown> = {}) =>
      store.sites.upsert({
        id,
        name,
        intervalMinutes: 20,
        source: { kind: "shopify_rest", baseUrl: "https://sharedpour.com", ...extra },
        filters: { titleContains },
      });
    await mkSite("sharedpour_t8ke_all", "SharedPour T8KE (all)", ["T8ke"]);
    await mkSite("sharedpour_t8ke", "SharedPour T8KE", ["T8ke"], { collectionPath: "/collections/t8ke" });
    await mkSite("sharedpour_reveries", "SharedPour The Reveries", ["Reveries"]);
    await mkSite("sharedpour_provenance", "SharedPour Provenance", ["Provenance"]);
    const prod = (handle: string) => ({
      handle,
      title: handle,
      url: `https://sharedpour.com/products/${handle}`,
      tags: [],
      available: true,
    });
    await store.state.save("sharedpour_t8ke_all", {
      lastChecked: "2026-08-26T00:00:00.000Z",
      products: { "t8ke-a": prod("t8ke-a") },
      recentlySeen: { "t8ke-a": "2026-08-26T00:00:00.000Z" },
    });
    await store.state.save("sharedpour_reveries", {
      lastChecked: "2026-08-26T00:00:00.000Z",
      products: { "rev-a": prod("rev-a") },
    });
    await store.state.save("sharedpour_provenance", {
      lastChecked: "2026-08-26T00:00:00.000Z",
      products: { "prov-a": prod("prov-a") },
    });

    await applyConfigFixes(store, log);

    const survivor = await store.sites.get("sharedpour_t8ke_all");
    expect(survivor!.definition.name).toBe("SharedPour Watchlist");
    expect(survivor!.definition.filters.titleContains).toEqual(["T8ke", "Reveries", "Provenance"]);
    expect(survivor!.enabled).toBe(true);
    for (const id of ["sharedpour_t8ke", "sharedpour_reveries", "sharedpour_provenance"]) {
      expect((await store.sites.get(id))!.enabled).toBe(false); // disabled, never deleted
    }
    // Union baseline: retiree-only handles are present, so the widened filter
    // cannot re-alert them as "new" on the first consolidated check.
    const st = await store.state.load("sharedpour_t8ke_all");
    expect(Object.keys(st!.products!).sort()).toEqual(["prov-a", "rev-a", "t8ke-a"]);
    expect((st!["recentlySeen"] as Record<string, string>)["t8ke-a"]).toBeDefined();

    // Operator later re-enables a retiree by hand — a redeploy must not re-retire it.
    await store.sites.setEnabled("sharedpour_reveries", true);
    await applyConfigFixes(store, log);
    expect((await store.sites.get("sharedpour_reveries"))!.enabled).toBe(true);
  });

  it("never recreates a site the operator deleted (the old resurrect-on-deploy bug)", async () => {
    await applyConfigFixes(store, log); // first boot: one-shots latch
    // Nothing in the fix list may create a site out of thin air on a later boot.
    await applyConfigFixes(store, log);
    expect(await store.sites.list()).toHaveLength(0);
  });

  it("keeps fix ids unique (the meta latch is keyed on them)", () => {
    const ids = [...CORRECTIONS, ...ONE_SHOTS].map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
