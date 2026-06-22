// Maps a source `kind` to its adapter. Adapters are added incrementally; asking
// for a kind without an adapter throws a clear error (rather than silently
// doing nothing), which the worker surfaces as a site_error.

import type { SourceKind } from "../schema.js";
import type { SourceAdapter } from "./types.js";
import { shopifyRestAdapter } from "./shopify_rest.js";

const adapters = new Map<SourceKind, SourceAdapter>([[shopifyRestAdapter.kind, shopifyRestAdapter]]);

export function getAdapter(kind: SourceKind): SourceAdapter {
  const adapter = adapters.get(kind);
  if (!adapter) {
    throw new Error(`No source adapter registered for kind "${kind}" yet`);
  }
  return adapter;
}

export function hasAdapter(kind: SourceKind): boolean {
  return adapters.has(kind);
}

export function registeredKinds(): SourceKind[] {
  return [...adapters.keys()];
}
