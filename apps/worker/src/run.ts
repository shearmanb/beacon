// One pass over all sites — ported from worker.js run(), adapted to the DB.
// Loads config/schedules/ignored/secrets from the store, drains commands, runs
// imminent auto-off, then checks each due site via the engine and persists the
// outcome. No GitHub push/merge/SHA machinery — the DB handles persistence.
//
// Two reliability behaviors layered on top of the port:
//  • Per-site budget (2c): each site check runs under an AbortSignal with a
//    wall-clock cap, so one slow/blocked host can't starve the loop (esp. the
//    ~10s imminent cadence).
//  • Systemic-failure detection (2d): if EVERY checked site fails in one pass
//    (a network outage or the egress IP being blocked), send ONE aggregate
//    `system_degraded` page instead of N near-identical site_error pings, and
//    suppress the per-site error sends for that pass.

import { buildAdapterDeps, diagnoseSite, getAdapter, hasAdapter, registerAdapter, siteDefinitionSchema, sourceUrl, type AdapterDeps, type SiteDefinition } from "@beacon/core";
import { expireIdentity } from "@beacon/fetch";
import { sleep, jitter, shouldCheck, getEffectiveInterval, type Alert } from "@beacon/shared";
import type { NotificationChannel } from "@beacon/notify";
import type { BeaconStore, SiteRow } from "@beacon/db";
import { applyCommands } from "./commands.js";
import { processSite, type SiteOutcome } from "./process-site.js";

export const DEFAULT_IMMINENT_DURATION_MIN = 20;
// Wall-clock ceiling for a single site's check (fetch + parse). The fetch layer
// has its own 30s per-request deadline; this bounds the whole multi-page/site
// op so the loop stays responsive. 60s (was 45s): a failover check legitimately
// spends up to 20s proving REST is stalled (restStallMs) BEFORE the 8-page
// Storefront fallback even starts — 45s left the fallback too little headroom
// and a slow-but-working fallback could die at the parent budget.
const PER_SITE_BUDGET_MS = 60_000;
// Browser-tier checks (remote Chromium over CDP) legitimately spend longer:
// session create + CDP connect + page load + challenge settling before the
// roster fetch even starts. Still hard-capped so one walled host can't own the loop.
const BROWSER_SITE_BUDGET_MS = 120_000;
// Need at least this many checked sites before "all failed" means "systemic"
// rather than "my two sites happen to both be down".
const SYSTEMIC_MIN_SITES = 2;
// Drop-window cooldown clamp (2026-07-22): the 5→15→60→180 min breaker ladder
// is right overnight, but it was mission-failure in a drop window — a few
// consecutive both-channel failures (below the site_error page threshold)
// silently blacked out the exact hours Beacon exists for (the Jul 22
// Glaze/ENDALZ miss: last good check 5:24 PM, listing ~6:30 PM, tile frozen in
// a long cooldown, zero pages). While the site's CURRENT effective interval is
// tight (≤ TIGHT_INTERVAL_MIN — i.e. the schedule says we're inside a
// data-tuned drop window), honor at most TIGHT_COOLDOWN_CAP_MS of any stored
// cooldown, measured from the last attempt. Read-side only: stored state is
// untouched, the full ladder still applies overnight, and an already-stored
// long cooldown un-sticks on the first pass after deploy. A 15-min re-probe of
// a 429ing host matches the ladder's step-2 politeness, so this stays civil.
const TIGHT_INTERVAL_MIN = 15;
const TIGHT_COOLDOWN_CAP_MS = 15 * 60_000;

// ── Quarantine (2026-08-14) ──────────────────────────────────────────────────
// A site that is BROKEN, not blocked — a 404 on a moved product page, a dead
// paid API — never recovers on its own, and the alerting was built on the
// assumption that failure is temporary. `cgf` reached 458 consecutive HTTP 404s
// and `sharedpour_browser` 362 consecutive HTTP 402s (Browserbase billing):
// each re-paged daily forever, and — worse — poisoned the aggregate signals,
// since one permanently-dead site plus one transient failure satisfies
// "every checked site failed this pass" and fires a false system_degraded.
// After this many failures AND this long without a success, disable the site
// with one clear page. Deliberately generous: a genuinely blocked host that
// keeps 429ing recovers long before it trips this.
const QUARANTINE_MIN_FAILURES = 25;
const QUARANTINE_MIN_AGE_MS = 72 * 3_600_000;

