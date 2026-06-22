// Default wiring of the capabilities adapters need: secrets resolution (from a
// provided map — the worker loads these from the DB secrets table) and the
// custom-extractor registry.

import { getExtractor } from "./extractors/registry.js";
import type { AdapterDeps } from "./sources/types.js";

export function buildAdapterDeps(secrets: Record<string, string> = {}): AdapterDeps {
  return {
    resolveSecret: (ref) => secrets[ref],
    getExtractor,
  };
}
