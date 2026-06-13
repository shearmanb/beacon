// Persistent Railway worker. Loops every ~60 s; per-site shouldCheck() gates
// actual fetches. State is kept in memory and pushed to GitHub after each
// changed run so the dashboard continues to read from raw GitHub URLs.

import { sendAlert as sendDiscordAlert } from "./notifiers/discord.js";
import { readFile, writeFile } from "./lib/github.js";
import { shouldCheck } from "./lib/schedule.js";
import { loadStrategy, strategyNames } from "./lib/strategies.js";
import { sleep, jitter } from "./lib/utils.js";
import { https } from "./lib/fetch.js";

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const HEALTHCHECK_URL = process.env.HEALTHCHECK_URL; // optional dead-man ping
const LOOP_BASE_MS = 60_000;
const IMMINENT_LOOP_MS = 10_000; // tighter loop floor when any site is imminent
const MAX_HISTORY = 500;
const MAX_ARCHIVE = 5000; // hard ceiling on the archive so it can't grow unbounded
const ERROR_ALERT_THRESHOLD = 5; // consecutive failures before paging Discord
const DEFAULT_IMMINENT_DURATION_MIN = 20;
// Routine state changes (just checkHistory/lastChecked ticking over) don't need
// a GitHub commit every loop — that's the main source of commit spam and 409s.
// Push immediately when something noteworthy happened (alerts/errors); otherwise
// hold and push at most this often. State always lives in memory so nothing is
// lost — only the dashboard's view of it lags slightly.
const STATE_PUSH_MIN_INTERVAL_MS = 5 * 60_000;
// Consecutive loops where the GitHub reads at the top of run() all failed.
// Past this we assume GitHub is unreachable or GH_TOKEN expired (R4) and stop
// pretending we're healthy — see startLoop().
const GITHUB_FAILURE_THRESHOLD = 3;
// Escalating per-site cooldown after a 429/403 — back off immediately when a
// site pushes back instead of re-hitting it on the normal schedule.
const COOLDOWN_STEPS_MIN = [5, 15, 60];

// ── In-memory state ───────────────────────────────────────────────────────────

let globalState = {};
let stateFileSha = null;
let lastStatePushAt = 0;          // 2e: throttle routine state pushes
let anyImminentActive = false;    // 2d: drives the loop-sleep floor
let githubFailureStreak = 0;      // 2b: consecutive GitHub-read failures
let githubFailureAlerted = false; // 2b: suppress repeat token-down pages

async function loadStartupState() {
  console.log("[startup] Fetching state.json from GitHub...");
  const res = await readFile("state.json");
  if (res.content) {
    try {
      globalState = JSON.parse(res.content);
    } catch {
      console.error("[startup] state.json parse failed — starting empty");
      globalState = {};
    }
    stateFileSha = res.sha;
  }
  console.log(`[startup] Ready. ${Object.keys(globalState).length} sites in state.`);
}

// On 409 conflict we re-fetch the latest remote state and merge: for sites
// this loop touched, our in-memory data wins (it's fresher); for everything
// else, the remote wins (we'd be discarding a concurrent writer's entry).
async function pushState(touchedSiteIds) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const newSha = await writeFile(
        "state.json",
        JSON.stringify(globalState, null, 2),
        stateFileSha,
        "chore: update state [skip ci]"
      );
      if (newSha) stateFileSha = newSha;
      return;
    } catch (err) {
      if (!err.message.includes("409") || attempt !== 0) throw err;
      console.warn("[pushState] 409 conflict — merging with remote state");
      const res = await readFile("state.json");
      stateFileSha = res.sha;
      let remote = {};
      try { remote = JSON.parse(res.content ?? "{}"); } catch { remote = {}; }
      const merged = { ...remote };
      for (const id of touchedSiteIds) {
        if (globalState[id] !== undefined) merged[id] = globalState[id];
      }
      globalState = merged;
    }
  }
}

