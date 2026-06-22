// Shared dashboard helpers: relative-time formatting and per-site health.

import { getEffectiveInterval, type Schedules } from "@beacon/shared";
import type { SiteDefinition, SiteState } from "@beacon/core";

export type Health = "ok" | "warn" | "err" | "off";

export function ago(iso?: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const m = Math.round(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function siteHealth(def: SiteDefinition, state: SiteState | undefined, schedules: Schedules): Health {
  if (!def.enabled) return "off";
  const consecutiveErrors = (state?.consecutiveErrors as number | undefined) ?? 0;
  if (consecutiveErrors >= 5) return "err";
  if (consecutiveErrors > 0) return "warn";
  if (!state?.lastChecked) return "warn";
  const interval = getEffectiveInterval(def, schedules);
  const overdueMs = Date.now() - new Date(state.lastChecked).getTime();
  // Generous staleness grace (× 2.5 + 8 min) so the state-push lag never reads
  // as a false "late" — same spirit as the old dashboard's STALE_GRACE_MIN.
  if (overdueMs > (interval * 2.5 + 8) * 60_000) return "warn";
  return "ok";
}
