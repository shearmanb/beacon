import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const HISTORY_FILE = resolve("alert_history.json");
const MAX_EVENTS = 200;

export function appendHistory(events) {
  let history = [];
  try {
    history = JSON.parse(readFileSync(HISTORY_FILE, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[history] Could not read alert_history.json: ${err.message} — starting fresh`);
    }
  }

  history.push(...events);
  if (history.length > MAX_EVENTS) {
    history = history.slice(history.length - MAX_EVENTS);
  }

  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}
