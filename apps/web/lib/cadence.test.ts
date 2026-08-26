import { describe, expect, it } from "vitest";
import type { Schedules } from "@beacon/shared";
import { cadenceByHour, formatRange, groupCadence, nowInterval } from "./cadence";

// Mirrors the live drop_windows schedule (data-tuned, 2026-07-16 + 8–9 shoulder).
const SCHEDULES: Schedules = {
  drop_windows: {
    label: "Drop Windows",
    rules: [
      { fromHour: 9, toHour: 13, interval: 5 },
      { fromHour: 17, toHour: 20, interval: 5 },
      { fromHour: 8, toHour: 9, interval: 15 },
      { fromHour: 13, toHour: 17, interval: 15 },
      { fromHour: 20, toHour: 22, interval: 15 },
      { fromHour: 22, toHour: 8, interval: 120 },
      { defaultInterval: 120 },
    ],
  },
  weekday_only: {
    rules: [
      { days: ["mon"], fromHour: 9, toHour: 18, interval: 5 },
      { defaultInterval: 60 },
    ],
  },
};

describe("cadenceByHour", () => {
  it("resolves each ET hour through the shared engine", () => {
    const hours = cadenceByHour({ id: "s", schedule: "drop_windows" }, SCHEDULES, "tue");
    expect(hours[9]).toBe(5);
    expect(hours[12]).toBe(5);
    expect(hours[8]).toBe(15);
    expect(hours[14]).toBe(15);
    expect(hours[21]).toBe(15);
    expect(hours[23]).toBe(120);
    expect(hours[3]).toBe(120);
    expect(hours).toHaveLength(24);
  });

  it("flat numeric schedules are constant all day", () => {
    const hours = cadenceByHour({ id: "s", schedule: "60" }, SCHEDULES, "tue");
    expect(new Set(hours)).toEqual(new Set([60]));
  });

  it("day-scoped rules resolve per weekday", () => {
    const mon = cadenceByHour({ id: "s", schedule: "weekday_only" }, SCHEDULES, "mon");
    const sun = cadenceByHour({ id: "s", schedule: "weekday_only" }, SCHEDULES, "sun");
    expect(mon[10]).toBe(5);
    expect(sun[10]).toBe(60);
  });
});

describe("groupCadence", () => {
  it("groups ranges by interval and merges the midnight wrap", () => {
    const hours = cadenceByHour({ id: "s", schedule: "drop_windows" }, SCHEDULES, "tue");
    const groups = groupCadence(hours);
    expect(groups.map((g) => g.interval)).toEqual([5, 15, 120]);
    expect(groups[0].ranges).toEqual([
      [9, 13],
      [17, 20],
    ]);
    expect(groups[1].ranges).toEqual([
      [8, 9],
      [13, 17],
      [20, 22],
    ]);
    // 22–24 and 0–8 collapse into the overnight range the editor writes.
    expect(groups[2].ranges).toEqual([[22, 8]]);
  });

  it("a constant day is one all-day range", () => {
    const groups = groupCadence(Array(24).fill(30));
    expect(groups).toEqual([{ interval: 30, ranges: [[0, 24]] }]);
    expect(formatRange(groups[0].ranges[0])).toBe("all day");
  });

  it("a run ending at midnight without wrapping keeps its 24 bound", () => {
    const hours = [...Array(20).fill(10), ...Array(4).fill(60)];
    const groups = groupCadence(hours);
    expect(groups).toEqual([
      { interval: 10, ranges: [[0, 20]] },
      { interval: 60, ranges: [[20, 24]] },
    ]);
    expect(formatRange([20, 24])).toBe("20–24");
  });
});

describe("nowInterval", () => {
  it("imminent override wins while set", () => {
    expect(
      nowInterval(
        { id: "s", schedule: "60", imminent: true, imminentIntervalMinutes: 2 },
        SCHEDULES,
      ),
    ).toBe(2);
  });

  it("falls back to the effective interval when not imminent", () => {
    expect(nowInterval({ id: "s", schedule: "45" }, SCHEDULES)).toBe(45);
  });
});
