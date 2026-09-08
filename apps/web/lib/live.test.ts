import { describe, expect, it } from "vitest";
import { ROSTER_STALE_MS, behindWall, rosterIsLive, stockKey, storeHost, walledHosts } from "./live";

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

describe("storeHost / walledHosts / behindWall", () => {
  const monitor = (url: string, pageReset: boolean, extra: Partial<{ enabled: boolean; lastChecked: string }> = {}) => ({
    row: { enabled: extra.enabled ?? true, sourceKind: "http_status", definition: { source: { url } } },
    state: { lastChecked: extra.lastChecked ?? iso(60_000), pageReset },
  });

  it("normalizes www. and case, and survives a bare host", () => {
    expect(storeHost("https://www.thereveries.co/shop")).toBe("thereveries.co");
    expect(storeHost("https://THEREVERIES.co")).toBe("thereveries.co");
    expect(storeHost("sharedpour.com/products/x")).toBe("sharedpour.com");
    expect(storeHost("#")).toBe("");
  });

  it("collects only hosts whose LIVE http_status monitor reports a wall", () => {
    const walls = walledHosts([
      monitor("https://www.thereveries.co/shop", true),
      monitor("https://open.example", false),
      monitor("https://disabled.example", true, { enabled: false }),
      monitor("https://silent.example", true, { lastChecked: iso(ROSTER_STALE_MS + 60_000) }),
      // A product checker is never a wall source, whatever its state says.
      { row: { enabled: true, sourceKind: "shopify_rest", definition: { source: { url: "https://x.example" } } }, state: { lastChecked: iso(0), pageReset: true } },
    ]);
    expect([...walls]).toEqual(["thereveries.co"]);
  });

  it("gates a product by host, and never gates when no wall is up", () => {
    const walls = new Set(["thereveries.co"]);
    expect(behindWall("https://www.thereveries.co/shop", walls)).toBe(true);
    expect(behindWall("https://sharedpour.com/products/gambit", walls)).toBe(false);
    expect(behindWall("#", walls)).toBe(false);
    expect(behindWall("https://www.thereveries.co/shop", new Set())).toBe(false);
  });
});
