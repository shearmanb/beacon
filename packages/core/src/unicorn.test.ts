import { describe, expect, it } from "vitest";
import {
  defaultUnicornConfig,
  descriptionCoverage,
  matchLots,
  parseUnicornListing,
  parseUnicornScanState,
  termMatches,
  validateUnicornConfig,
  type UnicornLot,
} from "./unicorn.js";

const BASE = "https://www.unicornauctions.com";

// Synthetic fixtures — shaped like common auction-platform payloads. The real
// Phase-0 payload (pasted via the /unicorn sandbox) validates the branch Brad
// actually needs; these lock the tolerant-key behavior either way.
const JSON_FIXTURE = JSON.stringify({
  page: 1,
  totalPages: 3,
  total: 5500,
  lots: [
    {
      id: 101,
      title: "Weller 12 Year &amp; Antique 107 (2 bottles)",
      url: "/lots/101-weller-12",
      current_bid: "$1,250.00",
      description: "Two classic wheaters, pristine labels.",
      image: { url: "https://cdn.example.com/101.jpg" },
    },
    {
      lot_id: "202",
      name: "Michter's 20 Year Bourbon 2021",
      link: "https://www.unicornauctions.com/lots/202",
      high_bid: 3400,
    },
    { irrelevant: "metadata row without id/title" },
  ],
});

const NEXT_FIXTURE = `<html><head></head><body>
<script id="__NEXT_DATA__" type="application/json">
{"props":{"pageProps":{"auction":{"name":"Weekly"},"results":{"hits":[
  {"uuid":"abc-1","lotName":"Old Rip Van Winkle 10yr","path":"/lot/abc-1","startingBid":900,"notes":"OWA distillate"},
  {"uuid":"abc-2","lotName":"Reveries Single Barrel Rye","path":"/lot/abc-2","currentBid":150}
],"hasNextPage":false}}}}
</script></body></html>`;

const HTML_FIXTURE = `<html><body>
<!-- <a href="/lots/fake-comment">Commented out</a> -->
<div class="card"><a href="/lots/lot-9001">Blanton's Gold Takara</a><span class="bid">Current bid: $410</span></div>
<div class="card"><a href="https://www.unicornauctions.com/lot/lot-9002?ref=x">Weller Full Proof Single Barrel</a> $95</div>
<a href="/lots/lot-9001">Blanton's Gold Takara — duplicate nav link</a>
</body></html>`;

describe("parseUnicornListing", () => {
  it("json_api: tolerant keys, entity decode, money parse, url resolution, pagination", () => {
    const page = parseUnicornListing(JSON_FIXTURE, { format: "json_api", baseUrl: BASE });
    expect(page.lots).toHaveLength(2);
    expect(page.hasMore).toBe(true); // page 1 of 3
    expect(page.total).toBe(5500);

    const weller = page.lots.find((l) => l.id === "101")!;
    expect(weller.title).toBe("Weller 12 Year & Antique 107 (2 bottles)");
    expect(weller.url).toBe(`${BASE}/lots/101-weller-12`);
    expect(weller.currentBidDollars).toBe(1250);
    expect(weller.description).toContain("wheaters");
    expect(weller.image).toBe("https://cdn.example.com/101.jpg");

    const michters = page.lots.find((l) => l.id === "202")!;
    expect(michters.currentBidDollars).toBe(3400);
    expect(michters.description).toBeNull();
  });

  it("next_data: extracts the __NEXT_DATA__ script and honors hasNextPage:false", () => {
    const page = parseUnicornListing(NEXT_FIXTURE, { format: "next_data", baseUrl: BASE });
    expect(page.lots.map((l) => l.id).sort()).toEqual(["abc-1", "abc-2"]);
    expect(page.hasMore).toBe(false);
    expect(page.lots.find((l) => l.id === "abc-1")!.currentBidDollars).toBe(900);
    expect(page.lots.find((l) => l.id === "abc-1")!.description).toBe("OWA distillate");
    expect(page.lots.find((l) => l.id === "abc-2")!.url).toBe(`${BASE}/lot/abc-2`);
  });

  it("next_data: accepts a raw pasted JSON payload (no script wrapper)", () => {
    const raw = NEXT_FIXTURE.match(/<script[^>]*>([\s\S]*?)<\/script>/)![1]!;
    const page = parseUnicornListing(raw, { format: "next_data", baseUrl: BASE });
    expect(page.lots).toHaveLength(2);
  });

  it("html: anchors to /lot(s)/, nearby $ bid, comment-stripped, deduped", () => {
    const page = parseUnicornListing(HTML_FIXTURE, { format: "html", baseUrl: BASE });
    expect(page.lots.map((l) => l.id).sort()).toEqual(["lot-9001", "lot-9002"]);
    const gold = page.lots.find((l) => l.id === "lot-9001")!;
    expect(gold.currentBidDollars).toBe(410);
    // Dedup keeps the longer (richer) title.
    expect(gold.title).toContain("duplicate nav link");
    expect(page.lots.find((l) => l.id === "lot-9002")!.currentBidDollars).toBe(95);
  });

  it("json_api: throws on non-JSON so the job records a real error", () => {
    expect(() => parseUnicornListing("<html>block page</html>", { format: "json_api", baseUrl: BASE })).toThrow();
  });
});

