import { describe, it, expect } from "vitest";
import {
  windowMatches,
  resolveNamedSchedule,
  getEffectiveInterval,
  cycleJitterFactor,
  shouldCheck,
} from "./schedule.js";
import type { Schedules } from "./types.js";

const schedules: Schedules = {
  working_hours_heavy: {
    label: "Working Hours Heavy",
    rules: [
      { fromHour: 9, toHour: 18, interval: 5 },
      { fromHour: 18, toHour: 22, interval: 20 },
      { fromHour: 22, toHour: 9, interval: 120 },
      { defaultInterval: 300 },
    ],
  },
  weekend_only: {
    label: "Weekend Only",
    rules: [
      { fromHour: 0, toHour: 24, interval: 10, days: ["sat", "sun"] },
      { defaultInterval: 60 },
    ],
  },
};

describe("windowMatches", () => {
  it("matches a normal same-day window", () => {
    expect(windowMatches(9, 18, 12)).toBe(true);
    expect(windowMatches(9, 18, 18)).toBe(false); // upper bound exclusive
    expect(windowMatches(9, 18, 8)).toBe(false);
  });

  it("matches a midnight-crossing window (22 -> 9)", () => {
    expect(windowMatches(22, 9, 23)).toBe(true);
    expect(windowMatches(22, 9, 2)).toBe(true);
    expect(windowMatches(22, 9, 9)).toBe(false);
    expect(windowMatches(22, 9, 12)).toBe(false);
  });
});

describe("resolveNamedSchedule", () => {
  it("returns the first matching time window", () => {
    expect(resolveNamedSchedule("working_hours_heavy", schedules, { hour: 10, day: "mon" })).toBe(5);
    expect(resolveNamedSchedule("working_hours_heavy", schedules, { hour: 20, day: "mon" })).toBe(20);
    expect(resolveNamedSchedule("working_hours_heavy", schedules, { hour: 3, day: "mon" })).toBe(120);
  });

  it("honors day-scoped rules and falls through to default", () => {
    expect(resolveNamedSchedule("weekend_only", schedules, { hour: 12, day: "sat" })).toBe(10);
    expect(resolveNamedSchedule("weekend_only", schedules, { hour: 12, day: "wed" })).toBe(60);
  });

  it("returns null for an unknown schedule", () => {
    expect(resolveNamedSchedule("nope", schedules, { hour: 12, day: "mon" })).toBeNull();
  });
});

describe("getEffectiveInterval", () => {
  it("parses a fixed numeric-string schedule", () => {
    expect(getEffectiveInterval({ schedule: "15", intervalMinutes: 99 }, schedules)).toBe(15);
  });

  it("resolves a named schedule", () => {
    expect(
      getEffectiveInterval({ schedule: "working_hours_heavy", intervalMinutes: 99 }, schedules, {
        hour: 10,
        day: "mon",
      }),
    ).toBe(5);
  });

  it("falls back to intervalMinutes when schedule is absent", () => {
    expect(getEffectiveInterval({ intervalMinutes: 30 }, schedules)).toBe(30);
  });

  it("defaults to 60 when nothing resolves", () => {
    expect(getEffectiveInterval({ schedule: "does_not_exist" }, schedules, { hour: 1, day: "mon" })).toBe(60);
  });
});

describe("cycleJitterFactor", () => {
  it("is deterministic for the same seed", () => {
    expect(cycleJitterFactor("site_a", "2026-06-22T10:00:00Z")).toBe(
      cycleJitterFactor("site_a", "2026-06-22T10:00:00Z"),
    );
  });

  it("stays within [0.9, 1.15)", () => {
    for (const id of ["a", "b", "c", "russells_reserve_limited", "sharedpour_t8ke"]) {
      for (const ts of ["2026-06-22T10:00:00Z", "2026-01-01T00:00:00Z", "2025-12-31T23:59:59Z"]) {
        const f = cycleJitterFactor(id, ts);
        expect(f).toBeGreaterThanOrEqual(0.9);
        expect(f).toBeLessThan(1.15);
      }
    }
  });

  it("changes when lastChecked changes (new cycle)", () => {
    expect(cycleJitterFactor("site_a", "2026-06-22T10:00:00Z")).not.toBe(
      cycleJitterFactor("site_a", "2026-06-22T10:05:00Z"),
    );
  });
});

