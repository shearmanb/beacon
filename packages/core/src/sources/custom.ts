// custom adapter — the escape hatch. Fetches the page (with conditional GET) and
// hands the body to a registered extractor function resolved from deps. The
// extractor returns the same canonical { products, signals } the rest of the
// pipeline consumes. Used today by the Campari sites via extractorId "campari_v1".

import { httpGet, conditionalHeaders, extractValidators, type HttpValidators } from "@beacon/fetch";
import type { SourceOf } from "../schema.js";
import type { AdapterDeps, FetchResult, PrevState, SourceAdapter } from "./types.js";

const EMPTY_NOTE =
  "Custom extractor parsed 0 products on consecutive checks. Previous products " +
  "are preserved. The page template may have changed, or the site may be blocking " +
  "the fetch (e.g. Incapsula / age wall).";

export const customAdapter: SourceAdapter = {
  kind: "custom",
  async fetch(site, prev: PrevState, deps?: AdapterDeps): Promise<FetchResult> {
    const src = site.source as SourceOf<"custom">;
    const extractor = deps?.getExtractor?.(src.extractorId);
    if (!extractor) {
      throw new Error(`No custom extractor registered for extractorId "${src.extractorId}"`);
    }

    const validators: HttpValidators | null = prev.httpValidators ?? null;
    const requestHeaders = (src.options?.["requestHeaders"] as Record<string, string> | undefined) ?? {};
    const res = await httpGet(src.url, {
      withResponse: true,
      headers: { ...conditionalHeaders(validators), ...requestHeaders },
    });
    if (res.status === 304) {
      return { kind: "not_modified", validators };
    }

    const out = extractor(res.body, {
      baseUrl: src.url,
      vendorName: site.name,
      options: src.options,
      site,
    });
    const nextValidators = extractValidators(res.headers);

    if (out.signals && out.signals.length > 0) {
      return { kind: "signal", signal: out.signals[0]!, validators: nextValidators };
    }
    return {
      kind: "products",
      products: out.products,
      validators: nextValidators,
      emptyGuardThreshold: 3,
      emptyGuardNote: EMPTY_NOTE,
    };
  },
};
