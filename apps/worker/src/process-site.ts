// Per-site processing — ported from the worker.js run() try/catch. Given the
// previous state and an adapter, it runs the engine and produces the next state
// + the alert events (Alert[]). Pure with respect to I/O: it does NOT touch the
// DB or Discord — the caller persists newState, appends events to history, and
// dispatches non-baseline events to channels. This keeps all the alert decision
// logic (quiet mode, recovery, circuit breaker, error escalation) testable with
// a stub adapter.

import { runSiteCheck, sourceUrl, type AdapterDeps, type SiteDefinition, type SiteState, type SourceAdapter } from "@beacon/core";
import type { Alert } from "@beacon/shared";
import { annotateProducts, type AnnotatedProduct } from "./annotate.js";

export const ERROR_ALERT_THRESHOLD = 5;
// In imminent mode, surface a block fast — the operator needs to know the drop
// window is being blocked, not wait out the full 5-failure threshold.
export const IMMINENT_ERROR_ALERT_THRESHOLD = 2;
// Adaptive backoff (1b): the ladder now extends to 3h for a block that persists
// past an hour — keep resting a hostile host instead of re-poking it every 60m.
// Recovery latency is bounded by the daily re-page + the fallback channel
// carrying the actual monitoring.
export const COOLDOWN_STEPS_MIN = [5, 15, 60, 180];
const CHECK_HISTORY_CAP = 100;
const ERROR_LOG_CAP = 25;
// A site stuck erroring re-pages once a day (3e) — mirrors the empty-guard's
// daily reminder, so a multi-day outage doesn't go silent after the first ping.
const ERROR_REALERT_MS = 24 * 3_600_000;
// Alert types that count as "site activity" for the quiet-site surface (3d).
const ACTIVITY_TYPES = new Set(["new_product", "restock", "sold_out", "site_changed", "site_reset"]);

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
        product: { title: site.name, url: sourceUrl(site), note: "Checks are succeeding again." },
      });
    }

    // Self-healing visibility: fire ONCE when a fallback channel engages (with
    // the why) and once when the primary recovers — auto-recovery should never
    // be invisible to the operator. Keyed on the fetchVia transition, so a site
    // that stays on the fallback for days doesn't re-ping every check.
    const prevVia = (prevState?.fetchVia as string | undefined) ?? null;
    const newVia = (newState.fetchVia as string | undefined) ?? null;
    if (newVia && newVia !== prevVia) {
      const why = (newState.fetchViaReason as string | undefined) ?? "primary channel blocked";
      events.push({
        type: "self_healed",
        product: {
          title: site.name,
          url: sourceUrl(site),
          note:
            `⛑ Self-healed: ${why}, so this check ran via the Storefront GraphQL API instead. ` +
            `Monitoring continues uninterrupted; the primary endpoint is retried on every check and ` +
            `you'll get another ping when it recovers.`,
        },
      });
    } else if (!newVia && prevVia) {
      events.push({
        type: "self_healed",
        product: {
          title: site.name,
          url: sourceUrl(site),
          note: "✅ Primary endpoint is reachable again — back to normal checks (fallback no longer needed).",
        },
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
            url: sourceUrl(site),
            note: `First check with no prior state — ${suppressed.length} existing product(s) baselined without alerts.`,
          },
        });
      }
    }

    for (const alert of alerts) {
      if (alert.product.handle && ignored.has(alert.product.handle)) continue;
      events.push(alert);
    }

    // Quiet-site surface (3d): track the last time this site produced real
    // activity, so the dashboard can flag a site that checks fine for weeks but
    // never alerts (likely a too-narrow filter or a quietly-broken source).
    const hadActivity = events.some((e) => ACTIVITY_TYPES.has(e.type));
    newState.lastAlertAt = hadActivity ? nowIso() : (prevState?.lastAlertAt as string | undefined) ?? null;

    return { newState, events, ok: true };
  } catch (err) {
    return buildErrorOutcome(site, prevState, err);
  }
}

// A fetch that died with NO status at all — aborted/deadline/idle-timeout — is
// a stall: the host accepted the connection and left it hanging (tar-pit bot
// mitigation). Functionally a block, so it gets the same cooldown + wording.
const STALL_RE = /aborted (fetch|post)ing|deadline exceeded|socket idle timeout/i;

function buildErrorOutcome(site: SiteDefinition, prevState: SiteState | undefined, err: unknown): SiteOutcome {
  const message = err instanceof Error ? err.message : String(err);
  const statusCode = (err as { statusCode?: number }).statusCode;
  const stalled = statusCode == null && STALL_RE.test(message);
  const prev = prevState ?? ({} as SiteState);
  const consecutiveErrors = ((prev.consecutiveErrors as number | undefined) ?? 0) + 1;
  const alreadyAlerted = prev.errorAlertSent === true;
  // Re-page a stuck site once a day (3e) rather than going silent after the
  // first site_error.
  const lastErrorAlertMs = prev.errorAlertAt ? new Date(prev.errorAlertAt as string).getTime() : null;
  const dueForRealert = alreadyAlerted && lastErrorAlertMs != null && Date.now() - lastErrorAlertMs >= ERROR_REALERT_MS;
  const threshold = site.imminent ? IMMINENT_ERROR_ALERT_THRESHOLD : ERROR_ALERT_THRESHOLD;
  const shouldAlert = consecutiveErrors >= threshold && (!alreadyAlerted || dueForRealert);

  // Circuit breaker: 429/403/430 or a stall -> escalating cooldown (430 is
  // Shopify's own bot-block status; a stall is a status-less block).
  let cooldown: Partial<SiteState> = {};
  if (statusCode === 429 || statusCode === 403 || statusCode === 430 || stalled) {
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
    errorAlertAt: shouldAlert ? nowIso : (prev.errorAlertAt as string | undefined) ?? null,
    checkHistory,
    errorLog,
    ...cooldown,
  };

  // "What to check" guidance (2c): every site_error page tells the operator the
  // next move instead of just stating the failure.
  const blockedLike = statusCode === 401 || statusCode === 403 || statusCode === 429 || statusCode === 430 || stalled;
  const tips = blockedLike
    ? "What to check: 1) open the site in your own browser — if it loads fine, this is a server-IP block, not an outage; " +
      "2) hit 🩺 Diagnose on the tile for a step-by-step verdict (incl. whether the Storefront fallback still works); " +
      "3) if it stays fully blocked for days, a Railway redeploy can rotate the egress IP."
    : "What to check: 1) does the URL still load in your browser (store moved/renamed?); " +
      "2) hit 🩺 Diagnose on the tile; 3) if the site redesigned, the source config may need updating (⚙ source on the tile).";

  const events: Alert[] = shouldAlert
    ? [
        {
          type: "site_error",
          product: {
            title: site.name,
            url: sourceUrl(site),
            note:
              `${consecutiveErrors} consecutive failures${statusCode ? ` (HTTP ${statusCode}` +
              `${statusCode === 403 || statusCode === 401 || statusCode === 430 ? " — looks blocked (bot protection?); the page may still load fine in a browser" : ""})` : ""}` +
              `${stalled ? " (connections left hanging with no response — looks like tar-pit bot mitigation; the page may still load fine in a browser)" : ""}. ` +
              `Last error: ${message}${dueForRealert ? " (daily reminder)" : ""}\n\n${tips}`,
          },
        },
      ]
    : [];

  return { newState, events, ok: false };
}
