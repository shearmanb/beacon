import { describe, it, expect } from "vitest";
import { jitter, randomFrom, sleep } from "./utils.js";

describe("jitter", () => {
  it("stays within [base-spread, base+spread]", () => {
    for (let i = 0; i < 1000; i++) {
      const v = jitter(1000, 200);
      expect(v).toBeGreaterThanOrEqual(800);
      expect(v).toBeLessThanOrEqual(1200);
    }
  });

  it("floors at 0 even when spread exceeds base", () => {
    for (let i = 0; i < 1000; i++) {
      expect(jitter(100, 1000)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("randomFrom", () => {
  it("returns a member of the array", () => {
    const arr = ["a", "b", "c"] as const;
    for (let i = 0; i < 100; i++) {
      expect(arr).toContain(randomFrom(arr));
    }
  });
});

describe("sleep", () => {
  it("resolves after roughly the requested delay", async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
