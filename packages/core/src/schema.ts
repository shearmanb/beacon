// The single source of truth for a site definition: a Zod schema whose inferred
// type drives the rest of the engine. A site is data; `source` is a discriminated
// union over the source "recipes", so the four legacy strategies become config.
//
// Adapters are added incrementally (see sources/registry.ts); the schema defines
// all five kinds up front so config/migration can be written against the full
// shape even before every adapter exists.

import { z } from "zod";

export const filtersSchema = z
  .object({
    titleContains: z.array(z.string()).default([]),
    titleExcludes: z.array(z.string()).default([]),
    vendorIs: z.array(z.string()).default([]),
    productType: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    minPriceDollars: z.number().nullable().default(null),
    maxPriceDollars: z.number().nullable().default(null),
    availableOnly: z.boolean().default(false),
  })
  .default({});

export const alertFlagsSchema = z
  .object({
    onNew: z.boolean().default(true),
    onRestock: z.boolean().default(true),
    onSoldOut: z.boolean().default(false),
    onSiteReset: z.boolean().default(true),
  })
  .default({});

// ── Source recipes ──────────────────────────────────────────────────────────

export const shopifyRestSource = z.object({
  kind: z.literal("shopify_rest"),
  baseUrl: z.string().url(),
  /** Omit for the store root /products.json; otherwise e.g. "/collections/t8ke". */
  collectionPath: z.string().optional(),
  /** Extra query params appended to products.json (rarely needed). */
  extraParams: z.string().optional(),
  conditionalGet: z.boolean().default(true),
  /** Self-healing failover: when the REST endpoint is bot-blocked (401/403/429/
   *  430), the adapter retries via the token-authenticated Storefront GraphQL
   *  API on the canonical *.myshopify.com domain — Shopify's designed-for-server
   *  channel, which a custom domain's WAF/bot protection doesn't sit in front of. */
  storefrontFallback: z
    .object({
      domain: z.string(),
      /** Reference into the secrets table — never an inline token. */
      accessTokenRef: z.string(),
      apiVersion: z.string().default("2025-01"),
      /** Full endpoint override (primarily for testing); derived from domain otherwise. */
      endpoint: z.string().url().optional(),
      /** How long the REST attempt gets before failing over (ms). A tar-pitting
       *  host never returns a status at all — it just leaves the connection
       *  hanging — so don't burn the whole per-site budget waiting on it. */
      restStallMs: z.number().default(20_000),
    })
    .optional(),
});

export const shopifyGraphqlSource = z.object({
  kind: z.literal("shopify_graphql"),
  domain: z.string(),
  /** Reference into the secrets table — never an inline token. */
  accessTokenRef: z.string(),
  /** Watch a published collection by numeric id. */
  collectionId: z.string().optional(),
  /** Watch a single product by numeric id — for Buy Button single-product embeds
   *  (a collection that sold down to one bottle, or a shop that embeds one SKU). */
  productId: z.string().optional(),
  /** Self-heal (R2): read the LIVE Buy Button embed (type + id) from this shop
   *  page's `ShopifyBuyInit` block on every check, so Beacon follows when the shop
   *  swaps its collection/product instead of querying a dead id. Falls back to the
   *  last-known discovered embed (persisted in state), then productId/collectionId. */
  discoverEmbedFrom: z.string().url().optional(),
  apiVersion: z.string().default("2025-01"),
  /** Public URL products link to (the shop page). Defaults to https://<domain>. */
  productUrl: z.string().url().optional(),
  /** Full endpoint override (primarily for testing); derived from domain otherwise. */
  endpoint: z.string().url().optional(),
  defaults: z
    .object({ vendor: z.string().optional(), productType: z.string().optional() })
    .optional(),
});

export const httpStatusSource = z.object({
  kind: z.literal("http_status"),
  url: z.string().url(),
  blockedWhen: z.object({
    bodyMatchesAny: z.array(z.string()).default([]),
    httpStatusIn: z.array(z.number()).default([401, 403]),
  }),
  // site_reset still fires ONCE on the open->blocked transition. These add the
  // reverse + a content-change net so a wall flipping to a live store is caught
  // even if the open/blocked classification never registers it (never-miss bias).
  /** Fire `site_changed` ("wall lifted") on the blocked->open transition. */
  alertOnOpen: z.boolean().default(true),
  /** Fire `site_changed` when the normalized page fingerprint changes. */
  watchContentChange: z.boolean().default(true),
  /** Optional noise mute: require the normalized length to move by at least this
   *  fraction before a same-classification change counts. 0 = any change fires. */
  contentChangeMinFrac: z.number().default(0),
});

/** Real-browser check via a remote Chromium (Browserbase CDP). The adapter
 *  lives in @beacon/browser (worker registers it lazily) so core stays free of
 *  playwright deps. The check opens the retailer page in a persistent
 *  per-retailer browser context (real Chrome TLS/JS/cookies), then reads the
 *  roster with a fetch made BY the page itself (same-origin, cookie-bearing —
 *  what the site's own frontend does), not by our server. */