// ── Cross-site duplicate suppression (2026-08-14) ────────────────────────────
// Four checkers watch sharedpour.com (t8ke, t8ke_all, reveries, provenance)
// with overlapping rosters, so one drop paged four times (Aug 7, "The Eleventh
// Hour"). Each site keeps its own tile, its own filters and its own alert
// flags — nothing is consolidated away — but the same product on the same host
// only reaches Discord once inside this window. Per-site opt-out:
// `alerts.dedupeAcrossSites: false`.
const CROSS_SITE_DEDUPE_MS = 60 * 60_000;
const DEDUPE_KEYS_CAP = 400;
const DEDUPE_META_KEY = "recent_alert_keys";
// Above this many product alerts from ONE site in ONE pass, Discord gets a
// single digest embed instead of N. History keeps every row either way.
const SITE_DIGEST_THRESHOLD = 6;
const DIGEST_MAX_LINES = 25;
const PRODUCT_ALERT_TYPES = new Set(["new_product", "restock", "sold_out"]);

// Site IDs we've already alerted about a config/adapter problem this process, so
// the warning fires once per start instead of every ~60s loop.
const warnedConfigSiteIds = new Set<string>();
// Whether we've paged about the current systemic-failure episode (reset when a
// pass is no longer all-failing). Process-level so a restart re-pages if still down.
let systemicAlerted = false;

