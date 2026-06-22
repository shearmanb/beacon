// One pass over all sites — ported from worker.js run(), adapted to the DB.
// Loads config/schedules/ignored/secrets from the store, drains commands, runs
// imminent auto-off, then checks each due site via the engine and persists the
// outcome. No GitHub push/merge/SHA machinery — the DB handles persistence.

import { buildAdapterDeps, getAdapter, type SiteDefinition } from "@beacon/core";
import { sleep, jitter, shouldCheck, type Alert } from "@beacon/shared";
import type { NotificationChannel } from "@beacon/notify";
import type { BeaconStore, SiteRow } from "@beacon/db";
import { applyCommands } from "./commands.js";
import { processSite } from "./process-site.js";

export const DEFAULT_IMMINENT_DURATION_MIN = 20;

export interface RunContext {
  store: BeaconStore;
  channel?: NotificationChannel | undefined;
  dryRun: boolean;
  log?: (msg: string) => void;
  /** Override the inter-fetch politeness sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

function siteUrl(site: SiteDefinition): string {
  const s = site.source;
  if ("url" in s) return s.url;
  if ("baseUrl" in s) return s.baseUrl;
  return "";
}

async function autoOffImminent(ctx: RunContext, rows: SiteRow[]): Promise<void> {
  const { store, channel, dryRun, log = () => {} } = ctx;
  for (const row of rows) {
    const def = row.definition;
    if (!def.imminent || !def.imminentSince) continue;
    const durationMin = def.imminentDurationMinutes ?? DEFAULT_IMMINENT_DURATION_MIN;
    if (Date.now() - Date.parse(def.imminentSince) < durationMin * 60_000) continue;

    const restored = def.scheduleBeforeImminent ?? def.schedule ?? undefined;
    log(`[${def.name}] Imminent auto-off after ${durationMin}m timeout`);
    const event: Alert = {
      type: "imminent_timeout",
      product: {
        title: def.name,
        url: siteUrl(def),
        note: `Imminent mode auto-disabled after ${durationMin} min.`,
      },
    };
    if (!dryRun) {
      await store.sites.upsert({
        ...def,
        imminent: false,
        imminentSince: null,
        scheduleBeforeImminent: null,
        schedule: restored ?? undefined,
      });
      await store.history.append(def.id, [event]);
      if (channel) {
        try {
          await channel.send(def.name, event);
        } catch (err) {
          log(`  Discord imminent_timeout error: ${(err as Error).message}`);
        }
      }
    }
  }
}

export interface RunResult {
  anyImminentActive: boolean;
  checked: number;
}

export async function runOnce(ctx: RunContext): Promise<RunResult> {
  const { store, channel, dryRun, log = () => {} } = ctx;
  const wait = ctx.sleep ?? sleep;

  const schedules = await store.schedules.all();
  const ignored = await store.ignored.set();
  const deps = buildAdapterDeps(await store.secrets.all());

  await applyCommands(store, await store.commands.drainPending());
  let rows = await store.sites.list();
  await autoOffImminent(ctx, rows);
  rows = await store.sites.list(); // refresh after auto-off mutations

  const anyImminentActive = rows.some((r) => r.enabled && r.definition.imminent);
  let checked = 0;

  for (const row of rows) {
    const def = row.definition;
    if (!def.enabled) continue;

    const prevState = await store.state.load(def.id);

    const cooldownUntil = prevState?.cooldownUntil ? Date.parse(prevState.cooldownUntil as string) : 0;
    if (cooldownUntil > Date.now()) {
      log(`[${def.name}] Skipping — rate-limit cooldown`);
      continue;
    }
    if (!shouldCheck(def, prevState, schedules)) continue;

    let adapter;
    try {
      adapter = getAdapter(def.source.kind);
    } catch (err) {
      log(`[${def.name}] ${(err as Error).message}`);
      continue;
    }

    await wait(jitter(3500, 1500)); // pre-site politeness jitter
    log(`[${def.name}] Checking...`);
    checked += 1;

    const outcome = await processSite({ site: def, prevState, adapter, deps, ignored });

    if (!dryRun) {
      await store.state.save(def.id, outcome.newState);
      if (outcome.events.length) await store.history.append(def.id, outcome.events);
    }
    for (const ev of outcome.events) {
      log(`  → ${ev.type}: ${ev.product.title}`);
      if (ev.type !== "baseline" && channel && !dryRun) {
        try {
          await channel.send(def.name, ev);
        } catch (err) {
          log(`  Discord error: ${(err as Error).message}`);
        }
      }
    }

    await wait(jitter(1000, 500)); // inter-site gap
  }

  return { anyImminentActive, checked };
}
