// Registry of custom extractors, keyed by the `extractorId` used in a
// kind:"custom" source. Ship extractors with the build (no dynamic loading).

import type { CustomExtractor } from "./types.js";
import { campariV1 } from "./campari_v1.js";

const extractors = new Map<string, CustomExtractor>([["campari_v1", campariV1]]);

export function getExtractor(id: string): CustomExtractor | undefined {
  return extractors.get(id);
}

export function registeredExtractors(): string[] {
  return [...extractors.keys()];
}
