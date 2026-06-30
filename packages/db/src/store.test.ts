import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openStore, type BeaconStore } from "./store.js";
import type { SiteState } from "@beacon/core";

let store: BeaconStore;

beforeEach(async () => {
  store = await openStore({ url: ":memory:" });
});
afterEach(() => {
  store.close();
});

const SITE = {
  id: "sharedpour_t8ke",
  name: "SharedPour T8KE",
  schedule: "working_hours_heavy",
  intervalMinutes: 20,
  source: { kind: "shopify_rest", baseUrl: "https://sharedpour.com", collectionPath: "/collections/t8ke" },
};

describe("sites repo", () => {
  it("validates on upsert and round-trips a definition", async () => {
    const def = await store.sites.upsert(SITE);
    expect(def.source.kind).toBe("shopify_rest");
    const got = await store.sites.get("sharedpour_t8ke");
    expect(got?.name).toBe("SharedPour T8KE");
    expect(got?.definition.filters.titleContains).toEqual([]); // defaults applied + persisted
  });

  it("rejects an invalid definition", async () => {
    await expect(store.sites.upsert({ id: "x", name: "X", source: { kind: "shopify_rest", baseUrl: "nope" } })).rejects.toThrow();
  });

  it("toggles enabled through the validated path", async () => {
    await store.sites.upsert(SITE);
    await store.sites.setEnabled("sharedpour_t8ke", false);
    expect((await store.sites.get("sharedpour_t8ke"))?.enabled).toBe(false);
  });
});

describe("state repo", () => {
  it("saves and loads SiteState including the products map", async () => {
    const state: SiteState = {
      lastChecked: "2026-06-22T00:00:00Z",
      productCount: 1,
      products: { a: { handle: "a", title: "A", url: "https://x/a", tags: [], available: true } },
      httpValidators: { etag: '"v1"', lastModified: null },
    };
    await store.state.save("s1", state);
    const loaded = await store.state.load("s1");
    expect(loaded?.products?.["a"]?.available).toBe(true);
    expect(loaded?.httpValidators?.etag).toBe('"v1"');
    expect(await store.state.products("s1")).toHaveProperty("a");
  });

  it("returns undefined for an unknown site (startup-quiet signal)", async () => {
    expect(await store.state.load("missing")).toBeUndefined();
  });

  it("clear() drops stored state so the site re-baselines", async () => {
    await store.state.save("s1", { lastChecked: "2026-06-22T00:00:00Z", products: { a: { handle: "a", title: "A", url: "https://x/a", tags: [], available: true } } });
    expect(await store.state.load("s1")).toBeDefined();
    await store.state.clear("s1");
    expect(await store.state.load("s1")).toBeUndefined(); // → startup-quiet on next check
  });
});

describe("history repo", () => {
  it("appends alerts and reads them back newest-first", async () => {
    await store.history.append("s1", [
      { type: "new_product", product: { handle: "a", title: "A", url: "https://x/a", available: true } },
      { type: "restock", product: { handle: "b", title: "B", url: "https://x/b", available: true } },
    ]);
    const recent = await store.history.recent(10);
    expect(recent).toHaveLength(2);
    expect(recent[0]?.type).toBe("restock"); // newest first
  });

  it("no-ops on an empty alert list", async () => {
    await store.history.append("s1", []);
    expect(await store.history.recent()).toHaveLength(0);
  });
});

describe("ignored repo", () => {
  it("adds, lists, and removes handles", async () => {
    await store.ignored.add("ghost-pour");
    await store.ignored.add("ghost-pour"); // idempotent
    expect([...(await store.ignored.set())]).toEqual(["ghost-pour"]);
    await store.ignored.remove("ghost-pour");
    expect((await store.ignored.set()).size).toBe(0);
  });
});

describe("commands repo", () => {
  it("enqueues then drains pending exactly once", async () => {
    await store.commands.enqueue("run_now", "s1");
    await store.commands.enqueue("run_now", null);
    const first = await store.commands.drainPending();
    expect(first).toHaveLength(2);
    expect(first[0]?.type).toBe("run_now");
    const second = await store.commands.drainPending();
    expect(second).toHaveLength(0); // already marked processed
  });
});

describe("secrets + schedules + reminders", () => {
  it("stores and reads secrets", async () => {
    await store.secrets.set("reveries_token", "abc");
    expect(await store.secrets.all()).toEqual({ reveries_token: "abc" });
  });

  it("upserts and reads schedules", async () => {
    await store.schedules.upsert("wh", { label: "WH", rules: [{ defaultInterval: 60 }] });
    expect((await store.schedules.all())["wh"]?.label).toBe("WH");
  });

  it("orders reminders by date then time and updates fields", async () => {
    await store.reminders.add({ id: "r2", date: "2026-07-02", time: "10:00", text: "later", priority: false });
    await store.reminders.add({ id: "r1", date: "2026-07-01", time: null, text: "earlier", priority: true });
    const list = await store.reminders.list();
    expect(list.map((r) => r.id)).toEqual(["r1", "r2"]);
    await store.reminders.update("r1", { done: true });
    expect((await store.reminders.list()).find((r) => r.id === "r1")?.done).toBe(true);
  });
});
