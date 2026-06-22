// Per-site processing — ported from the worker.js run() try/catch. Given the
// previous state and an adapter, it runs the engine and produces the next state
// + the alert events (Alert[]). Pure with respect to I/O: it does NOT touch the
// DB or Discord — the caller persists newState, appends events to history, and
// dispatches non-baseline events to channels. This keeps all the alert decision
// logic (quiet mode, recovery, circuit breaker, error escalation) testable with
// a stub adapter.

import { runSiteCheck, type AdapterDeps, type SiteDefinition, type SiteState, type SourceAdapter } from "@beacon/core";
import type { Alert } from "@beacon/shared";
import { annotateProducts, type AnnotatedProduct } from "./annotate.js";

export const ERROR_ALERT_THRESHOLD = 5;
export const COOLDOWN_STEPS_MIN = [5, 15, 60];
const CHECK_HISTORY_CAP = 100;
const ERROR_LOG_CAP = 25;

interface CheckRecord {
  ts: string;
  ok: boolean;
}

export interface SiteOutcome {
  newState: SiteState;
  /** History events to record; non-"baseline" events are also sent to channels. */
  events: Alert[];
  ok: boolean;
}

function siteUrl(site: SiteDefinition): string {
  const s = site.source;
  if ("url" in s) return s.url;
  if ("baseUrl" in s) return s.baseUrl;
  return "";
}

export interface ProcessSiteArgs {
  site: SiteDefinition;
  prevState: SiteState | undefined;
  adapter: SourceAdapter;
  deps: AdapterDeps;
  ignored: Set<string>;
}

export async function processSite({
  site,
  prevState,
  adapter,
  deps,
  ignored,
}: ProcessSiteArgs): Promise<SiteOutcome> {
  const nowIso = () => new Date().toISOString();
  try {
    const result = await runSiteCheck(site, prevState, adapter, deps);
    annotateProducts(
      prevState?.products as Record<string, AnnotatedProduct> | undefined,
      result.state.products as Record<string, AnnotatedProduct> | undefined,
    );

    const events: Alert[] = [];
    const wasInErrorAlert = prevState?.errorAlertSent === true;
    const checkHistory = [
      ...((prevState?.checkHistory as CheckRecord[] | undefined) ?? []),
      { ts: nowIso(), ok: true },
    ].slice(-CHECK_HISTORY_CAP);

    const newState: SiteState = {
      ...result.state,
      consecutiveErrors: 0,
      errorAlertSent: false,
      cooldownLevel: 0,
      cooldownUntil: null,
      checkHistory,
    };

    // Recovery: we had an open error page; close it.
    if (wasInErrorAlert) {
      events.push({
        type: "site_recovered",
        product: { title: site.name, url: siteUrl(site), note: "Checks are succeeding again." },
      });
    }

    // Startup quiet mode: with NO previous state entry at all, every product
    // would alert as "new". Baseline silently instead. Keyed on the entry being
    // absent (not the product map being empty) so a real 0->N wave still alerts.
    let alerts = result.alerts;
    if (!prevState) {
      const suppressed = alerts.filter((a) => a.type === "new_product");
      if (suppressed.length > 0) {
        alerts = alerts.filter((a) => a.type !== "new_product");
        events.push({
          type: "baseline",
          product: {
            title: site.name,
            url: siteUrl(site),
            note: `First check with no prior state — ${suppressed.length} existing product(s) baselined without alerts.`,
          },
        });
      }
    }

    for (const alert of alerts) {
      if (alert.product.handle && ignored.has(alert.product.handle)) continue;
      events.push(alert);
    }

    return { newState, events, ok: true };
  } catch (err) {
    return buildErrorOutcome(site, prevState, err);
  }
}

function buildErrorOutcome(site: SiteDefinition, prevState: SiteState | undefined, err: unknown): SiteOutcome {
  const message = err instanceof Error ? err.message : String(err);
  const statusCode = (err as { statusCode?: number }).statusCode;
  const prev = prevState ?? ({} as SiteState);
  const consecutiveErrors = ((prev.consecutiveErrors as number | undefined) ?? 0) + 1;
  const alreadyAlerted = prev.errorAlertSent === true;
  const shouldAlert = consecutiveErrors >= ERROR_ALERT_THRESHOLD && !alreadyAlerted;

  // Circuit breaker: 429/403 -> escalating cooldown.
  let cooldown: Partial<SiteState> = {};
  if (statusCode === 429 || statusCode === 403) {
    const level = Math.min(((prev.cooldownLevel as number | undefined) ?? 0) + 1, COOLDOWN_STEPS_MIN.length);
    const minutes = COOLDOWN_STEPS_MIN[level - 1]!;
    cooldown = { cooldownLevel: level, cooldownUntil: new Date(Date.now() + minutes * 60_000).toISOString() };
  }

  const nowIso = new Date().toISOString();
  const checkHistory = [
    ...((prev.checkHistory as CheckRecord[] | undefined) ?? []),
    { ts: nowIso, ok: false },
  ].slice(-CHECK_HISTORY_CAP);
  const errorLog = [
    ...((prev.errorLog as unknown[] | undefined) ?? []),
    { ts: nowIso, message, statusCode: statusCode ?? null },
  ].slice(-ERROR_LOG_CAP);

  const newState: SiteState = {
    ...prev,
    lastChecked: nowIso,
    consecutiveErrors,
    lastError: message,
    lastErrorAt: nowIso,
    errorAlertSent: alreadyAlerted || shouldAlert,
    checkHistory,
    errorLog,
    ...cooldown,
  };

  const events: Alert[] = shouldAlert
    ? [
        {
          type: "site_error",
          product: {
            title: site.name,
            url: siteUrl(site),
            note: `${consecutiveErrors} consecutive failures. Last error: ${message}`,
          },
        },
      ]
    : [];

  return { newState, events, ok: false };
}
