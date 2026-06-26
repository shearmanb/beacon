// Reveries identity — shared by the Sites page (headline stat + ✨ section) and
// the Products table (✨ flag + filter). Lifted out of app/page.tsx so both
// surfaces agree on what counts as "a Reveries bottle" instead of duplicating it.
//
// A product counts as Reveries if it lives on a Reveries-carrying site OR its
// title says so (the Storefront feed's titles may not literally contain
// "reveries", and third-party retailers list it under varied vendor names).

export const REVERIES_SITE_IDS = new Set([
  "reveries_official",
  "sharedpour_reveries",
  "fountain_inn_dc",
  "bourbon_concierge",
]);

export function isReveries(siteId: string, title: string): boolean {
  return REVERIES_SITE_IDS.has(siteId) || title.toLowerCase().includes("reveries");
}
