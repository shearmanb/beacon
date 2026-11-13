// Block back-off — a read-side feedback loop (2026-10-30). A site that logged a
// block-like failure (401/403/429/430/503 or a tar-pit stall) inside the last
// BLOCK_BACKOFF_WINDOW_MS is checked at BLOCK_BACKOFF_FACTOR × its interval
// until the window passes. It never touches stored state, so it reverts on its
// own, and it only ever LENGTHENS an interval — it cannot add load. Imminent
// mode bypasses it (the operator is watching a drop). Sibling of run.ts' tight-
// window cooldown clamp, and like it, the dashboard's next-check prediction
// (apps/web/lib/nextcheck.ts) must apply the same factor so the tile stays
// truthful. Lives in @beacon/shared so the worker and the web agree by
// construction.

export const BLOCK_BACKOFF_WINDOW_MS = 6 * 3_600_000;
export const BLOCK_BACKOFF_FACTOR = 1.5;

/** Status-less failures that mean "the host left us hanging" (tar-pit). */
export const STALL_RE = /aborted (fetch|post)ing|deadline exceeded|socket idle timeout/i;

/** A failure that says "blocked / rate-limited", not "broken": these recover on
 *  their own, so they must never count toward quarantine. 503 is the
 *  challenge-mode WAF answer (Jul 22). */
export function isBlockLikeFailure(statusCode: number | null | undefined, message: string): boolean {
  if (statusCode == null) return STALL_RE.test(message);
  return [401, 403, 429, 430, 503].includes(statusCode);
}

export interface ErrorLogEntry {
  ts: string;
  message?: string;
  statusCode?: number | null;
}

/** The newest block-like failure inside the window, or null. */
export function recentBlock(
  errorLog: ErrorLogEntry[] | undefined | null,
  now: number = Date.now(),
): ErrorLogEntry | null {
  if (!Array.isArray(errorLog)) return null;
  for (let i = errorLog.length - 1; i >= 0; i--) {
    const e = errorLog[i];
    if (!e) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t) || now - t > BLOCK_BACKOFF_WINDOW_MS) continue;
    if (isBlockLikeFailure(e.statusCode, e.message ?? "")) return e;
  }
  return null;
}

/** 1 normally; BLOCK_BACKOFF_FACTOR while a block-like failure is recent. */
export function blockBackoffFactor(
  errorLog: ErrorLogEntry[] | undefined | null,
  now: number = Date.now(),
): number {
  return recentBlock(errorLog, now) ? BLOCK_BACKOFF_FACTOR : 1;
}

// ── Cadence adjustment: the whole loop in one place (2026-11-13) ─────────────
// The scheduler and the dashboard both ask ONE question — "by what factor is
// this site's interval adjusted right now, and why?" — so they agree by
// construction. Read-side only: nothing is stored, every state reverts alone.
//   block   ×1.5  a block-like failure in the last 6 h (above).
//   slow    ×1.5  early warning: a tar-pit begins as slow answers before it
//                 becomes a 429. The last SLOW_RUN successful checks each took
//                 over SLOW_FACTOR × the site's own median (and over
//                 SLOW_FLOOR_MS, so a 304-heavy median can't make an ordinary
//                 full fetch look slow). Ends as soon as one check is quick.
//   faster  ×0.8 / ×0.6  opt-in (`adaptiveFloorMinutes`), tight intervals only:
//                 3 clean days without a block earn ×0.8, 7 earn ×0.6 — but a
//                 host that blocked inside the last 30 days never gets past
//                 ×0.8, so the loop does not keep re-finding the same edge.
//                 Never below the site's floor.
// Imminent mode ignores all of it (the caller skips the call).

export const SLOW_FACTOR = 3;
export const SLOW_FLOOR_MS = 4_000;
export const SLOW_RUN = 3;
export const SLOW_MIN_SAMPLES = 12;
export const SLOW_MAX_AGE_MS = 3_600_000;
export const FASTER_TIGHT_MAX_MIN = 15;
const DAY_MS = 24 * 3_600_000;

export interface CadenceSignals {
  errorLog?: ErrorLogEntry[] | null | undefined;
  checkHistory?: Array<{ ts: string; ok: boolean; ms?: number }> | null | undefined;
  /** When the site was last (re-)enabled — a clean streak can't predate it. */
  enabledAt?: string | null | undefined;
}

export interface CadenceAdjust {
  factor: number;
  reason: "block" | "slow" | "faster" | null;
  /** Short operator-facing why, for the tile. */
  detail: string;
}

const NONE: CadenceAdjust = { factor: 1, reason: null, detail: "" };

function slowdown(history: CadenceSignals["checkHistory"], now: number): { ms: number; median: number } | null {
  const timed = (Array.isArray(history) ? history : []).filter((c) => c?.ok === true && typeof c.ms === "number");
  if (timed.length < SLOW_MIN_SAMPLES) return null;
  const recent = timed.slice(-SLOW_RUN);
  if (now - Date.parse(recent[recent.length - 1]!.ts) > SLOW_MAX_AGE_MS) return null;
  const base = timed.slice(0, -SLOW_RUN).map((c) => c.ms!).sort((a, b) => a - b);
  const median = base[Math.floor(base.length / 2)]!;
  const bar = Math.max(SLOW_FLOOR_MS, SLOW_FACTOR * median);
  return recent.every((c) => c.ms! > bar) ? { ms: Math.min(...recent.map((c) => c.ms!)), median } : null;
}

export function cadenceAdjust(
  intervalMin: number,
  site: { adaptiveFloorMinutes?: number | null | undefined },
  signals: CadenceSignals | undefined | null,
  now: number = Date.now(),
): CadenceAdjust {
  const errorLog = signals?.errorLog;
  const block = recentBlock(errorLog, now);
  if (block) {
    const what = block.statusCode != null ? `HTTP ${block.statusCode}` : "stall";
    return { factor: BLOCK_BACKOFF_FACTOR, reason: "block", detail: what };
  }
  const slow = slowdown(signals?.checkHistory, now);
  if (slow) {
    return {
      factor: BLOCK_BACKOFF_FACTOR,
      reason: "slow",
      detail: `answers ≥${(slow.ms / 1000).toFixed(1)}s vs a usual ${(slow.median / 1000).toFixed(1)}s`,
    };
  }
  const floor = site.adaptiveFloorMinutes;
  if (floor == null || !(floor > 0) || intervalMin > FASTER_TIGHT_MAX_MIN || intervalMin <= floor) return NONE;
  let lastBlock = 0;
  for (const e of Array.isArray(errorLog) ? errorLog : []) {
    const t = Date.parse(e?.ts ?? "");
    if (Number.isFinite(t) && isBlockLikeFailure(e.statusCode, e.message ?? "")) lastBlock = Math.max(lastBlock, t);
  }
  const enabledAt = Date.parse(signals?.enabledAt ?? "");
  const cleanSince = Math.max(lastBlock, Number.isFinite(enabledAt) ? enabledAt : 0);
  const cleanDays = (now - cleanSince) / DAY_MS;
  if (cleanDays < 3) return NONE;
  const step = cleanDays >= 7 && now - lastBlock > 30 * DAY_MS ? 0.6 : 0.8;
  const factor = Math.max(step, floor / intervalMin);
  return { factor, reason: "faster", detail: `${Math.min(99, Math.floor(cleanDays))} clean days` };
}
