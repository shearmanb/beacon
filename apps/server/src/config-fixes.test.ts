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
