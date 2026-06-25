// Contract every source adapter implements. An adapter does only the variable
// front of the pipeline — FETCH + EXTRACT — and returns one of three outcomes.
// Everything downstream (filter, diff, empty-guard, signal state machine) is the
// shared pipeline operating on the canonical result.

import type { NormalizedProduct, SiteSignal } from "@beacon/shared";
import type { HttpValidators } from "@beacon/fetch";
import type { SiteDefinition, SourceKind } from "../schema.js";
import type { CustomExtractor } from "../extractors/types.js";

/** Loose view of the previous state entry an adapter may read (validators, paging). */
export interface PrevState {
  products?: Record<string, NormalizedProduct>;
  httpValidators?: HttpValidators | null;
  pageCount?: number;
  [key: string]: unknown;
}

/** Injected capabilities an adapter may need (secrets, custom extractors). */
export interface AdapterDeps {
  /** Resolve a secret reference (e.g. a Storefront token) — never inline in config. */
  resolveSecret?: (ref: string) => string | null | undefined;
  /** Look up a registered custom extractor by id. */
  getExtractor?: (id: string) => CustomExtractor | undefined;
  /**
   * Per-site abort signal (2c). The worker arms one with a wall-clock budget and
   * passes it here; adapters forward it to httpGet/httpPost so a slow/blocked
   * host can't starve the loop. Absent in tests / preview (no budget).
   */
  signal?: AbortSignal;
}

export type FetchResult =
  // 304 / byte-identical — nothing changed; pipeline just ticks lastChecked.
  | { kind: "not_modified"; validators?: HttpValidators | null }
  // Normal product roster from a catalog/listing source.
  | {
      kind: "products";
      products: NormalizedProduct[];
      validators?: HttpValidators | null;
      pageCount?: number;
      /** Per-source empty-guard tuning (defaults applied by the pipeline). */
      emptyGuardThreshold?: number;
      emptyGuardNote?: string;
    }
  // Page-state probe (no products) — feeds the signal state machine.
  | { kind: "signal"; signal: SiteSignal; validators?: HttpValidators | null };

export interface SourceAdapter {
  kind: SourceKind;
  fetch(site: SiteDefinition, prev: PrevState, deps?: AdapterDeps): Promise<FetchResult>;
}
