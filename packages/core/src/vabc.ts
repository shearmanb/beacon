// vABC limited-availability list watcher — pure core (no network) for an
// ISOLATED side-job, same shape as the Unicorn watcher: no sites row, no tile,
// no site_error paging, no systemic-failure participation. The worker job
// (apps/worker/src/vabc.ts) fetches once a day; this module owns parsing,
// diffing, and the guards that keep a bad read from ever looking like a change.
//
// The page (abc.virginia.gov/products/limited-availability) is server-rendered
// Sitecore HTML. Each bottle is an <li> under a section heading:
//     <li><a href="/products/bourbon/...">Name 750ml</a> | 021443</li>
// The 6-digit product code is the stable key; the name is display only (vABC
// edits names, and one <li> even splits the first letter outside the <a>).
// Sections: "Available On-Shelf" (onShelf) and "Limited Availability Products
// | One Bottle Per Person" (limited). A code can sit in both sections at once.

import { decodeEntities } from "@beacon/shared";

export const VABC_STATE_META_KEY = "vabc_state";
// History label only (alert_history.siteId) — never a sites-table row.
export const VABC_SITE_ID = "vabc_limited";
export const VABC_URL = "https://www.abc.virginia.gov/products/limited-availability";

export type VabcSection = "limited" | "onShelf";

export interface VabcItem {
  code: string;
  name: string;
  url: string | null;
  section: VabcSection;
}

export interface VabcPage {
  items: VabcItem[];
  /** The page's own "Updated: 11.23.26" stamp, verbatim, if present. */
  updatedLabel: string | null;
}

export interface VabcChange {
  at: string;
  added: VabcItem[];
  removed: VabcItem[];
  updatedLabel: string | null;
}

export interface VabcState {
  lastAttemptAt: string | null;
  nextDueAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** A failure warning went to Discord; cleared (with an all-clear) on recovery. */
  errorAlerted: boolean;
  forceCheckRequested: boolean;
  /** The last list that was read successfully — the baseline for the next diff. */
  items: VabcItem[];
  updatedLabel: string | null;
  /** Newest first, capped — what /vabc shows as "recent changes". */
  changes: VabcChange[];
  /** Fingerprint of a suspicious (mass-shrink) read held for confirmation. */
  pendingFingerprint: string | null;
}

export const VABC_CHANGES_CAP = 60;

export function emptyVabcState(): VabcState {
  return {
    lastAttemptAt: null,
    nextDueAt: null,
    lastSuccessAt: null,
    lastError: null,
    consecutiveFailures: 0,
    errorAlerted: false,
    forceCheckRequested: false,
    items: [],
    updatedLabel: null,
    changes: [],
    pendingFingerprint: null,
  };
}

export function parseVabcState(raw: string | null | undefined): VabcState {
  if (!raw) return emptyVabcState();
  try {
    const data = JSON.parse(raw) as Partial<VabcState>;
    if (typeof data !== "object" || data === null || Array.isArray(data)) return emptyVabcState();
    return {
      ...emptyVabcState(),
      ...data,
      items: Array.isArray(data.items) ? data.items : [],
      changes: Array.isArray(data.changes) ? data.changes : [],
    };
  } catch {
    return emptyVabcState();
  }
}

// ── Parsing ──────────────────────────────────────────────────────────────────

/** Cloudflare's interstitial ("Just a moment…", cf_chl) — a 200 or 403 that
 *  carries no list. Must never be read as "every bottle was removed". */
export function looksLikeBotChallenge(html: string): boolean {
  return /_cf_chl_opt|cf-browser-verification|<title>\s*Just a moment/i.test(html);
}

