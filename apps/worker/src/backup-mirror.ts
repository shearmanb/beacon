// Off-box backup → GitHub (analytics/backup/beacon-restore.json).
//
// WHY: the on-volume `VACUUM INTO` snapshots guard against corruption and bad
// writes, but they live on the SAME Railway volume as the database — so the one
// failure they cannot survive is the volume being lost. The seed-guard in
// serve.ts correctly REFUSES to re-seed stale baselines in that case (it would
// flood Discord with false "new product" alerts for every bottle already on
// every shelf), which means today a lost volume leaves Beacon sitting there
// with no sites until the operator intervenes.
//
// This is the missing half: one daily JSON bundle pushed to the repo, and a
// restore path serve.ts calls automatically when the volume is gone. It reuses
// the exact machinery the alert-history mirror already proved (GH_TOKEN +
// GH_REPO, [skip ci] commits, analytics/ is outside Railway's watchPatterns so
// a backup push triggers no deploy).
//
// What's in the bundle:
//   • site definitions, schedules, ignored products, reminders
//   • the meta blobs that hold hand-curated config (the Unicorn watchlist,
//     target bottles and buying notes — irreplaceable by re-scraping)
//   • per-site product BASELINES, which is what actually prevents the
//     false-alert flood on restore
// What's NOT: the secrets table (never put tokens in the repo — the preventive
// harvest re-arms Storefront fallbacks on its own within a day), and the alert
// history (already mirrored to analytics/alert_history.jsonl).

import type { BeaconStore } from "@beacon/db";

const BACKUP_INTERVAL_MS = 24 * 3_600_000;
const BACKUP_PATH = "analytics/backup/beacon-restore.json";
const META_KEY = "configBackup"; // JSON: { at: iso }
const HTTP_TIMEOUT_MS = 20_000;
// Meta keys worth carrying: hand-authored config, not operational bookkeeping.
const BACKED_UP_META_KEYS = ["unicorn_config"];
// Per-site state fields that are pure operational history — dropped so the
// bundle stays small and well under the GitHub contents API's 1 MB read limit.
const VOLATILE_STATE_FIELDS = ["checkHistory", "errorLog", "viaFlips", "recentlySeen", "seenTitles"];

export interface BackupBundle {
  version: 1;
  at: string;
  sites: unknown[];
  schedules: Record<string, unknown>;
  ignored: string[];
  reminders: unknown[];
  meta: Record<string, string>;
  /** siteId -> trimmed SiteState (product baselines above all). */
  states: Record<string, unknown>;
}

export interface BackupCtx {
  store: BeaconStore;
  dryRun: boolean;
  log?: (msg: string) => void;
}

export interface BackupOverrides {
  fetchImpl?: typeof fetch;
  token?: string;
  repo?: string;
  branch?: string;
  /** Test hook: bypass the 24h gate. */
  intervalMs?: number;
}

let warnedDisarmed = false;

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "beacon-worker",
  };
}

export async function buildBackupBundle(store: BeaconStore): Promise<BackupBundle> {
  const sites = (await store.sites.list()).map((r) => r.definition);
  const states: Record<string, unknown> = {};
  for (const row of sites) {
    const state = await store.state.load(row.id);
    if (!state) continue;
    const trimmed: Record<string, unknown> = { ...state };
    for (const f of VOLATILE_STATE_FIELDS) delete trimmed[f];
    states[row.id] = trimmed;
  }
  const meta: Record<string, string> = {};
  for (const key of BACKED_UP_META_KEYS) {
    const value = await store.meta.get(key);
    if (value != null) meta[key] = value;
  }
  return {
    version: 1,
    at: new Date().toISOString(),
    sites,
    schedules: await store.schedules.all(),
    ignored: [...(await store.ignored.set())],
    reminders: await store.reminders.list(),
    meta,
    states,
  };
}