describe("shouldCheck", () => {
  it("checks immediately when there is no prior lastChecked", () => {
    expect(shouldCheck({ id: "a", intervalMinutes: 30 }, undefined, schedules)).toBe(true);
  });

  it("uses imminentIntervalMinutes when imminent and skips jitter", () => {
    const now = Date.parse("2026-06-22T10:03:00Z");
    const site = { id: "a", imminent: true, imminentIntervalMinutes: 2, intervalMinutes: 30 };
    const state = { lastChecked: "2026-06-22T10:00:00Z" }; // 3 min elapsed
    expect(shouldCheck(site, state, schedules, now)).toBe(true);
  });

  it("an un-tuned imminent site runs at the shared default, not its normal schedule", () => {
    // Regression: imminentIntervalMinutes unset used to fall through to the
    // normal interval (30m here) — imminent mode silently did nothing.
    const now = Date.parse("2026-06-22T10:03:00Z");
    const site = { id: "a", imminent: true, intervalMinutes: 30 };
    const state = { lastChecked: "2026-06-22T10:00:00Z" }; // 3 min elapsed ≥ 2m default
    expect(shouldCheck(site, state, schedules, now)).toBe(true);
    expect(shouldCheck(site, { lastChecked: "2026-06-22T10:02:00Z" }, schedules, now)).toBe(false);
  });

  it("does not check before the imminent interval elapses", () => {
    const now = Date.parse("2026-06-22T10:01:00Z");
    const site = { id: "a", imminent: true, imminentIntervalMinutes: 2, intervalMinutes: 30 };
    const state = { lastChecked: "2026-06-22T10:00:00Z" }; // 1 min elapsed
    expect(shouldCheck(site, state, schedules, now)).toBe(false);
  });

  it("gates a normal site by interval * jitter factor", () => {
    const site = { id: "a", intervalMinutes: 30 };
    const lastChecked = "2026-06-22T10:00:00Z";
    const factor = cycleJitterFactor("a", lastChecked);
    const threshold = 30 * factor; // minutes
    const justBefore = Date.parse(lastChecked) + (threshold - 0.5) * 60_000;
    const justAfter = Date.parse(lastChecked) + (threshold + 0.5) * 60_000;
    expect(shouldCheck(site, { lastChecked }, schedules, justBefore)).toBe(false);
    expect(shouldCheck(site, { lastChecked }, schedules, justAfter)).toBe(true);
  });
});

describe("shouldCheck — block back-off (read-side ×1.5 for 6 h after a block-like failure)", () => {
  const site = { id: "bo", intervalMinutes: 10 };
  const now = Date.parse("2026-10-30T12:00:00.000Z");
  const lastChecked = new Date(now - 12 * 60_000).toISOString(); // 12 m ago
  const jitter = cycleJitterFactor("bo", lastChecked); // in [0.9, 1.15)

  it("a plain site is due after its jittered interval", () => {
    expect(12 >= 10 * jitter).toBe(true); // sanity: the fixture is due
    expect(shouldCheck(site, { lastChecked }, {}, now)).toBe(true);
  });

  it("a recent 429 stretches the interval ×1.5, so the same elapsed time is not yet due", () => {
    const errorLog = [{ ts: new Date(now - 60 * 60_000).toISOString(), statusCode: 429, message: "" }];
    expect(12 >= 15 * jitter).toBe(false);
    expect(shouldCheck(site, { lastChecked, errorLog }, {}, now)).toBe(false);
  });

  it("a block older than 6 h no longer stretches", () => {
    const errorLog = [{ ts: new Date(now - 7 * 3_600_000).toISOString(), statusCode: 429, message: "" }];
    expect(shouldCheck(site, { lastChecked, errorLog }, {}, now)).toBe(true);
  });

  it("a non-block failure (HTTP 500) never stretches", () => {
    const errorLog = [{ ts: new Date(now - 60_000).toISOString(), statusCode: 500, message: "boom" }];
    expect(shouldCheck(site, { lastChecked, errorLog }, {}, now)).toBe(true);
  });

  it("imminent mode ignores the back-off", () => {
    const errorLog = [{ ts: new Date(now - 60_000).toISOString(), statusCode: 429, message: "" }];
    const imm = { ...site, imminent: true, imminentIntervalMinutes: 2 };
    expect(shouldCheck(imm, { lastChecked, errorLog }, {}, now)).toBe(true);
  });
});
