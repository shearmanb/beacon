// Persistent Railway worker. Loops every ~60 s; per-site shouldCheck() gates
// actual fetches. State is kept in memory and pushed to GitHub after each
// changed run so the dashboard continues to read from raw GitHub URLs.

import { sendAlert as sendDiscordAlert } from "./notifiers/discord.js";
import { readFile, writeFile } from "./lib/github.js";
import { shouldCheck } from "./lib/schedule.js";
import { loadStrategy } from "./lib/strategies.js";
import { sleep, jitter } from "./lib/utils.js";

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const LOOP_BASE_MS = 60_000;
const MAX_HISTORY = 250;
const ERROR_ALERT_THRESHOLD = 5; // consecutive failures before paging Discord

// ── In-memory state ───────────────────────────────────────────────────────────

let globalState = {};
let stateFileSha = null;
let historyFileSha = null;

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
    historyFileSha = res.sha;
    let history = [];
    if (res.content) {
      try { history = JSON.parse(res.content); } catch { /* start fresh */ }
    }
    history.push(...events);
    if (history.length > MAX_HISTORY) history = history.slice(history.length - MAX_HISTORY);
    try {
      const newSha = await writeFile(
        "alert_history.json",
        JSON.stringify(history, null, 2),
        historyFileSha,
        "chore: update history [skip ci]"
      );
      if (newSha) historyFileSha = newSha;
      return;
    } catch (err) {
      if (err.message.includes("409") && attempt === 0) continue;
      throw err;
    }
  }
}

async function fetchJsonFile(path) {
  const res = await readFile(path);
  if (!res.content) return null;
  try { return JSON.parse(res.content); } catch { return null; }
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
  } catch (err) {
    console.error("[run] Failed to fetch config/ignored/schedules:", err.message);
  }
  if (!config?.sites?.length) {
    console.error("[run] No sites in config.json — skipping run.");
    return;
  }

  const newHistory = [];
  const touchedSiteIds = [];
  let stateChanged = false;

  for (const site of config.sites) {
    if (!site.enabled) continue;

    const siteState = globalState[site.id];
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

      // Recovery alert: if we had an open error page, close it.
      const wasInErrorAlert = siteState?.errorAlertSent === true;
      globalState[site.id] = { ...state, consecutiveErrors: 0, errorAlertSent: false };
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

      const filteredAlerts = alerts.filter((a) => !ignored[a.product?.handle]);
      console.log(
        `[${site.name}] ${Object.keys(state.products ?? {}).length} products, ` +
        `${filteredAlerts.length} alerts (${alerts.length - filteredAlerts.length} ignored)`
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

      globalState[site.id] = {
        ...prev,
        consecutiveErrors,
        lastError: err.message,
        lastErrorAt: new Date().toISOString(),
        errorAlertSent: alreadyAlerted || shouldAlert,
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
    try {
      await pushState(touchedSiteIds);
      console.log("[run] State pushed to GitHub.");
    } catch (err) {
      console.error("[run] Failed to push state:", err.message);
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
    // Loop every ~60 s ± 5 s so subsequent runs never land on the exact same
    // clock second.
    const wait = jitter(LOOP_BASE_MS, 5000);
    console.log(`[loop] Next run in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
}

startLoop();