/** Push one bundle per interval. Never throws into the check loop. */
export async function maybeBackupConfig(ctx: BackupCtx, over: BackupOverrides = {}): Promise<boolean> {
  const { store, dryRun, log = () => {} } = ctx;
  const token = over.token ?? process.env["GH_TOKEN"];
  const repo = over.repo ?? process.env["GH_REPO"];
  if (!token || !repo) {
    if (!warnedDisarmed) {
      warnedDisarmed = true;
      log("[backup] Off-box backup disarmed — set GH_TOKEN + GH_REPO to push a daily restore bundle.");
    }
    return false;
  }
  if (dryRun) return false;

  const intervalMs = over.intervalMs ?? BACKUP_INTERVAL_MS;
  let lastAt = 0;
  const metaRaw = await store.meta.get(META_KEY);
  if (metaRaw) {
    try {
      lastAt = Date.parse((JSON.parse(metaRaw) as { at?: string }).at ?? "") || 0;
    } catch {
      /* corrupt meta -> treat as never run */
    }
  }
  if (Date.now() - lastAt < intervalMs) return false;

  const bundle = await buildBackupBundle(store);
  // An empty datastore must never overwrite a good backup — that's precisely
  // the volume-loss state this exists to recover from.
  if (bundle.sites.length === 0) {
    log("[backup] Skipped — no sites in the datastore (refusing to overwrite a good backup with an empty one).");
    return false;
  }

  const fetchImpl = over.fetchImpl ?? fetch;
  const branch = over.branch ?? "main";
  const api = `https://api.github.com/repos/${repo}/contents/${BACKUP_PATH}`;
  const headers = ghHeaders(token);

  const getRes = await fetchImpl(`${api}?ref=${branch}`, { headers, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  let sha: string | undefined;
  if (getRes.status === 200) {
    sha = ((await getRes.json()) as { sha?: string }).sha;
  } else if (getRes.status !== 404) {
    throw new Error(`backup GET: HTTP ${getRes.status}`);
  }

  const body = JSON.stringify(bundle, null, 1);
  const putRes = await fetchImpl(api, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    body: JSON.stringify({
      message: `backup: config + ${bundle.sites.length} site baseline(s) [skip ci]`,
      content: Buffer.from(body, "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!putRes.ok) throw new Error(`backup PUT: HTTP ${putRes.status}`);

  await store.meta.set(META_KEY, JSON.stringify({ at: bundle.at }));
  log(`[backup] Pushed restore bundle (${bundle.sites.length} sites, ${Math.round(body.length / 1024)} KB) to ${repo}.`);
  return true;
}

export interface RestoreResult {
  restored: boolean;
  sites: number;
  at?: string;
  reason?: string;
}

/**
 * Pull the newest bundle back into an EMPTY datastore. Called by serve.ts only
 * when the volume was lost and no on-volume snapshot survived — never against a
 * datastore that still has sites, so it can't clobber live state.
 */
export async function restoreFromGithub(
  store: BeaconStore,
  over: BackupOverrides = {},
): Promise<RestoreResult> {
  const token = over.token ?? process.env["GH_TOKEN"];
  const repo = over.repo ?? process.env["GH_REPO"];
  if (!token || !repo) return { restored: false, sites: 0, reason: "GH_TOKEN/GH_REPO not set" };

  const existing = await store.sites.list();
  if (existing.length > 0) return { restored: false, sites: 0, reason: "datastore is not empty" };

  const fetchImpl = over.fetchImpl ?? fetch;
  const branch = over.branch ?? "main";
  const res = await fetchImpl(
    `https://api.github.com/repos/${repo}/contents/${BACKUP_PATH}?ref=${branch}`,
    { headers: ghHeaders(token), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
  );
  if (res.status === 404) return { restored: false, sites: 0, reason: "no backup bundle in the repo" };
  if (!res.ok) return { restored: false, sites: 0, reason: `GET: HTTP ${res.status}` };

  const file = (await res.json()) as { content?: string };
  if (!file.content) return { restored: false, sites: 0, reason: "backup bundle is empty" };
  const bundle = JSON.parse(Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8")) as BackupBundle;
  if (!Array.isArray(bundle.sites) || bundle.sites.length === 0) {
    return { restored: false, sites: 0, reason: "backup bundle has no sites" };
  }

  for (const [id, definition] of Object.entries(bundle.schedules ?? {})) {
    await store.schedules.upsert(id, definition as never);
  }
  let sites = 0;
  for (const def of bundle.sites) {
    try {
      await store.sites.upsert(def);
      sites += 1;
    } catch {
      /* a definition that no longer validates is skipped, not fatal */
    }
  }
  // Baselines LAST and only for sites that came back — this is the part that
  // stops a restore from paging every bottle on every shelf as a new drop.
  for (const [siteId, state] of Object.entries(bundle.states ?? {})) {
    if (state && typeof state === "object") await store.state.save(siteId, state as never);
  }
  for (const handle of bundle.ignored ?? []) await store.ignored.add(handle);
  for (const [key, value] of Object.entries(bundle.meta ?? {})) await store.meta.set(key, value);
  for (const r of (bundle.reminders ?? []) as Array<Record<string, unknown>>) {
    try {
      await store.reminders.add(r as never);
    } catch {
      /* duplicate/invalid reminder — never worth failing a restore over */
    }
  }
  return { restored: true, sites, at: bundle.at };
}
