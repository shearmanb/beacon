// Page-state classification for browser checks: is this rendered page a real
// storefront, or a wall? Mirrors the worker's status-code discipline
// (BLOCKED_STATUSES) at the DOM level — a challenge page can arrive with HTTP
// 200 once the browser has been "passed through", so markers matter, not just
// status. An ambiguous page must NEVER be read as "0 products" (rule 1e in
// docs/RETAILER_CHECK_STRATEGY.md).

export type WallKind = "challenge" | "blocked" | "login" | "consent" | "password_wall";

export interface WallVerdict {
  kind: WallKind;
  marker: string;
}

// Ordered: most-specific first. Lowercase substring match against html+title.
const MARKERS: Array<{ kind: WallKind; marker: string }> = [
  { kind: "challenge", marker: "just a moment" }, // Cloudflare interstitial
  { kind: "challenge", marker: "cf-chl" },
  { kind: "challenge", marker: "_incapsula_" }, // Imperva/Incapsula
  { kind: "challenge", marker: "px-captcha" }, // PerimeterX
  { kind: "challenge", marker: "perimeterx" },
  { kind: "challenge", marker: "verify you are human" },
  { kind: "challenge", marker: "checking your browser" },
  { kind: "password_wall", marker: "sqs-pw-form" }, // Squarespace password wall
  { kind: "password_wall", marker: "enter store using password" }, // Shopify pw page
  { kind: "consent", marker: "confirm you are 21" },
  { kind: "consent", marker: "age verification" },
  { kind: "login", marker: "customer_account/login" },
  { kind: "blocked", marker: "access denied" },
  { kind: "blocked", marker: "has been blocked" },
];

/** Classify a rendered page. Returns null when nothing wall-like is present. */
export function classifyWall(html: string, title = ""): WallVerdict | null {
  const hay = `${title}\n${html}`.toLowerCase();
  for (const m of MARKERS) {
    if (hay.includes(m.marker)) return m;
  }
  return null;
}

/** Error carrying an HTTP-ish status so the worker's existing circuit breaker
 *  (429/403/430/503 cooldown ladder in process-site.ts) treats browser blocks
 *  exactly like HTTP blocks. Wall kinds without a real status map to 403. */
export class BrowserCheckError extends Error {
  readonly statusCode: number | undefined;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "BrowserCheckError";
    this.statusCode = statusCode;
  }
}

export function wallToError(verdict: WallVerdict, status: number | undefined, url: string): BrowserCheckError {
  const effective = status && status >= 400 ? status : 403;
  return new BrowserCheckError(
    `Browser check hit a ${verdict.kind} wall (marker: "${verdict.marker}", HTTP ${status ?? "200"}) at ${url}`,
    effective,
  );
}
