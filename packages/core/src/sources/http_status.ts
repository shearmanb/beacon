// http_status adapter — ported from sites/site_status_monitor.js. A page-state
// probe (no products): it fetches the page and decides blocked vs open. 401/403
// (configurable) and any body reset-signal mean blocked. It emits a SiteSignal;
// the pipeline's signal state machine owns the once-only site_reset lifecycle.
//
// Real errors (network/5xx/timeout) are re-thrown so the worker's error path
// (consecutiveErrors -> site_error, 429/403 circuit breaker) handles them.

import { httpGet, conditionalHeaders, extractValidators, type HttpValidators } from "@beacon/fetch";
import type { SourceOf } from "../schema.js";
import type { FetchResult, PrevState, SourceAdapter } from "./types.js";

export const httpStatusAdapter: SourceAdapter = {
  kind: "http_status",
  async fetch(site, prev: PrevState): Promise<FetchResult> {
    const src = site.source as SourceOf<"http_status">;
    let html = "";
    let validators: HttpValidators | null = prev.httpValidators ?? null;
    let blockedByStatus = false;

    try {
      const res = await httpGet(src.url, {
        withResponse: true,
        headers: conditionalHeaders(validators),
      });
      if (res.status === 304) {
        // Byte-identical to last time — previous status stands.
        return { kind: "not_modified", validators };
      }
      html = res.body;
      validators = extractValidators(res.headers);
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code != null && src.blockedWhen.httpStatusIn.includes(code)) {
        // Hard wall (password / age gate) — treat as blocked, not an error.
        html = "";
        validators = null;
        blockedByStatus = true;
      } else {
        throw err;
      }
    }

    const lower = html.toLowerCase();
    const matched = src.blockedWhen.bodyMatchesAny.find((s) => lower.includes(s.toLowerCase()));
    const isBlocked = matched !== undefined || blockedByStatus || html === "";

    if (!isBlocked) {
      return { kind: "signal", signal: { kind: "open" }, validators };
    }

    const reason =
      `Coming Soon / password wall detected at ${src.url}` +
      (matched ? ` (signal: "${matched}")` : " (HTTP 401/403)") +
      "\nNew wave likely 2–14 days away.";
    return { kind: "signal", signal: { kind: "blocked", reason }, validators };
  },
};