async function appendAndPushHistory(events) {
  // Always re-read on each call so we have the latest sha and don't lose
  // entries pushed by a concurrent writer.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await readFile("alert_history.json");
    const historyFileSha = res.sha;
    let history = [];
    if (res.content) {
      try { history = JSON.parse(res.content); } catch { /* start fresh */ }
    }
    history.push(...events);
    // When trimming, the evicted oldest entries aren't dropped — they're moved
    // to alert_history_archive.json (never trimmed by the dashboard) so the
    // full alert record is never permanently lost.
    let evicted = [];
    if (history.length > MAX_HISTORY) {
      evicted = history.slice(0, history.length - MAX_HISTORY);
      history = history.slice(history.length - MAX_HISTORY);
    }
    try {
      await writeFile(
        "alert_history.json",
        JSON.stringify(history, null, 2),
        historyFileSha,
        "chore: update history [skip ci]"
      );
      if (evicted.length) await appendToArchive(evicted);
      return;
    } catch (err) {
      if (err.message.includes("409") && attempt === 0) continue;
      throw err;
    }
  }
}

// Appends evicted history entries to alert_history_archive.json. Best-effort:
// a failure here is logged but never blocks the main history write above.
async function appendToArchive(evicted) {
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await readFile("alert_history_archive.json");
      let archive = [];
      if (res.content) {
        try { archive = JSON.parse(res.content); } catch { /* start fresh */ }
      }
      archive.push(...evicted);
      if (archive.length > MAX_ARCHIVE) archive = archive.slice(archive.length - MAX_ARCHIVE);
      try {
        await writeFile(
          "alert_history_archive.json",
          JSON.stringify(archive, null, 2),
          res.sha,
          "chore: archive history [skip ci]"
        );
        return;
      } catch (err) {
        if (err.message.includes("409") && attempt === 0) continue;
        throw err;
      }
    }
  } catch (err) {
    console.error(`[archive] Failed to append ${evicted.length} evicted entries: ${err.message}`);
  }
}

// Re-reads config.json, applies `updates` to the named site, and writes back.
// Retries once on 409 conflict.
async function updateConfigSiteFields(siteId, updates, message) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await readFile("config.json");
    if (!res.content) throw new Error("config.json missing");
    let cfg;
    try { cfg = JSON.parse(res.content); }
    catch { throw new Error("config.json parse failed"); }
    const site = cfg.sites?.find((s) => s.id === siteId);
    if (!site) return false;
    Object.assign(site, updates);
    try {
      await writeFile("config.json", JSON.stringify(cfg, null, 2) + "\n", res.sha, message);
      return true;
    } catch (err) {
      if (err.message.includes("409") && attempt === 0) continue;
      throw err;
    }
  }
  return false;
}

async function fetchJsonFile(path) {
  const res = await readFile(path);
  if (!res.content) return null;
  try { return JSON.parse(res.content); } catch { return null; }
}

// ── Schedule validation ───────────────────────────────────────────────────────
// schedules.json is hand/dashboard-edited. A malformed definition would
// otherwise fail soft (resolveNamedSchedule returns null → site silently falls
// back to intervalMinutes). Drop malformed definitions, warn once per start,
// and keep the valid ones so one bad entry can't take out the rest.
const invalidSchedulesAlerted = new Set();

function scheduleDefError(def) {
  if (!def || typeof def !== "object") return "not an object";
  if (!Array.isArray(def.rules) || def.rules.length === 0) return "missing rules array";
  for (const rule of def.rules) {
    if (rule == null || typeof rule !== "object") return "rule is not an object";
    const isDefault = rule.defaultInterval != null;
    const isWindow = rule.fromHour != null || rule.toHour != null || rule.interval != null;
    if (isDefault) {
      if (!Number.isFinite(rule.defaultInterval) || rule.defaultInterval < 1) return "bad defaultInterval";
    } else if (isWindow) {
      if (!Number.isFinite(rule.fromHour) || !Number.isFinite(rule.toHour)) return "window missing fromHour/toHour";
      if (!Number.isFinite(rule.interval) || rule.interval < 1) return "window missing valid interval";
    } else {
      return "rule is neither a window nor a default";
    }
  }
  return null;
}

async function validateSchedules(schedules) {
  const valid = {};
  for (const [key, def] of Object.entries(schedules ?? {})) {
    const reason = scheduleDefError(def);
    if (reason === null) { valid[key] = def; continue; }
    const alertKey = `${key}: ${reason}`;
    console.error(`[schedules] Dropping malformed schedule "${key}" — ${reason}`);
    if (DISCORD_WEBHOOK && !invalidSchedulesAlerted.has(alertKey)) {
      invalidSchedulesAlerted.add(alertKey);
      try {
        await sendDiscordAlert(DISCORD_WEBHOOK, "schedules.json", {
          type: "site_error",
          product: {
            title: `Invalid schedule: ${key}`,
            url: "https://github.com",
            note: `schedules.json validation failed (${reason}) — definition dropped. Sites using it fall back to intervalMinutes.`,
          },
        });
      } catch (err) {
        console.error(`[schedules] Discord invalid-schedule alert failed: ${err.message}`);
      }
    }
  }
  return valid;
}