const text = (html: string): string =>
  decodeEntities(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

function sectionFor(heading: string): VabcSection {
  return /on[\s-]?shelf/i.test(heading) ? "onShelf" : "limited";
}

/**
 * Pull every "Name | 123456" list item, tagged with the nearest preceding
 * <h2>/<h3> heading. Nav menus have no "| code" so they never match.
 */
export function parseVabcPage(html: string, baseUrl = VABC_URL): VabcPage {
  const items: VabcItem[] = [];
  const seen = new Set<string>();
  const tokenRe = /<h[23][^>]*>([\s\S]*?)<\/h[23]>|<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let section: VabcSection | null = null;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html))) {
    if (m[1] !== undefined) {
      section = sectionFor(text(m[1]));
      continue;
    }
    if (section === null) continue;
    const inner = m[2] ?? "";
    const row = /^(.+?)\s*\|\s*(\d{6})\b/.exec(text(inner));
    if (!row) continue;
    const code = row[2]!;
    const key = `${section}:${code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const href = /href="([^"]+)"/i.exec(inner)?.[1];
    let url: string | null = null;
    if (href) {
      try {
        url = new URL(decodeEntities(href), baseUrl).href;
      } catch {
        url = null;
      }
    }
    items.push({ code, name: row[1]!.trim(), url, section });
  }
  const stamp = /Updated:?\s*(?:&nbsp;|\s)*(\d{1,2}\.\d{1,2}\.\d{2,4})/i.exec(html);
  return { items, updatedLabel: stamp?.[1] ?? null };
}

// ── Diffing ──────────────────────────────────────────────────────────────────

const keyOf = (i: VabcItem): string => `${i.section}:${i.code}`;

export function diffVabc(prev: VabcItem[], next: VabcItem[]): { added: VabcItem[]; removed: VabcItem[] } {
  const prevKeys = new Set(prev.map(keyOf));
  const nextKeys = new Set(next.map(keyOf));
  return {
    added: next.filter((i) => !prevKeys.has(keyOf(i))),
    removed: prev.filter((i) => !nextKeys.has(keyOf(i))),
  };
}

export function vabcFingerprint(items: VabcItem[]): string {
  return items.map(keyOf).sort().join(",");
}

// A read that loses more than this share of the previous list (and at least
// MASS_SHRINK_MIN bottles) is far more likely a template change than vABC
// pulling half its allocation overnight — hold it until a second read agrees.
const MASS_SHRINK_SHARE = 0.5;
const MASS_SHRINK_MIN = 10;
/** Fewer limited bottles than this = the parser is no longer seeing the list. */
export const VABC_MIN_LIMITED = 5;

export type VabcReadVerdict =
  | { kind: "ok" }
  | { kind: "invalid"; reason: string }
  | { kind: "hold"; reason: string; fingerprint: string };

/**
 * Self-check before a read is allowed to move the baseline. `invalid` = the
 * page no longer looks like the list (structure drift) — fail loudly, never
 * diff. `hold` = a plausible-but-alarming shrink, accepted only when the next
 * read produces the identical list (pendingFingerprint).
 */
export function judgeVabcRead(prev: VabcItem[], page: VabcPage, pendingFingerprint: string | null): VabcReadVerdict {
  const limited = page.items.filter((i) => i.section === "limited").length;
  if (limited < VABC_MIN_LIMITED) {
    return {
      kind: "invalid",
      reason: `Parsed only ${limited} limited-availability bottle(s) (expected ≥ ${VABC_MIN_LIMITED}) — the page layout probably changed.`,
    };
  }
  const { removed } = diffVabc(prev, page.items);
  if (prev.length > 0 && removed.length >= MASS_SHRINK_MIN && removed.length / prev.length > MASS_SHRINK_SHARE) {
    const fingerprint = vabcFingerprint(page.items);
    if (fingerprint !== pendingFingerprint) {
      return {
        kind: "hold",
        reason: `List shrank from ${prev.length} to ${page.items.length} — holding until the next check confirms it.`,
        fingerprint,
      };
    }
  }
  return { kind: "ok" };
}

const SECTION_LABEL: Record<VabcSection, string> = { limited: "limited list", onShelf: "on-shelf list" };

// Discord's embed description caps at 4096 chars. Small changes keep per-bottle
// links; a big one drops them and caps each section (full list on /vabc).
const LINKS_UP_TO = 12;
const SECTION_CHAR_BUDGET = 1_800; // two sections + stamp stay well under 4096

function line(i: VabcItem, withLink: boolean): string {
  const name = withLink && i.url ? `[${i.name}](${i.url})` : i.name;
  return `• ${name} · ${i.code}${i.section === "onShelf" ? ` (${SECTION_LABEL.onShelf})` : ""}`;
}

function block(title: string, items: VabcItem[], withLink: boolean): string {
  const shown: string[] = [];
  let used = 0;
  for (const i of items) {
    const l = line(i, withLink);
    if (used + l.length + 1 > SECTION_CHAR_BUDGET) break;
    shown.push(l);
    used += l.length + 1;
  }
  const extra = items.length - shown.length;
  return `**${title} (${items.length})**\n${shown.join("\n")}${extra > 0 ? `\n…and ${extra} more (full list on /vabc)` : ""}`;
}

/** Discord/History note for one change: additions first, then removals. */
export function formatVabcChange(change: Pick<VabcChange, "added" | "removed" | "updatedLabel">): string {
  const withLink = change.added.length + change.removed.length <= LINKS_UP_TO;
  const parts: string[] = [];
  if (change.added.length > 0) parts.push(block("➕ Added", change.added, withLink));
  if (change.removed.length > 0) parts.push(block("➖ Removed", change.removed, withLink));
  if (change.updatedLabel) parts.push(`_vABC page stamp: Updated ${change.updatedLabel}_`);
  return parts.join("\n\n");
}
