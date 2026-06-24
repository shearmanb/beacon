// One-time migration: read the legacy JSON files and write them into the new
// libSQL datastore. Critically, it preserves the existing product baselines
// (state.products verbatim) so the first real check after cutover sees them as
// already-known and produces ZERO new_product alerts (no re-alert flood).
//
// pending_bottles.json is intentionally NOT imported — bottle tracking moves to
// the Cellar app. alert_history_archive.json (v1's pre-500 overflow) is also NOT
// imported: the recent alert_history (cap 500) carries over; deeper history stays
// in that archive file + git history if it's ever needed.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { schema, type BeaconStore } from "@beacon/db";
import type { SiteState } from "@beacon/core";
import type { ScheduleDefinition } from "@beacon/shared";
import { mapSiteDefinition, mapSource, type LegacySite } from "./mapping.js";

export interface ImportSummary {
  sites: number;
  sitesFailed: Array<{ id: string; error: string }>;
  states: number;
  products: number;
  history: number;
  schedules: number;
  ignored: number;
  reminders: number;
  secrets: number;
}

interface LegacyHistoryEntry {
  timestamp: string;
  siteId?: string;
  type: string;
  product?: { handle?: string; title?: string; url?: string };
}

async function readJson<T>(dir: string, file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(join(dir, file), "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

export async function runImport(
  store: BeaconStore,
  dataDir: string,
  opts: { reset?: boolean } = {},
): Promise<ImportSummary> {
  if (opts.reset) {
    for (const table of Object.values(schema)) {
      await store.db.delete(table);
    }
  }

  const config = await readJson<{ sites: LegacySite[] }>(dataDir, "config.json", { sites: [] });
  const state = await readJson<Record<string, SiteState>>(dataDir, "state.json", {});
  const schedules = await readJson<Record<string, ScheduleDefinition>>(dataDir, "schedules.json", {});
  const ignored = await readJson<Record<string, boolean>>(dataDir, "ignored_products.json", {});
  const reminders = await readJson<{ items: Array<Record<string, unknown>> }>(dataDir, "reminders.json", { items: [] });
  const history = await readJson<LegacyHistoryEntry[]>(dataDir, "alert_history.json", []);

  const summary: ImportSummary = {
    sites: 0,
    sitesFailed: [],
    states: 0,
    products: 0,
    history: 0,
    schedules: 0,
    ignored: 0,
    reminders: 0,
    secrets: 0,
  };

  // 1) Sites (+ secrets pulled out of definitions).
  for (const legacy of config.sites) {
    try {
      const { source, secret } = mapSource(legacy);
      if (secret) {
        await store.secrets.set(secret.ref, secret.value);
        summary.secrets += 1;
      }
      await store.sites.upsert(mapSiteDefinition(legacy, source));
      summary.sites += 1;
    } catch (err) {
      summary.sitesFailed.push({ id: legacy.id, error: (err as Error).message });
    }
  }

  // 2) State + product baselines (verbatim — this is what prevents the flood).
  for (const [siteId, siteState] of Object.entries(state)) {
    await store.state.save(siteId, siteState);
    summary.states += 1;
    summary.products += Object.keys((siteState.products as object | undefined) ?? {}).length;
  }

  // 3) History (preserve timestamps).
  await store.history.import(
    history.map((h) => ({
      ts: h.timestamp,
      siteId: h.siteId ?? null,
      type: h.type,
      handle: h.product?.handle ?? null,
      title: h.product?.title ?? null,
      url: h.product?.url ?? null,
      payload: h.product ?? null,
    })),
  );
  summary.history = history.length;

  // 4) Schedules / ignored / reminders.
  for (const [id, def] of Object.entries(schedules)) {
    await store.schedules.upsert(id, def);
    summary.schedules += 1;
  }
  for (const [handle, on] of Object.entries(ignored)) {
    if (on) {
      await store.ignored.add(handle);
      summary.ignored += 1;
    }
  }
  for (const item of reminders.items ?? []) {
    await store.reminders.add({
      id: String(item["id"]),
      date: String(item["date"]),
      time: (item["time"] as string | undefined) ?? null,
      text: String(item["text"] ?? ""),
      priority: item["priority"] === true,
      done: item["done"] === true,
    });
    summary.reminders += 1;
  }

  return summary;
}
