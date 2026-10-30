import { describe, expect, it } from "vitest";
import { BLOCK_BACKOFF_FACTOR, BLOCK_BACKOFF_WINDOW_MS, blockBackoffFactor, isBlockLikeFailure, recentBlock } from "./backoff.js";

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
