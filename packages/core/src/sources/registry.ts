// Maps a source `kind` to its adapter. Asking for a kind without an adapter
// throws a clear error (rather than silently doing nothing), which the worker
// surfaces as a site_error.
//
// Note: kind:"html" (the declarative selector adapter) is intentionally not yet
// implemented — no current site uses it (the Campari sites go through
// kind:"custom" / campari_v1). It will be added when a real site needs it,
// rather than built on spec.

import type { SourceKind } from "../schema.js";
import type { SourceAdapter } from "./types.js";
import { shopifyRestAdapter } from "./shopify_rest.js";
import { shopifyGraphqlAdapter } from "./shopify_graphql.js";
import { httpStatusAdapter } from "./http_status.js";
import { customAdapter } from "./custom.js";

const adapters = new Map<SourceKind, SourceAdapter>(
  [shopifyRestAdapter, shopifyGraphqlAdapter, httpStatusAdapter, customAdapter].map((a) => [a.kind, a]),
);

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
