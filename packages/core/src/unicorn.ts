// Unicorn Auctions watcher — pure core for the ISOLATED side-module (no network,
// importable by both the worker job and the web sandbox/actions).
//
// Deliberately NOT a site/source in the pipeline: Unicorn is a weekly auction
// house (≈6k lots/week), not a retail stock checker, and the operator wants its
// failures fully decoupled from site tracking (and vice versa). Everything lives
// in two meta-table JSON blobs — no sites row, no site_state, no tile, no
// site_error paging, no systemic-failure participation. The worker job
// (apps/worker/src/unicorn.ts) fetches; this module owns config validation,
// listing parsing, and term matching so the dashboard sandbox exercises the
// exact code the job runs.
//
// The listing format is config, not code: unicornauctions.com blocks this dev
// sandbox, so the parser ships three tolerant format branches (json_api /
// next_data / html) validated against pasted payloads via the /unicorn sandbox.
// Discovery (which branch + listingPath) is a dashboard edit, not a deploy.

import { z } from "zod";

// Meta-table keys — the module's entire storage footprint.
export const UNICORN_CONFIG_META_KEY = "unicorn_config";
export const UNICORN_STATE_META_KEY = "unicorn_scan_state";
// History label only (alert_history.siteId) — never a sites-table row.
export const UNICORN_SITE_ID = "unicorn_auctions";

// ── Config ───────────────────────────────────────────────────────────────────

export const unicornTermSchema = z.object({
  term: z.string().trim().min(1),
  /** Match against the lot name/title. */
  inName: z.boolean().default(true),
  /** Match against the lot description (degrades to name-only when the listing
   *  feed carries no description text — see matchLots). */
  inDesc: z.boolean().default(false),
  /** Which bottle this keyword is hunting for. Optional so a term can exist
   *  before its bottle does (and so existing terms keep working), but the
   *  dashboard nudges you to link them. */
  bottleId: z.string().optional(),
});

/** A target bottle: the research, the price discipline, and the notes. Keywords
 *  point at these, so a lot inherits "which bottle am I actually hunting" and
 *  the walk-away price that goes with it. */
export const unicornBottleSchema = z.object({
  id: z.string().min(1),
  /** Free-form priority label (A1, A2, …) — sorts the list, no semantics. */
  rank: z.string().default(""),
  name: z.string().min(1),
  /** Why this bottle fits — the research note behind the target. */
  why: z.string().default(""),
  /** Sensible all-in target range, in dollars (delivered, not hammer). */
  targetLowDollars: z.number().nullable().default(null),
  targetHighDollars: z.number().nullable().default(null),
  /** The walk-away number: the highest HAMMER price still worth bidding, after
   *  which fees push the delivered cost past the ceiling. */
  maxHammerDollars: z.number().nullable().default(null),
  notes: z.string().default(""),
  links: z
    .array(z.object({ label: z.string().default(""), url: z.string() }))
    .default([]),
});

/** Auction cost model. Unicorn's hammer price is not what you pay — a 15%
 *  buyer's premium, then sales tax on the total, then shipping. Configurable
 *  because every one of those numbers can change. */
export const unicornFeesSchema = z
  .object({
    buyerPremiumPct: z.number().min(0).default(15),
    salesTaxPct: z.number().min(0).default(10.25),
    shippingDollars: z.number().min(0).default(25),
  })
  .default({});

export type UnicornBottle = z.infer<typeof unicornBottleSchema>;
export type UnicornFees = z.infer<typeof unicornFeesSchema>;

/** Hammer price -> estimated delivered cost. Premium first, then tax on the
 *  premium-inclusive subtotal, then shipping (verified against the operator's
 *  own reference point: a $375 hammer lands at ~$500 delivered). */
export function estimateAllInDollars(hammerDollars: number, fees: UnicornFees): number {
  const withPremium = hammerDollars * (1 + fees.buyerPremiumPct / 100);
  return withPremium * (1 + fees.salesTaxPct / 100) + fees.shippingDollars;
}

