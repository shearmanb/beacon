import { describe, expect, it } from "vitest";
import { BLOCK_BACKOFF_FACTOR, BLOCK_BACKOFF_WINDOW_MS, blockBackoffFactor, cadenceAdjust, isBlockLikeFailure, recentBlock } from "./backoff.js";

const T0 = Date.parse("2026-10-30T12:00:00.000Z");
const at = (msAgo: number) => new Date(T0 - msAgo).toISOString();
const H = 3_600_000;

describe("isBlockLikeFailure", () => {
  it("treats the WAF / rate-limit statuses as block-like", () => {
    for (const s of [401, 403, 429, 430, 503]) expect(isBlockLikeFailure(s, "")).toBe(true);
    for (const s of [404, 500, 502]) expect(isBlockLikeFailure(s, "")).toBe(false);
  });
  it("treats a status-less stall as block-like, other status-less errors not", () => {
    expect(isBlockLikeFailure(null, "Aborted fetching https://x (socket idle timeout)")).toBe(true);
    expect(isBlockLikeFailure(undefined, "deadline exceeded")).toBe(true);
    expect(isBlockLikeFailure(null, "Unexpected token < in JSON")).toBe(false);
  });
});

describe("blockBackoffFactor", () => {
  it("is 1 with no log, an empty log, or only non-block failures", () => {
    expect(blockBackoffFactor(undefined, T0)).toBe(1);
    expect(blockBackoffFactor([], T0)).toBe(1);
    expect(blockBackoffFactor([{ ts: at(5 * 60_000), statusCode: 500, message: "boom" }], T0)).toBe(1);
  });
  it("stretches while a block-like failure is inside the window", () => {
    expect(blockBackoffFactor([{ ts: at(2 * H), statusCode: 429, message: "" }], T0)).toBe(BLOCK_BACKOFF_FACTOR);
    expect(blockBackoffFactor([{ ts: at(10 * 60_000), statusCode: null, message: "socket idle timeout" }], T0)).toBe(1.5);
  });
  it("reverts on its own once the window has passed", () => {
    expect(blockBackoffFactor([{ ts: at(BLOCK_BACKOFF_WINDOW_MS + 1), statusCode: 429 }], T0)).toBe(1);
    expect(blockBackoffFactor([{ ts: at(BLOCK_BACKOFF_WINDOW_MS - 1), statusCode: 429 }], T0)).toBe(1.5);
  });
  it("ignores malformed timestamps and finds the newest block among mixed entries", () => {
    const log = [
      { ts: "not-a-date", statusCode: 429 },
      { ts: at(1 * H), statusCode: 403, message: "" },
      { ts: at(30 * 60_000), statusCode: 500, message: "boom" },
    ];
    expect(recentBlock(log, T0)?.statusCode).toBe(403);
  });
});

describe("cadenceAdjust", () => {
  const NOW = Date.parse("2026-11-13T15:00:00Z");
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
  const DAY = 24 * 60;
  const checks = (ms: number[]) => ms.map((m, i) => ({ ts: ago((ms.length - i) * 5), ok: true, ms: m }));

  it("is neutral with no signals and no floor", () => {
    expect(cadenceAdjust(5, {}, undefined, NOW)).toMatchObject({ factor: 1, reason: null });
    expect(cadenceAdjust(5, {}, { errorLog: [], checkHistory: checks([200, 300]) }, NOW).factor).toBe(1);
  });

  it("a recent block wins over everything", () => {
    const sig = { errorLog: [{ ts: ago(60), statusCode: 429 }], enabledAt: ago(30 * DAY) };
    expect(cadenceAdjust(5, { adaptiveFloorMinutes: 3 }, sig, NOW)).toMatchObject({ factor: 1.5, reason: "block", detail: "HTTP 429" });
  });

  it("eases off when the last three answers are far slower than the site's own normal", () => {
    const normal = Array.from({ length: 12 }, () => 400);
    expect(cadenceAdjust(5, {}, { checkHistory: checks([...normal, 9000, 12000, 8000]) }, NOW)).toMatchObject({ factor: 1.5, reason: "slow" });
    // One quick answer ends it; an ordinary full fetch after a run of 304s is not "slow".
    expect(cadenceAdjust(5, {}, { checkHistory: checks([...normal, 9000, 12000, 500]) }, NOW).factor).toBe(1);
    expect(cadenceAdjust(5, {}, { checkHistory: checks([...normal, 1500, 1800, 2000]) }, NOW).factor).toBe(1);
    // Too little history, or stale history, proves nothing.
    expect(cadenceAdjust(5, {}, { checkHistory: checks([400, 9000, 9000, 9000]) }, NOW).factor).toBe(1);
    const stale = checks([...normal, 9000, 12000, 8000]).map((c) => ({ ...c, ts: ago(600) }));
    expect(cadenceAdjust(5, {}, { checkHistory: stale }, NOW).factor).toBe(1);
  });

  it("speeds up only for opted-in sites, in tight windows, after clean days, never below the floor", () => {
    const site = { adaptiveFloorMinutes: 3 };
    expect(cadenceAdjust(5, {}, { enabledAt: ago(30 * DAY) }, NOW).factor).toBe(1); // not opted in
    expect(cadenceAdjust(60, site, { enabledAt: ago(30 * DAY) }, NOW).factor).toBe(1); // overnight
    expect(cadenceAdjust(5, site, { enabledAt: ago(2 * DAY) }, NOW).factor).toBe(1); // too new
    expect(cadenceAdjust(5, site, { enabledAt: ago(4 * DAY) }, NOW)).toMatchObject({ factor: 0.8, reason: "faster" });
    expect(cadenceAdjust(5, site, { enabledAt: ago(10 * DAY) }, NOW).factor).toBe(0.6);
    expect(cadenceAdjust(5, { adaptiveFloorMinutes: 4 }, { enabledAt: ago(10 * DAY) }, NOW).factor).toBe(0.8); // floor wins
    expect(cadenceAdjust(3, site, { enabledAt: ago(10 * DAY) }, NOW).factor).toBe(1); // already at the floor
  });

  it("a host that blocked in the last 30 days never gets past the first step", () => {
    const sig = { errorLog: [{ ts: ago(10 * DAY), statusCode: 403 }], enabledAt: ago(60 * DAY) };
    expect(cadenceAdjust(5, { adaptiveFloorMinutes: 3 }, sig, NOW).factor).toBe(0.8);
    const recent = { errorLog: [{ ts: ago(2 * DAY), statusCode: 403 }], enabledAt: ago(60 * DAY) };
    expect(cadenceAdjust(5, { adaptiveFloorMinutes: 3 }, recent, NOW).factor).toBe(1);
  });
});
