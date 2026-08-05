import { describe, expect, it } from "vitest";
import {
  buildGraphqlBody,
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

// Shaped from the real SearchLots response (DevTools, 2026-08-05): nested
// currentBid { amount }, photos { photoN }, a stringified `next`, no url field.
const GRAPHQL_FIXTURE = JSON.stringify({
  data: {
    searchLots: {
      count: 4635,
      next: "true",
      previous: null,
      results: [
        {
          uuid: "5f1e-aaa",
          auctionUuid: "4a408679",
          number: 12,
          title: "Weller 12 Year",
          description: "Wheated bourbon, 750ml.",
          photos: { photo1: "https://cdn.example.com/a.jpg", photo2: null, __typename: "Photos" },
          currentBid: { amount: 425, currency: "USD", __typename: "Bid" },
          lowEstimate: 300,
          __typename: "Lot",
        },
        {
          uuid: "5f1e-bbb",
          number: 13,
          title: "Scotch Single Malt 18",
          description: "Sherry cask.",
          photos: null,
          currentBid: null,
          __typename: "Lot",
        },
      ],
      categoryFilter: [{ category: "Bourbon", count: 2645, type: null, __typename: "CategoryFilter" }],
      __typename: "SearchLotsResult",
    },
  },
});

describe("parseUnicornListing — graphql", () => {
  it("builds nested lot URLs from raw fields (/auction/{auctionUuid}/lot/{id})", () => {
    const page = parseUnicornListing(GRAPHQL_FIXTURE, {
      format: "graphql",
      baseUrl: BASE,
      lotUrlTemplate: "/auction/{auctionUuid}/lot/{id}",
    });
    expect(page.lots.find((l) => l.id === "5f1e-aaa")!.url).toBe(`${BASE}/auction/4a408679/lot/5f1e-aaa`);
    // Lot 2 has no auctionUuid — rather than emit /auction//lot/… (a 404 in an
    // alert), fall back to the default link shape.
    expect(page.lots.find((l) => l.id === "5f1e-bbb")!.url).toBe(`${BASE}/lots/5f1e-bbb`);
  });

  it("reads data.searchLots.results with nested bids, photo sets, and a template URL", () => {
    const page = parseUnicornListing(GRAPHQL_FIXTURE, {
      format: "graphql",
      baseUrl: BASE,
      lotUrlTemplate: "/lots/{id}",
    });
    expect(page.lots).toHaveLength(2);
    expect(page.total).toBe(4635);
    expect(page.hasMore).toBe(true); // next: "true"

    const weller = page.lots.find((l) => l.id === "5f1e-aaa")!;
    expect(weller.title).toBe("Weller 12 Year");
    expect(weller.currentBidDollars).toBe(425); // nested { amount }
    expect(weller.image).toBe("https://cdn.example.com/a.jpg"); // photos.photo1
    expect(weller.url).toBe(`${BASE}/lots/5f1e-aaa`);
    expect(page.lots.find((l) => l.id === "5f1e-bbb")!.description).toBe("Sherry cask.");
    expect(weller.description).toBe("Wheated bourbon, 750ml.");

    const scotch = page.lots.find((l) => l.id === "5f1e-bbb")!;
    expect(scotch.currentBidDollars).toBeNull(); // no bids yet
    expect(scotch.image).toBeNull();
  });

  it('treats next: "false" as the last page, not another one', () => {
    const last = GRAPHQL_FIXTURE.replace('"next":"true"', '"next":"false"');
    expect(parseUnicornListing(last, { format: "graphql", baseUrl: BASE }).hasMore).toBe(false);
  });

  it("surfaces a GraphQL errors array instead of reporting zero lots", () => {
    const body = JSON.stringify({ errors: [{ message: "Signature has expired" }], data: null });
    expect(() => parseUnicornListing(body, { format: "graphql", baseUrl: BASE })).toThrow(/Signature has expired/);
  });
});

describe("buildGraphqlBody", () => {
  const cfg = (extra: Record<string, unknown> = {}) =>
    validateUnicornConfig({
      format: "graphql",
      graphql: {
        endpoint: "https://graphql.example.com/graphql",
        operationName: "SearchLots",
        query: "query SearchLots($input: SearchLotInput!) { searchLots(input: $input) { count } }",
        pageSize: 100,
        variables: { input: { page: "{page}", limit: "{limit}", offset: "{offset}", auctionUuid: "abc-123" } },
        ...(extra as Record<string, unknown>),
      },
    }).config!;

  it("substitutes page/offset/limit as real numbers and preserves the rest", () => {
    const body = JSON.parse(buildGraphqlBody(cfg(), 3)) as {
      operationName: string;
      variables: { input: { page: number; limit: number; offset: number; auctionUuid: string } };
    };
    expect(body.operationName).toBe("SearchLots");
    expect(body.variables.input).toEqual({ page: 3, limit: 100, offset: 200, auctionUuid: "abc-123" });
  });

  it("offers {pageIndex} and {offset} for APIs that page differently", () => {
    const c = validateUnicornConfig({
      graphql: { variables: { a: "{page}", b: "{pageIndex}", c: "{offset}", d: "{limit}" }, pageSize: 50 },
    }).config!;
    expect((JSON.parse(buildGraphqlBody(c, 4)) as { variables: unknown }).variables).toEqual({
      a: 4,
      b: 3,
      c: 150,
      d: 50,
    });
  });

  // The shipped defaults ARE the live Unicorn recipe (verified against the API
  // 2026-08-05). Two of these encode non-obvious API behavior and would cause
  // silent breakage if "tidied": `state: "LIVE"` is what scopes the query to
  // the running auction (an unrecognized value returns the 725k-lot archive),
  // and `offset` is a 1-INDEXED PAGE NUMBER, so it takes {page}, not {offset}.
  it("ships defaults that are the verified live Unicorn recipe", () => {
    const c = defaultUnicornConfig();
    expect(c.format).toBe("graphql");
    expect(c.graphql.endpoint).toBe("https://graphql.beta.unicornauctions.com/graphql");
    expect(c.graphql.operationName).toBe("SearchLots");
    expect(c.graphql.variables).toEqual({ input: { state: "LIVE", limit: "{limit}", offset: "{page}" } });
    expect(c.lotUrlTemplate).toBe("/auction/{auctionUuid}/lot/{id}");
    expect(c.maxExpectedLots).toBe(25_000);
    // Never request consignor name/email — the site's own query includes them,
    // but a stock watcher has no business pulling seller PII.
    expect(c.graphql.query).not.toMatch(/consignor|email/i);
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

    // Default format is "graphql" — asserted in full by the defaults test above.
    expect(defaultUnicornConfig().format).toBe("graphql");
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
