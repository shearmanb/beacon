// The Sites tile's ONE status line — "✓ checking · 3m ago · next ~2m · every 5m
// until 20:00 → 8m" — plus the small secondary notes (fallback channel,
// truncated roster, back-off, quiet). Pure: takes the site definition, stored
// state and schedules and returns text + a tone; the tile just renders it.
// Replaced an 11-stat grid (Products / Last check / Schedule / Cadence / Next
// check / Today / Errors / Cooldown / Channel / Coverage / Activity) that made
// "are checks OK?" a reading exercise. Everything here resolves through the same
// @beacon/shared helpers the worker uses, so it can never disagree with it.

import type { SchedulableSite, Schedules } from "@beacon/shared";
import { cadenceAdjust, getEtDay, getEtHour, getEffectiveInterval, imminentInterval, recentBlock, type CadenceSignals } from "@beacon/shared";
import { cadenceByHour } from "./cadence";
import { ago, type Health } from "./health";

export type Tone = "ok" | "warn" | "err" | "off";

export interface SecondaryNote {
  text: string;
  title?: string;
  tone?: "warn" | "faint";
}

export interface TileStatus {
  tone: Tone;
  /** Joined with " · " on the tile. */
  parts: string[];
  secondary: SecondaryNote[];
  /** Stored lastError (only while failing), with a bot-protection / stall hint. */
  lastError: string | null;
  errorHint: string | null;
}

// Quiet-site canary: healthy for weeks with no activity — often a too-narrow
// filter or a quietly-broken source.
const QUIET_MS = 21 * 86_400_000;

const fmtHour = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;

/**
 * "every 5m until 20:00 → 8m" | "every 5m all day" | "every 2m while imminent".
 * Walks today's per-hour cadence from the current ET hour to the end of the
 * current run (wrapping past midnight into the same array — close enough for a
 * glance; day-scoped rules differ rarely).
 */
export function cadencePhrase(def: SchedulableSite, schedules: Schedules, now: number = Date.now()): string {
  if (def.imminent) return `every ${imminentInterval(def)}m while imminent`;
  const date = new Date(now);
  const hours = cadenceByHour(def, schedules, getEtDay(date));
  const h = getEtHour(date);
  const cur = hours[h]!;
  if (hours.every((x) => x === cur)) return `every ${cur}m all day`;
  let end = h;
  for (let i = 1; i < 24; i++) {
    if (hours[(h + i) % 24] !== cur) {
      end = (h + i) % 24;
      break;
    }
  }
  return `every ${cur}m until ${fmtHour(end)}, then every ${hours[end]}m`;
}

export interface TileStatusInput {
  enabled: boolean;
  def: SchedulableSite;
  state: Record<string, unknown> | undefined;
  schedules: Schedules;
  health: Health;
  /** Server-rendered "next check" label (formatEta); the tile swaps in the live ticker. */
  nextLabel: string;
  now?: number;
}

