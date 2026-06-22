// Scheduling logic ported from the original lib/schedule.js. Behavior is
// preserved verbatim; the only change is that the ET clock is injectable
// (`EtContext` / `now`) so the rules are deterministically testable.

import type {
  EtContext,
  SchedulableSite,
  SchedulableState,
  Schedules,
} from "./types.js";

export type { EtContext } from "./types.js";

export function getEtHour(date: Date = new Date()): number {
  return parseInt(
    date.toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }),
    10,
  );
}

/** Three-letter lowercase ET weekday ("mon".."sun"), for day-scoped rules. */
export function getEtDay(date: Date = new Date()): string {
  return date
    .toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "short" })
    .toLowerCase();
}

/** Handles midnight-crossing windows: fromHour=22 toHour=9 means 10pm–9am. */
export function windowMatches(fromHour: number, toHour: number, hour: number): boolean {
  if (fromHour <= toHour) return hour >= fromHour && hour < toHour;
  return hour >= fromHour || hour < toHour;
}

export function resolveNamedSchedule(
  scheduleName: string,
  schedules: Schedules,
  ctx?: EtContext,
): number | null {
  const def = schedules[scheduleName];
  if (!def?.rules) return null;
  const hour = ctx?.hour ?? getEtHour();
  const day = ctx?.day ?? getEtDay();
  for (const rule of def.rules) {
    // Optional day scope: a rule carrying a `days` array only applies on those
    // ET weekdays. Rules with no `days` apply every day.
    if (Array.isArray(rule.days) && !rule.days.includes(day)) continue;
    if ("defaultInterval" in rule && rule.defaultInterval != null) return rule.defaultInterval;
    if ("fromHour" in rule && rule.fromHour != null && windowMatches(rule.fromHour, rule.toHour, hour)) {
      return rule.interval;
    }
  }
  return null;
}

export function getEffectiveInterval(
  site: SchedulableSite,
  schedules: Schedules,
  ctx?: EtContext,
): number {
  const { schedule } = site;
  let interval: number = site.intervalMinutes ?? NaN;
  if (schedule != null && schedule !== "") {
    const fixed = parseInt(String(schedule), 10);
    interval = !Number.isNaN(fixed)
      ? fixed
      : resolveNamedSchedule(String(schedule), schedules, ctx) ?? site.intervalMinutes ?? NaN;
  }
  if (!Number.isFinite(interval)) {
    // Misconfigured site (unresolvable schedule + missing intervalMinutes): a
    // non-numeric interval makes `elapsed >= interval` permanently false,
    // silently disabling checks. Fall back to a safe 60m instead.
    console.warn(`[schedule] ${site.id ?? site.name}: no resolvable interval — defaulting to 60m`);
    return 60;
  }
  return interval;
}

// Deterministic per-cycle jitter factor in [0.9, 1.15). Seeded from the site
// and its lastChecked so the factor is stable across loops within one wait
// cycle but changes every cycle, so checks never land on an exact metronome.
export function cycleJitterFactor(siteId: string, lastChecked: string): number {
  const seed = `${siteId}|${lastChecked}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return 0.9 + ((h % 1000) / 1000) * 0.25;
}

export function shouldCheck(
  site: SchedulableSite,
  siteState: SchedulableState | undefined,
  schedules: Schedules,
  now: number = Date.now(),
  ctx?: EtContext,
): boolean {
  if (!siteState?.lastChecked) return true;
  const elapsed = (now - new Date(siteState.lastChecked).getTime()) / 1000 / 60;
  // Imminent mode uses imminentIntervalMinutes; fall back to the effective
  // interval if that field is absent so the site never silently stops checking.
  // Imminent checks skip the jitter — drop windows want the floor, not variance.
  if (site.imminent && site.imminentIntervalMinutes != null) {
    return elapsed >= site.imminentIntervalMinutes;
  }
  const interval = getEffectiveInterval(site, schedules, ctx);
  return elapsed >= interval * cycleJitterFactor(site.id ?? site.name ?? "", siteState.lastChecked);
}