describe("termMatches", () => {
  it("is case-insensitive, order-free, all-words-required", () => {
    expect(termMatches("weller 12", "Lot 4: WELLER 12 Year Bourbon")).toBe(true);
    expect(termMatches("12 weller", "Weller 12 Year")).toBe(true);
    expect(termMatches("weller 12", "Weller Special Reserve")).toBe(false);
    expect(termMatches("", "anything")).toBe(false);
  });
});

describe("matchLots", () => {
  const lots: UnicornLot[] = [
    { id: "1", title: "Weller 12 Year", url: "u1", currentBidDollars: 100, description: "wheated bourbon" },
    { id: "2", title: "Mystery Dusty", url: "u2", currentBidDollars: 50, description: "a Stitzel-Weller era pour" },
    { id: "3", title: "Reveries Rye", url: "u3", currentBidDollars: 75, description: null },
  ];

  it("matches by name, by description, or both — reporting which terms hit", () => {
    const matches = matchLots(lots, [
      { term: "weller", inName: true, inDesc: false },
      { term: "stitzel-weller", inName: false, inDesc: true },
    ]);
    expect(matches.map((m) => m.lot.id)).toEqual(["1", "2"]);
    expect(matches[1]!.matchedTerms).toEqual(["stitzel-weller"]);
  });

  it("degrades a desc-only term to name matching when the lot has no description", () => {
    const matches = matchLots(lots, [{ term: "reveries", inName: false, inDesc: true }]);
    expect(matches.map((m) => m.lot.id)).toEqual(["3"]);
  });

  it("returns nothing with no active terms", () => {
    expect(matchLots(lots, [])).toEqual([]);
  });
});

describe("config + state", () => {
  it("defaults populate and invalid configs report a flat path error", () => {
    const ok = validateUnicornConfig({ terms: [{ term: "weller 12" }] });
    expect(ok.ok).toBe(true);
    expect(ok.config!.enabled).toBe(true);
    expect(ok.config!.terms[0]).toEqual({ term: "weller 12", inName: true, inDesc: false });
    expect(ok.config!.maxPages).toBe(80);

    const bad = validateUnicornConfig({ baseUrl: "not a url" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("baseUrl");

    expect(defaultUnicornConfig().format).toBe("next_data");
  });

  it("parseUnicornScanState survives corrupt blobs", () => {
    expect(parseUnicornScanState(undefined).lots).toEqual({});
    expect(parseUnicornScanState("not json").consecutiveFailures).toBe(0);
    expect(parseUnicornScanState('{"lots":"nope"}').lots).toEqual({});
    const good = parseUnicornScanState('{"lastScanAt":"2026-08-01T00:00:00Z","lots":{"a":{"title":"t"}}}');
    expect(good.lastScanAt).toBe("2026-08-01T00:00:00Z");
    expect(Object.keys(good.lots)).toEqual(["a"]);
  });
});

describe("descriptionCoverage", () => {
  it("computes the described fraction", () => {
    const lots: UnicornLot[] = [
      { id: "1", title: "a", url: "u", currentBidDollars: null, description: "text" },
      { id: "2", title: "b", url: "u", currentBidDollars: null, description: null },
    ];
    expect(descriptionCoverage(lots)).toBe(0.5);
    expect(descriptionCoverage([])).toBe(0);
  });
});
