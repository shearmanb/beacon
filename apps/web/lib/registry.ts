// The Reveries Registry (reveriesregistry.com) — an independent, fan-made
// archive of every Reveries release, one page per release
// (`bottle.html?id=<n>`). Beacon links each Reveries bottle to its registry
// page when the registry has it, and to the registry's homepage otherwise.
//
// Source: the site serves its whole catalog as one static script, `data.js`
// (`const BARRELS = [ {id, name, …, series, group, …}, … ]`, ~100 KB, robots
// allows all). It is fetched by the DASHBOARD server, at most every 12 h, and
// held in memory only: nothing touches the worker, the database or the backup.
// It is never executed — each record line is read with a regex for the four
// fields the links need.
//
// Matching refuses to guess, the same rule Drop Tracker's bottle matcher
// follows (a confident wrong link is worse than the homepage):
//   1. a barrel number in the title ("#27706") equal to exactly one record's
//      `series`;
//   2. else a quoted name in the title ("Glaze", “Wake of the Ship”) equal to
//      exactly one record's name — and never to a GROUP name ("Cask in
//      Point", "EndAlz" are store groups that span several barrels).
// Measured 2026-11-09 against Beacon's 100 distinct Reveries titles: ~18 link
// to their own page. The rest (most recent T8KE Reserve Casks — Sinister Glee,
// Gambit, Wake of the Ship…) are simply not in the registry yet; they link to
// the homepage and start deep-linking once the registry adds them.
//
// Self-healing: a failed fetch, or a parse that finds far fewer records than
// the last good one (the file changed shape), keeps the last good catalog and
// records why; with no good catalog at all every link is the homepage.
// `registryStatus()` exposes this to /api/ops/status.

export const REGISTRY_HOME = "https://reveriesregistry.com/";
const DATA_URL = "https://reveriesregistry.com/data.js";
const TTL_MS = 12 * 3_600_000;
/** After a failure, wait this long before trying again (don't hammer a dead host). */
const RETRY_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 8_000;
/** A parse yielding under this share of the last good count is treated as a shape change. */
const MIN_SHARE = 0.5;

export interface RegistryEntry {
  id: number;
  name: string;
  series: string;
  group: string;
}

export interface RegistryIndex {
  bySeries: Map<string, number[]>;
  byName: Map<string, number[]>;
  groups: Set<string>;
  count: number;
}

/** Lowercase, accents and apostrophes dropped, everything else to single spaces. */
export function normName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’'`]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function field(line: string, key: string): string {
  const m = line.match(new RegExp(`\\b${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  return m ? m[1]!.replace(/\\(.)/g, "$1") : "";
}

/** Read the four fields out of the registry's data.js text. Never evaluates it. */
export function parseRegistry(js: string): RegistryEntry[] {
  const out: RegistryEntry[] = [];
  for (const line of js.split("\n")) {
    const id = line.match(/\{\s*id:\s*(\d+)\s*,/);
    if (!id) continue;
    const name = field(line, "name");
    if (!name) continue;
    out.push({ id: Number(id[1]), name, series: field(line, "series"), group: field(line, "group") });
  }
  return out;
}

export function buildIndex(entries: RegistryEntry[]): RegistryIndex {
  const bySeries = new Map<string, number[]>();
  const byName = new Map<string, number[]>();
  const groups = new Set<string>();
  const push = (m: Map<string, number[]>, k: string, id: number) => m.set(k, [...(m.get(k) ?? []), id]);
  for (const e of entries) {
    const s = e.series.trim().toLowerCase();
    if (s && s !== "n/a") push(bySeries, s, e.id);
    const n = normName(e.name);
    if (n) push(byName, n, e.id);
    // A group can list several names ("Bourbon BarrALZ / EndAlz").
    for (const g of e.group.split("/")) if (normName(g)) groups.add(normName(g));
  }
  return { bySeries, byName, groups, count: entries.length };
}

/** The registry id for a product title, or null when it can't be told without guessing. */
export function matchRegistry(title: string, idx: RegistryIndex): number | null {
  for (const m of title.matchAll(/#\s*([A-Za-z]{0,4}\d{3,6}(?:-[A-Za-z])?)\b/g)) {
    const ids = idx.bySeries.get(m[1]!.toLowerCase());
    if (ids?.length === 1) return ids[0]!;
  }
  for (const m of title.matchAll(/["“”]([^"“”]{2,60})["“”]/g)) {
    const n = normName(m[1]!);
    if (!n || idx.groups.has(n)) continue;
    const ids = idx.byName.get(n);
    if (ids?.length === 1) return ids[0]!;
  }
  return null;
}

export function registryUrl(id: number | null): string {
  return id == null ? REGISTRY_HOME : `${REGISTRY_HOME}bottle.html?id=${id}`;
}

// ── In-memory cache (dashboard server process) ─────────────────────────────

interface CacheState {
  index: RegistryIndex | null;
  fetchedAt: number | null;
  lastTryAt: number | null;
  lastError: string | null;
  inflight: Promise<void> | null;
}
const cache: CacheState = { index: null, fetchedAt: null, lastTryAt: null, lastError: null, inflight: null };

async function refresh(fetchImpl: typeof fetch): Promise<void> {
  cache.lastTryAt = Date.now();
  try {
    const res = await fetchImpl(DATA_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: "*/*", "User-Agent": "Beacon (personal bourbon tracker; links to reveriesregistry.com)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const entries = parseRegistry(await res.text());
    const floor = cache.index ? Math.ceil(cache.index.count * MIN_SHARE) : 1;
    if (entries.length < floor) {
      throw new Error(`parsed ${entries.length} releases (last good ${cache.index?.count ?? 0}) — data.js may have changed shape`);
    }
    cache.index = buildIndex(entries);
    cache.fetchedAt = Date.now();
    cache.lastError = null;
  } catch (err) {
    cache.lastError = err instanceof Error ? err.message : String(err);
  }
}

/** The current index (refreshing when due), or null when none has ever loaded. Never throws. */
export async function loadRegistry(fetchImpl: typeof fetch = fetch): Promise<RegistryIndex | null> {
  const now = Date.now();
  const stale = cache.fetchedAt == null || now - cache.fetchedAt > TTL_MS;
  const mayRetry = cache.lastTryAt == null || now - cache.lastTryAt > (cache.lastError ? RETRY_MS : 0);
  if (stale && mayRetry && !cache.inflight) {
    cache.inflight = refresh(fetchImpl).finally(() => {
      cache.inflight = null;
    });
  }
  // First load waits (bounded by the fetch timeout); later refreshes serve the
  // last good index while the new one arrives.
  if (!cache.index && cache.inflight) await cache.inflight;
  return cache.index;
}

/** For /api/ops/status: is the registry feed healthy? */
export function registryStatus(): { releases: number; fetchedAt: string | null; lastError: string | null } {
  return {
    releases: cache.index?.count ?? 0,
    fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    lastError: cache.lastError,
  };
}

/** Tests only. */
export function _resetRegistryCache(): void {
  Object.assign(cache, { index: null, fetchedAt: null, lastTryAt: null, lastError: null, inflight: null });
}

/** The link a Reveries bottle gets: its own page, or the homepage. */
export function registryRef(title: string, idx: RegistryIndex | null): { url: string; exact: boolean } {
  const id = idx ? matchRegistry(title, idx) : null;
  return { url: registryUrl(id), exact: id != null };
}
