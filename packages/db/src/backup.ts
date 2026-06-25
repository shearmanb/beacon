// Datastore durability (1b). The prod DB is a single libSQL file on one Railway
// volume — corruption or a lost volume = total loss, and the auto-seed would
// silently reset baselines. This module adds rotated on-volume snapshots
// (`VACUUM INTO`, a consistent copy even under concurrent writes) plus a restore
// helper, and is structured so an off-box upload (GitHub/Turso) can be bolted on
// as a no-op-by-default hook later. Snapshots only apply to file: URLs; Turso is
// already server-managed and :memory: is unshared, so both are no-ops here.

import { mkdir, readdir, copyFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Client } from "@libsql/client";

const PREFIX = "beacon-";
const SUFFIX = ".db";

/** Local filesystem path for a `file:` libSQL URL, else null (Turso/:memory:). */
export function dbPathFromUrl(url: string): string | null {
  if (!url.startsWith("file:")) return null;
  return resolve(url.slice("file:".length));
}

function defaultDir(dbPath: string): string {
  return join(dirname(dbPath), "backups");
}

/** Take one rotated snapshot. Returns the snapshot path, or null when the DB
 *  isn't a local file (nothing to snapshot here). Best-effort by contract — the
 *  caller logs failures but never lets a backup error take down the worker. */
export async function snapshot(
  client: Client,
  dbUrl: string,
  opts: { dir?: string; keep?: number; stamp?: string } = {},
): Promise<string | null> {
  const dbPath = dbPathFromUrl(dbUrl);
  if (!dbPath) return null;
  const dir = opts.dir ?? defaultDir(dbPath);
  const keep = opts.keep ?? 24; // e.g. 24 × 6h ≈ 6 days of history
  await mkdir(dir, { recursive: true });

  const stamp = (opts.stamp ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const dest = join(dir, `${PREFIX}${stamp}${SUFFIX}`);
  // VACUUM INTO writes a transactionally-consistent copy. The path is a SQL
  // string literal (no bind params), so escape single quotes defensively.
  await client.execute(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);

  await rotate(dir, keep);
  return dest;
}

/** Snapshot files newest-first. */
export async function listBackups(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX))
    .sort()
    .reverse()
    .map((n) => join(dir, n));
}

async function rotate(dir: string, keep: number): Promise<void> {
  const all = await listBackups(dir);
  for (const old of all.slice(keep)) {
    await rm(old, { force: true });
  }
}

/** Restore the newest snapshot over the live DB file (1b volume-loss recovery).
 *  Must run BEFORE the store opens the file. Returns the restored snapshot path,
 *  or null when there's nothing to restore. Clears stale -wal/-shm so SQLite
 *  reads the restored copy cleanly. */
export async function restoreLatest(dbUrl: string, dir?: string): Promise<string | null> {
  const dbPath = dbPathFromUrl(dbUrl);
  if (!dbPath) return null;
  const backupsDir = dir ?? defaultDir(dbPath);
  const [latest] = await listBackups(backupsDir);
  if (!latest) return null;
  // Only restore real data (a 0-byte/empty snapshot is no better than reseeding).
  try {
    const s = await stat(latest);
    if (s.size === 0) return null;
  } catch {
    return null;
  }
  await copyFile(latest, dbPath);
  await rm(`${dbPath}-wal`, { force: true });
  await rm(`${dbPath}-shm`, { force: true });
  return latest;
}
