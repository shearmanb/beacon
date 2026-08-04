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
});

export const unicornConfigSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string().url().default("https://www.unicornauctions.com"),
  /** Listing path with a {page} placeholder, e.g. "/api/lots?page={page}".
   *  The default is a placeholder — set the real value from browser DevTools
   *  (Network tab on the lots page) via the /unicorn advanced settings. */
  listingPath: z.string().min(1).default("/auctions?page={page}"),
  format: z.enum(["json_api", "next_data", "html"]).default("next_data"),
  maxPages: z.number().int().min(1).max(200).default(80),
  pageDelayMs: z.number().int().min(0).max(10_000).default(400),
  terms: z.array(unicornTermSchema).default([]),
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
  firstSeenAt: string;
}

export interface UnicornScanState {
  lastScanAt: string | null;
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

/** "$1,234.56" | "1234" | 1234 → dollars number; anything else → null. */
function parseMoney(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
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
const IMAGE_KEYS = ["image", "imageUrl", "image_url", "thumbnail", "thumb", "photo", "cover"];

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

function normalizeRawLot(raw: Raw, baseUrl: string): UnicornLot | null {
  const idVal = pick(raw, ID_KEYS);
  const titleVal = pick(raw, TITLE_KEYS);
  if (idVal === undefined || titleVal === undefined) return null;
  const id = String(idVal);
  const title = cleanText(String(titleVal));
  if (!id || !title) return null;

  let url = `${baseUrl.replace(/\/$/, "")}/lots/${encodeURIComponent(id)}`;
  const urlVal = pick(raw, URL_KEYS);
  if (typeof urlVal === "string" && urlVal.trim()) {
    try {
      url = new URL(urlVal, baseUrl).href;
    } catch {
      /* keep the constructed default */
    }
  }

  const descVal = pick(raw, DESC_KEYS);
  const imgVal = pick(raw, IMAGE_KEYS);
  const image =
    typeof imgVal === "string"
      ? imgVal
      : typeof (imgVal as Raw | undefined)?.["url"] === "string"
        ? ((imgVal as Raw)["url"] as string)
        : typeof (imgVal as Raw | undefined)?.["src"] === "string"
          ? ((imgVal as Raw)["src"] as string)
          : null;

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
      if (k in raw && (typeof raw[k] === "number" || typeof raw[k] === "string")) return true;
      if (k in raw && raw[k] === null) return false;
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
    for (const k of ["total", "totalCount", "total_count", "totalResults", "total_results"]) {
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

function parseJsonLots(data: unknown, baseUrl: string): UnicornListingPage {
  const lots = findLotArray(data)
    .map((raw) => normalizeRawLot(raw, baseUrl))
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
  opts: { format: UnicornConfig["format"]; baseUrl: string },
): UnicornListingPage {
  const { format, baseUrl } = opts;
  if (format === "json_api") {
    return parseJsonLots(JSON.parse(body), baseUrl);
  }
  if (format === "next_data") {
    const m = body.match(NEXT_DATA_RE);
    if (!m) {
      // Some payloads ARE the raw __NEXT_DATA__ JSON (pasted from DevTools).
      try {
        return parseJsonLots(JSON.parse(body), baseUrl);
      } catch {
        throw new Error("No __NEXT_DATA__ script found in the page (and the body is not JSON).");
      }
    }
    return parseJsonLots(JSON.parse(m[1]!.trim()), baseUrl);
  }
  return parseHtmlLots(body, baseUrl);
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
}

export function matchLots(lots: UnicornLot[], terms: UnicornTerm[]): UnicornMatch[] {
  const active = terms.filter((t) => t.term.trim().length > 0 && (t.inName || t.inDesc));
  if (active.length === 0) return [];
  const out: UnicornMatch[] = [];
  for (const lot of lots) {
    const hasDesc = typeof lot.description === "string" && lot.description.trim().length > 0;
    const matched: string[] = [];
    for (const t of active) {
      // A desc-only term degrades to name matching when the feed has no
      // description for this lot — better a name hit than silent blindness.
      const checkName = t.inName || (t.inDesc && !hasDesc);
      const hit =
        (checkName && termMatches(t.term, lot.title)) ||
        (t.inDesc && hasDesc && termMatches(t.term, lot.description!));
      if (hit) matched.push(t.term);
    }
    if (matched.length > 0) out.push({ lot, matchedTerms: matched });
  }
  return out;
}

/** Share of lots carrying description text — 0 disables desc-matching hopes. */
export function descriptionCoverage(lots: UnicornLot[]): number {
  if (lots.length === 0) return 0;
  const withDesc = lots.filter((l) => typeof l.description === "string" && l.description.trim().length > 0).length;
  return withDesc / lots.length;
}
