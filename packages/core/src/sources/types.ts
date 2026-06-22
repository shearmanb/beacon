// Contract every source adapter implements. An adapter does only the variable
// front of the pipeline — FETCH + EXTRACT — and returns one of three outcomes.
// Everything downstream (filter, diff, empty-guard, signal state machine) is the
// shared pipeline operating on the canonical result.

import type { NormalizedProduct, SiteSignal } from "@beacon/shared";
import type { HttpValidators } from "@beacon/fetch";
import type { SiteDefinition, SourceKind } from "../schema.js";

/** Loose view of the previous state entry an adapter may read (validators, paging). */
export interface PrevState {
  products?: Record<string, NormalizedProduct>;
  httpValidators?: HttpValidators | null;
  pageCount?: number;
  [key: string]: unknown;
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
    }
  // Page-state probe (no products) — feeds the signal state machine.
  | { kind: "signal"; signal: SiteSignal };

export interface SourceAdapter {
  kind: SourceKind;
  fetch(site: SiteDefinition, prev: PrevState): Promise<FetchResult>;
}
