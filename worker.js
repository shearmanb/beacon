// Persistent Railway worker — replaces the one-shot checker.js GitHub Actions model.
// Loops every ~60 s; per-site shouldCheck() gates actual fetches.
// State is kept in memory and pushed to GitHub after each changed run so the
// dashboard continues to read from raw GitHub URLs as before.

import { sites } from "./config.js";
import { sendAlert as sendDiscordAlert } from "./notifiers/discord.js";
import { readFile, writeFile } from "./lib/github.js";

const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const LOOP_BASE_MS = 60_000;
const MAX_HISTORY = 200;

// ── Utilities ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Returns a duration in ms: base ± up to spread ms.
function jitter(baseMs, spreadMs) {
  return Math.max(0, baseMs + (Math.random() * 2 - 1) * spreadMs);
}

// ── Schedule helpers (mirrors checker.js exactly) ─────────────────────────────

function getEtHour() {
  return parseInt(
    new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }),
    10
  );
}

function resolveNamedSchedule(scheduleName, schedules) {
  const def = schedules[scheduleName];
  if (!def?.rules) return null;
  const hour = getEtHour();
  for (const rule of def.rules) {
    if (rule.defaultInterval != null) return rule.defaultInterval;
    if (rule.fromHour != null && hour >= rule.fromHour && hour < rule.toHour) return rule.interval;
  }
  return null;
}

function getEffectiveInterval(site, schedules) {
  const { schedule } = site;
  if (!schedule) return site.intervalMinutes;
  const fixed = parseInt(schedule, 10);
  if (!isNaN(fixed)) return fixed;
  const resolved = resolveNamedSchedule(schedule, schedules);
  if (resolved != null) return resolved;
  if (schedule === "working_hours_heavy") {
    const hour = getEtHour();
    if (hour >= 9 && hour < 18) return 5;
    if (hour >= 18 && hour < 22) return 20;
    return 300;
  }
  return site.intervalMinutes;
}

function shouldCheck(site, siteState, schedules) {
  if (!siteState?.lastChecked) return true;
  const elapsed = (Date.now() - new Date(siteState.lastChecked).getTime()) / 1000 / 60;
  const interval = site.imminent
    ? site.imminentIntervalMinutes
    : getEffectiveInterval(site, schedules);
  return elapsed >= interval;
}

// ── Strategy loader ───────────────────────────────────────────────────────────

const strategyCache = {};

async function loadStrategy(name) {
  if (strategyCache[name]) return strategyCache[name];
  const loaders = {
    shopify_collection: () => import("./sites/shopify_collection.js"),
    shopify_storefront: () => import("./sites/shopify_storefront.js"),
    reveries_squarespace: () => import("./sites/reveries_squarespace.js"),
  };
  const loader = loaders[name];
  if (!loader) throw new Error(`Unknown strategy: ${name}`);
  const mod = await loader();
  strategyCache[name] = mod;
  return mod;
}

// ── In-memory state ───────────────────────────────────────────────────────────

let globalState = {};
let stateFileSha = null;

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

async function pushState() {
  const content = JSON.stringify(globalState, null, 2);
  // Retry once on SHA conflict (e.g. a manual workflow_dispatch ran concurrently).
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const newSha = await writeFile(
        "state.json",
        content,
        stateFileSha,
        "chore: update state [skip ci]"
      );
      if (newSha) stateFileSha = newSha;
      return;
    } catch (err) {
      if (err.message.includes("409") && attempt === 0) {
        const res = await readFile("state.json");
        stateFileSha = res.sha;
      } else {
        throw err;
      }
    }
  }
}

async function appendAndPushHistory(events) {
  const res = await readFile("alert_history.json");
  let history = [];
  if (res.content) {
    try { history = JSON.parse(res.content); } catch { /* start fresh */ }
  }
  history.push(...events);
  if (history.length > MAX_HISTORY) history = history.slice(history.length - MAX_HISTORY);
  await writeFile(
    "alert_history.json",
    JSON.stringify(history, null, 2),
    res.sha,
    "chore: update history [skip ci]"
  );
}

async function fetchIgnored() {
  const res = await readFile("ignored_products.json");
  if (!res.content) return {};
  try { return JSON.parse(res.content); } catch { return {}; }
}

async function fetchSchedules() {
  const res = await readFile("schedules.json");
  if (!res.content) return {};
  try { return JSON.parse(res.content); } catch { return {}; }
}

// ── Main run ──────────────────────────────────────────────────────────────────

async function run() {
  // Fetch ignored and schedules fresh each loop so dashboard changes take effect
  // without a redeploy.
  let ignored = {};
  let schedules = {};
  try {
    [ignored, schedules] = await Promise.all([fetchIgnored(), fetchSchedules()]);
  } catch (err) {
    console.error("[run] Failed to fetch ignored/schedules:", err.message);
  }

  const newHistory = [];
  let stateChanged = false;

  for (const site of sites) {
    if (!site.enabled) continue;

    const siteState = globalState[site.id];
    if (!shouldCheck(site, siteState, schedules)) {
      console.log(`[${site.name}] Skipping — checked recently`);
      continue;
    }

    // Pre-site jitter: 2–5 s random delay before each fetch to avoid
    // hitting sites at predictable clock times.
    await sleep(jitter(3500, 1500));

    console.log(`[${site.name}] Checking...`);

    try {
      const strategy = await loadStrategy(site.strategy);
      const { state, alerts } = await strategy.checkSite(site, siteState);

      globalState[site.id] = state;
      stateChanged = true;

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
          try {
            await sendDiscordAlert(DISCORD_WEBHOOK, site.name, alert);
          } catch (err) {
            console.error(`  Discord error: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.error(`[${site.name}] Error: ${err.message}`);
    }

    // Inter-site gap: 500–1500 ms between sites within a single run.
    await sleep(jitter(1000, 500));
  }

  if (stateChanged) {
    try {
      await pushState();
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
