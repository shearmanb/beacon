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

// Default responder: a healthy products.json. Tests that need path-specific
// behavior (e.g. blocked REST + a working Storefront endpoint) swap `respond`.
const defaultRespond = (_req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ products }));
};
let respond: (req: IncomingMessage, res: ServerResponse) => void = defaultRespond;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => respond(req, res));
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
  respond = defaultRespond;
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

  it("clamps a long cooldown to 15m when the schedule is a tight drop-window cadence", async () => {
    // A 5-min cadence (drop window) with a 170-min cooldown stored and the last
    // attempt 20 min ago: the 15-min clamp has elapsed, so the site checks.
    await store.sites.upsert({
      id: "s1",
      name: "Local Shop",
      intervalMinutes: 5,
      source: { kind: "shopify_rest", baseUrl: base },
    });
    await store.state.save("s1", {
      lastChecked: new Date(Date.now() - 20 * 60_000).toISOString(),
      products: {},
      cooldownUntil: new Date(Date.now() + 170 * 60_000).toISOString(),
      cooldownLevel: 4,
    });
    expect((await runOnce(ctx())).checked).toBe(1);

    // Control: the same cooldown under a relaxed 60-min cadence honors the
    // full ladder and stays skipped.
    await store.sites.upsert({
      id: "s1",
      name: "Local Shop",
      intervalMinutes: 60,
      source: { kind: "shopify_rest", baseUrl: base },
    });
    await store.state.save("s1", {
      lastChecked: new Date(Date.now() - 20 * 60_000).toISOString(),
      products: {},
      cooldownUntil: new Date(Date.now() + 170 * 60_000).toISOString(),
      cooldownLevel: 4,
    });
    expect((await runOnce(ctx())).checked).toBe(0);
  });

  it("set_imminent command toggles imminent on with a timestamp", async () => {
    await store.commands.enqueue("set_imminent", "s1", { imminent: true });
    const res = await runOnce(ctx());
    const def = (await store.sites.get("s1"))?.definition;
    expect(def?.imminent).toBe(true);
    expect(typeof def?.imminentSince).toBe("string");
    expect(res.anyImminentActive).toBe(true);
  });

  it("host-level pin propagation: a flap-pin on one site pre-pins armed siblings on the same host", async () => {
    const norm = (h: string) => ({ handle: h, title: h, url: `${base}/products/${h}`, tags: [], available: true, minPrice: 50 });
    const fb = { domain: "x.myshopify.com", accessTokenRef: "sp_token", endpoint: `${base}/api/graphql` };
    await store.secrets.set("sp_token", "tok");
    // Replaces the default "s1" from beforeEach. s3 shares the host but has NO
    // fallback armed — propagation must leave it alone.
    await store.sites.upsert({ id: "s1", name: "Flapper", intervalMinutes: 20, source: { kind: "shopify_rest", baseUrl: base, storefrontFallback: fb } });
    await store.sites.upsert({ id: "s2", name: "Sibling", intervalMinutes: 20, source: { kind: "shopify_rest", baseUrl: base, storefrontFallback: fb } });
    await store.sites.upsert({ id: "s3", name: "Unarmed", intervalMinutes: 20, source: { kind: "shopify_rest", baseUrl: base } });

    const now = Date.now();
    // Flapper: due for a check, already 2 via-flips in the window → this check's
    // failover is flip #3 → flap-pin.
    await store.state.save("s1", {
      lastChecked: new Date(now - 60 * 60_000).toISOString(),
      products: { a: norm("a") },
      viaFlips: [new Date(now - 2 * 3_600_000).toISOString(), new Date(now - 1 * 3_600_000).toISOString()],
    });
    // Sibling: NOT due this pass (fresh lastChecked) — propagation must still reach it.
    await store.state.save("s2", {
      lastChecked: new Date().toISOString(),
      products: { a: norm("a") },
    });
    // Unarmed sibling: same host, no fallback — must not be touched.
    await store.state.save("s3", {
      lastChecked: new Date().toISOString(),
      products: { a: norm("a") },
    });

    // REST is blocked (403) everywhere; the Storefront endpoint answers.
    respond = (req, res) => {
      if (req.method === "POST" && req.url?.startsWith("/api/graphql")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: { products: { pageInfo: { hasNextPage: false }, nodes: [
          { handle: "a", title: "a", availableForSale: true },
        ] } } }));
        return;
      }
      res.writeHead(403);
      res.end("blocked");
    };

    const res = await runOnce(ctx());
    expect(res.checked).toBeGreaterThanOrEqual(1);

    // Flapper pinned itself, with the one explanatory note recorded to history.
    // self_healed is history-only now (operator's call: page only real problems),
    // so the flap-pin explanation is stored but never sent to Discord.
    const s1 = await store.state.load("s1");
    expect(s1?.preferFallback).toBe(true);
    expect(sent.filter((s) => s.alert.type === "self_healed")).toHaveLength(0);
    const s1History = (await store.history.recent()).filter((h) => h.siteId === "s1");
    expect(
      s1History.some(
        (h) => h.type === "self_healed" && ((h.payload as { note?: string })?.note ?? "").includes("flapping"),
      ),
    ).toBe(true);

    // Sibling got pre-pinned without being checked, quietly.
    const s2 = await store.state.load("s2");
    expect(s2?.preferFallback).toBe(true);
    expect(typeof s2?.lastRestProbeAt).toBe("string");
    expect(sent.filter((s) => s.site === "Sibling")).toHaveLength(0);
    const s2History = (await store.history.recent()).filter((h) => h.siteId === "s2");
    expect(s2History.some((h) => h.type === "self_healed")).toBe(true);

    // The un-armed same-host site is left alone.
    const s3 = await store.state.load("s3");
    expect(s3?.preferFallback).toBeFalsy();
  });

  it("quiet events reach history but are never sent to Discord", async () => {
    // Prev state: on the fallback channel, with a self_healed ping sent 10 min
    // ago. REST (the local server) answers -> recovery transition -> the event
    // is damped (quiet) -> history yes, Discord no.
    await store.state.save("s1", {
      lastChecked: new Date(Date.now() - 60 * 60_000).toISOString(),
      products: { a: { handle: "a", title: "a", url: `${base}/products/a`, tags: [], available: true, minPrice: 50 },
                  b: { handle: "b", title: "b", url: `${base}/products/b`, tags: [], available: true, minPrice: 50 } },
      fetchVia: "storefront_fallback",
      lastSelfHealedPingAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    await runOnce(ctx());
    expect(sent.filter((s) => s.alert.type === "self_healed")).toHaveLength(0);
    expect((await store.history.recent()).some((h) => h.type === "self_healed")).toBe(true);
  });

  it("collapses an all-sites-failing pass into one system_degraded page (2d)", async () => {
    // Disable the working site; add two sites pointing at a dead port so both fail.
    await store.sites.setEnabled("s1", false);
    const dead = "http://127.0.0.1:9"; // connection refused → fast failure
    await store.sites.upsert({ id: "d1", name: "Dead One", intervalMinutes: 20, source: { kind: "shopify_rest", baseUrl: dead } });
    await store.sites.upsert({ id: "d2", name: "Dead Two", intervalMinutes: 20, source: { kind: "shopify_rest", baseUrl: dead } });

    const res = await runOnce(ctx());
    expect(res.checked).toBe(2);
    const types = sent.map((s) => s.alert.type);
    expect(types).toContain("system_degraded");
    // The per-site errors are suppressed in favor of the single aggregate page.
    expect(types).not.toContain("site_error");
    expect(types.filter((t) => t === "system_degraded")).toHaveLength(1);
    // And it's recorded in history under a null siteId.
    expect((await store.history.recent()).some((h) => h.type === "system_degraded")).toBe(true);
  });

  // ── Cross-site duplicate suppression (2b) ─────────────────────────────────
  it("pages once when two checkers on the same host see the same product", async () => {
    // Two sites, same host, overlapping rosters — the sharedpour.com shape.
    await store.sites.upsert({
      id: "s2",
      name: "Local Shop (second view)",
      intervalMinutes: 20,
      source: { kind: "shopify_rest", baseUrl: base },
    });
    await runOnce(ctx()); // baseline both
    products = [...products, shopifyProduct("newbottle", true)];
    await store.state.save("s1", { ...(await store.state.load("s1"))!, lastChecked: null });
    await store.state.save("s2", { ...(await store.state.load("s2"))!, lastChecked: null });

    await runOnce(ctx());
    const pages = sent.filter((s) => s.alert.type === "new_product");
    expect(pages).toHaveLength(1); // one drop, one ping — not one per checker
    // But BOTH sites still recorded it: nothing is hidden from the dashboard.
    const rows = (await store.history.recent(50)).filter((h) => h.type === "new_product");
    expect(rows.map((r) => r.siteId).sort()).toEqual(["s1", "s2"]);
  });

  it("respects alerts.dedupeAcrossSites: false on a site that must always page", async () => {
    await store.sites.upsert({
      id: "s2",
      name: "Independent View",
      intervalMinutes: 20,
      alerts: { dedupeAcrossSites: false },
      source: { kind: "shopify_rest", baseUrl: base },
    });
    await runOnce(ctx());
    products = [...products, shopifyProduct("newbottle", true)];
    await store.state.save("s1", { ...(await store.state.load("s1"))!, lastChecked: null });
    await store.state.save("s2", { ...(await store.state.load("s2"))!, lastChecked: null });

    await runOnce(ctx());
    expect(sent.filter((s) => s.alert.type === "new_product")).toHaveLength(2);
  });

  // ── Per-site digest (3c) ──────────────────────────────────────────────────
  it("collapses a flood of product alerts from one site into a single digest", async () => {
    await runOnce(ctx()); // baseline with 2 products
    products = [...products, ...Array.from({ length: 9 }, (_, i) => shopifyProduct(`drop${i}`, true))];
    await store.state.save("s1", { ...(await store.state.load("s1"))!, lastChecked: null });

    await runOnce(ctx());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.alert.product.title).toContain("9 changes");
    expect(sent[0]!.alert.product.note).toContain("drop0");
    // Every individual alert is still in history.
    expect((await store.history.recent(50)).filter((h) => h.type === "new_product")).toHaveLength(9);
  });

  // ── Quarantine (2a) ───────────────────────────────────────────────────────
  it("auto-disables a site that has failed the same way for days, and pages once", async () => {
    await store.sites.upsert({
      id: "dead",
      name: "Gone Forever",
      intervalMinutes: 20,
      source: { kind: "shopify_rest", baseUrl: "http://127.0.0.1:9" },
    });
    // Simulate a long-running identical failure streak.
    await store.state.save("dead", {
      lastChecked: null,
      consecutiveErrors: 40,
      errorStreakSince: new Date(Date.now() - 5 * 86_400_000).toISOString(),
      errorAlertSent: true,
    });

    await runOnce(ctx());
    expect((await store.sites.get("dead"))?.enabled).toBe(false);
    const page = sent.find((s) => s.alert.product.note?.includes("Monitoring PAUSED"));
    expect(page).toBeDefined();
    // A quarantined site is dropped from the pass, so it can't make a healthy
    // pass look systemic or add a phantom checker to the host rollup.
    expect(sent.map((s) => s.alert.type)).not.toContain("system_degraded");
  });

  it("does not quarantine a site whose failure streak is young", async () => {
    await store.sites.upsert({
      id: "flaky",
      name: "Just Started Failing",
      intervalMinutes: 20,
      source: { kind: "shopify_rest", baseUrl: "http://127.0.0.1:9" },
    });
    await store.state.save("flaky", {
      lastChecked: null,
      consecutiveErrors: 40,
      errorStreakSince: new Date(Date.now() - 3 * 3_600_000).toISOString(), // 3h
    });
    await runOnce(ctx());
    expect((await store.sites.get("flaky"))?.enabled).toBe(true);
  });
});
