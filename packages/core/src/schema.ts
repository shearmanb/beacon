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
});

export const shopifyGraphqlSource = z.object({
  kind: z.literal("shopify_graphql"),
  domain: z.string(),
  /** Reference into the secrets table — never an inline token. */
  accessTokenRef: z.string(),
  collectionId: z.string(),
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
  // Note: faithful to site_status_monitor.js — site_reset fires ONCE on the
  // open->blocked transition and clears silently on recovery (no periodic
  // re-alert; that's the empty-guard's job, not this probe's).
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

/** Parse + validate one site definition, returning a flat result (no throw). */
export function validateSite(input: unknown): SiteValidationResult {
  const parsed = siteDefinitionSchema.safeParse(input);
  if (parsed.success) return { ok: true, site: parsed.data };
  const first = parsed.error.issues[0];
  const path = first?.path.join(".") || "(root)";
  return { ok: false, error: `${path}: ${first?.message ?? "invalid"}` };
}