// ── Config validation ─────────────────────────────────────────────────────────
// A hand-edited config.json with a typo'd strategy or missing URL would
// otherwise fail silently every loop. Invalid sites are skipped (valid ones
// still run) and flagged once on Discord per worker start.

const invalidSitesAlerted = new Set();

function validateSite(site, seenIds) {
  if (!site.id || typeof site.id !== "string") return "missing id";
  if (seenIds.has(site.id)) return `duplicate id "${site.id}"`;
  if (!strategyNames.includes(site.strategy)) return `unknown strategy "${site.strategy}"`;
  if (!site.url) return "missing url";
  try { new URL(site.url); } catch { return `invalid url "${site.url}"`; }
  return null;
}

async function filterValidSites(sites) {
  const valid = [];
  const seenIds = new Set();
  for (const site of sites) {
    const reason = validateSite(site, seenIds);
    if (reason === null) {
      seenIds.add(site.id);
      valid.push(site);
      continue;
    }
    const key = `${site.id ?? site.name ?? "?"}: ${reason}`;
    console.error(`[config] Skipping invalid site — ${key}`);
    if (DISCORD_WEBHOOK && !invalidSitesAlerted.has(key)) {
      invalidSitesAlerted.add(key);
      try {
        await sendDiscordAlert(DISCORD_WEBHOOK, site.name ?? site.id ?? "config", {
          type: "site_error",
          product: {
            title: `Invalid config entry: ${site.name ?? site.id ?? "?"}`,
            url: site.url ?? "https://github.com",
            note: `config.json validation failed (${reason}) — site is being skipped until fixed.`,
          },
        });
      } catch (err) {
        console.error(`[config] Discord invalid-site alert failed: ${err.message}`);
      }
    }
  }
  return valid;
}

