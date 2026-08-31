import { describe, expect, it } from "vitest";
import { ROSTER_STALE_MS, rosterIsLive, stockKey } from "./live";

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe("rosterIsLive", () => {
  it("accepts an enabled site checked just now", () => {
    expect(rosterIsLive(true, iso(60_000))).toBe(true);
  });

  it("rejects a DISABLED site however recently it was checked", () => {
    // The 2026-08-31 bug: retired/quarantined checkers (the SharedPour 4->1
    // consolidation, the out-of-credit browser twin) kept reporting their
    // frozen rosters as live stock — two of those bottles had already been
    // recorded sold_out weeks earlier.
    expect(rosterIsLive(false, iso(60_000))).toBe(false);
  });

  it("rejects an enabled site that has gone silent past the staleness bound", () => {
    expect(rosterIsLive(true, iso(ROSTER_STALE_MS + 60_000))).toBe(false);
  });

  it("accepts right up to the staleness bound", () => {
    expect(rosterIsLive(true, iso(ROSTER_STALE_MS - 60_000))).toBe(true);
  });

  it("rejects a site that has never been checked, or has an unparseable stamp", () => {
    expect(rosterIsLive(true, null)).toBe(false);
    expect(rosterIsLive(true, undefined)).toBe(false);
    expect(rosterIsLive(true, "not-a-date")).toBe(false);
  });
});

describe("stockKey", () => {
  it("collapses the same bottle seen by different checkers on one store", () => {
    // Four checkers watched sharedpour.com with overlapping rosters, so the
    // same handle was counted once per checker.
    const a = stockKey("https://sharedpour.com/products/the-reveries-8-year", "the-reveries-8-year");
    const b = stockKey("https://sharedpour.com/products/the-reveries-8-year", "the-reveries-8-year");
    expect(a).toBe(b);
  });

  it("keeps the same handle on different stores apart", () => {
    expect(stockKey("https://a.com/products/x", "x")).not.toBe(stockKey("https://b.com/products/x", "x"));
  });

  it("falls back to a host-ish prefix when the url is unparseable", () => {
    expect(stockKey("sharedpour.com/products/x", "x")).toBe("sharedpour.com|x");
    expect(stockKey("#", "x")).toBe("#|x");
  });
});
