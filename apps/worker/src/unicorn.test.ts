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

  it("graphql format: POSTs the query, pages via variables, and attaches the bearer token", async () => {
    await store.secrets.set("unicorn_token", "tok-123");
    await saveConfig({
      baseUrl: "https://www.unicornauctions.com",
      format: "graphql",
      lotUrlTemplate: "/lots/{id}",
      pageDelayMs: 0,
      terms: [{ term: "weller", inName: true, inDesc: false }],
      graphql: {
        endpoint: "https://graphql.example.com/graphql",
        operationName: "SearchLots",
        query: "query SearchLots($input: SearchLotInput!) { searchLots(input: $input) { count } }",
        pageSize: 2,
        variables: { input: { page: "{page}", limit: "{limit}" } },
        authTokenRef: "unicorn_token",
      },
    });

    const posts: Array<{ url: string; body: string; auth?: string }> = [];
    const lot = (uuid: string, title: string, amount: number | null) => ({
      uuid,
      title,
      description: "desc",
      currentBid: amount == null ? null : { amount },
    });
    const reply = (results: unknown[], next: string) =>
      JSON.stringify({ data: { searchLots: { count: 4, next, results } } });

    const over: UnicornScanOverrides = {
      postImpl: async (url, body, opts) => {
        posts.push({ url, body, auth: opts.headers?.["Authorization"] });
        const page = (JSON.parse(body) as { variables: { input: { page: number } } }).variables.input.page;
        return page === 1
          ? reply([lot("a", "Weller 12", 425), lot("b", "Scotch 18", null)], "true")
          : reply([lot("c", "Weller Antique", 300)], "false");
      },
    };

    // Baseline, then a real scan so matches alert.
    await maybeScanUnicorn(ctx(), over);
    sent = [];
    await store.meta.set(UNICORN_STATE_META_KEY, JSON.stringify({ ...(await loadState()), lots: {} }));
    await maybeScanUnicorn(ctx(), { ...over, intervalMs: 0 });

    expect(posts.every((p) => p.url === "https://graphql.example.com/graphql")).toBe(true);
    expect(posts.every((p) => p.auth === "Bearer tok-123")).toBe(true);
    // Paged until next:"false" — 2 pages per scan, 2 scans.
    expect(posts).toHaveLength(4);
    expect(JSON.parse(posts[0]!.body)).toMatchObject({
      operationName: "SearchLots",
      variables: { input: { page: 1, limit: 2 } },
    });

    const state = await loadState();
    expect(state.rawLotCount).toBe(3);
    expect(Object.keys(state.lots).sort()).toEqual(["a", "c"]); // both Wellers matched
    expect(state.lots["a"]!.currentBidDollars).toBe(425);
    expect(state.lots["a"]!.url).toBe("https://www.unicornauctions.com/lots/a");
    expect(sent.map((s) => s.alert.product.title)).toEqual(
      expect.arrayContaining([expect.stringContaining("Weller 12"), expect.stringContaining("Weller Antique")]),
    );
  });

  it("graphql format: an errors-with-HTTP-200 body is recorded as a failure, not an empty scan", async () => {
    await saveConfig({
      format: "graphql",
      pageDelayMs: 0,
      terms: [{ term: "weller", inName: true, inDesc: false }],
      graphql: {
        endpoint: "https://graphql.example.com/graphql",
        query: "query { searchLots { count } }",
        variables: {},
      },
    });
    const out = await maybeScanUnicorn(ctx(), {
      postImpl: async () => JSON.stringify({ errors: [{ message: "Signature has expired" }], data: null }),
    });
    expect(out.error).toContain("Signature has expired");
    expect((await loadState()).lastError).toContain("Signature has expired");
  });

  it("puts the target bottle and the walk-away verdict in the Discord alert", async () => {
    await saveConfig({
      ...CONFIG,
      terms: [{ term: "virgin bourbon", inName: true, inDesc: false, bottleId: "a4" }],
      bottles: [
        {
          id: "a4",
          rank: "A4",
          name: "Virgin Bourbon 7 Year, 101 proof",
          maxHammerDollars: 175,
          notes: "Best actual buy (B1).",
        },
      ],
    });
    const page = (bid: number) =>
      lotsPage([{ id: 1, title: "Virgin Bourbon 7 Year 101 (1990s)", url: "/lots/1", current_bid: bid }]);

    // Baseline, clear stored lots, then a real scan under the max.
    await maybeScanUnicorn(ctx(), { fetchImpl: fetchFromPages({ "1": page(95) }) });
    await store.meta.set(UNICORN_STATE_META_KEY, JSON.stringify({ ...(await loadState()), lots: {} }));
    sent = [];
    await maybeScanUnicorn(ctx(), { intervalMs: 0, fetchImpl: fetchFromPages({ "1": page(95) }) });

    let note = sent[0]!.alert.product.note!;
    expect(note).toContain("A4 · Virgin Bourbon 7 Year, 101 proof");
    expect(note).toContain("Max hammer $175");
    expect(note).toContain("✅ Under your max");
    expect(note).toContain("$80 of room left"); // 175 - 95
    expect(note).toContain("Best actual buy (B1).");

    // Now above the max hammer.
    await store.meta.set(UNICORN_STATE_META_KEY, JSON.stringify({ ...(await loadState()), lots: {} }));
    sent = [];
    await maybeScanUnicorn(ctx(), { intervalMs: 0, fetchImpl: fetchFromPages({ "1": page(400) }) });
    note = sent[0]!.alert.product.note!;
    expect(note).toContain("⛔ Already ABOVE your max");
    expect(note).toContain("$532 delivered"); // 400 * 1.15 * 1.1025 + 25

    expect((await loadState()).lots["1"]!.bottleIds).toEqual(["a4"]);
  });

  it("never alerts on or stores a dismissed lot, even when it still matches a term", async () => {
    const weller = { id: 1, title: "Weller 12 Year", url: "/lots/1", current_bid: 100 };
    const decoy = { id: 2, title: "Weller-branded glassware", url: "/lots/2", current_bid: 15 };
    await saveConfig({ ...CONFIG, ignoredLots: [{ id: "2", title: "Weller-branded glassware", at: "" }] });

    // Baseline, then a real scan.
    const over = { fetchImpl: fetchFromPages({ "1": lotsPage([weller, decoy]) }) };
    await maybeScanUnicorn(ctx(), over);
    await store.meta.set(UNICORN_STATE_META_KEY, JSON.stringify({ ...(await loadState()), lots: {} }));
    sent = [];
    await maybeScanUnicorn(ctx(), { ...over, intervalMs: 0 });

    const state = await loadState();
    expect(Object.keys(state.lots)).toEqual(["1"]); // the decoy is never stored
    expect(state.rawLotCount).toBe(2); // but it was still scanned
    expect(sent).toHaveLength(1);
    expect(sent[0]!.alert.product.title).toContain("Weller 12 Year");
  });

  it("sends browser-coherent headers — a POST with no User-Agent is itself a bot tell", async () => {
    await saveConfig({ format: "graphql", pageDelayMs: 0, terms: [{ term: "weller" }] });
    let headers: Record<string, string> = {};
    await maybeScanUnicorn(ctx(), {
      postImpl: async (_u, _b, opts) => {
        headers = opts.headers ?? {};
        return JSON.stringify({ data: { searchLots: { count: 1, next: "false", results: [] } } });
      },
    });
    expect(headers["User-Agent"]).toMatch(/Mozilla\/5\.0/);
    expect(headers["Accept-Language"]).toBeTruthy();
    expect(headers["Origin"]).toBe("https://www.unicornauctions.com");
    expect(headers["Referer"]).toBe("https://www.unicornauctions.com/");
    // Client hints must match the UA they ship with, not be mixed and matched.
    if (headers["Sec-CH-UA-Platform"]) {
      const platform = headers["Sec-CH-UA-Platform"].replace(/"/g, "");
      const uaHint = { Windows: "Windows NT", macOS: "Mac OS X", Linux: "Linux" }[platform];
      if (uaHint) expect(headers["User-Agent"]).toContain(uaHint);
    }
  });

  it("jitters the next due time instead of firing on an exact 24h metronome", async () => {
    await saveConfig({ format: "graphql", pageDelayMs: 0, terms: [{ term: "weller" }] });
    const ok = async () => JSON.stringify({ data: { searchLots: { count: 0, next: "false", results: [] } } });

    await maybeScanUnicorn(ctx(), { postImpl: ok });
    const state = await loadState();
    const gapH = (Date.parse(state.nextDueAt!) - Date.parse(state.lastScanAt!)) / 3_600_000;
    expect(gapH).toBeGreaterThanOrEqual(22);
    expect(gapH).toBeLessThanOrEqual(26);

    // And the stored due time actually gates the next pass.
    expect((await maybeScanUnicorn(ctx(), { postImpl: ok })).ran).toBe(false);
    await store.meta.set(
      UNICORN_STATE_META_KEY,
      JSON.stringify({ ...state, nextDueAt: new Date(Date.now() - 1000).toISOString() }),
    );
    expect((await maybeScanUnicorn(ctx(), { postImpl: ok })).ran).toBe(true);
  });

  it("aborts instead of walking the archive when the roster comes back implausibly large", async () => {
    // Unicorn fails OPEN: a filter value it doesn't recognize returns all ~725k
    // historical lots rather than an error. Walking that would run for hours and
    // alert on lots that closed years ago.
    await saveConfig({ format: "graphql", maxExpectedLots: 25_000, pageDelayMs: 0, terms: [{ term: "weller" }] });
    let pages = 0;
    const out = await maybeScanUnicorn(ctx(), {
      postImpl: async () => {
        pages += 1;
        return JSON.stringify({
          data: { searchLots: { count: 725872, next: "true", results: [{ uuid: "x", title: "Weller 12" }] } },
        });
      },
    });
    expect(out.error).toMatch(/725872 lots, over the 25000 sanity limit/);
    expect(pages).toBe(1); // caught on page 1, never paged on
    expect((await loadState()).lots).toEqual({}); // no archive lots stored
  });

  it("stops on a short page — Unicorn's `next` stays \"true\" past the end of the roster", async () => {
    await saveConfig({ format: "graphql", pageDelayMs: 0, terms: [{ term: "weller" }], graphql: { pageSize: 2 } });
    const seen: number[] = [];
    await maybeScanUnicorn(ctx(), {
      postImpl: async (_u, body) => {
        const page = (JSON.parse(body) as { variables: { input: { offset: number } } }).variables.input.offset;
        seen.push(page);
        const full = [
          { uuid: `p${page}a`, title: "Weller A" },
          { uuid: `p${page}b`, title: "Weller B" },
        ];
        // Page 2 is short (1 of 2) and still claims next:"true".
        return JSON.stringify({
          data: { searchLots: { count: 3, next: "true", results: page === 1 ? full : [{ uuid: "p2a", title: "Weller C" }] } },
        });
      },
    });
    expect(seen).toEqual([1, 2]); // stopped at the short page, no wasted 3rd call
    expect((await loadState()).rawLotCount).toBe(3);
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
