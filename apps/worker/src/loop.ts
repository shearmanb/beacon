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

    if (maxIterations && iterations >= maxIterations) return;

    const base = anyImminentActive ? IMMINENT_LOOP_MS : LOOP_BASE_MS;
    await sleep(jitter(base, anyImminentActive ? 2000 : 5000));
  }
}
