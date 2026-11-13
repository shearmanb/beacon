import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type BeaconStore } from "@beacon/db";
import type { Alert } from "@beacon/shared";
import type { NotificationChannel } from "@beacon/notify";
import { AUTO_IMMINENT_META_KEY, maybeAutoImminent, parseAutoImminent } from "./auto-imminent.js";
import { runOnce, type CheckedSite } from "./run.js";

let store: BeaconStore;
const sent: Alert[] = [];
const channel: NotificationChannel = { name: "test", send: async (_site, alert) => void sent.push(alert) };

const GROUP = { id: "g", triggers: ["probe", "a"], targets: ["a", "b"], minutes: 20, maxPerDay: 2 };

async function site(id: string, over: Record<string, unknown> = {}): Promise<void> {
  await store.sites.upsert({
    id,
    name: id.toUpperCase(),
    schedule: "60",
    source: { kind: "shopify_rest", baseUrl: `https://${id}.invalid` },
    ...over,
  });
}

async function fired(siteId: string, events: Alert[], ok = true): Promise<CheckedSite[]> {
  const row = await store.sites.get(siteId);
  return [{ def: row!.definition, outcome: { ok, events, newState: { lastChecked: null } } }];
}

const ev = (type: Alert["type"], extra: Partial<Alert> = {}): Alert => ({ type, product: { title: "Bottle", url: "" }, ...extra });
const def = async (id: string) => (await store.sites.get(id))!.definition;
const ctx = () => ({ store, channel, dryRun: false, sleep: async () => {} });

beforeEach(async () => {
  store = await openStore({ url: ":memory:" });
  sent.length = 0;
  await site("probe");
  await site("a");
  await site("b");
  await store.meta.set(AUTO_IMMINENT_META_KEY, JSON.stringify({ groups: [GROUP] }));
});
afterEach(() => store.close());

describe("parseAutoImminent", () => {
  it("is off for a missing, malformed or disabled blob", () => {
    expect(parseAutoImminent(null)).toEqual([]);
    expect(parseAutoImminent("{nope")).toEqual([]);
    expect(parseAutoImminent(JSON.stringify({ enabled: false, groups: [GROUP] }))).toEqual([]);
    expect(parseAutoImminent(JSON.stringify({ groups: [{ id: "x", triggers: [], targets: ["a"] }] }))).toEqual([]);
  });
  it("fills defaults", () => {
    const [g] = parseAutoImminent(JSON.stringify({ groups: [{ id: "x", triggers: ["a"], targets: ["b"] }] }));
    expect(g).toMatchObject({ on: ["new_product", "restock", "site_changed"], minutes: 20, maxPerDay: 4 });
  });
});

describe("maybeAutoImminent", () => {
  it("a new product on one member puts every target on a bounded auto run", async () => {
    await maybeAutoImminent(ctx(), await fired("a", [ev("new_product")]));
    for (const id of ["a", "b"]) {
      expect(await def(id)).toMatchObject({ imminent: true, imminentAutoMinutes: 20, scheduleBeforeImminent: "60" });
    }
    expect((await def("probe")).imminent).toBe(false); // trigger-only
  });

  it("ignores baselines, sold-outs, quiet rows, failed checks and non-members", async () => {
    await maybeAutoImminent(ctx(), await fired("a", [ev("baseline"), ev("sold_out"), ev("new_product", { quiet: true })]));
    await maybeAutoImminent(ctx(), await fired("a", [ev("new_product")], false));
    await maybeAutoImminent(ctx(), await fired("b", [ev("new_product")])); // b is a target, not a trigger
    expect((await def("a")).imminent).toBe(false);
    expect((await def("b")).imminent).toBe(false);
  });

  it("never touches a run that is already on, or a site that is off", async () => {
    await site("a", { imminent: true, imminentSince: "2026-01-01T00:00:00.000Z", imminentDurationMinutes: 90 });
    await site("b", { enabled: false });
    await maybeAutoImminent(ctx(), await fired("probe", [ev("site_changed")]));
    expect(await def("a")).toMatchObject({ imminentSince: "2026-01-01T00:00:00.000Z" });
    expect((await def("a")).imminentAutoMinutes ?? null).toBeNull();
    expect((await def("b")).imminent).toBe(false);
  });

  it("stops at the daily cap", async () => {
    const off = async () => {
      for (const id of ["a", "b"]) await store.sites.upsert({ ...(await def(id)), imminent: false, imminentSince: null, imminentAutoMinutes: null });
    };
    for (let i = 0; i < 2; i++) {
      await maybeAutoImminent(ctx(), await fired("a", [ev("restock")]));
      expect((await def("b")).imminent).toBe(true);
      await off();
    }
    await maybeAutoImminent(ctx(), await fired("a", [ev("restock")]));
    expect((await def("b")).imminent).toBe(false);
  });
});

describe("auto runs in runOnce", () => {
  it("revert silently after their own duration, and honor a cooldown a click would override", async () => {
    await store.sites.upsert({ ...(await def("probe")), enabled: false });
    await store.sites.upsert({ ...(await def("b")), enabled: false });
    const longAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    // Operator tuning says 90 min; the auto run's own 20 min must win.
    await site("a", { imminent: true, imminentSince: longAgo, imminentAutoMinutes: 20, imminentDurationMinutes: 90, scheduleBeforeImminent: "60" });
    await runOnce(ctx());
    expect(await def("a")).toMatchObject({ imminent: false, schedule: "60" });
    expect((await def("a")).imminentAutoMinutes ?? null).toBeNull();
    expect(sent.filter((a) => a.type === "imminent_timeout")).toHaveLength(0);

    // Still on, but the host is in a rate-limit cooldown: an auto run waits.
    await site("a", { imminent: true, imminentSince: new Date().toISOString(), imminentAutoMinutes: 20 });
    await store.state.save("a", { lastChecked: new Date().toISOString(), cooldownUntil: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await runOnce(ctx())).checked).toBe(0);
    // The same cooldown under the operator's own click is overridden.
    await store.sites.upsert({ ...(await def("a")), imminentAutoMinutes: null });
    await store.state.save("a", { lastChecked: null, cooldownUntil: new Date(Date.now() + 3_600_000).toISOString() });
    expect((await runOnce(ctx())).checked).toBe(1);
  });
});