export interface RunContext {
  store: BeaconStore;
  channel?: NotificationChannel | undefined;
  dryRun: boolean;
  log?: (msg: string) => void;
  /** Override the inter-fetch politeness sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

// Re-validate each stored definition through Zod on load so schema defaults
// (e.g. a newly-added source field) populate without a data migration, and a
// definition that somehow went invalid is skipped + warned once rather than
// crashing the pass. `sites.list()` returns the raw stored JSON — only `upsert`
// runs Zod — so this is where defaults actually land for the running worker.
function normalizeRows(rows: SiteRow[], log: (msg: string) => void): SiteRow[] {
  const out: SiteRow[] = [];
  for (const row of rows) {
    const parsed = siteDefinitionSchema.safeParse(row.definition);
    if (parsed.success) {
      out.push({ ...row, definition: parsed.data, enabled: parsed.data.enabled, sourceKind: parsed.data.source.kind });
    } else if (!warnedConfigSiteIds.has(row.id)) {
      warnedConfigSiteIds.add(row.id);
      log(`[${row.name ?? row.id}] Invalid site definition — skipped: ${parsed.error.issues[0]?.message ?? "invalid"}`);
    }
  }
  return out;
}

async function autoOffImminent(ctx: RunContext, rows: SiteRow[]): Promise<void> {
  const { store, channel, dryRun, log = () => {} } = ctx;
  for (const row of rows) {
    const def = row.definition;
    if (!def.imminent || !def.imminentSince) continue;
    const durationMin = def.imminentDurationMinutes ?? DEFAULT_IMMINENT_DURATION_MIN;
    if (Date.now() - Date.parse(def.imminentSince) < durationMin * 60_000) continue;

    const restored = def.scheduleBeforeImminent ?? def.schedule ?? undefined;
    log(`[${def.name}] Imminent auto-off after ${durationMin}m timeout`);
    const event: Alert = {
      type: "imminent_timeout",
      product: {
        title: def.name,
        url: sourceUrl(def),
        note: `Imminent mode auto-disabled after ${durationMin} min.`,
      },
    };
    if (!dryRun) {
      await store.sites.upsert({
        ...def,
        imminent: false,
        imminentSince: null,
        scheduleBeforeImminent: null,
        schedule: restored ?? undefined,
      });
      await store.history.append(def.id, [event]);
      if (channel) {
        try {
          await channel.send(def.name, event);
        } catch (err) {
          log(`  Discord imminent_timeout error: ${(err as Error).message}`);
        }
      }
    }
  }
}

export interface RunResult {
  anyImminentActive: boolean;
  checked: number;
}

interface CheckedSite {
  def: SiteDefinition;
  outcome: SiteOutcome;
}

export async function runOnce(ctx: RunContext): Promise<RunResult> {
  const { store, channel, dryRun, log = () => {} } = ctx;
  const wait = ctx.sleep ?? sleep;

  const schedules = await store.schedules.all();
  const ignored = await store.ignored.set();
  const baseDeps = buildAdapterDeps(await store.secrets.all());

  await applyCommands(store, await store.commands.drainPending());
  let rows = normalizeRows(await store.sites.list(), log);
  await autoOffImminent(ctx, rows);

  // Preventive fallback arming (2a): harvest Storefront tokens for shopify_rest
  // sites that lack one, while their pages are still reachable (≤1 try/site/day).
  try {
    const { maybeHarvestFallbacks } = await import("./harvest.js");
    await maybeHarvestFallbacks(ctx, rows);
  } catch (err) {
    log(`Fallback harvest error (continuing): ${(err as Error).message}`);
  }

  // Daily analytics mirror: push new alert-history rows to the repo
  // (analytics/alert_history.jsonl) so drop-timing analysis can be mined from
  // git without touching the volume. No-ops unless GH_TOKEN + GH_REPO are set.
  try {
    const { maybeMirrorHistory } = await import("./mirror.js");
    await maybeMirrorHistory({ store, dryRun, log });
  } catch (err) {
    log(`History mirror error (continuing): ${(err as Error).message}`);
  }

  // Daily OFF-BOX backup: site config, schedules, hand-curated meta blobs and
  // product baselines pushed to the repo, so a lost Railway volume is
  // recoverable (the on-volume snapshots live on the volume that just died).
  try {
    const { maybeBackupConfig } = await import("./backup-mirror.js");
    await maybeBackupConfig({ store, dryRun, log });
  } catch (err) {
    log(`Config backup error (continuing): ${(err as Error).message}`);
  }

  // Unicorn Auctions watcher: ISOLATED side-job with its own meta storage,
  // error surface (/unicorn), and daily cadence. Deliberately not a pipeline
  // site — its failures never page site_error, never count toward systemic
  // failure, and never touch breakers/host pins (and vice versa).
  try {
    const { maybeScanUnicorn } = await import("./unicorn.js");
    await maybeScanUnicorn(ctx);
  } catch (err) {
    log(`Unicorn scan error (continuing): ${(err as Error).message}`);
  }

  rows = normalizeRows(await store.sites.list(), log); // refresh after auto-off/harvest mutations

  // Browser tier (lazy): @beacon/browser carries the playwright-core dep, so it
  // is imported ONLY when an enabled browser-kind site exists — a config-free
  // deploy never loads it. Registration is process-wide and once.
  if (!hasAdapter("browser") && rows.some((r) => r.enabled && r.definition.source.kind === "browser")) {
    try {
      const { browserAdapter } = await import("@beacon/browser");
      registerAdapter(browserAdapter);
      log("Browser adapter registered (Browserbase engine).");
    } catch (err) {
      log(`Browser adapter unavailable (continuing without it): ${(err as Error).message}`);
    }
  }

  const anyImminentActive = rows.some((r) => r.enabled && r.definition.imminent);
  let checked = 0;
  const results: CheckedSite[] = [];
  // Hosts whose channel got pinned to the Storefront API THIS pass (host →
  // name of the site that pinned), for host-level propagation below.
  const newlyPinnedHosts = new Map<string, string>();

  for (const row of rows) {
    const def = row.definition;
    if (!def.enabled) continue;

    const prevState = await store.state.load(def.id);

    // Inside a tight (drop-window) cadence, blocking failures page earlier and
    // long cooldowns are clamped — see TIGHT_INTERVAL_MIN above.
    const tightWindow = getEffectiveInterval(def, schedules) <= TIGHT_INTERVAL_MIN;

    const cooldownUntil = prevState?.cooldownUntil ? Date.parse(prevState.cooldownUntil as string) : 0;
    if (cooldownUntil > Date.now()) {
      // The circuit breaker would black out a site after a 403/429. In imminent
      // mode the operator is actively watching a drop, so a single transient
      // block must not silence the launch window — check anyway. Cadence is
      // still bounded by imminentIntervalMinutes (shouldCheck below), and the
      // breaker reasserts automatically once imminent ends.
      if (def.imminent) {
        log(`[${def.name}] In cooldown but imminent — checking anyway`);
      } else {
        const lastAttempt = prevState?.lastChecked ? Date.parse(prevState.lastChecked as string) : 0;
        const honoredUntil = tightWindow
          ? Math.min(cooldownUntil, lastAttempt + TIGHT_COOLDOWN_CAP_MS)
          : cooldownUntil;
        if (honoredUntil > Date.now()) {
          log(`[${def.name}] Skipping — rate-limit cooldown`);
          continue;
        }
        log(`[${def.name}] Long cooldown clamped to ${TIGHT_INTERVAL_MIN}m — tight drop-window cadence, checking anyway`);
      }
    }
    if (!shouldCheck(def, prevState, schedules)) continue;

    let adapter;
    try {
      adapter = getAdapter(def.source.kind);
    } catch (err) {
      log(`[${def.name}] ${(err as Error).message}`);
      // Config-level problem (e.g. an unknown/unimplemented source kind in the
      // DB — Zod gates the normal write path, but a bad definition or a deferred
      // kind like `html` lands here). Don't go silent: alert the operator ONCE
      // per start instead of quietly skipping the site every loop.
      if (channel && !dryRun && !warnedConfigSiteIds.has(def.id)) {
        warnedConfigSiteIds.add(def.id);
        const event: Alert = {
          type: "site_error",
          product: {
            title: def.name,
            url: sourceUrl(def),
            note: `Config error — ${(err as Error).message}. Site skipped until fixed.`,
          },
        };
        try {
          await channel.send(def.name, event);
        } catch (e) {
          log(`  Discord config-warning error: ${(e as Error).message}`);
        }
      }
      continue;
    }

    await wait(jitter(3500, 1500)); // pre-site politeness jitter
    log(`[${def.name}] Checking...`);
    checked += 1;

    // Per-site wall-clock budget (2c): abort the fetch if it overruns so the
    // loop isn't held hostage by one slow/blocked host. Kind-aware: browser
    // checks get more headroom (remote session + page load are legitimate cost).
    const controller = new AbortController();
    const budgetMs = def.source.kind === "browser" ? BROWSER_SITE_BUDGET_MS : PER_SITE_BUDGET_MS;
    const budget = setTimeout(() => controller.abort(), budgetMs);
    let outcome: SiteOutcome;
    try {
      outcome = await processSite({
        site: def,
        prevState,
        adapter,
        deps: { ...baseDeps, signal: controller.signal },
        ignored,
        tightWindow,
      });
    } finally {
      clearTimeout(budget);
    }

    // Self-healing nudge: a second consecutive block (cooldown escalated past
    // level 1) suggests the current browser identity may be flagged — re-roll it
    // so the next attempt presents a fresh profile. Stamped into state (before
    // the save below) so the tile/errorLog era of "we already tried a new
    // browser" is visible, not just a log line.
    if (!outcome.ok && ((outcome.newState.cooldownLevel as number | undefined) ?? 0) >= 2) {
      try {
        const host = new URL(sourceUrl(def)).hostname;
        expireIdentity(host);
        outcome.newState.identityRerolledAt = new Date().toISOString();
        log(`[${def.name}] Re-rolled browser identity for ${host} after repeated blocks.`);
      } catch {
        /* sourceUrl may be empty for some kinds */
      }
    }

    if (!dryRun) {
      await store.state.save(def.id, outcome.newState);
      if (outcome.events.length) await store.history.append(def.id, outcome.events);
      if (await maybeQuarantine(ctx, def, outcome)) continue; // disabled + paged; skip the rest
    }
    results.push({ def, outcome });

    // Collect newly-pinned hosts (flap-pin or fallback-streak preference) for
    // host-level propagation after the pass.
    if (outcome.newState.preferFallback === true && prevState?.preferFallback !== true) {
      const host = hostOf(def);
      if (host) newlyPinnedHosts.set(host, def.name);
    }

    await wait(jitter(1000, 500)); // inter-site gap
  }

  if (!dryRun && newlyPinnedHosts.size > 0) {
    await propagateHostPins(ctx, rows, newlyPinnedHosts);
  }

  await dispatch(ctx, results, baseDeps);

  return { anyImminentActive, checked };
}

