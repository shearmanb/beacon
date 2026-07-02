// On-demand block diagnosis for the dashboard's 🩺 button: exercise a site's
// channels one step at a time FROM THIS SERVER — the same egress IP the worker
// uses — and report each step's outcome. This is how "is Railway's IP blocked?"
// gets a definitive answer: if a step 403s (or hangs) here but the same URL
// loads in the operator's browser, the block targets the server IP, not the
// site being down.
//
// Every step runs under its own short timeout: a tar-pitting host (accepts the
// connection, never answers) must end as a visible "left hanging" step in
// seconds — not silently eat the whole action budget so later steps never run.
//
// Runs in whichever process calls it (web or worker) — identity state is
// per-process, so the fresh-identity step here never disturbs the worker's
// cached identities.

import { httpGet, httpPost, expireIdentity, HttpError } from "@beacon/fetch";
import type { SiteDefinition, SourceOf } from "./schema.js";
import { sourceUrl } from "./schema.js";
import type { AdapterDeps } from "./sources/types.js";

// Statuses that read as "you are being blocked" rather than "the site is broken".
const BLOCKED = new Set([401, 403, 429, 430]);
const DEFAULT_STEP_MS = 12_000;

export interface DiagnoseStep {
  label: string;
  ok: boolean;
  status: number | null;
  detail: string;
}

export interface DiagnoseReport {
  steps: DiagnoseStep[];
  /** Plain-English conclusion, including what to compare in a browser. */
  verdict: string;
  /** True when the evidence points at this server's IP being bot-blocked. */
  blocked: boolean;
}

export interface DiagnoseOptions {
  /** Per-step wall-clock cap (ms). Default 12s — 3 steps fit a 45s action budget. */
  stepTimeoutMs?: number;
}

interface Attempt {
  ok: boolean;
  status: number | null;
  detail: string;
  /** No status at all inside the step budget — the host left us hanging. */
  stalled?: boolean;
}

/** Run one fetch under its own timeout, chained to the caller's overall signal. */
async function step(
  run: (signal: AbortSignal) => Promise<Attempt>,
  parentSignal: AbortSignal | undefined,
  stepMs: number,
): Promise<Attempt> {
  const ctl = new AbortController();
  let stallFired = false;
  const timer = setTimeout(() => {
    stallFired = true;
    ctl.abort();
  }, stepMs);
  let onAbort: (() => void) | null = null;
  if (parentSignal) {
    if (parentSignal.aborted) ctl.abort();
    else {
      onAbort = () => ctl.abort();
      parentSignal.addEventListener("abort", onAbort, { once: true });
    }
  }
  try {
    return await run(ctl.signal);
  } catch (err) {
    if (stallFired) {
      return {
        ok: false,
        status: null,
        stalled: true,
        detail: `no response within ${Math.round(stepMs / 1000)}s — connection left hanging (tar-pit)`,
      };
    }
    const status = err instanceof HttpError ? err.statusCode : null;
    return { ok: false, status, detail: status != null ? `HTTP ${status}` : (err as Error).message };
  } finally {
    clearTimeout(timer);
    if (onAbort && parentSignal) parentSignal.removeEventListener("abort", onAbort);
  }
}

function getAttempt(url: string, kind: "api" | "document") {
  return async (signal: AbortSignal): Promise<Attempt> => {
    const res = await httpGet(url, { withResponse: true, kind, signal });
    let detail = `HTTP ${res.status}`;
    if (kind === "api") {
      try {
        const json = JSON.parse(res.body) as { products?: unknown[] };
        if (Array.isArray(json.products)) detail = `HTTP ${res.status} — ${json.products.length} product(s) on page 1`;
      } catch {
        detail = `HTTP ${res.status} — but the body is not JSON (a challenge page?)`;
      }
    }
    return { ok: true, status: res.status, detail };
  };
}

function browserCompareHint(url: string): string {
  return (
    `Compare in your own browser: open ${url} — if it loads normally there while failing here, ` +
    `the block is aimed at this server's egress IP (Railway), not at you and not the site being down.`
  );
}

/** "HTTP 403" vs "never answers (tar-pit)" — used in verdict sentences. */
function blockPhrase(a: Attempt): string {
  return a.stalled ? "never answers — it tar-pits the connection" : `HTTP ${a.status}`;
}

