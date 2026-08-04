import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type BeaconStore } from "@beacon/db";
import { UNICORN_CONFIG_META_KEY, UNICORN_STATE_META_KEY, parseUnicornScanState } from "@beacon/core";
import type { Alert } from "@beacon/shared";
import { maybeScanUnicorn, type UnicornScanOverrides } from "./unicorn.js";
import type { RunContext } from "./run.js";

let store: BeaconStore;
let sent: Array<{ siteName: string; alert: Alert }>;

beforeEach(async () => {
  store = await openStore({ url: ":memory:" });
  sent = [];
});
afterEach(() => {
  store.close();
});

function ctx(withChannel = true): RunContext {
  return {
    store,
    dryRun: false,
    log: () => {},
    ...(withChannel
      ? {
          channel: {
            name: "test",
            send: async (siteName: string, alert: Alert) => {
              sent.push({ siteName, alert });
            },
          },
        }
      : {}),
  };
}

const CONFIG = {
  baseUrl: "https://unicorn.example.com",
  listingPath: "/api/lots?page={page}",
  format: "json_api",
  pageDelayMs: 0,
  terms: [{ term: "weller", inName: true, inDesc: false }],
};

function lotsPage(lots: unknown[], hasMore = false) {
  return JSON.stringify({ lots, hasMore });
}

/** fetchImpl serving one page per call from a queue keyed by page param. */
function fetchFromPages(pages: Record<string, string>, hits?: string[]): UnicornScanOverrides["fetchImpl"] {
  return async (url) => {
    hits?.push(url);
    const page = new URL(url).searchParams.get("page") ?? "1";
    const body = pages[page];
    if (!body) throw new Error(`no fixture for page ${page}`);
    return body;
  };
}

async function saveConfig(cfg: unknown = CONFIG) {
  await store.meta.set(UNICORN_CONFIG_META_KEY, JSON.stringify(cfg));
}

async function loadState() {
  return parseUnicornScanState(await store.meta.get(UNICORN_STATE_META_KEY));
}

