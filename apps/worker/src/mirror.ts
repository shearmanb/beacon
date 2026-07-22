// Daily alert-history mirror → GitHub (analytics/alert_history.jsonl).
//
// WHY: the live history lives in SQLite on the Railway volume, which Claude
// sessions can't reach — but they CAN read the repo (the v1 cadence analysis
// was mined straight from git history). Mirroring new alert rows to an
// append-only JSONL in the repo once a day makes the repo the permanent,
// self-serve mining surface — and doubles as off-box durability for the alert
// history (a slice of the volume-loss TODO).
//
// Design constraints, deliberately lean:
//  • Armed only when GH_TOKEN + GH_REPO env vars exist (v1's names, likely
//    still set on the Railway service). Disarmed = one log line, no errors.
//  • One push per MIRROR_INTERVAL_MS, tracked in the meta table together with
//    the last mirrored row id — restarts never re-push old rows.
//  • Commit message carries [skip ci]; analytics/ is outside Railway's
//    watchPatterns, so a mirror push triggers neither CI nor a deploy.
//  • Failures log and retry next interval — the check loop must never notice.

import type { BeaconStore } from "@beacon/db";

const MIRROR_INTERVAL_MS = 24 * 3_600_000;
const MIRROR_PATH = "analytics/alert_history.jsonl";
const META_KEY = "historyMirror"; // JSON: { at: iso, lastId: number }
// Hard cap on each GitHub call (2026-07-22): this await runs INSIDE the check
// loop, and it was the loop's only unbounded HTTP — undici's own limits can let
// a stalled call sit for minutes. "Failures log and retry next interval — the
// check loop must never notice" has to be enforced, not assumed.
const MIRROR_HTTP_TIMEOUT_MS = 20_000;
// Hard bound on the mirror file so it can't grow forever. 20k lines ≈ 4× the
// DB's own 5,000-row cap — older rows scroll off the file but stay in git
// history (mining can always walk versions, exactly like the v1 analysis).
const MAX_MIRROR_LINES = 20_000;

export interface MirrorCtx {
  store: BeaconStore;
  dryRun: boolean;
  log?: (msg: string) => void;
}

export interface MirrorOverrides {
  fetchImpl?: typeof fetch;
  token?: string;
  repo?: string;
  branch?: string;
  /** Test hook: bypass the 24h gate. */
  intervalMs?: number;
}

let warnedDisarmed = false;

/** Append rows to an existing JSONL body, bounded to the newest MAX lines. */
export function appendJsonl(existing: string, rows: unknown[]): string {
  const lines = existing.split("\n").filter((l) => l.trim().length > 0);
  for (const r of rows) lines.push(JSON.stringify(r));
  return lines.slice(-MAX_MIRROR_LINES).join("\n") + "\n";
}

export async function maybeMirrorHistory(ctx: MirrorCtx, over: MirrorOverrides = {}): Promise<void> {
  const { store, dryRun, log = () => {} } = ctx;
  const token = over.token ?? process.env["GH_TOKEN"];
  const repo = over.repo ?? process.env["GH_REPO"];
  if (!token || !repo) {
    if (!warnedDisarmed) {
      warnedDisarmed = true;
      log("[mirror] History mirror disarmed — set GH_TOKEN + GH_REPO to push daily analytics to the repo.");
    }
    return;
  }
  if (dryRun) return;

  const intervalMs = over.intervalMs ?? MIRROR_INTERVAL_MS;
  let lastAt = 0;
  let lastId = 0;
  const metaRaw = await store.meta.get(META_KEY);
  if (metaRaw) {
    try {
      const m = JSON.parse(metaRaw) as { at?: string; lastId?: number };
      lastAt = m.at ? Date.parse(m.at) : 0;
      lastId = m.lastId ?? 0;
    } catch {
      /* corrupt meta -> treat as first run */
    }
  }
  if (Date.now() - lastAt < intervalMs) return;

  // recent() is newest-first over a ≤5,000-row table; take what's new, oldest-first.
  const rows = (await store.history.recent(100_000))
    .filter((r) => r.id > lastId)
    .sort((a, b) => a.id - b.id);
  const nowIso = new Date().toISOString();
  if (rows.length === 0) {
    await store.meta.set(META_KEY, JSON.stringify({ at: nowIso, lastId }));
    return;
  }

  const fetchImpl = over.fetchImpl ?? fetch;
  const branch = over.branch ?? "main";
  const api = `https://api.github.com/repos/${repo}/contents/${MIRROR_PATH}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "beacon-worker",
  };

  const getRes = await fetchImpl(`${api}?ref=${branch}`, {
    headers,
    signal: AbortSignal.timeout(MIRROR_HTTP_TIMEOUT_MS),
  });
  let existing = "";
  let sha: string | undefined;
  if (getRes.status === 200) {
    const file = (await getRes.json()) as { content?: string; sha?: string };
    sha = file.sha;
    if (file.content) existing = Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");
  } else if (getRes.status !== 404) {
    throw new Error(`mirror GET ${MIRROR_PATH}: HTTP ${getRes.status}`);
  }

  const body = appendJsonl(existing, rows);
  const putRes = await fetchImpl(api, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(MIRROR_HTTP_TIMEOUT_MS),
    body: JSON.stringify({
      message: `analytics: mirror ${rows.length} alert-history row(s) [skip ci]`,
      content: Buffer.from(body, "utf8").toString("base64"),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!putRes.ok) throw new Error(`mirror PUT ${MIRROR_PATH}: HTTP ${putRes.status}`);

  await store.meta.set(META_KEY, JSON.stringify({ at: nowIso, lastId: rows[rows.length - 1]!.id }));
  log(`[mirror] Pushed ${rows.length} alert-history row(s) to ${repo}/${MIRROR_PATH}.`);
}
