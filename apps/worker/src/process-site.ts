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
// Inside a tight drop-window cadence (run.ts passes tightWindow), page at 3
// consecutive failures instead of 5. The Jul 22 miss showed 5 was tuned for
// noise, not for the hours that matter: 3-4 both-channel failures + the
// cooldown ladder = a silent blackout across an entire drop with zero pages.
export const TIGHT_ERROR_ALERT_THRESHOLD = 3;
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
// Channel-flap damping (feedback loop): a host that rate-limits intermittently
// makes the checker ping-pong REST <-> fallback. The transition-keyed
// self_healed alert was designed for rare engage/recover pairs, so a flapping
// channel would page on EVERY flip — and preferFallback's consecutive-streak
// trigger never fires because each REST success resets the streak (the exact
// blind spot ping-pong exploits). Detection: FLAP_THRESHOLD via-transitions
// inside FLAP_WINDOW_MS → pin the site to the fallback channel (the adapter's
// existing preferFallback machinery, REST re-probed after ~12 h) with ONE
// explanatory ping. Independently, repeat self_healed pings inside
// SELF_HEALED_PING_GAP_MS go to history only.
const FLAP_WINDOW_MS = 6 * 3_600_000;
const FLAP_THRESHOLD = 3;
const SELF_HEALED_PING_GAP_MS = 90 * 60_000;
const VIA_FLIPS_CAP = 20;
// Reappearance guard: rosters can differ per channel (a product missing from
// the fallback's view, a truncated deep scan), so a channel flip makes products
// vanish and "reappear" — and diff() would re-alert them as NEW every cycle.
// Handles seen within RESEEN_WINDOW_MS are remembered; a new_product alert for
// a remembered handle becomes a quiet history note instead of a page. A real
// relist after ≥24 h away still alerts.
const RESEEN_WINDOW_MS = 24 * 3_600_000;
const RECENTLY_SEEN_CAP = 800;
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
  /** True when the site's current effective interval is a drop-window cadence — errors page earlier. */
  tightWindow?: boolean;
}

