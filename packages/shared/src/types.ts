// Canonical domain types shared across the engine. Source adapters normalize
// whatever they fetch into NormalizedProduct[] + SiteSignal[]; everything
// downstream (diff, filter, notify) operates only on these shapes.

export interface NormalizedProduct {
  handle: string;
  title: string;
  url: string;
  vendor?: string | null;
  productType?: string | null;
  tags: string[];
  minPrice?: number | null;
  available: boolean;
  image?: string | null;
  /**
   * Raw call-to-action / state text a source used to decide `available` (e.g. a
   * product card's button text). When a source populates it, diff() emits a
   * `site_changed` alert if it changes while availability stays the same — a
   * language-agnostic catch for buyable states a fixed word-list won't recognize.
   */
  cta?: string | null;
  /** Cleaned product description / tasting notes (plain text, capped at
   *  DETAILS_MAX_CHARS). Shown in Discord alerts and the dashboard. */
  details?: string | null;
  /** The product's own page when `url` is a shared shop page (a Buy Button
   *  embed: every product's `url` is the same /shop page). Kept separate so
   *  `url` still drives the password-wall gate (behindWall) by host. */
  pageUrl?: string | null;
  /** When the store says the product went live (Shopify published_at, else
   *  created_at) and was last changed (updated_at). Raw material for the
   *  detection-lag measurement in diff() — never used to decide an alert. */
  listedAt?: string | null;
  updatedAt?: string | null;
}

export type ProductMap = Record<string, NormalizedProduct>;

// Alert types map 1:1 to the existing Discord embed colors/labels. `product`
// carries either a real product or a site-level pseudo-product (site_reset /
// site_error use the site name + url + an optional human-readable note).
export type AlertType =
  | "new_product"
  | "restock"
  | "sold_out"
  | "site_reset"
  | "site_error"
  | "site_recovered"
  | "imminent_timeout"
  | "site_changed"
  | "system_degraded"
  // Self-healing engaged (or disengaged): a primary channel was blocked and the
  // checker kept running via a fallback — fired once per transition, with the
  // "why" in the note, so silent auto-recovery is never invisible.
  | "self_healed"
  | "baseline";

export interface AlertProduct {
  handle?: string;
  title: string;
  url: string;
  vendor?: string | null;
  productType?: string | null;
  minPrice?: number | null;
  available?: boolean;
  image?: string | null;
  tags?: string[];
  details?: string | null;
  pageUrl?: string | null;
  note?: string;
  listedAt?: string | null;
  updatedAt?: string | null;
  /** Detection lag (2026-11-13): seconds between the store's own timestamp and
   *  Beacon noticing. "listed" = since the product went live (new_product);
   *  "updated" = since the store last changed it (restock — approximate: any
   *  edit moves that clock, so read it as an upper bound on how late we were). */
  lagSec?: number | null;
  lagBasis?: "listed" | "updated";
}

export interface Alert {
  type: AlertType;
  product: AlertProduct;
  /** History-only: record in alert history but do NOT page Discord. Used to
   *  damp repeats (e.g. a flapping channel re-announcing itself every flip). */
  quiet?: boolean;
}

// A page-state probe (http_status source) emits a signal rather than products:
// `blocked` = password wall / coming-soon / 401-403; `open` = normal.
export type SiteSignalKind = "blocked" | "open";

export interface SiteSignal {
  kind: SiteSignalKind;
  reason?: string;
}

// ── Scheduling ────────────────────────────────────────────────────────────────

/** Injectable ET clock context so schedule resolution is deterministically testable. */
export interface EtContext {
  hour: number;
  day: string;
}

export interface ScheduleWindowRule {
  fromHour: number;
  toHour: number;
  interval: number;
  /** Optional ET weekday scope ("mon".."sun"); absent = every day. */
  days?: string[];
}

export interface ScheduleDefaultRule {
  defaultInterval: number;
  days?: string[];
}

export type ScheduleRule = ScheduleWindowRule | ScheduleDefaultRule;

export interface ScheduleDefinition {
  label?: string;
  builtin?: boolean;
  rules: ScheduleRule[];
}

export type Schedules = Record<string, ScheduleDefinition>;

/** Minimal structural shape the scheduler needs from a site definition. */
export interface SchedulableSite {
  id?: string;
  name?: string;
  schedule?: string | number | null;
  intervalMinutes?: number | null;
  imminent?: boolean;
  imminentIntervalMinutes?: number | null;
  /** Opt-in floor for the clean-days speed-up (backoff.ts cadenceAdjust). */
  adaptiveFloorMinutes?: number | null | undefined;
}

export interface SchedulableState {
  lastChecked?: string | null;
  /** Recent failures ({ts, message, statusCode}); the block back-off reads it. */
  errorLog?: Array<{ ts: string; message?: string; statusCode?: number | null }> | null;
  /** Recent checks ({ts, ok, ms}); the slowdown early-warning reads it. */
  checkHistory?: Array<{ ts: string; ok: boolean; ms?: number }> | null;
  enabledAt?: string | null;
}

export interface DiffOptions {
  onNew: boolean;
  onRestock: boolean;
  onSoldOut: boolean;
}
