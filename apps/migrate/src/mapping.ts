// Maps the legacy config.json site objects (strategy-based) onto the new
// SiteDefinition (source-discriminated). Storefront tokens are pulled OUT of the
// definition into a secret (the legacy config committed them in plaintext).

import type { SourceSpec } from "@beacon/core";

export interface LegacySite {
  id: string;
  name: string;
  enabled?: boolean;
  strategy: string;
  url: string;
  intervalMinutes?: number;
  schedule?: string | number;
  imminent?: boolean;
  imminentIntervalMinutes?: number;
  imminentSince?: string | null;
  scheduleBeforeImminent?: string | number | null;
  alertOnNewProduct?: boolean;
  alertOnRestock?: boolean;
  alertOnSoldOut?: boolean;
  filters?: Record<string, unknown>;
  useCollectionSchema?: boolean;
  storefrontDomain?: string;
  storefrontAccessToken?: string;
  storefrontCollectionId?: string;
}

export interface MappedSource {
  source: SourceSpec;
  secret?: { ref: string; value: string };
}

const SQUARESPACE_RESET_SIGNALS = [
  "sqs-pw-form",
  "coming soon",
  "enter password",
  "password protected",
  "this store is unavailable",
];

export function mapSource(legacy: LegacySite): MappedSource {
  switch (legacy.strategy) {
    case "shopify_collection": {
      const u = new URL(legacy.url);
      const collectionPath = u.pathname && u.pathname !== "/" ? u.pathname : undefined;
      return {
        source: {
          kind: "shopify_rest",
          baseUrl: u.origin,
          conditionalGet: true,
          ...(collectionPath ? { collectionPath } : {}),
        },
      };
    }
    case "shopify_storefront": {
      const ref = `${legacy.id}_storefront_token`;
      return {
        source: {
          kind: "shopify_graphql",
          domain: legacy.storefrontDomain!,
          accessTokenRef: ref,
          collectionId: legacy.storefrontCollectionId!,
          apiVersion: "2025-01",
          productUrl: legacy.url,
          defaults: { vendor: "The Reveries", productType: "Whiskey" },
        },
        ...(legacy.storefrontAccessToken
          ? { secret: { ref, value: legacy.storefrontAccessToken } }
          : {}),
      };
    }
    case "site_status_monitor":
      return {
        source: {
          kind: "http_status",
          url: legacy.url,
          blockedWhen: { bodyMatchesAny: SQUARESPACE_RESET_SIGNALS, httpStatusIn: [401, 403] },
        },
      };
    case "purchasable_state_monitor":
      return {
        source: {
          kind: "custom",
          extractorId: "campari_v1",
          url: legacy.url,
          ...(legacy.useCollectionSchema ? { options: { useCollectionSchema: true } } : {}),
        },
      };
    default:
      throw new Error(`Unknown legacy strategy "${legacy.strategy}" for site "${legacy.id}"`);
  }
}

/** Build a (pre-Zod) SiteDefinition input from a legacy site + its mapped source. */
export function mapSiteDefinition(legacy: LegacySite, source: SourceSpec): Record<string, unknown> {
  return {
    id: legacy.id,
    name: legacy.name,
    enabled: legacy.enabled ?? true,
    ...(legacy.schedule != null ? { schedule: legacy.schedule } : {}),
    ...(legacy.intervalMinutes != null ? { intervalMinutes: legacy.intervalMinutes } : {}),
    imminent: legacy.imminent === true,
    ...(legacy.imminentIntervalMinutes != null ? { imminentIntervalMinutes: legacy.imminentIntervalMinutes } : {}),
    ...(legacy.imminentSince !== undefined ? { imminentSince: legacy.imminentSince } : {}),
    ...(legacy.scheduleBeforeImminent !== undefined ? { scheduleBeforeImminent: legacy.scheduleBeforeImminent } : {}),
    alerts: {
      onNew: legacy.alertOnNewProduct ?? true,
      onRestock: legacy.alertOnRestock ?? true,
      onSoldOut: legacy.alertOnSoldOut ?? false,
      onSiteReset: true,
    },
    filters: legacy.filters && Object.keys(legacy.filters).length ? legacy.filters : {},
    source,
  };
}
