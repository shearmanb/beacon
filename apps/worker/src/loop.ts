// The forever loop — ported from worker.js startLoop(). Tightens to ~10s while
// any site is imminent. DB-unreachable detection generalizes the old
// "GitHub-down -> page Discord, skip healthcheck" (R4): when the datastore is
// the broken thing, the webhook still works (it needs no DB), and skipping the
// healthcheck lets the external dead-man fire.
//
// Each loop also writes a heartbeat (2e) the dashboard can read to detect a
// wedged loop (distinct from a fully-dead process, which the external
// healthcheck covers), and periodically persists host identities (2i).

import { sleep, jitter, type Alert } from "@beacon/shared";
import { httpGet } from "@beacon/fetch";
import type { NotificationChannel } from "@beacon/notify";
import { runOnce, type RunContext } from "./run.js";
import { persistIdentities, rehydrateIdentities } from "./identity-store.js";

const LOOP_BASE_MS = 60_000;
const IMMINENT_LOOP_MS = 10_000;
const DB_FAILURE_THRESHOLD = 3;
// Identities change at most every 6–24h; flushing every Nth loop is plenty.
const IDENTITY_FLUSH_EVERY = 30;

export const HEARTBEAT_KEY = "worker_heartbeat";

// Wedge watchdog (2026-07-22): the one failure the 2e guards could NOT recover
// from was a pass that never finishes — a hung await (an unbounded fetch) or a
// promise chain broken by a swallowed uncaughtException. The process stays
// alive, the web child keeps serving the dashboard, Railway's ON_FAILURE never
// fires (nothing exited), and monitoring silently stops: the Jul 21–22 blackout.
// The watchdog closes the loop on the loop itself: if no pass completes inside
// WEDGE_LIMIT_MS, record a self_healed history row (dashboard-only, per the
// self_healed policy) and exit(1) so the platform restarts the service and
// checks resume unattended. 15 min is well past the worst legitimate pass
// (every site dying at its full 60s budget) while capping a blackout at
// minutes instead of days.
export const WEDGE_LIMIT_MS = 15 * 60_000;
const WEDGE_SCAN_MS = 60_000;

export interface LoopOptions {
  healthcheckUrl?: string | undefined;
  /** For tests: stop after N iterations instead of running forever. */
  maxIterations?: number;
}

async function pageDbDown(channel: NotificationChannel | undefined, streak: number): Promise<void> {
  if (!channel) return;
  const event: Alert = {
    type: "site_error",
    product: {
      title: "Datastore unreachable",
      url: "",
      note: `DB reads have failed ${streak} loops in a row. The worker is running but can't read config or persist state.`,
    },
  };
  try {
    await channel.send("Beacon worker", event);
  } catch {
    /* best-effort */
  }
}

export async function startLoop(ctx: RunContext, options: LoopOptions = {}): Promise<void> {
  const { healthcheckUrl, maxIterations } = options;
  const log = ctx.log ?? ((m: string) => console.log(m));
  let dbFailureStreak = 0;
  let dbFailureAlerted = false;
  let anyImminentActive = false;
  let iterations = 0;

  // Rehydrate persisted browser identities before the first fetch (2i).
  try {
    await rehydrateIdentities(ctx.store);
  } catch (err) {
    log(`[loop] identity rehydrate skipped: ${(err as Error).message}`);
  }

  // Arm the wedge watchdog (see WEDGE_LIMIT_MS above). `lastPassEndAt` is
  // stamped after every completed pass; the scan runs on its own timer, so a
  // pass hung forever can't starve it. unref'd so it never keeps a finished
  // process alive (tests / seed-only runs).
  let lastPassEndAt = Date.now();
  const watchdog = setInterval(() => {
    const stalledMs = Date.now() - lastPassEndAt;
    if (stalledMs < WEDGE_LIMIT_MS) return;
    const stalledMin = Math.round(stalledMs / 60_000);
    log(`[loop] WEDGED — no pass completed in ${stalledMin} min; exiting so the platform restarts the worker.`);
    const event: Alert = {
      type: "self_healed",
      product: {
        title: "Beacon worker",
        url: "",
        note:
          `⛑ Self-restart: the check loop stopped completing passes (wedged ${stalledMin} min — ` +
          `likely a hung request or a broken promise chain). The worker exited so the platform ` +
          `restarts it; checks resume automatically on boot.`,
      },
    };
    // Best-effort history row (a direct append is dashboard-only by nature),
    // hard-capped so a dead DB can't block the restart that fixes things.
    void Promise.race([ctx.store.history.append(null, [event]), sleep(3_000)])
      .catch(() => {})
      .finally(() => process.exit(1));
  }, WEDGE_SCAN_MS);
  watchdog.unref?.();

  try {
    for (;;) {
      iterations += 1;
      try {
        const result = await runOnce(ctx);
        anyImminentActive = result.anyImminentActive;
        dbFailureStreak = 0;
        dbFailureAlerted = false;
      } catch (err) {
        dbFailureStreak += 1;
        log(`[loop] run failed (${dbFailureStreak}): ${(err as Error).message}`);
      }

      const dbDown = dbFailureStreak >= DB_FAILURE_THRESHOLD;
      if (dbDown && !dbFailureAlerted) {
        dbFailureAlerted = true;
        await pageDbDown(ctx.channel, dbFailureStreak);
      }

      // Heartbeat + identity flush (best-effort; only when the DB is reachable so a
      // write storm doesn't pile onto an outage).
      if (!dbDown) {
        try {
          await ctx.store.meta.set(HEARTBEAT_KEY, new Date().toISOString());
          if (iterations % IDENTITY_FLUSH_EVERY === 0) await persistIdentities(ctx.store);
        } catch (err) {
          log(`[loop] heartbeat/identity flush failed: ${(err as Error).message}`);
        }
      }

      if (healthcheckUrl && !dbDown) {
        try {
          await httpGet(healthcheckUrl);
        } catch (err) {
          log(`[loop] healthcheck ping failed: ${(err as Error).message}`);
        }
      }

      lastPassEndAt = Date.now(); // pass complete — feed the watchdog

      if (maxIterations && iterations >= maxIterations) return;

      const base = anyImminentActive ? IMMINENT_LOOP_MS : LOOP_BASE_MS;
      await sleep(jitter(base, anyImminentActive ? 2000 : 5000));
    }
  } finally {
    clearInterval(watchdog);
  }
}