describe("maybeScanUnicorn", () => {
  it("no-ops (once-logged) when unconfigured", async () => {
    const out = await maybeScanUnicorn(ctx());
    expect(out.ran).toBe(false);
    expect(await store.meta.get(UNICORN_STATE_META_KEY)).toBeUndefined();
  });

  it("first scan baselines quietly; later scans alert only on NEW matched lots and refresh bids silently", async () => {
    await saveConfig();
    const weller = { id: 1, title: "Weller 12 Year", url: "/lots/1", current_bid: 100 };

    // Scan 1: baseline — matched lot stored, nothing sent.
    let out = await maybeScanUnicorn(ctx(), { fetchImpl: fetchFromPages({ "1": lotsPage([weller]) }) });
    expect(out).toMatchObject({ ran: true, newMatches: 0 });
    expect(sent).toHaveLength(0);
    let state = await loadState();
    expect(Object.keys(state.lots)).toEqual(["1"]);
    expect(state.lots["1"]!.currentBidDollars).toBe(100);

    // Scan 2: same lot, higher bid + one new match ⇒ exactly one alert; bid updated.
    out = await maybeScanUnicorn(ctx(), {
      intervalMs: 0,
      fetchImpl: fetchFromPages({
        "1": lotsPage([
          { ...weller, current_bid: 250 },
          { id: 2, title: "Weller Full Proof", url: "/lots/2", current_bid: 90 },
        ]),
      }),
    });
    expect(out.newMatches).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.alert.type).toBe("new_product");
    expect(sent[0]!.alert.product.title).toContain("Weller Full Proof");
    state = await loadState();
    expect(state.lots["1"]!.currentBidDollars).toBe(250);
    expect(state.rawLotCount).toBe(2);
    expect(state.lastError).toBeNull();

    // Scan 3: lot 1 vanished (auction ended) ⇒ dropped silently, no alert.
    sent = [];
    out = await maybeScanUnicorn(ctx(), {
      intervalMs: 0,
      fetchImpl: fetchFromPages({ "1": lotsPage([{ id: 2, title: "Weller Full Proof", url: "/lots/2", current_bid: 120 }]) }),
    });
    expect(sent).toHaveLength(0);
    state = await loadState();
    expect(Object.keys(state.lots)).toEqual(["2"]);
  });

  it("paginates until the no-more signal and stops on all-repeat pages", async () => {
    await saveConfig({ ...CONFIG, terms: [{ term: "zzz", inName: true, inDesc: false }] });
    const hits: string[] = [];
    await maybeScanUnicorn(ctx(), {
      fetchImpl: fetchFromPages(
        {
          "1": lotsPage([{ id: 1, title: "A", url: "/lots/1" }], true),
          "2": lotsPage([{ id: 2, title: "B", url: "/lots/2" }], true),
          "3": lotsPage([{ id: 2, title: "B", url: "/lots/2" }], true), // repeat page ⇒ stop
        },
        hits,
      ),
    });
    expect(hits).toHaveLength(3);
    expect((await loadState()).rawLotCount).toBe(2);
  });

  it("gates to one scan per interval; forceScanRequested bypasses and is consumed", async () => {
    await saveConfig();
    const hits: string[] = [];
    const over: UnicornScanOverrides = { fetchImpl: fetchFromPages({ "1": lotsPage([]) }, hits) };

    expect((await maybeScanUnicorn(ctx(), over)).ran).toBe(true);
    expect((await maybeScanUnicorn(ctx(), over)).ran).toBe(false); // within 24h
    expect(hits).toHaveLength(1);

    const state = await loadState();
    await store.meta.set(UNICORN_STATE_META_KEY, JSON.stringify({ ...state, forceScanRequested: true }));
    expect((await maybeScanUnicorn(ctx(), over)).ran).toBe(true);
    expect((await loadState()).forceScanRequested).toBe(false);
    expect((await maybeScanUnicorn(ctx(), over)).ran).toBe(false); // force consumed
  });

  it("isolates failures: records lastError, never throws, and warns Discord once after 3 straight failures", async () => {
    await saveConfig();
    const failing: UnicornScanOverrides = {
      intervalMs: 0,
      fetchImpl: async () => {
        throw new Error("HTTP 403 for https://unicorn.example.com");
      },
    };

    for (let i = 1; i <= 4; i++) {
      const out = await maybeScanUnicorn(ctx(), failing); // must not throw
      expect(out.error).toContain("403");
      const state = await loadState();
      expect(state.consecutiveFailures).toBe(i);
      expect(state.lastError).toContain("403");
    }
    // One warning at failure #3, none at #4.
    const warnings = sent.filter((s) => s.alert.type === "site_error");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.alert.product.note).toContain("Site tracking is unaffected");

    // Recovery clears the streak and re-arms the warning.
    const out = await maybeScanUnicorn(ctx(), { intervalMs: 0, fetchImpl: fetchFromPages({ "1": lotsPage([]) }) });
    expect(out.error).toBeUndefined();
    const state = await loadState();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastError).toBeNull();
    expect(state.errorAlerted).toBe(false);
  });

  it("stays paused on disabled or invalid config", async () => {
    await saveConfig({ ...CONFIG, enabled: false });
    expect((await maybeScanUnicorn(ctx())).ran).toBe(false);

    await store.meta.set(UNICORN_CONFIG_META_KEY, "{corrupt");
    expect((await maybeScanUnicorn(ctx())).ran).toBe(false);
  });

  it("appends new-match alerts to alert_history under the unicorn label", async () => {
    await saveConfig();
    const over = (bid: number, extra: unknown[] = []): UnicornScanOverrides => ({
      intervalMs: 0,
      fetchImpl: fetchFromPages({ "1": lotsPage([{ id: 1, title: "Weller 12", url: "/lots/1", current_bid: bid }, ...extra]) }),
    });
    await maybeScanUnicorn(ctx(), over(100)); // baseline
    await maybeScanUnicorn(ctx(), over(100, [{ id: 9, title: "Weller CYPB", url: "/lots/9", current_bid: 55 }]));

    const rows = await store.history.recent(10);
    const match = rows.find((r) => r.type === "new_product");
    expect(match?.siteId).toBe("unicorn_auctions");
    expect(match?.title).toContain("Weller CYPB");
    const baseline = rows.find((r) => r.type === "baseline");
    expect(baseline?.siteId).toBe("unicorn_auctions");
  });
});