// ── Product provenance ────────────────────────────────────────────────────────
// Carries per-product metadata across checks: firstSeen powers the dashboard's
// NEW badge, prevPrice/priceChangedAt its price-delta arrows. Deltas expire
// after 7 days so an old price change doesn't wear an arrow forever.
const PRICE_DELTA_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function annotateProducts(prevProducts = {}, products = {}) {
  const now = new Date().toISOString();
  for (const [handle, p] of Object.entries(products ?? {})) {
    const prev = (prevProducts ?? {})[handle];
    if (!prev) { p.firstSeen = now; continue; }
    if (prev.firstSeen) p.firstSeen = prev.firstSeen;
    if (prev.minPrice != null && p.minPrice != null && prev.minPrice !== p.minPrice) {
      p.prevPrice = prev.minPrice;
      p.priceChangedAt = now;
    } else if (prev.prevPrice != null && prev.priceChangedAt &&
               Date.now() - new Date(prev.priceChangedAt).getTime() < PRICE_DELTA_TTL_MS) {
      p.prevPrice = prev.prevPrice;
      p.priceChangedAt = prev.priceChangedAt;
    }
  }
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  // Fetch config, ignored, and schedules fresh each loop so dashboard changes
  // take effect without a redeploy.
  let config = null;
  let ignored = {};
  let schedules = {};
  try {
    const [c, i, s] = await Promise.all([
      fetchJsonFile("config.json"),
      fetchJsonFile("ignored_products.json"),
      fetchJsonFile("schedules.json"),
    ]);
    config = c;
    ignored = i ?? {};
    schedules = s ?? {};
    // config.json is the one file that must be present — a null here means the
    // read failed (network/404/token), not just an empty optional file.
    if (config) { githubFailureStreak = 0; githubFailureAlerted = false; }
    else githubFailureStreak++;
  } catch (err) {
    console.error("[run] Failed to fetch config/ignored/schedules:", err.message);
    githubFailureStreak++;
  }
  if (!config?.sites?.length) {
    console.error("[run] No sites in config.json — skipping run.");
    return;
  }
  schedules = await validateSchedules(schedules);
  config.sites = await filterValidSites(config.sites);
  if (!config.sites.length) {
    console.error("[run] No valid sites after config validation — skipping run.");
    return;
  }
  // Drives the loop-sleep floor in startLoop(): a tighter ~10 s cadence while
  // any enabled site is in imminent mode, normal ~60 s otherwise.
  anyImminentActive = config.sites.some((s) => s.enabled && s.imminent);

  const newHistory = [];
  const touchedSiteIds = [];
  let stateChanged = false;

  // Imminent mode auto-off: any site whose imminent timer has elapsed gets
  // flipped back off and its prior schedule restored. Fires a Discord alert
  // so you know the cooldown started.
  for (const site of config.sites) {
    if (!site.imminent || !site.imminentSince) continue;
    const durationMin = site.imminentDurationMinutes ?? DEFAULT_IMMINENT_DURATION_MIN;
    const elapsedMs = Date.now() - new Date(site.imminentSince).getTime();
    if (!(elapsedMs >= durationMin * 60_000)) continue;

    const restoredSchedule = site.scheduleBeforeImminent ?? site.schedule ?? null;
    try {
      await updateConfigSiteFields(site.id, {
        imminent: false,
        imminentSince: null,
        scheduleBeforeImminent: null,
        schedule: restoredSchedule,
      }, `chore: auto-off imminent for ${site.id} [skip ci]`);
      // Mutate the in-memory copy so the rest of this loop sees the new state.
      site.imminent = false;
      site.imminentSince = null;
      site.scheduleBeforeImminent = null;
      site.schedule = restoredSchedule;
      console.log(`[${site.name}] Imminent auto-off after ${durationMin}m timeout`);

      const event = {
        timestamp: new Date().toISOString(),
        siteId: site.id,
        siteName: site.name,
        type: "imminent_timeout",
        product: {
          title: site.name,
          url: site.url,
          note: `Imminent mode auto-disabled after ${durationMin} min. Back to ${restoredSchedule ?? site.intervalMinutes + ' min'} schedule.`,
        },
      };
      newHistory.push(event);
      if (DISCORD_WEBHOOK) {
        try { await sendDiscordAlert(DISCORD_WEBHOOK, site.name, event); }
        catch (err) { console.error(`  Discord imminent_timeout error: ${err.message}`); }
      }
    } catch (err) {
      console.error(`[${site.name}] Failed to auto-off imminent: ${err.message}`);
    }
  }

  for (const site of config.sites) {
    if (!site.enabled) continue;

    const siteState = globalState[site.id];

    // Circuit breaker: a site that answered 429/403 sits out its cooldown
    // regardless of schedule.
    const cooldownUntil = siteState?.cooldownUntil ? new Date(siteState.cooldownUntil).getTime() : 0;
    if (cooldownUntil > Date.now()) {
      console.log(`[${site.name}] Skipping — rate-limit cooldown until ${siteState.cooldownUntil}`);
      continue;
    }

    if (!shouldCheck(site, siteState, schedules)) {
      console.log(`[${site.name}] Skipping — checked recently`);
      continue;
    }

    // Pre-site jitter: 2–5 s random delay before each fetch so we don't
    // hit servers at predictable clock-aligned times.
    await sleep(jitter(3500, 1500));

    console.log(`[${site.name}] Checking...`);
    touchedSiteIds.push(site.id);

    try {
      const strategy = await loadStrategy(site.strategy);
      const { state, alerts } = await strategy.checkSite(site, siteState);
      annotateProducts(siteState?.products, state.products);

      // Recovery alert: if we had an open error page, close it.
      const wasInErrorAlert = siteState?.errorAlertSent === true;
      const checkHistory = [...(siteState?.checkHistory ?? []), { ts: new Date().toISOString(), ok: true }].slice(-100);
      globalState[site.id] = {
        ...state,
        consecutiveErrors: 0,
        errorAlertSent: false,
        cooldownLevel: 0,
        cooldownUntil: null,
        checkHistory,
      };
      stateChanged = true;

      if (wasInErrorAlert) {
        const recoveryEvent = {
          timestamp: new Date().toISOString(),
          siteId: site.id,
          siteName: site.name,
          type: "site_recovered",
          product: { title: site.name, url: site.url, note: "Checks are succeeding again." },
        };
        newHistory.push(recoveryEvent);
        if (DISCORD_WEBHOOK) {
          try { await sendDiscordAlert(DISCORD_WEBHOOK, site.name, recoveryEvent); }
          catch (err) { console.error(`  Discord recovery error: ${err.message}`); }
        }
      }

      // Startup quiet mode: with no previous state entry at all (fresh site,
      // or state.json was empty/corrupt at load), every product would alert
      // as "new" — 37+ Discord pings from one bad state file. Baseline
      // silently instead. Keyed on the state entry being absent, not on the
      // product map being empty: a site whose last real check saw 0 products
      // must still alert on a 0→N wave drop.
      let activeAlerts = alerts;
      if (!siteState) {
        const suppressed = activeAlerts.filter((a) => a.type === "new_product");
        if (suppressed.length > 0) {
          activeAlerts = activeAlerts.filter((a) => a.type !== "new_product");
          console.log(`[${site.name}] Baseline run — ${suppressed.length} product(s) recorded silently`);
          newHistory.push({
            timestamp: new Date().toISOString(),
            siteId: site.id,
            siteName: site.name,
            type: "baseline",
            product: {
              title: site.name,
              url: site.url,
              note: `First check with no prior state — ${suppressed.length} existing product(s) baselined without alerts.`,
            },
          });
        }
      }

      const filteredAlerts = activeAlerts.filter((a) => !ignored[a.product?.handle]);
      console.log(
        `[${site.name}] ${Object.keys(state.products ?? {}).length} products, ` +
        `${filteredAlerts.length} alerts (${activeAlerts.length - filteredAlerts.length} ignored)`
      );

      for (const alert of filteredAlerts) {
        console.log(`  → ${alert.type}: ${alert.product.title}`);

        newHistory.push({
          timestamp: new Date().toISOString(),
          siteId: site.id,
          siteName: site.name,
          type: alert.type,
          product: alert.product,
        });

        if (DISCORD_WEBHOOK) {
          try { await sendDiscordAlert(DISCORD_WEBHOOK, site.name, alert); }
          catch (err) { console.error(`  Discord error: ${err.message}`); }
        }
      }
    } catch (err) {
      console.error(`[${site.name}] Error: ${err.message}`);
      const prev = globalState[site.id] ?? {};
      const consecutiveErrors = (prev.consecutiveErrors ?? 0) + 1;
      const alreadyAlerted = prev.errorAlertSent === true;
      const shouldAlert = consecutiveErrors >= ERROR_ALERT_THRESHOLD && !alreadyAlerted;

      // Circuit breaker: 429/403 means the site is pushing back — cool this
      // site down with escalating delays instead of retrying on schedule.
      let cooldown = {};
      if (err.statusCode === 429 || err.statusCode === 403) {
        const level = Math.min((prev.cooldownLevel ?? 0) + 1, COOLDOWN_STEPS_MIN.length);
        const minutes = COOLDOWN_STEPS_MIN[level - 1];
        cooldown = {
          cooldownLevel: level,
          cooldownUntil: new Date(Date.now() + minutes * 60_000).toISOString(),
        };
        console.warn(`[${site.name}] HTTP ${err.statusCode} — cooling down ${minutes}m (level ${level})`);
      }

      const checkHistory = [...(prev.checkHistory ?? []), { ts: new Date().toISOString(), ok: false }].slice(-100);
      globalState[site.id] = {
        ...prev,
        consecutiveErrors,
        lastError: err.message,
        lastErrorAt: new Date().toISOString(),
        errorAlertSent: alreadyAlerted || shouldAlert,
        checkHistory,
        ...cooldown,
      };
      stateChanged = true;

      if (shouldAlert) {
        const errEvent = {
          timestamp: new Date().toISOString(),
          siteId: site.id,
          siteName: site.name,
          type: "site_error",
          product: {
            title: site.name,
            url: site.url,
            note: `${consecutiveErrors} consecutive failures. Last error: ${err.message}`,
          },
        };
        newHistory.push(errEvent);
        if (DISCORD_WEBHOOK) {
          try { await sendDiscordAlert(DISCORD_WEBHOOK, site.name, errEvent); }
          catch (e) { console.error(`  Discord site_error post failed: ${e.message}`); }
        }
      }
    }

    // Inter-site gap: 500–1500 ms between sites within a single run.
    await sleep(jitter(1000, 500));
  }

  if (stateChanged) {
    // Push immediately when something noteworthy happened this loop (any alert,
    // baseline, error, or recovery all land in newHistory). Otherwise this was
    // a routine check that only ticked checkHistory/lastChecked — hold it and
    // let the throttle window batch it, to cut commit spam and 409 contention.
    const noteworthy = newHistory.length > 0;
    const due = Date.now() - lastStatePushAt >= STATE_PUSH_MIN_INTERVAL_MS;
    if (noteworthy || due) {
      try {
        await pushState(touchedSiteIds);
        lastStatePushAt = Date.now();
        console.log("[run] State pushed to GitHub.");
      } catch (err) {
        console.error("[run] Failed to push state:", err.message);
      }
    } else {
      console.log("[run] State changed (routine) — holding; in-memory only until the next push window.");
    }
  }

  if (newHistory.length > 0) {
    try {
      await appendAndPushHistory(newHistory);
      console.log(`[run] ${newHistory.length} history event(s) pushed.`);
    } catch (err) {
      console.error("[run] Failed to push history:", err.message);
    }
  }

  console.log("[run] Done.");
}

