// The `browser` source adapter: a REAL Chromium (Browserbase session, attached
// over CDP with playwright-core) visits the retailer page the way the operator
// does — real TLS fingerprint, JS execution (WAF challenges actually run),
// persistent per-retailer cookies via a Browserbase Context — and then reads
// the roster with a fetch made BY THE PAGE ITSELF (same-origin, cookie-bearing,
// exactly what the store's own frontend does). This is the tier for hosts that
// block or under-report to the plain-HTTP adapters.
//
// Design notes:
//  • Implements the standard SourceAdapter contract, so filters/diff/alerts/
//    guards all apply unchanged downstream.
//  • No fake mouse/scroll theater — navigation + state-based waits only.
//  • solveCaptchas is disabled at session create (see browserbase.ts). A wall
//    is classified + thrown with a statusCode so the existing circuit breaker
//    and cooldown ladder handle it exactly like an HTTP-tier block.
//  • Everything is scoped by the worker's per-site AbortSignal budget; an abort
//    closes the browser connection, which unwinds any in-flight wait.

import { chromium, type Browser, type Page } from "playwright-core";
import {
  normalizeShopifyProduct,
  type AdapterDeps,
  type FetchResult,
  type PrevState,
  type ShopifyProduct,
  type SiteDefinition,
  type SourceAdapter,
  type SourceOf,
} from "@beacon/core";
import { sleep } from "@beacon/shared";
import { createContext, createSession, ensureProjectId, resolveAuth, BrowserbaseApiError } from "./browserbase.js";
import { classifyWall, wallToError, BrowserCheckError } from "./classify.js";
import { captureEvidence, type EvidenceRefs } from "./evidence.js";

const CONNECT_TIMEOUT_MS = 20_000;
const NAV_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 15_000;
// A Cloudflare-style managed challenge usually clears itself in real Chrome
// within a few seconds (no CAPTCHA involved). Wait on the STATE (marker gone),
// never a fixed sleep, capped here.
const CHALLENGE_SETTLE_MS = 15_000;
const PAGE_LIMIT = 250;

type BrowserSource = SourceOf<"browser">;

interface PageJsonResult {
  __status?: number;
  products?: ShopifyProduct[];
}

function collectionBase(src: BrowserSource): string {
  const base = src.baseUrl.replace(/\/$/, "");
  const collection = src.collectionPath ? `/${src.collectionPath.replace(/^\/|\/$/g, "")}` : "";
  return `${base}${collection}`;
}

async function settleChallenge(page: Page, marker: string): Promise<void> {
  try {
    await page.waitForFunction(
      (m: string) => !document.documentElement.outerHTML.toLowerCase().includes(m),
      marker,
      { timeout: CHALLENGE_SETTLE_MS },
    );
  } catch {
    /* still walled — caller re-classifies */
  }
}

