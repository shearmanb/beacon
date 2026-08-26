// Per-hour cadence resolution + range grouping for the /schedules "Site
// cadence" listing. Pure functions so the day-strip math is unit-testable;
// interval resolution is delegated to @beacon/shared, so this view can never
// disagree with what the worker actually does.

import type { SchedulableSite, Schedules } from "@beacon/shared";
import { getEffectiveInterval } from "@beacon/shared";

/** Effective interval (minutes) for each ET hour 0–23 on the given ET day. */
export function cadenceByHour(
  site: SchedulableSite,
  schedules: Schedules,
  day: string,
): number[] {
  return Array.from({ length: 24 }, (_, hour) =>
    getEffectiveInterval(site, schedules, { hour, day }),
  );
}

export interface CadenceGroup {
  interval: number;
  /** ET hour ranges [from, to) — a wrapped overnight run collapses to e.g. [22, 8]. */
  ranges: [number, number][];
}

/**
 * Collapse a 24-entry per-hour interval array into interval → hour-range
 * groups (midnight wrap merged), fastest first — the textual cadence listing.
 */
export function groupCadence(hours: number[]): CadenceGroup[] {
  const runs: { interval: number; from: number; to: number }[] = [];
  for (let h = 0; h < hours.length; h++) {
    const iv = hours[h];
    const last = runs[runs.length - 1];
    if (last && last.interval === iv) last.to = h + 1;
    else runs.push({ interval: iv, from: h, to: h + 1 });
  }
  // Merge the midnight wrap (…–24 joining 0–…) into one overnight range, so a
  // 22–24 + 0–8 pair reads "22–8" the way the schedule editor writes it.
  if (runs.length > 1) {
    const first = runs[0];
    const last = runs[runs.length - 1];
    if (first.interval === last.interval && first.from === 0 && last.to === 24) {
      last.to = first.to;
      runs.shift();
    }
  }
  const byInterval = new Map<number, [number, number][]>();
  for (const r of runs) {
    const list = byInterval.get(r.interval);
    if (list) list.push([r.from, r.to]);
    else byInterval.set(r.interval, [[r.from, r.to]]);
  }
  return [...byInterval.entries()]
    .map(([interval, ranges]) => ({ interval, ranges }))
    .sort((a, b) => a.interval - b.interval);
}

export function formatRange([from, to]: [number, number]): string {
  return from === 0 && to === 24 ? "all day" : `${from}–${to}`;
}

/**
 * Interval the worker is actually using right now — mirrors shouldCheck's
 * imminent branch (imminentIntervalMinutes wins while imminent mode is on).
 */
export function nowInterval(site: SchedulableSite, schedules: Schedules): number {
  if (site.imminent && site.imminentIntervalMinutes != null) return site.imminentIntervalMinutes;
  return getEffectiveInterval(site, schedules);
}