export function tileStatus({ enabled, def, state, schedules, health, nextLabel, now = Date.now() }: TileStatusInput): TileStatus {
  const errors = (state?.["consecutiveErrors"] as number | undefined) ?? 0;
  const errLog = (state?.["errorLog"] as { ts: string; statusCode?: number | null; message?: string }[] | undefined) ?? [];
  const lastStatus = errors > 0 ? (errLog[errLog.length - 1]?.statusCode ?? null) : null;
  const lastChecked = state?.["lastChecked"] as string | undefined;
  const secondary: SecondaryNote[] = [];
  const lastErrorRaw = errors > 0 ? String(state?.["lastError"] ?? "") : "";
  const lastError = lastErrorRaw || null;

  if (!enabled) {
    return { tone: "off", parts: ["○ off", `last check ${ago(lastChecked, now)}`], secondary, lastError: null, errorHint: null };
  }

  const parts: string[] = [];
  const tone: Tone = health === "err" ? "err" : health === "warn" ? "warn" : "ok";
  if (health === "err") parts.push(`✕ down · ${errors} failures${lastStatus != null ? ` · HTTP ${lastStatus}` : ""}`);
  else if (errors > 0) parts.push(`⚠ ${errors} failure${errors === 1 ? "" : "s"}${lastStatus != null ? ` · HTTP ${lastStatus}` : ""}`);
  else if (!lastChecked) parts.push("⚠ not checked yet");
  else if (health === "warn") parts.push("⚠ late");
  else parts.push("✓ checking");

  parts.push(lastChecked ? ago(lastChecked, now) : "never");
  parts.push(`next ${nextLabel}`);

  const cooldownUntil = state?.["cooldownUntil"] as string | undefined;
  const cooldownLeft = cooldownUntil ? Date.parse(cooldownUntil) - now : 0;
  if (!def.imminent && cooldownLeft > 0) parts.push(`⏸ cooldown ${Math.ceil(cooldownLeft / 60_000)}m`);
  // The cadence ("every 5m until 15:00, then every 8m") has its own 🕒 line on
  // the tile, next to the schedule's name and a link to change it.

  // Secondary notes — only the ones that apply, each with the why in a tooltip.
  const adjust = def.imminent
    ? null
    : cadenceAdjust(getEffectiveInterval(def, schedules), def, state as CadenceSignals | undefined, now);
  const block = adjust?.reason === "block" ? recentBlock(errLog, now) : null;
  if (adjust && block) {
    secondary.push({
      text: `⏳ backing off ×${adjust.factor} (${adjust.detail} ${ago(block.ts, now)})`,
      tone: "warn",
      title: "A block-like failure in the last 6 h stretches this site's interval ×1.5 so a hostile host is poked less often. Reverts by itself; imminent mode ignores it.",
    });
  } else if (adjust?.reason === "slow") {
    secondary.push({
      text: `🐢 easing off ×${adjust.factor} (${adjust.detail})`,
      tone: "warn",
      title: "This host's last few answers were far slower than its own normal — the usual first sign of a tar-pit. The interval is stretched ×1.5 until one check comes back quick. Imminent mode ignores it.",
    });
  } else if (adjust?.reason === "faster") {
    secondary.push({
      text: `🚀 checking ×${(1 / adjust.factor).toFixed(2).replace(/\.?0+$/, "")} faster (${adjust.detail})`,
      tone: "faint",
      title: "No block from this host for days, so checks run faster than the schedule (never below this site's floor). Any block or slowdown puts it straight back.",
    });
  }
  if (state?.["fetchVia"] === "storefront_fallback") {
    const preferred = state?.["preferFallback"] === true;
    secondary.push({
      text: `⛑ via storefront ${preferred ? "(preferred)" : "fallback"}`,
      tone: "warn",
      title: `${(state?.["fetchViaReason"] as string | undefined) ?? "products.json is blocked"} — this roster came from the Storefront GraphQL API fallback. ${
        preferred
          ? "After repeated blocks the Storefront API is now the PREFERRED channel; REST is re-probed twice a day and this flips back automatically when it recovers."
          : "REST is retried first on every check and this clears when it recovers."
      }`,
    });
  }
  if (state?.["fallbackTruncated"] === true) {
    secondary.push({
      text: "⚠ roster truncated",
      tone: "warn",
      title: "The Storefront fallback stopped at its pagination cap with catalog left over — products past the cap are invisible on this channel. Scope this source to a collectionPath (⚙ source) so a check isn't a full-catalog scan.",
    });
  }
  const checkHist = (state?.["checkHistory"] as unknown[] | undefined) ?? [];
  const lastAlertAt = state?.["lastAlertAt"] as string | undefined;
  const quiet = health === "ok" && (lastAlertAt ? now - Date.parse(lastAlertAt) > QUIET_MS : checkHist.length >= 50);
  if (quiet) {
    const days = lastAlertAt ? Math.floor((now - Date.parse(lastAlertAt)) / 86_400_000) : null;
    secondary.push({
      text: days != null ? `💤 no alerts in ${days}d` : "💤 no alerts yet",
      tone: "faint",
      title:
        "Checks are healthy but this site hasn't produced a new / restock / sold-out alert in 3+ weeks. Often that's just a slow shop; " +
        "if you expected drops here, check the keywords and source in ⚙ settings — a too-narrow filter looks exactly like this.",
    });
  }

  // Failure hints: bot-protection tells (401/403/430) and status-less stalls.
  let errorHint: string | null = null;
  if (lastError) {
    if (lastStatus === 401 || lastStatus === 403 || lastStatus === 430) {
      errorHint = "looks like bot protection blocking Beacon's server IP; the page can still load fine in your own browser.";
    } else if (lastStatus == null && /aborted (fetch|post)ing|deadline exceeded|socket idle timeout/i.test(lastError)) {
      errorHint = "the site is leaving Beacon's connections hanging with no answer (tar-pit bot mitigation aimed at server IPs); the page can still load fine in your own browser.";
    }
  }

  return { tone, parts, secondary, lastError, errorHint };
}

/** The tile's 🕒 line: which schedule, and what it means right now. */
export function scheduleLine(def: SchedulableSite, schedules: Schedules, label: string, now: number = Date.now()): string {
  if (def.imminent) return `⚡ imminent: ${cadencePhrase(def, schedules, now)} (then back to ${label})`;
  return `${label}: ${cadencePhrase(def, schedules, now)}`;
}
