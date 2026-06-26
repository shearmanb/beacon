// http_status adapter — ported from sites/site_status_monitor.js. A page-state
// probe (no products): it fetches the page and decides blocked vs open. 401/403
// (configurable) and any body reset-signal mean blocked. It emits a SiteSignal;
// the pipeline's signal state machine owns the once-only site_reset lifecycle.
//
// Real errors (network/5xx/timeout) are re-thrown so the worker's error path
// (consecutiveErrors -> site_error, 429/403 circuit breaker) handles them.

import { createHash } from "node:crypto";
import { httpGet, conditionalHeaders, extractValidators, type HttpValidators } from "@beacon/fetch";
import type { SourceOf } from "../schema.js";
import type { AdapterDeps, FetchResult, PrevState, SourceAdapter } from "./types.js";

/**
 * Normalized fingerprint of a page body, so the signal machine can detect that a
 * page MATERIALLY changed (wall -> live store) without parsing products. Strips
 * scripts/styles/comments and per-request churn (nonces, csrf, long hex/id runs,
 * long digit runs like timestamps/cart counts) so a stable page hashes the same
 * across requests; what's left is the human-visible structure + copy.
 *
 * Returns the sha1 hex of the residue plus its length (a cheap "how big is the
 * page" signal the state machine surfaces in the alert note).
 */
export function pageFingerprint(html: string): { hash: string; len: number } {
  const residue = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .toLowerCase()
    // volatile tokens that rotate per request — drop so they don't move the hash
    .replace(/\b(?:nonce|csrf|token|sessionid|_sid|cf_chl|__cf)\b[^\s"'<>]*/gi, " ")
    .replace(/\b[0-9a-f]{16,}\b/gi, " ") // long hex / ids
    .replace(/\b\d{8,}\b/g, " ") // long digit runs (epoch ms, cart/session counters)
    .replace(/\s+/g, " ")
    .trim();
  return { hash: createHash("sha1").update(residue).digest("hex"), len: residue.length };
}

export const httpStatusAdapter: SourceAdapter = {
  kind: "http_status",
  async fetch(site, prev: PrevState, deps?: AdapterDeps): Promise<FetchResult> {
    const src = site.source as SourceOf<"http_status">;
    let html = "";
    let validators: HttpValidators | null = prev.httpValidators ?? null;
    let blockedByStatus = false;

    try {
      const res = await httpGet(src.url, {
        withResponse: true,
        signal: deps?.signal,
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

    // Fingerprint the page so the signal machine can fire on a material content
    // change even when open/blocked doesn't flip (the never-miss path).
    const { hash, len } = pageFingerprint(html);

    if (!isBlocked) {
      return { kind: "signal", signal: { kind: "open" }, validators, contentHash: hash, contentLen: len };
    }

    const reason =
      `Coming Soon / password wall detected at ${src.url}` +
      (matched ? ` (signal: "${matched}")` : " (HTTP 401/403)") +
      "\nNew wave likely 2–14 days away.";
    return { kind: "signal", signal: { kind: "blocked", reason }, validators, contentHash: hash, contentLen: len };
  },
};
