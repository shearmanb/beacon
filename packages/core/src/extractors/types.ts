// The `custom` escape hatch: a registered TypeScript function that turns a
// fetched HTML/text body into the canonical { products, signals }. It receives
// the same fetch result and emits the same shape as declarative adapters, so it
// reuses the rest of the pipeline (filter, diff, empty-guard, notify) unchanged.
// Reserved for sites whose extraction needs imperative logic the declarative
// `html` spec deliberately can't express.

import type { NormalizedProduct, SiteSignal } from "@beacon/shared";
import type { SiteDefinition } from "../schema.js";

export interface ExtractorContext {
  baseUrl: string;
  vendorName?: string | null;
  options?: Record<string, unknown>;
  site: SiteDefinition;
}

export interface ExtractorOutput {
  products: NormalizedProduct[];
  signals?: SiteSignal[];
}

export type CustomExtractor = (html: string, ctx: ExtractorContext) => ExtractorOutput;
