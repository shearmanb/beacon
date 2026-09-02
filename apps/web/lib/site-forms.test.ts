import { describe, expect, it } from "vitest";
import type { ScheduleRule } from "@beacon/shared";
import { buildWindowRules, parseWindowRules } from "./site-forms";

describe("buildWindowRules", () => {
  it("produces one window rule and one default rule, in that order", () => {
    const rules = buildWindowRules({ fromHour: 17, toHour: 21, fast: 5, slow: 60 });
    expect(rules).toEqual([
      { fromHour: 17, toHour: 21, interval: 5 },
      { defaultInterval: 60 },
    ]);
  });

  it("supports an overnight window (fromHour > toHour) — the engine's windowMatches already handles the wrap", () => {
    const rules = buildWindowRules({ fromHour: 22, toHour: 6, fast: 5, slow: 60 });
    expect(rules[0]).toEqual({ fromHour: 22, toHour: 6, interval: 5 });
  });
});

describe("parseWindowRules", () => {
  it("round-trips buildWindowRules' own output", () => {
    const spec = { fromHour: 9, toHour: 13, fast: 5, slow: 30 };
    expect(parseWindowRules(buildWindowRules(spec))).toEqual(spec);
  });

  it("round-trips regardless of rule order (window second, default first)", () => {
    const rules: ScheduleRule[] = [{ defaultInterval: 60 }, { fromHour: 17, toHour: 21, interval: 5 }];
    expect(parseWindowRules(rules)).toEqual({ fromHour: 17, toHour: 21, fast: 5, slow: 60 });
  });

  it("returns null for undefined or empty rules", () => {
    expect(parseWindowRules(undefined)).toBeNull();
    expect(parseWindowRules([])).toBeNull();
  });

  it("returns null for a schedule with more than one window (e.g. drop_windows' 3-tier shape)", () => {
    const rules: ScheduleRule[] = [
      { fromHour: 9, toHour: 13, interval: 5 },
      { fromHour: 17, toHour: 20, interval: 5 },
      { defaultInterval: 120 },
    ];
    expect(parseWindowRules(rules)).toBeNull();
  });

  it("returns null for a day-scoped rule rather than silently dropping the day scope", () => {
    const rules: ScheduleRule[] = [
      { fromHour: 15, toHour: 20, interval: 5, days: ["fri", "sat"] },
      { defaultInterval: 60 },
    ];
    expect(parseWindowRules(rules)).toBeNull();
  });

  it("returns null for two window rules with no default (malformed for this shape)", () => {
    const rules: ScheduleRule[] = [
      { fromHour: 9, toHour: 13, interval: 5 },
      { fromHour: 13, toHour: 17, interval: 15 },
    ];
    expect(parseWindowRules(rules)).toBeNull();
  });
});
