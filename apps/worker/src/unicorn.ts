// Unicorn Auctions watcher — ISOLATED side-job (harvest/mirror pattern), not a
// pipeline site. Once a day (or on the dashboard's "Scan now") it pages through
// the auction listing, matches lots against the operator's term watchlist, and:
//   • NEW matched lot        → Discord embed + alert_history row
//   • existing matched lot   → silent current-bid refresh (dashboard-only)
//   • vanished lot           → dropped silently (auctions end weekly)
//
// Isolation contract (the whole point of this file's shape):
//   • All state in two meta blobs (unicorn_config / unicorn_scan_state) — no
//     sites row, no site tile, nothing on /products.
//   • Every failure is caught HERE: recorded as lastError on the /unicorn page,
//     never a site_error page, never an input to systemic-failure detection,
//     circuit breakers, or host pins. One Discord warning only after 3
//     consecutive failed days (then quiet until recovery).
//   • Own AbortController budget (180s) so a tar-pitting host can't hold the
//     check loop — well under the 15-min wedge watchdog.
//   • The daily stamp is written BEFORE the fetch (harvest precedent), so even
//     a crash-looping worker attempts at most once per interval.

import { httpGet, httpPost } from "@beacon/fetch";
import {
  buildGraphqlBody,
  descriptionCoverage,
  matchLots,
  parseUnicornListing,
  parseUnicornScanState,
  validateUnicornConfig,
  UNICORN_CONFIG_META_KEY,
  UNICORN_SITE_ID,
  UNICORN_STATE_META_KEY,
  type UnicornConfig,
  type UnicornMatch,
  type UnicornScanState,
  type UnicornStoredLot,
} from "@beacon/core";
import { identityForHost } from "@beacon/fetch";
import { jitter, sleep, type Alert } from "@beacon/shared";
import type { RunContext } from "./run.js";

const SCAN_INTERVAL_MS = 24 * 3_600_000;
// ±2 h of slop on the daily cadence. A request landing every 24.000 h is a
// metronome, and a metronome is a robot signature no matter how low the volume;
// 22–26 h drifts the slot around the clock and never repeats to the minute.
const SCAN_JITTER_MS = 2 * 3_600_000;
const SCAN_BUDGET_MS = 180_000;
const ERROR_ALERT_AFTER = 3; // consecutive failed scans (≈ days) before one Discord warning

// One log line per process when unconfigured, not one per ~60s loop.
let warnedUnconfigured = false;

