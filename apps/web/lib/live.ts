// Roster liveness — whether a site's stored product map is still evidence of
// CURRENT stock, or just a frozen snapshot.
//
// Why this exists: the worker replaces a site's product map wholesale on every
// successful check, so for a site being checked the map IS the store's current
// roster. The moment checking stops, that map freezes with whatever
// `available` values it last held — and nothing ever clears them. A retired
// checker (the 2026-08-26 SharedPour 4->1 consolidation), a quarantined one
// (2026-08-14), or one out of Browserbase credit keeps reporting its last-seen
// bottles as "in stock" indefinitely. On 2026-08-31 that was 36 of the 71
// "available" products dashboard-wide, including two bottles Beacon had itself
// recorded as sold_out weeks earlier (Aug 11 and Aug 24).
//
// So: stock surfaces must ask whether the roster is live, not just what it says.

/** A roster older than this is a snapshot, not stock — even on an enabled site
 *  (a long breaker cooldown or a wedged host can outrun its schedule). The
 *  slowest configured cadence is 120 min overnight, so a day of silence is well
 *  past "just between checks". */
export const ROSTER_STALE_MS = 24 * 3_600_000;

/** Is this site's stored product map still evidence of current stock? */
export function rosterIsLive(enabled: boolean, lastChecked: string | null | undefined): boolean {
  if (!enabled || !lastChecked) return false;
  const age = Date.now() - Date.parse(lastChecked);
  return Number.isFinite(age) && age <= ROSTER_STALE_MS;
}

/** Identity of a physical bottle across checkers: several sites watch the same
 *  store with overlapping rosters (four watched sharedpour.com before the
 *  consolidation), so counting per-site double-counts one bottle. Keyed by
 *  host+handle, mirroring the worker's cross-site alert dedupe key. */
export function stockKey(url: string, handle: string): string {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    host = url.replace(/^https?:\/\//, "").split("/")[0] ?? "";
  }
  return `${host}|${handle}`;
}
