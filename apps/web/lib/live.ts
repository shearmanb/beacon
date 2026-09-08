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

// ---------------------------------------------------------------------------
// Storefront walls — the second way "in stock" lies (2026-09-08).
//
// Shopify's `available` / `availableForSale` is a WAREHOUSE fact: units exist in
// inventory. It says nothing about whether a customer can reach a checkout. The
// Reveries shop (thereveries.co) is a Squarespace page embedding a Shopify Buy
// Button from the shared-pour store; between drops the page sits behind a
// "Come Back Later" password wall while the products stay loaded — and
// available — in the Shopify backend. reveries_official reads that backend
// (Storefront GraphQL) so it kept reporting 8 bottles "in stock" behind a wall
// nobody can get through. Beacon already KNEW the wall was up (the
// reveries_site_status http_status monitor had `pageReset: true` and had paged
// about it) — the two signals were just never joined.
//
// The join is host-based and needs no per-site config: any live http_status
// monitor currently reporting a wall gates every product whose public URL is
// on the same host. Add a monitor for a host and every stock surface for that
// host inherits the gate.

/** Hostname of a URL without a leading "www." — the identity of a storefront
 *  for wall-gating (thereveries.co and www.thereveries.co are one shop). */
export function storeHost(url: string): string {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    host = url.replace(/^https?:\/\//, "").split("/")[0] ?? "";
  }
  host = host.toLowerCase().replace(/^www\./, "");
  // Only host-shaped strings count — a "#" placeholder URL is not a store.
  return /^[a-z0-9.-]+$/.test(host) ? host : "";
}

/** Minimal shape of a site card this gate needs (matches lib/stock.ts SiteCard). */
export interface WallSource {
  row: { enabled: boolean; sourceKind: string; definition?: { source?: unknown } };
  state: { lastChecked?: string | null; pageReset?: boolean } | undefined;
}

/**
 * Hosts whose storefront is currently behind a password / coming-soon wall,
 * per a LIVE http_status monitor (same enabled + <24h gate as rosters — a
 * disabled or wedged monitor gates nothing, it just reads "unknown").
 */
export function walledHosts(cards: WallSource[]): Set<string> {
  const walls = new Set<string>();
  for (const { row, state } of cards) {
    if (row.sourceKind !== "http_status") continue;
    if (!rosterIsLive(row.enabled, state?.lastChecked)) continue;
    if (state?.pageReset !== true) continue;
    const src = row.definition?.source as { url?: unknown } | undefined;
    if (typeof src?.url !== "string") continue;
    const host = storeHost(src.url);
    if (host) walls.add(host);
  }
  return walls;
}

/** Is this product's public page on a storefront that is currently walled? */
export function behindWall(productUrl: string, walls: Set<string>): boolean {
  if (walls.size === 0) return false;
  const host = storeHost(productUrl);
  return host !== "" && walls.has(host);
}
