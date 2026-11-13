// Auto-imminent (2026-11-13) — check often only when it matters.
//
// Flat faster polling is what gets a datacenter IP flagged; drops, though,
// arrive in clusters across related shops (the official Reveries shop,
// SharedPour and Bourbon Concierge sell the same releases). So instead of
// raising everyone's cadence all day, a drop SIGNAL on one member of a group
// switches the whole group to imminent cadence for a short, bounded window.
//
// Declarative: groups live in the `auto_imminent` meta blob (seeded once by a
// config one-shot, carried in the off-box backup), e.g.
//   { "groups": [{ "id": "reveries",
//       "triggers": ["reveries_site_status", "sharedpour_channel", …],
//       "targets":  ["sharedpour_channel", "bourbon_concierge", …],
//       "on": ["new_product", "restock", "site_changed"],
//       "minutes": 20, "maxPerDay": 4 }] }
// A missing or unreadable blob means the feature is off.
//
// Guard rails, because nobody is watching an auto run:
//  • it never overrides a rate-limit cooldown (run.ts — only a click does);
//  • it carries its own duration (imminentAutoMinutes), never the operator's
//    longer manual tuning, and never extends a run that is already on;
//  • at most `maxPerDay` firings per group per 24 h, so a flapping product
//    cannot hold a host at 2-minute checks all day;
//  • it reverts without a Discord ping (autoOffImminent).

import type { Alert } from "@beacon/shared";
import type { CheckedSite, RunContext } from "./run.js";

export const AUTO_IMMINENT_META_KEY = "auto_imminent";
export const AUTO_IMMINENT_STATE_KEY = "auto_imminent_state";

const DEFAULT_ON = ["new_product", "restock", "site_changed"];
const DEFAULT_MINUTES = 20;
const DEFAULT_MAX_PER_DAY = 4;
const DAY_MS = 24 * 3_600_000;

export interface AutoImminentGroup {
  id: string;
  /** Site ids whose events can fire the group. */
  triggers: string[];
  /** Site ids switched to imminent when it fires. */
  targets: string[];
  /** Alert types that count as a drop signal. */
  on: string[];
  minutes: number;
  maxPerDay: number;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const positive = (v: unknown, fallback: number): number => (typeof v === "number" && v > 0 ? v : fallback);

/** Defensive read: anything malformed is dropped, never thrown. */
export function parseAutoImminent(raw: string | null | undefined): AutoImminentGroup[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const cfg = parsed as { enabled?: unknown; groups?: unknown } | null;
  if (!cfg || cfg.enabled === false || !Array.isArray(cfg.groups)) return [];
  const out: AutoImminentGroup[] = [];
  for (const g of cfg.groups as Array<Record<string, unknown> | null>) {
    if (!g || typeof g["id"] !== "string" || g["enabled"] === false) continue;
    const triggers = strings(g["triggers"]);
    const targets = strings(g["targets"]);
    if (triggers.length === 0 || targets.length === 0) continue;
    const on = strings(g["on"]);
    out.push({
      id: g["id"],
      triggers,
      targets,
      on: on.length > 0 ? on : DEFAULT_ON,
      minutes: positive(g["minutes"], DEFAULT_MINUTES),
      maxPerDay: positive(g["maxPerDay"], DEFAULT_MAX_PER_DAY),
    });
  }
  return out;
}

/** The first event this pass that counts as a drop signal for the group. */
export function findTrigger(group: AutoImminentGroup, results: CheckedSite[]): { siteName: string; event: Alert } | null {
  for (const { def, outcome } of results) {
    if (!outcome.ok || !group.triggers.includes(def.id)) continue;
    // Quiet rows are damped repeats; baselines are never in `on`.
    const event = outcome.events.find((ev) => ev.quiet !== true && group.on.includes(ev.type));
    if (event) return { siteName: def.name, event };
  }
  return null;
}

function loadFires(raw: string | null | undefined, now: number): Record<string, string[]> {
  try {
    const parsed = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [id, list] of Object.entries(parsed ?? {})) {
      out[id] = strings(list).filter((iso) => now - Date.parse(iso) < DAY_MS);
    }
    return out;
  } catch {
    return {};
  }
}

export async function maybeAutoImminent(ctx: RunContext, results: CheckedSite[]): Promise<void> {
  const { store, log = () => {} } = ctx;
  if (!results.some((r) => r.outcome.events.length > 0)) return; // the usual pass: nothing to read
  const groups = parseAutoImminent(await store.meta.get(AUTO_IMMINENT_META_KEY));
  if (groups.length === 0) return;

  const now = Date.now();
  const fires = loadFires(await store.meta.get(AUTO_IMMINENT_STATE_KEY), now);
  let dirty = false;

  for (const group of groups) {
    const hit = findTrigger(group, results);
    if (!hit) continue;
    const used = fires[group.id] ?? [];
    if (used.length >= group.maxPerDay) {
      log(`[auto-imminent:${group.id}] signal from ${hit.siteName} ignored — daily cap of ${group.maxPerDay} reached`);
      continue;
    }
    const switched: string[] = [];
    for (const id of group.targets) {
      const row = await store.sites.get(id);
      // Absent, switched off, or already imminent (the operator's run or an
      // earlier auto one): leave it exactly as it is.
      if (!row || !row.definition.enabled || row.definition.imminent) continue;
      const def = row.definition;
      await store.sites.upsert({
        ...def,
        imminent: true,
        imminentSince: new Date(now).toISOString(),
        imminentAutoMinutes: group.minutes,
        scheduleBeforeImminent: def.scheduleBeforeImminent ?? def.schedule ?? null,
      });
      switched.push(def.name);
    }
    if (switched.length === 0) continue; // nothing changed — don't spend the budget
    fires[group.id] = [...used, new Date(now).toISOString()];
    dirty = true;
    log(
      `[auto-imminent:${group.id}] ${hit.event.type} "${hit.event.product.title}" at ${hit.siteName} → ` +
        `${switched.join(", ")} imminent for ${group.minutes}m (${used.length + 1}/${group.maxPerDay} today)`,
    );
  }

  if (dirty) await store.meta.set(AUTO_IMMINENT_STATE_KEY, JSON.stringify(fires));
}
