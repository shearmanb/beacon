// "Next check in ~Xm" — predicts when the worker will next check a site, by
// running the same formula it does. Read-only prediction: nothing here
// changes what the worker actually decides, only what the tile displays
// ahead of it.
//
// Mirrors, in order: apps/worker/src/run.ts's cooldown gate (lines ~250-271)
// and packages/shared/src/schedule.ts's shouldCheck/cycleJitterFactor. Kept
// in sync by construction — it calls the same @beacon/shared functions the
// worker calls, rather than re-deriving the interval/jitter itself.

import type { Schedules, SchedulableSite } from "@beacon/shared";
import { cycleJitterFactor } from "@beacon/shared";
import { nowInterval } from "./cadence";

// Mirrors apps/worker/src/run.ts TIGHT_INTERVAL_MIN / TIGHT_COOLDOWN_CAP_MS —
// the read-side clamp that keeps a long stored cooldown from silently
// blacking out a drop window (the 2026-07-22 post-mortem fix).
const TIGHT_INTERVAL_MIN = 15;
const TIGHT_COOLDOWN_CAP_MS = 15 * 60_000;

/** A predicted instant this close (or past) reads as "due now" rather than a
 *  false/negative minute count. */
const DUE_NOW_THRESHOLD_MS = 30_000;

/**
 * Predicted next-check instant for a site, or null if it isn't on a
 * schedule at all (disabled, or never yet checked).
 */
export function predictedNextCheckAt(
  enabled: boolean,
  def: SchedulableSite,
  lastChecked: string | null | undefined,
  cooldownUntil: string | null | undefined,
  schedules: Schedules,
  now: number = Date.now(),
): string | null {
  if (!enabled || !lastChecked) return null;
  const lastMs = Date.parse(lastChecked);
  if (!Number.isFinite(lastMs)) return null;

  const imminentActive = def.imminent === true && def.imminentIntervalMinutes != null;
  // nowInterval is imminent-aware; when imminentActive is false it's
  // identical to getEffectiveInterval, so the cooldown-tight check below can
  // safely reuse this same value rather than resolving the interval twice.
  const interval = nowInterval(def, schedules);
  const jitter = imminentActive ? 1 : cycleJitterFactor(def.id ?? def.name ?? "", lastChecked);
  const scheduledDue = lastMs + interval * jitter * 60_000;

  if (imminentActive) return new Date(scheduledDue).toISOString(); // cooldown bypassed entirely

  const cooldownMs = cooldownUntil ? Date.parse(cooldownUntil) : NaN;
  if (Number.isFinite(cooldownMs) && cooldownMs > now) {
    const tight = interval <= TIGHT_INTERVAL_MIN;
    const gate = tight ? Math.min(cooldownMs, lastMs + TIGHT_COOLDOWN_CAP_MS) : cooldownMs;
    return new Date(Math.max(scheduledDue, gate)).toISOString();
  }
  return new Date(scheduledDue).toISOString();
}

/** Render a predicted instant as short display text. */
export function formatEta(predictedIso: string | null, now: number = Date.now()): string {
  if (!predictedIso) return "—";
  const target = Date.parse(predictedIso);
  if (!Number.isFinite(target)) return "—";
  const ms = target - now;
  if (ms <= DUE_NOW_THRESHOLD_MS) return "due now";
  return `~${Math.round(ms / 60_000)}m`;
}
