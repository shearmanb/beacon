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
