import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sites } from "./config.js";
import { appendHistory } from "./lib/history.js";
import { sendAlert as sendDiscordAlert } from "./notifiers/discord.js";
import { getEffectiveInterval, shouldCheck } from "./lib/schedule.js";
import { loadStrategy } from "./lib/strategies.js";

const STATE_FILE = resolve("state.json");
const IGNORED_FILE = resolve("ignored_products.json");
const SCHEDULES_FILE = resolve("schedules.json");
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL;

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

      globalState[site.id] = { ...state, consecutiveErrors: 0 };
      stateChanged = true;

      const filteredAlerts = alerts.filter((a) => !ignored[a.product?.handle]);
      console.log(`[${site.name}] ${Object.keys(state.products ?? {}).length} products, ${filteredAlerts.length} alerts (${alerts.length - filteredAlerts.length} ignored)`);

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
      const prev = globalState[site.id] ?? {};
      globalState[site.id] = {
        ...prev,
        consecutiveErrors: (prev.consecutiveErrors ?? 0) + 1,
        lastError: err.message,
        lastErrorAt: new Date().toISOString(),
      };
      stateChanged = true;
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
