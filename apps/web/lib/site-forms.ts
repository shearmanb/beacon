// Shared types + pure helpers for the add-site wizard, and for the site
// tile's quick 🕒 window editor. Deliberately NOT a "use server" module
// (that file may only export async actions) and free of server imports, so
// client components and server actions can both use it.

import type { ScheduleRule } from "@beacon/shared";

export interface PreviewSample {
  title: string;
  available: boolean;
  minPrice: number | null;
  url: string;
  vendor: string | null;
}

export type PreviewResult =
  | { ok: false; error: string }
  | { ok: true; mode: "products"; rawCount: number; filteredCount: number; sample: PreviewSample[]; detail?: string }
  | { ok: true; mode: "signal"; blocked: boolean; detail: string };

export interface AddResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/** "a, b ,, c" → ["a","b","c"] */
export function splitList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function splitNums(s: string): number[] {
  return splitList(s)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

export function numOrNull(s: string): number | null {
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

/** Turn a display name into a safe snake_case site id. */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "site"
  );
}

/** The tile's quick window editor's four fields: fast inside [fromHour,
 *  toHour) ET, slow the rest of the day. */
export interface WindowSpec {
  fromHour: number;
  toHour: number;
  fast: number;
  slow: number;
}

type WindowRule = Extract<ScheduleRule, { fromHour: number }>;
type DefaultRule = Extract<ScheduleRule, { defaultInterval: number }>;

function isWindowRule(r: ScheduleRule): r is WindowRule {
  return "fromHour" in r;
}
function hasDays(r: ScheduleRule): boolean {
  const days = (r as { days?: string[] }).days;
  return Array.isArray(days) && days.length > 0;
}

/** A simple two-rule schedule — fast inside the window, slow outside it,
 *  every day — the same rule shape drop_windows/bar_evening use by hand, just
 *  always exactly one window. Powers the tile's quick 🕒 window editor. */
export function buildWindowRules({ fromHour, toHour, fast, slow }: WindowSpec): ScheduleRule[] {
  return [
    { fromHour, toHour, interval: fast },
    { defaultInterval: slow },
  ];
}

/** Inverse of buildWindowRules — reads a schedule's rules back into the quick
 *  editor's four fields, so re-opening it shows what's actually saved.
 *  Returns null for anything that isn't exactly this shape (e.g. a schedule
 *  hand-edited on /schedules into multiple windows or day-scoped rules)
 *  rather than guessing which rule to show. */
export function parseWindowRules(rules: ScheduleRule[] | undefined): WindowSpec | null {
  if (!rules || rules.length !== 2) return null;
  const win = rules.find(isWindowRule);
  const def = rules.find((r): r is DefaultRule => !isWindowRule(r));
  if (!win || !def || hasDays(win) || hasDays(def)) return null;
  return { fromHour: win.fromHour, toHour: win.toHour, fast: win.interval, slow: def.defaultInterval };
}
