import { describe, expect, it } from "vitest";
import { cycleJitterFactor } from "@beacon/shared";
import { predictedNextCheckAt, formatEta } from "./nextcheck";

const T0 = Date.parse("2026-09-02T12:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const MIN = 60_000;

describe("predictedNextCheckAt", () => {
  it("returns null when the site is disabled, however recently checked", () => {
    expect(predictedNextCheckAt(false, { intervalMinutes: 5 }, iso(0), null, {}, T0)).toBeNull();
  });

  it("returns null when the site has never been checked", () => {
    expect(predictedNextCheckAt(true, { intervalMinutes: 5 }, null, null, {}, T0)).toBeNull();
    expect(predictedNextCheckAt(true, { intervalMinutes: 5 }, undefined, null, {}, T0)).toBeNull();
  });

  it("matches the real jittered formula for a plain flat-interval site", () => {
    const def = { id: "site_a", intervalMinutes: 20 };
    const lastChecked = iso(0);
    const jitter = cycleJitterFactor("site_a", lastChecked);
    const expected = new Date(T0 + 20 * jitter * MIN).toISOString();
    expect(predictedNextCheckAt(true, def, lastChecked, null, {}, T0)).toBe(expected);
  });

  it("imminent mode skips jitter, uses imminentIntervalMinutes, and bypasses any cooldown", () => {
    const def = { id: "site_b", intervalMinutes: 60, imminent: true, imminentIntervalMinutes: 2 };
    const lastChecked = iso(0);
    // A cooldown far in the future would normally dominate — imminent ignores it entirely.
    const cooldownUntil = iso(180 * MIN);
    const result = predictedNextCheckAt(true, def, lastChecked, cooldownUntil, {}, T0);
    expect(result).toBe(new Date(T0 + 2 * MIN).toISOString());
  });

  it("clamps a long stored cooldown to 15 minutes inside a tight (<=15m) window", () => {
    // The 2026-07-22 post-mortem fix: a 180m circuit-breaker cooldown must not
    // black out a fast drop window for its full duration.
    const def = { id: "site_c", intervalMinutes: 10 }; // tight: <= 15m
    const lastChecked = iso(0);
    const cooldownUntil = iso(180 * MIN); // far beyond the 15m cap
    const result = predictedNextCheckAt(true, def, lastChecked, cooldownUntil, {}, T0);
    expect(result).toBe(new Date(T0 + 15 * MIN).toISOString());
  });

  it("does not clamp a cooldown outside a tight window (uses the full stored cooldown)", () => {
    const def = { id: "site_d", intervalMinutes: 60 }; // not tight
    const lastChecked = iso(0);
    const cooldownUntil = iso(200 * MIN); // well past any jittered 60m due time
    const result = predictedNextCheckAt(true, def, lastChecked, cooldownUntil, {}, T0);
    expect(result).toBe(cooldownUntil);
  });

  it("prefers the schedule's own due time when a short cooldown clears first", () => {
    const def = { id: "site_e", intervalMinutes: 10 }; // tight
    const lastChecked = iso(0);
    const cooldownUntil = iso(2 * MIN); // clears well before a ~9-11.5m jittered due time
    const jitter = cycleJitterFactor("site_e", lastChecked);
    const expected = new Date(T0 + 10 * jitter * MIN).toISOString();
    expect(predictedNextCheckAt(true, def, lastChecked, cooldownUntil, {}, T0)).toBe(expected);
  });

  it("ignores an already-expired cooldown", () => {
    const def = { id: "site_f", intervalMinutes: 20 };
    const lastChecked = iso(0);
    const cooldownUntil = iso(-5 * MIN); // in the past relative to `now`
    const jitter = cycleJitterFactor("site_f", lastChecked);
    const expected = new Date(T0 + 20 * jitter * MIN).toISOString();
    expect(predictedNextCheckAt(true, def, lastChecked, cooldownUntil, {}, T0)).toBe(expected);
  });

  it("resolves a named schedule through the schedules map (imminent-aware nowInterval path)", () => {
    const def = { id: "site_g", schedule: "nightly" };
    const schedules = { nightly: { rules: [{ defaultInterval: 45 }] } };
    const lastChecked = iso(0);
    const jitter = cycleJitterFactor("site_g", lastChecked);
    const expected = new Date(T0 + 45 * jitter * MIN).toISOString();
    expect(predictedNextCheckAt(true, def, lastChecked, null, schedules, T0)).toBe(expected);
  });
});

describe("formatEta", () => {
  it("shows an em dash for no prediction", () => {
    expect(formatEta(null, T0)).toBe("—");
  });

  it("rounds a future prediction to whole minutes", () => {
    expect(formatEta(iso(7 * MIN), T0)).toBe("~7m");
    expect(formatEta(iso(7.6 * MIN), T0)).toBe("~8m");
  });

  it("clamps near-zero and negative (overdue) predictions to 'due now', never a negative count", () => {
    expect(formatEta(iso(0), T0)).toBe("due now");
    expect(formatEta(iso(20_000), T0)).toBe("due now");
    expect(formatEta(iso(-5 * MIN), T0)).toBe("due now");
  });
});