export const unicornConfigSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().url().default("https://www.unicornauctions.com"),
  /** Safety valve. Unicorn's API FAILS OPEN: an unrecognized filter value (e.g.
   *  state "live" instead of "LIVE") silently returns the entire 725k-lot
   *  historical archive instead of erroring. Scanning that would take hours and
   *  alert on ancient lots, so a roster larger than this aborts the scan with a
   *  loud error. 0 disables the check. */
  maxExpectedLots: z.number().int().min(0).default(25_000),
  /** Listing path with a {page} placeholder, e.g. "/api/lots?page={page}".
   *  Ignored by the `graphql` format, which uses its own endpoint.
   *  Set the real value from browser DevTools (Network tab on the lots page)
   *  via the /unicorn advanced settings. */
  listingPath: z.string().min(1).default("/auctions?page={page}"),
  format: z.enum(["json_api", "next_data", "html", "graphql"]).default("graphql"),
  /** How to build a lot's link when the feed carries no URL field (Unicorn's
   *  searchLots returns uuid/number only). {id} is the lot id; any other
   *  placeholder resolves against the raw lot object, e.g. {auctionUuid}. */
  lotUrlTemplate: z.string().optional().default("/auction/{auctionUuid}/lot/{id}"),
  /** The POST recipe for format "graphql". Defaults are the live Unicorn
   *  Auctions API, verified 2026-08-05 — enabling the module needs no typing.
   *  All of it stays editable so a schema change is a config fix, not a deploy.
   *
   *  Two API quirks are baked into the default `variables`:
   *   • `state: "LIVE"` scopes to the auction currently running, so the weekly
   *     auction rollover needs no config change (an auctionUuid would).
   *   • `offset` is a 1-INDEXED PAGE NUMBER, not a record offset (offset 2 with
   *     limit 500 returns lots 503+), hence {page} rather than {offset}.
   *  searchLots needs no authentication for browsing. */
  graphql: z
    .object({
      endpoint: z.string().url().default("https://graphql.beta.unicornauctions.com/graphql"),
      operationName: z.string().optional().default("SearchLots"),
      query: z
        .string()
        .min(1)
        .default(
          "query SearchLots($input: SearchLotInput!) {\n" +
            "  searchLots(input: $input) {\n    count\n    next\n    results {\n" +
            "      uuid\n      auctionUuid\n      number\n      title\n      description\n" +
            "      state\n      endDatetime\n      currentBid { amount currency }\n" +
            "      photos { photo1 }\n    }\n  }\n}",
        ),
      variables: z.record(z.unknown()).default({ input: { state: "LIVE", limit: "{limit}", offset: "{page}" } }),
      /** Rows per request. Substituted into {limit}; also drives {offset} =
       *  (page-1) * pageSize and {pageIndex} = page-1. Unicorn accepts 1000. */
      pageSize: z.number().int().min(1).max(1000).default(500),
      /** Secrets-table ref holding a bearer token, if the API ever needs auth. */
      authTokenRef: z.string().optional(),
    })
    .default({}),
  maxPages: z.number().int().min(1).max(200).default(80),
  pageDelayMs: z.number().int().min(0).max(10_000).default(400),
  terms: z.array(unicornTermSchema).default([]),
  /** Target bottles. Keywords link to these for organization + price discipline. */
  bottles: z.array(unicornBottleSchema).default([]),
  fees: unicornFeesSchema,
  /** Free-text buying rules / general discipline notes shown on the page. */
  notes: z.string().default(""),
  /** False-positive lots the operator has dismissed. Kept in CONFIG rather than
   *  scan state so the decision survives a re-baseline, and stored with the
   *  title so the un-ignore list is readable. Lot ids are per-auction, so this
   *  is capped when written (see the ignoreUnicornLot action). */
  ignoredLots: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().default(""),
        at: z.string().default(""),
      }),
    )
    .default([]),
  /** Secrets-table ref for a session cookie, if the listing needs login. */
  cookieRef: z.string().optional(),
  /** Extra request headers (e.g. an API key header), stored as plain config. */
  requestHeaders: z.record(z.string()).optional(),
});