// Auto-disable a site that has been failing the same way for days (2a). Returns
// true when the site was quarantined this pass, so the caller drops it from the
// pass results — a dead site must not count toward systemic-failure detection
// or the host rollup, which is half of what made it harmful.
async function maybeQuarantine(ctx: RunContext, def: SiteDefinition, outcome: SiteOutcome): Promise<boolean> {
  const { store, channel, log = () => {} } = ctx;
  if (outcome.ok) return false;
  const failures = (outcome.newState.consecutiveErrors as number | undefined) ?? 0;
  const since = outcome.newState.errorStreakSince as string | undefined;
  if (failures < QUARANTINE_MIN_FAILURES) return false;
  // No streak stamp yet (state written before this field existed) — start the
  // clock now rather than quarantining on failure count alone.
  if (!since) {
    await store.state.save(def.id, { ...outcome.newState, errorStreakSince: new Date().toISOString() });
    return false;
  }
  if (Date.now() - Date.parse(since) < QUARANTINE_MIN_AGE_MS) return false;

  const days = Math.round((Date.now() - Date.parse(since)) / 86_400_000);
  const lastError = (outcome.newState.lastError as string | undefined) ?? "unknown error";
  await store.sites.upsert({ ...def, enabled: false });
  const event: Alert = {
    type: "site_error",
    product: {
      title: def.name,
      url: sourceUrl(def),
      note:
        `⏸ Monitoring PAUSED for this site: ${failures} consecutive failures over ${days} day(s) with the same ` +
        `error — this is broken, not blocked, and a permanently-failing checker also corrupts the ` +
        `"all sites failing" and host-block signals for everything else.\nLast error: ${lastError}\n\n` +
        `Nothing else is affected. Fix the source (⚙ on the tile) or the URL, then re-enable the site on the dashboard.`,
    },
  };
  await store.history.append(def.id, [event]);
  log(`[${def.name}] QUARANTINED after ${failures} failures over ${days}d — site disabled.`);
  if (channel) {
    try {
      await channel.send(def.name, event);
    } catch (err) {
      log(`  Discord quarantine error: ${(err as Error).message}`);
    }
  }
  return true;
}