export async function processSite({
  site,
  prevState,
  adapter,
  deps,
  ignored,
  tightWindow,
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

    // Self-healing visibility: fire when a fallback channel engages (with the
    // why) and when the primary recovers — auto-recovery should never be
    // invisible. Keyed on the fetchVia transition, PLUS two dampers for a
    // flapping channel (see constants above): repeat pings inside the gap go
    // history-only, and hitting the flap threshold pins the site to the
    // fallback with one explanatory ping instead of narrating every flip.
    const prevVia = (prevState?.fetchVia as string | undefined) ?? null;
    const newVia = (newState.fetchVia as string | undefined) ?? null;
    const flapCutoff = Date.now() - FLAP_WINDOW_MS;
    let viaFlips = ((prevState?.viaFlips as string[] | undefined) ?? []).filter(
      (ts) => Date.parse(ts) >= flapCutoff,
    );
    let lastSelfHealedPingAt = (prevState?.lastSelfHealedPingAt as string | undefined) ?? null;

    if (newVia !== prevVia) {
      viaFlips = [...viaFlips, nowIso()].slice(-VIA_FLIPS_CAP);
      const lastPingMs = lastSelfHealedPingAt ? Date.parse(lastSelfHealedPingAt) : 0;
      const damped = Date.now() - lastPingMs < SELF_HEALED_PING_GAP_MS;
      const alreadyPinned = prevState?.preferFallback === true;

      if (viaFlips.length >= FLAP_THRESHOLD && !alreadyPinned) {
        // Flapping — pin to the stable channel and say so ONCE. A fresh probe
        // stamp means the adapter leads with the Storefront API and re-probes
        // REST in ~12 h; a stable recovery then gets its own ping.
        newState.preferFallback = true;
        newState.lastRestProbeAt = nowIso();
        lastSelfHealedPingAt = nowIso();
        events.push({
          type: "self_healed",
          product: {
            title: site.name,
            url: sourceUrl(site),
            note:
              `⛑ Channel flapping: this site flipped between products.json and the Storefront API ` +
              `${viaFlips.length} times in the last 6 h — the host rate-limits intermittently. ` +
              `Pinning checks to the Storefront API for ~12 h to stop the alert noise; products.json ` +
              `will be re-probed automatically and you'll get one ping when it stably recovers.`,
          },
        });
      } else if (newVia) {
        const why = (newState.fetchViaReason as string | undefined) ?? "primary channel blocked";
        if (!damped) lastSelfHealedPingAt = nowIso();
        events.push({
          type: "self_healed",
          quiet: damped,
          product: {
            title: site.name,
            url: sourceUrl(site),
            note:
              `⛑ Self-healed: ${why}, so this check ran via the Storefront GraphQL API instead. ` +
              `Monitoring continues uninterrupted; the primary endpoint is retried on every check and ` +
              `you'll get another ping when it recovers.`,
          },
        });
      } else {
        if (!damped) lastSelfHealedPingAt = nowIso();
        events.push({
          type: "self_healed",
          quiet: damped,
          product: {
            title: site.name,
            url: sourceUrl(site),
            note: "✅ Primary endpoint is reachable again — back to normal checks (fallback no longer needed).",
          },
        });
      }
    }
    newState.viaFlips = viaFlips;
    newState.lastSelfHealedPingAt = lastSelfHealedPingAt;

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

    // Reappearance guard: suppress "new product" for handles we saw recently —
    // they didn't launch, they came back into view (channel flip / partial
    // fetch). Recorded as a quiet history note so the suppression is auditable.
    const seenCutoff = Date.now() - RESEEN_WINDOW_MS;
    const prevSeen = (prevState?.recentlySeen as Record<string, string> | undefined) ?? {};
    const reappeared: string[] = [];
    alerts = alerts.filter((a) => {
      if (a.type !== "new_product" || !a.product.handle) return true;
      const seenAt = prevSeen[a.product.handle];
      if (seenAt && Date.parse(seenAt) >= seenCutoff) {
        reappeared.push(a.product.title);
        return false;
      }
      return true;
    });
    if (reappeared.length > 0) {
      events.push({
        type: "baseline",
        product: {
          title: site.name,
          url: sourceUrl(site),
          note:
            `${reappeared.length} product(s) reappeared within 24 h (channel switch or partial fetch) — ` +
            `duplicate "new product" alert(s) suppressed: ${reappeared.slice(0, 3).join(", ")}` +
            (reappeared.length > 3 ? ", …" : ""),
        },
      });
    }

    // Remember every handle currently on the roster (pruned to the window,
    // capped by recency so state stays bounded). CRITICAL: absence from a
    // fallback-channel roster is NOT evidence of removal — that channel has
    // partial visibility (truncation / channel publishing), which is the whole
    // reason the guard exists. So while this check ran via the fallback, FREEZE
    // memory (re-stamp carried entries instead of decaying them); a long pinned
    // period must not expire REST-only products and re-alert them as "new" when
    // REST finally recovers. Decay only runs under the authoritative channel.
    const partialView = newVia != null;
    const seen: Record<string, string> = {};
    for (const [h, ts] of Object.entries(prevSeen)) {
      if (partialView) seen[h] = nowIso();
      else if (Date.parse(ts) >= seenCutoff) seen[h] = ts;
    }
    if (newState.products) {
      for (const h of Object.keys(newState.products)) seen[h] = nowIso();
    }
    const seenEntries = Object.entries(seen);
    newState.recentlySeen =
      seenEntries.length > RECENTLY_SEEN_CAP
        ? Object.fromEntries(
            seenEntries.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, RECENTLY_SEEN_CAP),
          )
        : seen;

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
    return buildErrorOutcome(site, prevState, err, tightWindow === true);
  }
}

// A fetch that died with NO status at all — aborted/deadline/idle-timeout — is
// a stall: the host accepted the connection and left it hanging (tar-pit bot
// mitigation). Functionally a block, so it gets the same cooldown + wording.
const STALL_RE = /aborted (fetch|post)ing|deadline exceeded|socket idle timeout/i;

function buildErrorOutcome(
  site: SiteDefinition,
  prevState: SiteState | undefined,
  err: unknown,
  tightWindow = false,
): SiteOutcome {
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
  const threshold = site.imminent
    ? IMMINENT_ERROR_ALERT_THRESHOLD
    : tightWindow
      ? TIGHT_ERROR_ALERT_THRESHOLD
      : ERROR_ALERT_THRESHOLD;
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
