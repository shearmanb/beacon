import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { openStore, type BeaconStore } from "@beacon/db";
import type { Alert } from "@beacon/shared";
import type { NotificationChannel } from "@beacon/notify";
import { runOnce, type RunContext } from "./run.js";

let server: Server;
let base: string;
let products: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ products }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function shopifyProduct(handle: string, available: boolean) {
  return { handle, title: handle, variants: [{ price: "50.00", available }], images: [] };
}

let store: BeaconStore;
const sent: Array<{ site: string; alert: Alert }> = [];
const channel: NotificationChannel = { name: "test", send: async (site, alert) => void sent.push({ site, alert }) };

function ctx(over: Partial<RunContext> = {}): RunContext {
  return { store, channel, dryRun: false, sleep: async () => {}, ...over };
}

beforeEach(async () => {
  store = await openStore({ url: ":memory:" });
  sent.length = 0;
  products = [shopifyProduct("a", true), shopifyProduct("b", true)];
  await store.sites.upsert({
    id: "s1",
    name: "Local Shop",
    intervalMinutes: 20,
    source: { kind: "shopify_rest", baseUrl: base },
  });
});
afterEach(() => store.close());

describe("runOnce", () => {
  it("baselines on the first check (quiet mode) — products recorded, no Discord pings", async () => {
    const res = await runOnce(ctx());
    expect(res.checked).toBe(1);
    const state = await store.state.load("s1");
    expect(Object.keys(state?.products ?? {}).sort()).toEqual(["a", "b"]);
    // baseline recorded in history but not sent to Discord
    expect(sent).toHaveLength(0);
    expect((await store.history.recent()).some((h) => h.type === "baseline")).toBe(true);
  });

  it("skips a site that was just checked, until a run_now command clears it", async () => {
    await runOnce(ctx()); // baseline
    const second = await runOnce(ctx());
    expect(second.checked).toBe(0); // shouldCheck gate

    products = [shopifyProduct("a", true), shopifyProduct("b", true), shopifyProduct("c", true)];
    await store.commands.enqueue("run_now", "s1");
    const third = await runOnce(ctx());
    expect(third.checked).toBe(1);
    expect(sent.map((s) => s.alert.type)).toEqual(["new_product"]); // "c" is new
    expect(sent[0]?.alert.product.handle).toBe("c");
  });

  it("dry-run computes but persists nothing and sends nothing", async () => {
    const res = await runOnce(ctx({ dryRun: true }));
    expect(res.checked).toBe(1);
    expect(await store.state.load("s1")).toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it("auto-offs an expired imminent site and fires imminent_timeout", async () => {
    await store.sites.upsert({
      id: "s1",
      name: "Local Shop",
      intervalMinutes: 20,
      imminent: true,
      imminentIntervalMinutes: 2,
      imminentDurationMinutes: 20,
      imminentSince: new Date(Date.now() - 30 * 60_000).toISOString(),
      source: { kind: "shopify_rest", baseUrl: base },
    });
    await runOnce(ctx());
    expect((await store.sites.get("s1"))?.definition.imminent).toBe(false);
    expect(sent.some((s) => s.alert.type === "imminent_timeout")).toBe(true);
  });

  it("imminent bypasses a circuit-breaker cooldown that would skip a non-imminent site", async () => {
    // A live 30-min cooldown sits on the site.
    await store.state.save("s1", {
      lastChecked: new Date(Date.now() - 60 * 60_000).toISOString(),
      products: {},
      cooldownUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
      cooldownLevel: 2,
    });

    // Non-imminent: the cooldown is honored, so the site is skipped.
    expect((await runOnce(ctx())).checked).toBe(0);

    // Flip to imminent (definition only — the cooldown state is untouched).
    await store.sites.upsert({
      id: "s1",
      name: "Local Shop",
      imminent: true,
      imminentIntervalMinutes: 1,
      imminentDurationMinutes: 20,
      imminentSince: new Date().toISOString(),
      source: { kind: "shopify_rest", baseUrl: base },
    });

    // Imminent: the cooldown is bypassed, so the launch window keeps checking.
    expect((await runOnce(ctx())).checked).toBe(1);
  });

  it("set_imminent command toggles imminent on with a timestamp", async () => {
    await store.commands.enqueue("set_imminent", "s1", { imminent: true });
    const res = await runOnce(ctx());
    const def = (await store.sites.get("s1"))?.definition;
    expect(def?.imminent).toBe(true);
    expect(typeof def?.imminentSince).toBe("string");
    expect(res.anyImminentActive).toBe(true);
  });
});