// Host-level pin propagation (feedback loop): rate limits and bot scores are
// per-HOST, so when one checker's flapping channel gets pinned to the
// Storefront API, its siblings on the same host are still poking the
// rate-limited REST endpoint — re-heating the block for everyone (and each
// sibling would need 3 flips of its own before pinning itself). Pre-pin every
// armed sibling: quiet history note only, no Discord page — the pinning site's
// own ping already told the story. The ~12 h REST re-probe un-pins them all
// automatically when the host cools down.
async function propagateHostPins(
  ctx: RunContext,
  rows: SiteRow[],
  pinnedHosts: Map<string, string>,
): Promise<void> {
  const { store, log = () => {} } = ctx;
  for (const row of rows) {
    const def = row.definition;
    if (!def.enabled || def.source.kind !== "shopify_rest" || !def.source.storefrontFallback) continue;
    const host = hostOf(def);
    if (!host || !pinnedHosts.has(host)) continue;
    const state = await store.state.load(def.id);
    // Skip never-checked sites (no state yet — their first check must baseline
    // quietly, and a synthetic state row would defeat startup quiet mode) and
    // anything already pinned (including the site that pinned this pass).
    if (!state || state.preferFallback === true) continue;
    const pinnedBy = pinnedHosts.get(host)!;
    await store.state.save(def.id, {
      ...state,
      preferFallback: true,
      lastRestProbeAt: new Date().toISOString(),
    });
    const event: Alert = {
      type: "self_healed",
      quiet: true,
      product: {
        title: def.name,
        url: sourceUrl(def),
        note:
          `⛑ Host-level pin: "${pinnedBy}" (same host: ${host}) was just pinned to the Storefront API after ` +
          `channel flapping — pre-pinning this site too so it stops poking the rate-limited REST endpoint. ` +
          `products.json is re-probed automatically in ~12 h.`,
      },
    };
    await store.history.append(def.id, [event]);
    log(`[${def.name}] Pre-pinned to the Storefront API (host-level, after "${pinnedBy}").`);
  }
}

