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

import { buildAdapterDeps, diagnoseSite, getAdapter, siteDefinitionSchema, sourceUrl, type AdapterDeps, type SiteDefinition } from "@beacon/core";
import { expireIdentity } from "@beacon/fetch";
import { sleep, jitter, shouldCheck, type Alert } from "@beacon/shared";
import type { NotificationChannel } from "@beacon/notify";
import type { BeaconStore, SiteRow } from "@beacon/db";
import { applyCommands } from "./commands.js";
import { processSite, type SiteOutcome } from "./process-site.js";

export const DEFAULT_IMMINENT_DURATION_MIN = 20;
// Wall-clock ceiling for a single site's check (fetch + parse). The fetch layer
// has its own 30s per-request deadline; this bounds the whole multi-page/site
// op so the loop stays responsive.
const PER_SITE_BUDGET_MS = 45_000;
// Need at least this many checked sites before "all failed" means "systemic"
// rather than "my two sites happen to both be down".
const SYSTEMIC_MIN_SITES = 2;

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

  rows = normalizeRows(await store.sites.list(), log); // refresh after auto-off/harvest mutations

  const anyImminentActive = rows.some((r) => r.enabled && r.definition.imminent);
  let checked = 0;
  const results: CheckedSite[] = [];

  for (const row of rows) {
    const def = row.definition;
    if (!def.enabled) continue;

    const prevState = await store.state.load(def.id);

    const cooldownUntil = prevState?.cooldownUntil ? Date.parse(prevState.cooldownUntil as string) : 0;
    if (cooldownUntil > Date.now()) {
      // The 5/15/60-min circuit breaker would black out a site after a 403/429.
      // In imminent mode the operator is actively watching a drop, so a single
      // transient block must not silence the launch window — check anyway. Cadence
      // is still bounded by imminentIntervalMinutes (shouldCheck below), and the
      // breaker reasserts automatically once imminent ends.
      if (!def.imminent) {
        log(`[${def.name}] Skipping — rate-limit cooldown`);
        continue;
      }
      log(`[${def.name}] In cooldown but imminent — checking anyway`);
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
    // loop isn't held hostage by one slow/blocked host.
    const controller = new AbortController();
    const budget = setTimeout(() => controller.abort(), PER_SITE_BUDGET_MS);
    let outcome: SiteOutcome;
    try {
      outcome = await processSite({
        site: def,
        prevState,
        adapter,
        deps: { ...baseDeps, signal: controller.signal },
        ignored,
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
    }
    results.push({ def, outcome });

    await wait(jitter(1000, 500)); // inter-site gap
  }

  await dispatch(ctx, results, baseDeps);

  return { anyImminentActive, checked };
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

  for (const { def, outcome } of results) {
    for (const ev of outcome.events) {
      log(`  → ${ev.type}: ${ev.product.title}`);
      if (ev.type === "baseline" || !channel) continue;

      let note = ev.product.note ?? "";
      if (ev.type === "site_error") {
        // Auto-diagnosis (3b): run the same step-by-step probe the 🩺 button
        // runs and ship the verdict INSIDE the page — the alert arrives already
        // explaining itself. Short per-step timeout; failures never block the send.
        try {
          const report = await diagnoseSite(def, deps, { stepTimeoutMs: 8_000 });
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
}
