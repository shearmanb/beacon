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
  note?: string;
}

export interface Alert {
  type: AlertType;
  product: AlertProduct;
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
}

export interface SchedulableState {
  lastChecked?: string | null;
}

export interface DiffOptions {
  onNew: boolean;
  onRestock: boolean;
  onSoldOut: boolean;
}