export const browserAdapter: SourceAdapter = {
  kind: "browser",
  async fetch(site: SiteDefinition, prev: PrevState, deps?: AdapterDeps): Promise<FetchResult> {
    const src = site.source as BrowserSource;
    if (src.engine !== "browserbase") {
      throw new Error(`browser engine "${src.engine}" is not implemented (only "browserbase")`);
    }
    const auth = resolveAuth(deps?.resolveSecret);
    if (!auth) {
      throw new Error(
        "Browserbase API key missing — set BROWSERBASE_API_KEY on the service (the project resolves automatically from the key)",
      );
    }
    // Only the API key is configured; the project id is discovered from the
    // API on first use and cached for the process.
    const creds = await ensureProjectId(auth, deps?.signal);

    const origin = new URL(src.baseUrl).origin;
    const visitUrl = src.visitUrl ?? collectionBase(src);
    const signal = deps?.signal;

    // Persistent per-retailer profile: reuse the stored Context id, minting one
    // on first use. A plan-gated/failed Context is downgraded gracefully — the
    // check still runs, just without cookie continuity (noted in state).
    let contextId = src.persistProfile ? ((prev["bbContextId"] as string | undefined) ?? undefined) : undefined;
    let contextNote: string | null = null;
    if (src.persistProfile && !contextId) {
      try {
        contextId = await createContext(creds, signal);
      } catch (err) {
        contextNote =
          err instanceof BrowserbaseApiError
            ? `context unavailable (HTTP ${err.statusCode}) — running without profile persistence`
            : `context unavailable — running without profile persistence`;
      }
    }

    const session = await createSession(
      creds,
      { contextId, residentialProxy: src.proxy === "residential" },
      signal,
    );

    let browser: Browser | undefined;
    let page: Page | undefined;
    let evidence: EvidenceRefs = {};
    const onAbort = (): void => {
      if (browser) void browser.close().catch(() => {});
    };
    if (signal) {
      if (signal.aborted) throw new Error(`Aborted browser check for ${site.name}`);
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      browser = await chromium.connectOverCDP(session.connectUrl, { timeout: CONNECT_TIMEOUT_MS });
      const context = browser.contexts()[0] ?? (await browser.newContext());
      page = context.pages()[0] ?? (await context.newPage());

      const nav = await page.goto(visitUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      const status = nav?.status();

      // Wall check on the rendered page (a challenge can hide behind HTTP 200).
      let wall = classifyWall(await page.content(), await page.title().catch(() => ""));
      if (wall?.kind === "challenge") {
        await settleChallenge(page, wall.marker);
        wall = classifyWall(await page.content(), await page.title().catch(() => ""));
      }
      if (wall && wall.kind !== "consent") {
        // Consent overlays usually don't hide catalog JSON; harder walls do.
        throw wallToError(wall, status, visitUrl);
      }
      if (status != null && status >= 400) {
        throw new BrowserCheckError(`Browser navigation to ${visitUrl} answered HTTP ${status}`, status);
      }

      if (src.waitForSelector) {
        await page.waitForSelector(src.waitForSelector, { timeout: READY_TIMEOUT_MS }).catch(() => {
          /* readiness hint only — extraction below is the real test */
        });
      }

      if (src.extract !== "page_json") {
        throw new Error(`browser extract mode "${src.extract}" is not implemented yet`);
      }

      // Roster via the page's own fetch — same-origin, cookies attached, indistinguishable
      // from the storefront's own XHRs. Paginate like shopify_rest, tighter cap.
      const collection = collectionBase(src);
      const all: ShopifyProduct[] = [];
      let pageN = 1;
      for (;;) {
        if (pageN > 1) await sleep(400 + Math.floor(Math.random() * 400));
        const url = `${collection}/products.json?limit=${PAGE_LIMIT}&page=${pageN}`;
        const result = (await page.evaluate(async (u: string) => {
          try {
            const r = await fetch(u, { headers: { accept: "application/json" }, credentials: "same-origin" });
            if (!r.ok) return { __status: r.status };
            return (await r.json()) as unknown;
          } catch {
            return { __status: 0 };
          }
        }, url)) as PageJsonResult;

        if (result.__status != null) {
          throw new BrowserCheckError(
            `In-page fetch of ${url} failed with HTTP ${result.__status || "network error"} (even from a real browser session)`,
            result.__status || undefined,
          );
        }
        const batch = Array.isArray(result.products) ? result.products : null;
        if (!batch) {
          throw new BrowserCheckError(`In-page fetch of ${url} returned unexpected structure`);
        }
        all.push(...batch);
        if (batch.length < PAGE_LIMIT || pageN >= src.maxPages) break;
        pageN += 1;
      }

      return {
        kind: "products",
        products: all.map((p) => normalizeShopifyProduct(p, origin)),
        validators: null,
        pageCount: pageN,
        stateExtras: {
          bbContextId: contextId ?? null,
          bbContextNote: contextNote,
          browserSessionId: session.id,
          lastBrowserCheckAt: new Date().toISOString(),
        },
        emptyGuardThreshold: 3,
        emptyGuardNote:
          "Browser check returned 0 products on consecutive checks. Previous products are " +
          "preserved. If the store is between waves this is expected — otherwise the page " +
          "layout or collection path may have changed.",
      };
    } catch (err) {
      // Evidence: keep what the browser saw (screenshot + HTML), reference it in
      // the error so errorLog/site_error carry the pointer.
      if (src.evidenceOnFailure && page) {
        evidence = await captureEvidence(site.id, page);
      }
      const refs = [evidence.screenshotPath, evidence.htmlPath].filter(Boolean).join(", ");
      if (refs && err instanceof Error) err.message = `${err.message} [evidence: ${refs}]`;
      throw err;
    } finally {
      if (signal) signal.removeEventListener("abort", onAbort);
      if (browser) await browser.close().catch(() => {});
    }
  },
};