export const browserSource = z.object({
  kind: z.literal("browser"),
  /** Where the check runs. Only "browserbase" is implemented; "local" reserved. */
  engine: z.enum(["browserbase", "local"]).default("browserbase"),
  /** Store base URL, e.g. https://sharedpour.com (mirrors shopify_rest.baseUrl). */
  baseUrl: z.string().url(),
  /** Optional collection scope, e.g. "/collections/reveries". */
  collectionPath: z.string().optional(),
  /** Page the browser visits before reading data (defaults to baseUrl+collectionPath).
   *  A plausible landing page lets the site set cookies / run its scripts. */
  visitUrl: z.string().url().optional(),
  /** Roster extraction. "page_json": the loaded page runs fetch("…/products.json")
   *  itself (browser-originated, same-origin). "dom" is reserved for non-Shopify. */
  extract: z.enum(["page_json", "dom"]).default("page_json"),
  /** Pagination cap for page_json (250/page). Browser checks are scoped, not scans. */
  maxPages: z.number().int().min(1).max(8).default(3),
  /** Optional CSS selector to await before extraction (page "ready" signal). */
  waitForSelector: z.string().optional(),
  /** Session proxy: "none" (default) or Browserbase residential (escalation only). */
  proxy: z.enum(["none", "residential"]).default("none"),
  /** Persist the browser profile (cookies/localStorage) across checks via a
   *  named Browserbase Context (id kept in site state). */
  persistProfile: z.boolean().default(true),
  /** Capture screenshot + HTML evidence when a check fails or is ambiguous. */
  evidenceOnFailure: z.boolean().default(true),
});

const textPredicate = z.object({ matchesAny: z.array(z.string()).default([]) });

export const htmlSource = z.object({
  kind: z.literal("html"),
  url: z.string().url(),
  conditionalGet: z.boolean().default(true),
  preprocess: z.array(z.enum(["stripComments", "stripScripts", "stripStyles"])).default([]),
  itemSelector: z.object({
    kind: z.literal("cta_anchor"),
    linkClassContains: z.string(),
    productUrlPattern: z.string(),
  }),
  title: z.object({
    kind: z.literal("nearestPrecedingHeading"),
    tag: z.string().default("h3"),
  }),
  availability: z.object({
    fromText: z.string().default("$ctaText"),
    availableWhen: textPredicate,
    unavailableWhen: textPredicate,
  }),
  overlay: z
    .object({
      kind: z.literal("jsonld"),
      type: z.string().default("CollectionPage"),
      path: z.string(),
      defaultAvailable: z.boolean().default(false),
      titleStrip: z.string().optional(),
    })
    .optional(),
});

export const customSource = z.object({
  kind: z.literal("custom"),
  extractorId: z.string(),
  url: z.string().url(),
  options: z.record(z.unknown()).optional(),
});

export const sourceSchema = z.discriminatedUnion("kind", [
  shopifyRestSource,
  shopifyGraphqlSource,
  httpStatusSource,
  htmlSource,
  customSource,
  browserSource,
]);

// ── Site definition ──────────────────────────────────────────────────────────

export const siteDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  // Fixed minutes ("5"/15/...) or a named schedule key resolved from schedules.
  schedule: z.union([z.string(), z.number()]).optional(),
  intervalMinutes: z.number().optional(),
  // Imminent mode: a temporary faster-then-auto-revert override (flat fields,
  // matching the scheduler contract + existing config/state).
  imminent: z.boolean().default(false),
  imminentIntervalMinutes: z.number().optional(),
  imminentDurationMinutes: z.number().optional(),
  imminentSince: z.string().nullable().optional(),
  scheduleBeforeImminent: z.union([z.string(), z.number()]).nullable().optional(),
  alerts: alertFlagsSchema,
  filters: filtersSchema,
  source: sourceSchema,
});

export type Filters = z.infer<typeof filtersSchema>;
export type AlertFlags = z.infer<typeof alertFlagsSchema>;
export type SourceSpec = z.infer<typeof sourceSchema>;
export type SourceKind = SourceSpec["kind"];
export type SiteDefinition = z.infer<typeof siteDefinitionSchema>;

/** Narrow a source spec to a specific kind. */
export type SourceOf<K extends SourceKind> = Extract<SourceSpec, { kind: K }>;

export interface SiteValidationResult {
  ok: boolean;
  site?: SiteDefinition;
  error?: string;
}

/** The public/source URL for a site, regardless of which source recipe it uses.
 *  One source of truth — callers previously re-implemented this per file (4d). */
export function sourceUrl(site: SiteDefinition): string {
  const s = site.source;
  if ("url" in s) return s.url;
  if ("baseUrl" in s) return "collectionPath" in s && s.collectionPath ? `${s.baseUrl.replace(/\/$/, "")}/${s.collectionPath.replace(/^\//, "")}` : s.baseUrl;
  return "";
}

/** Parse + validate one site definition, returning a flat result (no throw). */
export function validateSite(input: unknown): SiteValidationResult {
  const parsed = siteDefinitionSchema.safeParse(input);
  if (parsed.success) return { ok: true, site: parsed.data };
  const first = parsed.error.issues[0];
  const path = first?.path.join(".") || "(root)";
  return { ok: false, error: `${path}: ${first?.message ?? "invalid"}` };
}