function hostOf(def: SiteDefinition): string | null {
  try {
    return new URL(sourceUrl(def)).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

// Send alerts after the full pass, so systemic failure can be detected and
// collapsed into a single page. State/history are already persisted above —
// dispatch only touches Discord. site_error pages are enriched before sending:
// an auto-run 🩺 diagnosis verdict (3b) and a host-level rollup note when
// multiple checkers on the same host are failing together (3c).
async function dispatch(ctx: RunContext, results: CheckedSite[], deps?: AdapterDeps): Promise<void> {
  const { store, channel, dryRun, log = () => {} } = ctx;
  if (dryRun) {
    // In dry-run, still surface what WOULD have been sent (parity with the old
    // inline logging), but persist/send nothing.
    for (const { def, outcome } of results) {
      for (const ev of outcome.events) log(`  → ${ev.type}: ${ev.product.title}`);
    }
    return;
  }

  const errored = results.filter((r) => !r.outcome.ok);
  const systemic = results.length >= SYSTEMIC_MIN_SITES && errored.length === results.length;

  if (systemic) {
    log(`[systemic] All ${results.length} checked sites failed this pass.`);
    if (!systemicAlerted) {
      systemicAlerted = true;
      const sample = errored
        .slice(0, 4)
        .map((r) => `• ${r.def.name}: ${(r.outcome.newState.lastError as string | undefined) ?? "failed"}`)
        .join("\n");
      const event: Alert = {
        type: "system_degraded",
        product: {
          title: "All sites failing",
          url: "",
          note:
            `Every one of the ${results.length} checked sites failed this pass — likely a network ` +
            `outage or the egress IP being blocked, not a per-site problem.\n${sample}\n\n` +
            `What to check: 1) is the Railway service up (deploy logs)? 2) hit 🩺 Diagnose on any tile — ` +
            `if every step fails, the egress IP is blocked or the network is down; 3) a Railway redeploy ` +
            `can rotate the egress IP if this persists.`,
        },
      };
      await store.history.append(null, [event]);
      if (channel) {
        try {
          await channel.send("Beacon worker", event);
        } catch (err) {
          log(`  Discord system_degraded error: ${(err as Error).message}`);
        }
      }
    }
    // Suppress the individual site_error pings this pass — the aggregate covers it.
    return;
  }

  systemicAlerted = false;

  // Host-level view (3c): which hosts have 2+ failing checkers this pass.
  const failingByHost = new Map<string, string[]>();
  for (const { def } of errored) {
    const host = hostOf(def);
    if (!host) continue;
    failingByHost.set(host, [...(failingByHost.get(host) ?? []), def.name]);
  }

  // Cross-site duplicate memory (2b) + per-pass send bookkeeping (3c).
  const dedupeKeys = await loadDedupeKeys(store);
  let dedupeDirty = false;

  for (const { def, outcome } of results) {
    // Digest gate (3c): one site producing a pile of product alerts in a single
    // pass (a whole collection going live, a re-baseline) becomes ONE embed.
    const productEvents = outcome.events.filter((ev) => PRODUCT_ALERT_TYPES.has(ev.type) && ev.quiet !== true);
    if (channel && productEvents.length > SITE_DIGEST_THRESHOLD) {
      log(`  → ${productEvents.length} product alerts from ${def.name} — sending one digest`);
      try {
        await channel.send(def.name, buildSiteDigest(def, productEvents));
      } catch (err) {
        log(`  Discord digest error: ${(err as Error).message}`);
      }
      for (const ev of productEvents) {
        const key = alertKey(def, ev);
        if (key) {
          dedupeKeys[key] = new Date().toISOString();
          dedupeDirty = true;
        }
      }
    }
    const digested = productEvents.length > SITE_DIGEST_THRESHOLD ? new Set(productEvents) : new Set<Alert>();

    for (const ev of outcome.events) {
      if (digested.has(ev)) continue; // already covered by this site's digest
      // self_healed is self-healing telemetry, not a problem to act on: record it
      // to history + the dashboard (⛑ chips / fetchVia state) but never page
      // Discord. Operator's call (2026-07-19) — only genuine problems should ping.
      // A real outage still pages as site_error when BOTH channels fail, and
      // product drops still alert normally (they flow via whichever channel works).
      // baseline is likewise history-only; an explicitly-quiet event is damped too.
      const historyOnly = ev.type === "baseline" || ev.type === "self_healed" || ev.quiet === true;
      log(`  → ${ev.type}: ${ev.product.title}${historyOnly ? " (history only)" : ""}`);
      if (historyOnly || !channel) continue;

      // Same product, same host, more than one checker watching it: page once
      // (2b). Every tile still records it in history and still shows it — only
      // the Discord duplicate is dropped. Checked here, after the history-only
      // gate, so a suppressed event never consumes the key.
      if (def.alerts.dedupeAcrossSites !== false) {
        const key = alertKey(def, ev);
        if (key) {
          const seenAt = dedupeKeys[key];
          if (seenAt && Date.now() - Date.parse(seenAt) < CROSS_SITE_DEDUPE_MS) {
            log(`     (duplicate of an alert already sent for this host — not re-paged)`);
            continue;
          }
          dedupeKeys[key] = new Date().toISOString();
          dedupeDirty = true;
        }
      }

      let note = ev.product.note ?? "";
      if (ev.type === "site_error") {
        // Auto-diagnosis (3b): run the same step-by-step probe the 🩺 button
        // runs and ship the verdict INSIDE the page — the alert arrives already
        // explaining itself. Short per-step timeout; failures never block the send.
        try {
          const report = await diagnoseSite(def, deps, {
            stepTimeoutMs: 8_000,
            // Let it retest the exact request this failure died on (blind-spot
            // guard: a page-1 probe can pass while the scan fails pages deep).
            lastError: outcome.newState.lastError as string | undefined,
          });
          note += `\n\n🩺 Auto-diagnosis: ${report.verdict}`;
        } catch (err) {
          log(`  auto-diagnose failed: ${(err as Error).message}`);
        }
        const host = hostOf(def);
        const siblings = host ? failingByHost.get(host) ?? [] : [];
        if (siblings.length >= 2) {
          note += `\n\n⚠ Host-level: ${siblings.length} checkers on ${host} are failing together (${siblings.join(", ")}) — one host block, one fix clears them all.`;
        }
      }

      try {
        await channel.send(def.name, note === ev.product.note ? ev : { ...ev, product: { ...ev.product, note } });
      } catch (err) {
        log(`  Discord error: ${(err as Error).message}`);
      }
    }
  }

  if (dedupeDirty) await saveDedupeKeys(store, dedupeKeys);
}

// ── Cross-site dedupe helpers (2b) ───────────────────────────────────────────
// Identity is host + product handle + alert type: the same bottle on the same
// store, however many checkers happen to see it. Site-level events (site_error,
// self_healed, …) are never deduped — those are per-checker facts.
function alertKey(def: SiteDefinition, ev: Alert): string | null {
  if (!PRODUCT_ALERT_TYPES.has(ev.type) || !ev.product.handle) return null;
  const host = hostOf(def);
  return host ? `${host}|${ev.product.handle}|${ev.type}` : null;
}

async function loadDedupeKeys(store: BeaconStore): Promise<Record<string, string>> {
  const raw = await store.meta.get(DEDUPE_META_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const cutoff = Date.now() - CROSS_SITE_DEDUPE_MS;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, string>)) {
      if (typeof v === "string" && Date.parse(v) >= cutoff) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function saveDedupeKeys(store: BeaconStore, keys: Record<string, string>): Promise<void> {
  const entries = Object.entries(keys);
  const bounded =
    entries.length > DEDUPE_KEYS_CAP
      ? Object.fromEntries(entries.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1])).slice(0, DEDUPE_KEYS_CAP))
      : keys;
  try {
    await store.meta.set(DEDUPE_META_KEY, JSON.stringify(bounded));
  } catch {
    /* best-effort: a failed write only costs a duplicate ping */
  }
}

/** One embed standing in for a batch of this site's product alerts (3c). */
function buildSiteDigest(def: SiteDefinition, events: Alert[]): Alert {
  const label = (t: string): string => (t === "new_product" ? "NEW" : t === "restock" ? "BACK" : "GONE");
  const lines = events
    .slice(0, DIGEST_MAX_LINES)
    .map((e) => `• [${label(e.type)}] ${e.product.title}${e.product.minPrice != null ? ` — $${e.product.minPrice}` : ""}`);
  const extra = events.length - lines.length;
  const kinds = [...new Set(events.map((e) => e.type))];
  return {
    type: kinds.length === 1 && kinds[0] === "new_product" ? "new_product" : "site_changed",
    product: {
      title: `${events.length} changes at ${def.name}`,
      url: sourceUrl(def),
      note:
        `${lines.join("\n")}${extra > 0 ? `\n…and ${extra} more` : ""}\n\n` +
        `Batched into one alert (more than ${SITE_DIGEST_THRESHOLD} at once) — full detail on the dashboard.`,
    },
  };
}