export type UnicornTerm = z.infer<typeof unicornTermSchema>;
export type UnicornConfig = z.infer<typeof unicornConfigSchema>;

export interface UnicornConfigValidation {
  ok: boolean;
  config?: UnicornConfig;
  error?: string;
}

export function validateUnicornConfig(input: unknown): UnicornConfigValidation {
  const parsed = unicornConfigSchema.safeParse(input);
  if (parsed.success) return { ok: true, config: parsed.data };
  const first = parsed.error.issues[0];
  const path = first?.path.join(".") || "(root)";
  return { ok: false, error: `${path}: ${first?.message ?? "invalid"}` };
}

export function defaultUnicornConfig(): UnicornConfig {
  return unicornConfigSchema.parse({});
}

// ── Scan state (the second meta blob) ────────────────────────────────────────

export interface UnicornStoredLot {
  title: string;
  url: string;
  currentBidDollars: number | null;
  image?: string | null;
  matchedTerms: string[];
  /** Target bottles this lot is a candidate for (via its matching keywords). */
  bottleIds?: string[];
  firstSeenAt: string;
}

export interface UnicornScanState {
  lastScanAt: string | null;
  /** When the next scan becomes due, jittered at stamp time. Stored rather than
   *  recomputed so the cadence is deterministic and visible on the dashboard —
   *  and so requests never land on an exact 24.000h metronome. */
  nextDueAt?: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** One Discord warning per failure streak (cleared on success). */
  errorAlerted?: boolean;
  /** Set by the dashboard "Scan now" button; consumed by the next worker loop. */
  forceScanRequested?: boolean;
  rawLotCount: number;
  /** Fraction of scanned lots that carried description text (0..1) — drives the
   *  "descriptions not in feed, matching names only" dashboard note. */
  descCoverage: number;
  /** Matched lots only — the whole auction roster is never stored. */
  lots: Record<string, UnicornStoredLot>;
}

export function emptyUnicornScanState(): UnicornScanState {
  return {
    lastScanAt: null,
    nextDueAt: null,
    lastError: null,
    consecutiveFailures: 0,
    rawLotCount: 0,
    descCoverage: 0,
    lots: {},
  };
}

/** Guarded read of the stored state blob — corrupt/missing = fresh state. */
export function parseUnicornScanState(raw: string | null | undefined): UnicornScanState {
  if (!raw) return emptyUnicornScanState();
  try {
    const data = JSON.parse(raw) as Partial<UnicornScanState>;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return emptyUnicornScanState();
    return { ...emptyUnicornScanState(), ...data, lots: data.lots && typeof data.lots === "object" ? data.lots : {} };
  } catch {
    return emptyUnicornScanState();
  }
}

// ── Listing parser ───────────────────────────────────────────────────────────

export interface UnicornLot {
  id: string;
  title: string;
  url: string;
  currentBidDollars: number | null;
  description?: string | null;
  image?: string | null;
}

