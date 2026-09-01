// Reveries stock — dedup + roster-liveness gating for the ✨ panel and the
// headline stats, pulled out of app/page.tsx so the logic is unit-tested
// instead of living inline in a server component (which is exactly how the
// 2026-08-31 phantom-stock bug shipped unnoticed). See lib/live.ts for why
// "is this roster live" has to gate `available` at all.

import type { SiteRow } from "@beacon/db";
import type { SiteState } from "@beacon/core";
import type { NormalizedProduct } from "@beacon/shared";
import { rosterIsLive, stockKey } from "./live";
import { isReveries } from "./reveries";

export interface SiteCard {
  row: SiteRow;
  state: SiteState | undefined;
}

export interface StockProduct {
  key: string;
  handle: string;
  site: string;
  title: string;
  available: boolean;
  /** Roster frozen (site disabled / not checked in >24h): last-known values,
   *  not current stock. */
  stale: boolean;
  minPrice: number | null;
  vendor: string | null;
  url: string;
}

function productsOf(state: SiteState | undefined): NormalizedProduct[] {
  return Object.values(state?.products ?? {});
}

/**
 * One row per physical Reveries bottle across every site: deduped by
 * host+handle (several checkers can watch the same store — four watched
 * sharedpour.com before the 2026-08-26 consolidation) and gated by roster
 * liveness, so a disabled or long-silent checker's last-known `available`
 * can never outrank a live checker's current read of the same bottle.
 */
export function loadReveriesStock(cards: SiteCard[]): StockProduct[] {
  const byKey = new Map<string, StockProduct>();
  for (const { row, state } of cards) {
    const live = rosterIsLive(row.enabled, state?.lastChecked);
    for (const p of productsOf(state)) {
      if (!isReveries(row.id, p.title)) continue;
      const key = stockKey(p.url, p.handle);
      const existing = byKey.get(key);
      // First live entry wins; a stale one only fills a slot no live site covers.
      if (existing && !(live && existing.stale)) continue;
      byKey.set(key, {
        key,
        handle: p.handle,
        site: row.name,
        title: p.title || p.handle,
        available: live && p.available === true,
        stale: !live,
        minPrice: p.minPrice ?? null,
        vendor: p.vendor ?? null,
        url: p.url || "#",
      });
    }
  }
  return [...byKey.values()].sort(
    (a, b) =>
      Number(b.available) - Number(a.available) ||
      Number(a.stale) - Number(b.stale) ||
      a.title.localeCompare(b.title),
  );
}

/** Products tracked by rosters still being checked (see rosterIsLive) — a
 *  frozen roster no longer counts as tracked inventory. */
export function countLiveProducts(cards: SiteCard[]): number {
  return cards.reduce((n, { row, state }) => {
    const live = rosterIsLive(row.enabled, state?.lastChecked);
    return n + (live ? productsOf(state).length : 0);
  }, 0);
}

/** Products across every site regardless of liveness. The gap between this
 *  and countLiveProducts is how many products are currently stuck on a frozen
 *  roster — surfaced as a dashboard warning (see app/page.tsx). */
export function countAllProducts(cards: SiteCard[]): number {
  return cards.reduce((n, { state }) => n + productsOf(state).length, 0);
}