export async function diagnoseSite(
  site: SiteDefinition,
  deps?: AdapterDeps,
  opts?: DiagnoseOptions,
): Promise<DiagnoseReport> {
  const stepMs = opts?.stepTimeoutMs ?? DEFAULT_STEP_MS;
  if (site.source.kind === "shopify_rest") return diagnoseShopifyRest(site, stepMs, deps);

  // Generic path for other kinds: one fetch of the source URL, classified.
  const url = sourceUrl(site);
  const attempt = await step(getAttempt(url, "document"), deps?.signal, stepMs);
  const steps: DiagnoseStep[] = [{ label: "Fetch page from this server", ok: attempt.ok, status: attempt.status, detail: attempt.detail }];
  const blocked = !attempt.ok && (attempt.stalled === true || (attempt.status != null && BLOCKED.has(attempt.status)));
  return {
    steps,
    blocked,
    verdict: attempt.ok
      ? "Reachable from this server — the checker's fetch path is not blocked."
      : blocked
        ? `This server is blocked (${blockPhrase(attempt)}). ${browserCompareHint(url)} Note: for password/age walls (http_status sites) a 401/403 can be the wall itself, which the checker treats as a signal, not an error.`
        : `Fetch failed (${attempt.detail}) — looks like an outage or network problem rather than a block.`,
  };
}

async function diagnoseShopifyRest(site: SiteDefinition, stepMs: number, deps?: AdapterDeps): Promise<DiagnoseReport> {
  const src = site.source as SourceOf<"shopify_rest">;
  const base = src.baseUrl.replace(/\/$/, "");
  const collection = src.collectionPath ? `/${src.collectionPath.replace(/^\/|\/$/g, "")}` : "";
  const restUrl = `${base}${collection}/products.json?limit=1&page=1`;
  const host = new URL(base).hostname;
  const steps: DiagnoseStep[] = [];
  const push = (label: string, a: Attempt): void => {
    steps.push({ label, ok: a.ok, status: a.status, detail: a.detail });
  };

  // 1) REST as the worker fetches it.
  const rest = await step(getAttempt(restUrl, "api"), deps?.signal, stepMs);
  push("REST products.json (worker's primary channel)", rest);
  if (rest.ok) {
    return {
      steps,
      blocked: false,
      verdict: "products.json answers from this server — the primary channel is healthy right now. If the tile still shows errors, they were transient or the site was mid-cooldown.",
    };
  }
  const restBlocked = rest.stalled === true || (rest.status != null && BLOCKED.has(rest.status));
  if (!restBlocked) {
    return {
      steps,
      blocked: false,
      verdict: `products.json failed with ${rest.detail} — that reads as an outage/misconfiguration, not bot protection. Check the URL and whether the store moved.`,
    };
  }

  // 2) Same request with a freshly-rolled browser identity — separates
  //    "this UA/profile is flagged" from "the IP itself is blocked".
  expireIdentity(host);
  const fresh = await step(getAttempt(restUrl, "api"), deps?.signal, stepMs);
  push("REST retry with a fresh browser identity", fresh);
  if (fresh.ok) {
    return {
      steps,
      blocked: false,
      verdict: "Blocked with the old browser identity but fine with a fresh one — the block was fingerprint-level, not IP-level. The worker re-rolls identities automatically after repeated blocks, so it should recover on its own.",
    };
  }

  // 3) The Storefront-API fallback channel, when configured.
  const fb = src.storefrontFallback;
  const token = fb ? deps?.resolveSecret?.(fb.accessTokenRef) : null;
  if (fb && token) {
    const endpoint = fb.endpoint ?? `https://${fb.domain}/api/${fb.apiVersion}/graphql.json`;
    const attempt = await step(async (signal): Promise<Attempt> => {
      const res = await httpPost(endpoint, JSON.stringify({ query: "{ shop { name } }" }), {
        headers: { "X-Shopify-Storefront-Access-Token": token },
        signal,
      });
      const name = (JSON.parse(res.body) as { data?: { shop?: { name?: string } } })?.data?.shop?.name;
      return name
        ? { ok: true, status: res.status, detail: `HTTP ${res.status} — Storefront API answers (shop: ${name})` }
        : { ok: false, status: res.status, detail: `HTTP ${res.status} — unexpected response (bad token?)` };
    }, deps?.signal, stepMs);
    push("Storefront GraphQL API (fallback channel)", attempt);
    return {
      steps,
      blocked: true,
      verdict: attempt.ok
        ? `This server IS blocked at REST (${blockPhrase(rest)}; a fresh identity made no difference) — bot protection. ` +
          `The Storefront-API fallback works, so monitoring self-heals through it (⛑ chip on the tile). ${browserCompareHint(restUrl)}`
        : `This server is blocked at REST (${blockPhrase(rest)}) AND the Storefront fallback failed (${attempt.detail}) — the checker is fully blocked from this box. ` +
          `${browserCompareHint(restUrl)} A Railway redeploy sometimes lands a different egress IP; beyond that the levers are a longer check interval or a residential proxy (paid — on-demand only).`,
    };
  }

  return {
    steps,
    blocked: true,
    verdict:
      `This server's IP looks blocked (${blockPhrase(rest)}; a fresh browser identity made no difference) and no Storefront fallback is configured for this site. ` +
      `${browserCompareHint(restUrl)} Add a storefrontFallback to this site's source to let it self-heal.`,
  };
}