export interface UnicornListingPage {
  lots: UnicornLot[];
  /** Best-effort "another page exists" signal; the job also stops on a page
   *  that yields zero previously-unseen lot ids, so a wrong true can't loop. */
  hasMore: boolean;
  total?: number | null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#0*38;|&amp;/gi, "&")
    .replace(/&#0*39;|&apos;|&rsquo;|&#8217;/gi, "'")
    .replace(/&quot;|&#0*34;/gi, '"')
    .replace(/&nbsp;|&#0*160;/gi, " ")
    .replace(/&#8211;|&ndash;/gi, "–")
    .replace(/&#8212;|&mdash;/gi, "—");
}

function cleanText(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** "$1,234.56" | "1234" | 1234 | { amount } → dollars number; else null.
 *  The nested-object case is how GraphQL APIs usually shape money (Unicorn:
 *  `currentBid { amount currency }`). */
function parseMoney(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    for (const k of ["amount", "value", "price", "cents"]) {
      const inner = (v as Raw)[k];
      if (inner !== undefined && inner !== null) {
        const n = parseMoney(inner);
        // A `cents`-only shape is minor units; everything else is already dollars.
        return n !== null && k === "cents" ? n / 100 : n;
      }
    }
    return null;
  }
  if (typeof v !== "string") return null;
  const m = v.replace(/[$,\s]/g, "");
  if (!m) return null;
  const n = Number(m);
  return Number.isFinite(n) ? n : null;
}

type Raw = Record<string, unknown>;

const ID_KEYS = ["id", "lotId", "lot_id", "uuid", "slug", "lotNumber", "lot_number"];
const TITLE_KEYS = ["title", "name", "lotName", "lot_name", "headline"];
const URL_KEYS = ["url", "link", "href", "permalink", "path"];
const BID_KEYS = [
  "currentBidDollars",
  "currentBid",
  "current_bid",
  "highBid",
  "high_bid",
  "highestBid",
  "highest_bid",
  "currentPrice",
  "current_price",
  "bidAmount",
  "bid_amount",
  "price",
  "minimumBid",
  "minimum_bid",
  "startingBid",
  "starting_bid",
];
const DESC_KEYS = ["description", "desc", "details", "summary", "body", "notes"];
const IMAGE_KEYS = ["image", "imageUrl", "image_url", "thumbnail", "thumb", "photo", "photos", "cover"];

function pick(raw: Raw, keys: string[]): unknown {
  for (const k of keys) {
    const v = raw[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function lotLike(v: unknown): v is Raw {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const raw = v as Raw;
  return pick(raw, ID_KEYS) !== undefined && pick(raw, TITLE_KEYS) !== undefined;
}

/** Pull a usable image URL out of a string, a {url|src} object, or a numbered
 *  photo set (Unicorn: `photos { photo1 … photo5 }`). */
function firstImage(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const raw = v as Raw;
  for (const k of ["url", "src", "photo1", "thumbnail", "full"]) {
    if (typeof raw[k] === "string" && raw[k]) return raw[k] as string;
  }
  return null;
}

interface NormalizeOptions {
  baseUrl: string;
  /** Placeholders: {id}, {number}. Used when the feed carries no link field. */
  lotUrlTemplate?: string | undefined;
}

function normalizeRawLot(raw: Raw, opts: NormalizeOptions): UnicornLot | null {
  const { baseUrl, lotUrlTemplate } = opts;
  const idVal = pick(raw, ID_KEYS);
  const titleVal = pick(raw, TITLE_KEYS);
  if (idVal === undefined || titleVal === undefined) return null;
  const id = String(idVal);
  const title = cleanText(String(titleVal));
  if (!id || !title) return null;

  // Link precedence: a real field in the feed, else the configured template,
  // else a best-guess /lots/<id> so the tile is never link-less.
  let url = `${baseUrl.replace(/\/$/, "")}/lots/${encodeURIComponent(id)}`;
  const urlVal = pick(raw, URL_KEYS);
  if (typeof urlVal === "string" && urlVal.trim()) {
    try {
      url = new URL(urlVal, baseUrl).href;
    } catch {
      /* keep the constructed default */
    }
  } else if (lotUrlTemplate) {
    // {id} is the resolved lot id; every other placeholder reads the raw lot,
    // so a nested route like /auction/{auctionUuid}/lot/{id} is pure config.
    const filled = lotUrlTemplate.replace(/\{(\w+)\}/g, (_m, key: string) => {
      const v = key === "id" ? id : raw[key];
      return v === undefined || v === null ? "" : encodeURIComponent(String(v));
    });
    // An unresolved placeholder would yield a broken link (…/lot//…) — fall
    // back to the default rather than shipping a 404 into an alert.
    if (!filled.includes("//") || filled.startsWith("http")) {
      try {
        url = new URL(filled, baseUrl).href;
      } catch {
        /* malformed template — keep the default */
      }
    }
  }

  const descVal = pick(raw, DESC_KEYS);
  const image = firstImage(pick(raw, IMAGE_KEYS));

  return {
    id,
    title,
    url,
    currentBidDollars: parseMoney(pick(raw, BID_KEYS)),
    description: typeof descVal === "string" ? cleanText(descVal).slice(0, 2000) || null : null,
    image,
  };
}

/** Walk a JSON tree and return the largest array of lot-shaped objects. Depth-
 *  bounded so a pathological payload can't blow the stack. */
function findLotArray(node: unknown, depth = 0): Raw[] {
  if (depth > 8 || node === null || typeof node !== "object") return [];
  let best: Raw[] = [];
  if (Array.isArray(node)) {
    const lots = node.filter(lotLike);
    // Majority-lot-shaped arrays only, so a mixed metadata array can't win.
    if (lots.length > 0 && lots.length * 2 >= node.length) best = lots;
    for (const child of node) {
      const found = findLotArray(child, depth + 1);
      if (found.length > best.length) best = found;
    }
    return best;
  }
  for (const child of Object.values(node as Raw)) {
    const found = findLotArray(child, depth + 1);
    if (found.length > best.length) best = found;
  }
  return best;
}

/** Look for an explicit "more pages" signal near the JSON root. */
function findHasMore(node: unknown, lotCount: number): boolean {
  const scan = (n: unknown, depth: number): boolean | undefined => {
    if (depth > 3 || n === null || typeof n !== "object" || Array.isArray(n)) return undefined;
    const raw = n as Raw;
    for (const k of ["hasMore", "has_more", "hasNextPage", "has_next_page"]) {
      if (typeof raw[k] === "boolean") return raw[k] as boolean;
    }
    for (const k of ["nextPage", "next_page", "next"]) {
      if (!(k in raw)) continue;
      const v = raw[k];
      if (v === null) return false;
      // Unicorn's searchLots answers `next: "true"` — a stringified boolean, so
      // "presence means more" would misread "false" as another page.
      if (typeof v === "string") return v.trim().toLowerCase() !== "false" && v.trim() !== "";
      if (typeof v === "number") return true;
    }
    const page = raw["page"] ?? raw["currentPage"] ?? raw["current_page"];
    const pages = raw["totalPages"] ?? raw["total_pages"] ?? raw["pageCount"] ?? raw["page_count"];
    if (typeof page === "number" && typeof pages === "number") return page < pages;
    for (const child of Object.values(raw)) {
      const found = scan(child, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return scan(node, 0) ?? lotCount > 0;
}

function findTotal(node: unknown): number | null {
  const scan = (n: unknown, depth: number): number | undefined => {
    if (depth > 3 || n === null || typeof n !== "object" || Array.isArray(n)) return undefined;
    const raw = n as Raw;
    // `count` is checked last and only on objects (never inside arrays), so a
    // per-category count can't outrank a real total. Unicorn's searchLots uses
    // it for the roster size — 4,635 lots in the August 2026 auction.
    for (const k of ["total", "totalCount", "total_count", "totalResults", "total_results", "count"]) {
      if (typeof raw[k] === "number") return raw[k] as number;
    }
    for (const child of Object.values(raw)) {
      const found = scan(child, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return scan(node, 0) ?? null;
}

function parseJsonLots(data: unknown, opts: NormalizeOptions): UnicornListingPage {
  const lots = findLotArray(data)
    .map((raw) => normalizeRawLot(raw, opts))
    .filter((l): l is UnicornLot => l !== null);
  return { lots: dedupeById(lots), hasMore: findHasMore(data, lots.length), total: findTotal(data) };
}

function dedupeById(lots: UnicornLot[]): UnicornLot[] {
  const map = new Map<string, UnicornLot>();
  for (const lot of lots) {
    const prev = map.get(lot.id);
    if (!prev) {
      map.set(lot.id, lot);
      continue;
    }
    // Merge duplicates field-wise: longest title (the real card, not a nav
    // link), first non-null bid/description/image.
    map.set(lot.id, {
      ...prev,
      title: lot.title.length > prev.title.length ? lot.title : prev.title,
      currentBidDollars: prev.currentBidDollars ?? lot.currentBidDollars,
      description: prev.description ?? lot.description,
      image: prev.image ?? lot.image,
    });
  }
  return [...map.values()];
}

const NEXT_DATA_RE = /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

/** Generic HTML branch: anchors pointing at /lot/… or /lots/… are lot cards.
 *  Best-guess fallback — validate against a pasted page via the sandbox. */
function parseHtmlLots(html: string, baseUrl: string): UnicornListingPage {
  const dom = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  const lots: UnicornLot[] = [];
  const re = /<a\b[^>]*href\s*=\s*["']([^"']*\/lots?\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dom)) !== null) {
    let url: URL;
    try {
      url = new URL(m[1]!, baseUrl);
    } catch {
      continue;
    }
    const seg = url.pathname.match(/\/lots?\/([^/?#]+)\/?$/i)?.[1];
    if (!seg) continue;
    const title = cleanText(m[2]!);
    // A bid amount usually sits in the card markup shortly after the anchor.
    const window = dom.slice(m.index, m.index + 600);
    const bid = window.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
    lots.push({
      id: seg,
      title: title || seg,
      url: url.href,
      currentBidDollars: bid ? parseMoney(bid[1]) : null,
      description: null,
      image: null,
    });
  }
  const deduped = dedupeById(lots);
  return { lots: deduped, hasMore: deduped.length > 0, total: null };
}

export function parseUnicornListing(
  body: string,
  opts: { format: UnicornConfig["format"]; baseUrl: string; lotUrlTemplate?: string | undefined },
): UnicornListingPage {
  const { format, baseUrl, lotUrlTemplate } = opts;
  const norm: NormalizeOptions = { baseUrl, lotUrlTemplate };
  if (format === "json_api" || format === "graphql") {
    // GraphQL responses are just JSON; the lot-array walker finds
    // data.searchLots.results on its own. A top-level `errors` array is the
    // API reporting failure with HTTP 200, so surface it instead of "0 lots".
    const data = JSON.parse(body) as Raw;
    const errors = data?.["errors"];
    if (Array.isArray(errors) && errors.length > 0) {
      const first = errors[0] as Raw | undefined;
      throw new Error(`GraphQL error: ${String(first?.["message"] ?? JSON.stringify(errors[0]))}`);
    }
    return parseJsonLots(data, norm);
  }
  if (format === "next_data") {
    const m = body.match(NEXT_DATA_RE);
    if (!m) {
      // Some payloads ARE the raw __NEXT_DATA__ JSON (pasted from DevTools).
      try {
        return parseJsonLots(JSON.parse(body), norm);
      } catch {
        throw new Error("No __NEXT_DATA__ script found in the page (and the body is not JSON).");
      }
    }
    return parseJsonLots(JSON.parse(m[1]!.trim()), norm);
  }
  return parseHtmlLots(body, baseUrl);
}

export interface PageContext {
  /** 1-indexed page number — what Unicorn's `offset` actually wants. */
  page: number;
  /** 0-indexed page number, for APIs that count pages from zero. */
  pageIndex: number;
  /** Record offset ((page-1) * limit), for true record-offset APIs. */
  offset: number;
  limit: number;
}

/** Substitute {page} / {pageIndex} / {offset} / {limit} anywhere in a GraphQL
 *  variables tree, so pagination is expressed in config instead of hard-coded
 *  per API — the three common conventions are all reachable. A placeholder
 *  standing alone becomes a real number ("{page}" -> 2), not a string. */
export function substituteVariables(vars: unknown, ctx: PageContext, depth = 0): unknown {
  if (depth > 10) return vars;
  if (typeof vars === "string") {
    const solo = vars.trim().match(/^\{(page|pageIndex|offset|limit)\}$/);
    if (solo) return ctx[solo[1] as keyof PageContext];
    return vars
      .replace(/\{page\}/g, String(ctx.page))
      .replace(/\{pageIndex\}/g, String(ctx.pageIndex))
      .replace(/\{offset\}/g, String(ctx.offset))
      .replace(/\{limit\}/g, String(ctx.limit));
  }
  if (Array.isArray(vars)) return vars.map((v) => substituteVariables(v, ctx, depth + 1));
  if (vars !== null && typeof vars === "object") {
    const out: Raw = {};
    for (const [k, v] of Object.entries(vars as Raw)) out[k] = substituteVariables(v, ctx, depth + 1);
    return out;
  }
  return vars;
}

/** Build the POST body for one page of a `graphql`-format scan. */
export function buildGraphqlBody(config: UnicornConfig, page: number): string {
  const gql = config.graphql;
  if (!gql) throw new Error('format "graphql" requires a `graphql` config block (endpoint + query).');
  const limit = gql.pageSize;
  const variables = substituteVariables(gql.variables, {
    page,
    pageIndex: page - 1,
    offset: (page - 1) * limit,
    limit,
  });
  return JSON.stringify({
    ...(gql.operationName ? { operationName: gql.operationName } : {}),
    query: gql.query,
    variables,
  });
}

// ── Matching ─────────────────────────────────────────────────────────────────

/** Case-insensitive all-words-present: "weller 12" hits "1—Weller 12 Year". */
export function termMatches(term: string, text: string): boolean {
  const hay = text.toLowerCase();
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => hay.includes(w));
}

export interface UnicornMatch {
  lot: UnicornLot;
  matchedTerms: string[];
  /** Bottles the matching terms point at (deduped, usually one). */
  bottleIds: string[];
}

export function matchLots(
  lots: UnicornLot[],
  terms: UnicornTerm[],
  opts: { ignoredIds?: ReadonlySet<string> } = {},
): UnicornMatch[] {
  const active = terms.filter((t) => t.term.trim().length > 0 && (t.inName || t.inDesc));
  if (active.length === 0) return [];
  const out: UnicornMatch[] = [];
  for (const lot of lots) {
    if (opts.ignoredIds?.has(lot.id)) continue;
    const hasDesc = typeof lot.description === "string" && lot.description.trim().length > 0;
    const matched: string[] = [];
    const bottleIds = new Set<string>();
    for (const t of active) {
      // A desc-only term degrades to name matching when the feed has no
      // description for this lot — better a name hit than silent blindness.
      const checkName = t.inName || (t.inDesc && !hasDesc);
      const hit =
        (checkName && termMatches(t.term, lot.title)) ||
        (t.inDesc && hasDesc && termMatches(t.term, lot.description!));
      if (hit) {
        matched.push(t.term);
        if (t.bottleId) bottleIds.add(t.bottleId);
      }
    }
    if (matched.length > 0) out.push({ lot, matchedTerms: matched, bottleIds: [...bottleIds] });
  }
  return out;
}

/** Share of lots carrying description text — 0 disables desc-matching hopes. */
export function descriptionCoverage(lots: UnicornLot[]): number {
  if (lots.length === 0) return 0;
  const withDesc = lots.filter((l) => typeof l.description === "string" && l.description.trim().length > 0).length;
  return withDesc / lots.length;
}
