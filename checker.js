import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sites } from "./config.js";
import { appendHistory } from "./lib/history.js";
import { sendAlert as sendDiscordAlert } from "./notifiers/discord.js";
import { sendAlert as sendNtfyAlert } from "./notifiers/ntfy.js";

const STATE_FILE = resolve("state.json");
const IGNORED_FILE = resolve("ignored_products.json");
const SCHEDULES_FILE = resolve("schedules.json");
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;
const NTFY_TOPIC = process.env.NTFY_TOPIC;

function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    console.error(`[state] Cannot parse state.json: ${err.message}`);
    console.error("[state] Aborting — fix or delete state.json to avoid re-alerting all known products.");
    process.exit(1);
  }
}

function loadSchedules() {
  try {
    return JSON.parse(readFileSync(SCHEDULES_FILE, "utf8"));
  } catch {
    return {};
  }
}

function loadIgnored() {
  try {
    return JSON.parse(readFileSync(IGNORED_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    console.error(`[ignored] Cannot parse ignored_products.json: ${err.message} — continuing with empty ignore list.`);
    return {};
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getEtHour() {
  return parseInt(
    new Date().toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }),
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
  // Look up named schedule in schedules.json
  const resolved = resolveNamedSchedule(schedule, schedules);
  if (resolved != null) return resolved;
  // Legacy fallback for working_hours_heavy when not defined in schedules.json
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
  const interval = site.imminent ? site.imminentIntervalMinutes : getEffectiveInterval(site, schedules);
  return elapsed >= interval;
}

async function loadStrategy(strategyName) {
  const strategies = {
    shopify_collection: () => import("./sites/shopify_collection.js"),
    reveries_squarespace: () => import("./sites/reveries_squarespace.js"),
    html_text_monitor: () => import("./sites/html_text_monitor.js"),
  };
  const loader = strategies[strategyName];
  if (!loader) throw new Error(`Unknown strategy: ${strategyName}`);
  return loader();
}

async function run() {
  const globalState = loadState();
  const ignored = loadIgnored();
  const schedules = loadSchedules();
  const newHistory = [];
  let stateChanged = false;

  for (const site of sites) {
    if (!site.enabled) continue;

    const siteState = globalState[site.id];
    if (!shouldCheck(site, siteState, schedules)) {
      console.log(`[${site.name}] Skipping — checked recently`);
      continue;
    }

    console.log(`[${site.name}] Checking...`);

    try {
      const strategy = await loadStrategy(site.strategy);
      const { state, alerts } = await strategy.checkSite(site, siteState);

      globalState[site.id] = state;
      stateChanged = true;

      const filteredAlerts = alerts.filter((a) => !ignored[a.product?.handle]);
      console.log(`[${site.name}] ${Object.keys(state.products).length} products, ${filteredAlerts.length} alerts (${alerts.length - filteredAlerts.length} ignored)`);

      for (const alert of filteredAlerts) {
        console.log(`  → ${alert.type}: ${alert.product.title}`);

        const historyEvent = {
          timestamp: new Date().toISOString(),
          siteId: site.id,
          siteName: site.name,
          type: alert.type,
          product: alert.product,
        };
        newHistory.push(historyEvent);

        if (DISCORD_WEBHOOK) {
          try {
            await sendDiscordAlert(DISCORD_WEBHOOK, site.name, alert);
          } catch (err) {
            console.error(`  Discord error: ${err.message}`);
          }
        }

        if (NTFY_TOPIC) {
          try {
            await sendNtfyAlert(NTFY_TOPIC, site.name, alert);
          } catch (err) {
            console.error(`  ntfy error: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.error(`[${site.name}] Error: ${err.message}`);
    }
  }

  if (stateChanged) {
    saveState(globalState);
  }

  if (newHistory.length > 0) {
    appendHistory(newHistory);
  }

  console.log("Done.");
}

run().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