// ── Loop ──────────────────────────────────────────────────────────────────────

async function startLoop() {
  if (!process.env.GH_TOKEN || !process.env.GH_REPO) {
    console.error("[fatal] GH_TOKEN and GH_REPO env vars are required.");
    process.exit(1);
  }

  await loadStartupState();

  let runCount = 0;
  while (true) {
    runCount++;
    console.log(`\n[loop] Run #${runCount} — ${new Date().toISOString()}`);
    try {
      await run();
    } catch (err) {
      console.error("[loop] Uncaught run error:", err.message);
    }
    // GitHub-down / token-expiry detection (R4). When GitHub reads have failed
    // for several loops straight, the worker is alive but blind — it can't read
    // config or write state, and the healthcheck ping below would otherwise
    // keep reporting "healthy" and mask the outage. So once we cross the
    // threshold we (1) deliberately skip the healthcheck so the external
    // dead-man fires, and (2) page Discord directly — the webhook needs no
    // GH_TOKEN, so it still works when GitHub auth is the thing that's broken.
    const githubDown = githubFailureStreak >= GITHUB_FAILURE_THRESHOLD;
    if (githubDown && !githubFailureAlerted) {
      githubFailureAlerted = true;
      console.error(`[loop] GitHub reads failing (${githubFailureStreak} loops) — paging Discord, suppressing healthcheck.`);
      if (DISCORD_WEBHOOK) {
        try {
          await sendDiscordAlert(DISCORD_WEBHOOK, "Beacon worker", {
            type: "site_error",
            product: {
              title: "GitHub API unreachable",
              url: "https://github.com",
              note: `config.json reads have failed ${githubFailureStreak} loops in a row. GH_TOKEN may be expired or GitHub may be down — the worker is running but can't read config or persist state.`,
            },
          });
        } catch (err) {
          console.error(`[loop] Discord github-down page failed: ${err.message}`);
        }
      }
    }

    // Dead-man's switch: ping healthchecks.io (or similar) after every loop.
    // If the worker dies, the missed pings trigger an external alert — the
    // one failure mode Discord alerts can't cover, since a dead worker can't
    // send them. Skipped while GitHub is down so the dead-man fires for the
    // "alive but blind" case too.
    if (HEALTHCHECK_URL && !githubDown) {
      try {
        await https(HEALTHCHECK_URL);
      } catch (err) {
        console.error("[loop] Healthcheck ping failed:", err.message);
      }
    }
    // Loop every ~60 s ± 5 s normally; tighten to ~10 s while any site is in
    // imminent mode so imminentIntervalMinutes can actually drive sub-minute
    // checks (the loop is the floor). Non-imminent sites stay gated by
    // shouldCheck(), so they don't over-check during the fast loop.
    const base = anyImminentActive ? IMMINENT_LOOP_MS : LOOP_BASE_MS;
    const wait = jitter(base, anyImminentActive ? 2000 : 5000);
    console.log(`[loop] Next run in ${Math.round(wait / 1000)}s${anyImminentActive ? " (imminent)" : ""}`);
    await sleep(wait);
  }
}

startLoop();