export interface UnicornScanOverrides {
  /** Test hooks. */
  intervalMs?: number;
  budgetMs?: number;
  fetchImpl?: (url: string, opts: { kind: "document" | "api"; signal: AbortSignal; headers?: Record<string, string> }) => Promise<string>;
  /** Test hook for the `graphql` (POST) path. */
  postImpl?: (url: string, body: string, opts: { headers?: Record<string, string>; signal: AbortSignal }) => Promise<string>;
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface UnicornScanOutcome {
  ran: boolean;
  newMatches: number;
  error?: string;
}

/**
 * Headers coherent with a browser doing exactly what we're doing: an XHR from
 * the site's own front-end to its API. httpPost deliberately sends no browser
 * identity (it exists for Shopify/Discord server-to-server calls), so a bare
 * POST here would carry NO User-Agent at all — a louder bot signal than the ten
 * requests it's attached to. Reuses the same per-host identity machinery as
 * site checks, so the profile is stable for 6–24 h rather than re-rolling every
 * scan (a different browser from one IP each day is itself a tell).
 */
function browserHeaders(config: UnicornConfig, endpoint: string): Record<string, string> {
  const identity = identityForHost(new URL(endpoint).hostname);
  const { ua, ...clientHints } = identity.profile;
  const origin = config.baseUrl.replace(/\/$/, "");
  return {
    "User-Agent": ua,
    "Accept-Language": identity.acceptLanguage,
    ...clientHints,
    Origin: origin,
    Referer: `${origin}/`,
    // The site's own client sends this; Apollo uses it to force a CORS preflight.
    "Apollo-Require-Preflight": "true",
  };
}

function pageUrl(config: UnicornConfig, page: number): string {
  const path = config.listingPath.includes("{page}")
    ? config.listingPath.replace("{page}", String(page))
    : config.listingPath;
  return new URL(path, config.baseUrl).href;
}

async function fetchAllLots(
  config: UnicornConfig,
  headers: Record<string, string> | undefined,
  signal: AbortSignal,
  over: UnicornScanOverrides,
  log: (msg: string) => void,
): Promise<ReturnType<typeof parseUnicornListing>["lots"]> {
  const get = over.fetchImpl ?? ((url, opts) => httpGet(url, opts));
  const post = over.postImpl ?? (async (url, body, opts) => (await httpPost(url, body, opts)).body);
  const wait = over.sleepImpl ?? sleep;
  const kind = config.format === "json_api" ? ("api" as const) : ("document" as const);
  const byId = new Map<string, ReturnType<typeof parseUnicornListing>["lots"][number]>();

  for (let page = 1; page <= config.maxPages; page++) {
    let body: string;
    if (config.format === "graphql") {
      const gql = config.graphql;
      body = await post(gql.endpoint, buildGraphqlBody(config, page), {
        signal,
        headers: { Accept: "*/*", ...browserHeaders(config, gql.endpoint), ...headers },
      });
    } else {
      body = await get(pageUrl(config, page), { kind, signal, ...(headers ? { headers } : {}) });
    }
    const parsed = parseUnicornListing(body, {
      format: config.format,
      baseUrl: config.baseUrl,
      lotUrlTemplate: config.lotUrlTemplate,
    });

    // Fail-open guard: Unicorn answers an unrecognized filter value by
    // returning the whole ~725k-lot historical archive rather than erroring.
    // Catch that on page 1 — scanning it would run for hours and alert on lots
    // that closed years ago.
    if (page === 1 && config.maxExpectedLots > 0 && (parsed.total ?? 0) > config.maxExpectedLots) {
      throw new Error(
        `Roster is ${parsed.total} lots, over the ${config.maxExpectedLots} sanity limit — the query is probably ` +
          `not scoped to the current auction (check graphql.variables: state must be exactly "LIVE"). ` +
          `Scan aborted rather than walking the full archive.`,
      );
    }

    let fresh = 0;
    for (const lot of parsed.lots) {
      if (!byId.has(lot.id)) fresh += 1;
      byId.set(lot.id, lot);
    }
    // Stop on an empty page, an all-repeats page (some backends serve the last
    // page forever), a short page (the classic last-page tell), or an explicit
    // no-more signal. Unicorn needs the first three: its `next` stays "true"
    // even past the end of the roster.
    const pageSize = config.format === "graphql" ? config.graphql.pageSize : 0;
    const shortPage = pageSize > 0 && parsed.lots.length < pageSize;
    if (parsed.lots.length === 0 || fresh === 0 || shortPage || !parsed.hasMore) break;
    if (page === config.maxPages) {
      log(`[unicorn] Page cap hit (${config.maxPages}) with more pages available — raise maxPages if matches seem missing.`);
      break;
    }
    if (config.pageDelayMs > 0) await wait(config.pageDelayMs);
  }
  return [...byId.values()];
}

function buildAlert(match: UnicornMatch): Alert {
  const { lot, matchedTerms } = match;
  const bid = lot.currentBidDollars != null ? `$${lot.currentBidDollars.toLocaleString("en-US")}` : "no bid data";
  return {
    type: "new_product",
    product: {
      handle: lot.id,
      title: `🦄 ${lot.title}`,
      url: lot.url,
      minPrice: lot.currentBidDollars,
      image: lot.image ?? null,
      note: `Unicorn Auctions match on "${matchedTerms.join('", "')}" — current bid ${bid}.`,
    },
  };
}

/** Run at most one scan per interval; never throws (the run.ts call site is
 *  belt-and-braces guarded anyway). */
export async function maybeScanUnicorn(ctx: RunContext, over: UnicornScanOverrides = {}): Promise<UnicornScanOutcome> {
  const { store, channel, dryRun, log = () => {} } = ctx;
  if (dryRun) return { ran: false, newMatches: 0 };

  const rawConfig = await store.meta.get(UNICORN_CONFIG_META_KEY);
  if (!rawConfig) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      log("[unicorn] Not configured — set up the watcher on the /unicorn dashboard page.");
    }
    return { ran: false, newMatches: 0 };
  }

  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(rawConfig);
  } catch {
    parsedConfig = null;
  }
  const validated = validateUnicornConfig(parsedConfig);
  if (!validated.ok) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      log(`[unicorn] Stored config invalid (${validated.error}) — fix it on /unicorn. Scans paused.`);
    }
    return { ran: false, newMatches: 0 };
  }
  const config = validated.config!;
  if (!config.enabled) return { ran: false, newMatches: 0 };

  const state = parseUnicornScanState(await store.meta.get(UNICORN_STATE_META_KEY));
  const intervalMs = over.intervalMs ?? SCAN_INTERVAL_MS;
  // Prefer the stored (jittered) due time; fall back to the flat interval for
  // states written before nextDueAt existed, or when a test pins intervalMs.
  const dueAt =
    over.intervalMs !== undefined || !state.nextDueAt
      ? (state.lastScanAt ? Date.parse(state.lastScanAt) : 0) + intervalMs
      : Date.parse(state.nextDueAt);
  const due = state.forceScanRequested === true || !state.lastScanAt || Date.now() >= dueAt;
  if (!due) return { ran: false, newMatches: 0 };

  // Stamp BEFORE fetching so a crash can't hammer the site every loop; also
  // consume the force flag so "Scan now" fires exactly once.
  const attemptAt = new Date().toISOString();
  const jitterMs = over.intervalMs !== undefined ? 0 : SCAN_JITTER_MS;
  const stamped: UnicornScanState = {
    ...state,
    lastScanAt: attemptAt,
    nextDueAt: new Date(Date.now() + jitter(intervalMs, jitterMs)).toISOString(),
    forceScanRequested: false,
  };
  await store.meta.set(UNICORN_STATE_META_KEY, JSON.stringify(stamped));

  const controller = new AbortController();
  const budget = setTimeout(() => controller.abort(), over.budgetMs ?? SCAN_BUDGET_MS);
  try {
    let headers: Record<string, string> | undefined = config.requestHeaders;
    const authRef = config.graphql.authTokenRef;
    if (config.cookieRef || authRef) {
      const secrets = await store.secrets.all();
      const cookie = config.cookieRef ? secrets[config.cookieRef] : undefined;
      if (cookie) headers = { ...headers, Cookie: cookie };
      const token = authRef ? secrets[authRef] : undefined;
      if (token) headers = { ...headers, Authorization: token.startsWith("Bearer ") ? token : `Bearer ${token}` };
      else if (authRef) {
        log(`[unicorn] authTokenRef "${authRef}" has no stored secret — sending the request unauthenticated.`);
      }
    }

    log(`[unicorn] Scanning (${config.terms.length} term(s))...`);
    const lots = await fetchAllLots(config, headers, controller.signal, over, log);
    const matches = matchLots(lots, config.terms);

    const now = new Date().toISOString();
    const nextLots: Record<string, UnicornStoredLot> = {};
    const newMatches: UnicornMatch[] = [];
    for (const m of matches) {
      const prev = stamped.lots[m.lot.id];
      if (!prev) newMatches.push(m);
      nextLots[m.lot.id] = {
        title: m.lot.title,
        url: m.lot.url,
        currentBidDollars: m.lot.currentBidDollars,
        image: m.lot.image ?? null,
        matchedTerms: m.matchedTerms,
        firstSeenAt: prev?.firstSeenAt ?? now,
      };
    }

    // First-ever scan baselines quietly (startup-quiet spirit): everything is
    // "new" to an empty memory, and a term-list that already matches 30 live
    // lots shouldn't flood Discord on setup day.
    const firstScan = state.lastScanAt === null && Object.keys(state.lots).length === 0;
    const alerts = firstScan ? [] : newMatches.map(buildAlert);

    if (alerts.length > 0) {
      try {
        await store.history.append(UNICORN_SITE_ID, alerts);
      } catch (err) {
        log(`[unicorn] history append failed (continuing): ${(err as Error).message}`);
      }
      if (channel) {
        for (const alert of alerts) {
          try {
            await channel.send("Unicorn Auctions", alert);
          } catch (err) {
            log(`[unicorn] Discord error (continuing): ${(err as Error).message}`);
          }
        }
      }
    } else if (firstScan && newMatches.length > 0) {
      try {
        await store.history.append(UNICORN_SITE_ID, [
          {
            type: "baseline",
            product: {
              title: "Unicorn Auctions",
              url: config.baseUrl,
              note: `First scan baselined ${newMatches.length} already-matching lot(s) quietly — new matches alert from the next scan on.`,
            },
          },
        ]);
      } catch (err) {
        log(`[unicorn] history append failed (continuing): ${(err as Error).message}`);
      }
    }

    const next: UnicornScanState = {
      ...stamped,
      lastError: null,
      consecutiveFailures: 0,
      errorAlerted: false,
      rawLotCount: lots.length,
      descCoverage: descriptionCoverage(lots),
      lots: nextLots,
    };
    await store.meta.set(UNICORN_STATE_META_KEY, JSON.stringify(next));
    log(`[unicorn] Scan done: ${lots.length} lots, ${matches.length} matched, ${firstScan ? `${newMatches.length} baselined` : `${newMatches.length} new`}.`);
    return { ran: true, newMatches: firstScan ? 0 : newMatches.length };
  } catch (err) {
    const msg = controller.signal.aborted
      ? `Scan timed out after ${Math.round((over.budgetMs ?? SCAN_BUDGET_MS) / 1000)}s`
      : (err as Error).message;
    const failures = stamped.consecutiveFailures + 1;
    let errorAlerted = stamped.errorAlerted === true;
    log(`[unicorn] Scan failed (${failures} in a row): ${msg}`);

    if (failures >= ERROR_ALERT_AFTER && !errorAlerted && channel) {
      errorAlerted = true;
      const warning: Alert = {
        type: "site_error",
        product: {
          title: "Unicorn Auctions watcher",
          url: config.baseUrl,
          note:
            `The Unicorn scan has failed ${failures} days in a row (latest: ${msg}). ` +
            `Site tracking is unaffected — this is the isolated auction watcher. Check /unicorn ` +
            `(the listing format/path may have changed, or the site may block this server's IP).`,
        },
      };
      try {
        await store.history.append(UNICORN_SITE_ID, [warning]);
        await channel.send("Unicorn Auctions", warning);
      } catch (e) {
        log(`[unicorn] Discord error-warning failed (continuing): ${(e as Error).message}`);
      }
    }

    try {
      await store.meta.set(
        UNICORN_STATE_META_KEY,
        JSON.stringify({ ...stamped, lastError: msg, consecutiveFailures: failures, errorAlerted }),
      );
    } catch (e) {
      log(`[unicorn] state save failed after error (continuing): ${(e as Error).message}`);
    }
    return { ran: true, newMatches: 0, error: msg };
  } finally {
    clearTimeout(budget);
  }
}
