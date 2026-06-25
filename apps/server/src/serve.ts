// Combined single-process launcher for a one-service deploy (Railway): the
// worker loop runs in-process and the Next.js dashboard runs as a SUPERVISED
// child, both sharing ONE libSQL file on a mounted volume. This is what lets
// Beacon v2 run on Railway alone — no separate database service, no new
// accounts. (For a split worker/web topology, use a network DB like Turso — see
// REBUILD.md "scale-out path".)
//
// Reliability (1a/1b/2e):
//  • The worker is the resilient PARENT. A web (dashboard) crash never takes the
//    worker down — the child is restarted with backoff (1a). Monitoring is the
//    critical path; the dashboard is convenience.
//  • Durability: rotated on-volume snapshots (1b) guard against corruption, and a
//    "previously-initialized" latch keeps an empty datastore (a lost volume) from
//    silently re-seeding stale baselines — it restores the newest backup if one
//    exists, else refuses and pages the operator.
//  • Crash guards (2e) keep a stray rejection from killing the process.
//
// Env: BEACON_DB_URL (default file:/data/beacon.db), DISCORD_WEBHOOK_URL,
// HEALTHCHECK_URL, BEACON_DRY_RUN=1, BEACON_DATA_DIR (legacy JSON location),
// BEACON_FORCE_SEED=1 (re-seed even when previously initialized),
// BEACON_BACKUP_INTERVAL_H (default 6; 0 disables), and toggles
// BEACON_SEED_ONLY / BEACON_NO_WORKER / BEACON_NO_WEB.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openStore, restoreLatest, snapshot, type BeaconStore } from "@beacon/db";
import { DiscordChannel, type NotificationChannel } from "@beacon/notify";
import { startLoop } from "@beacon/worker";
import { runImport } from "@beacon/migrate";

process.on("unhandledRejection", (reason) => {
  console.error(`[serve] unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[serve] uncaughtException: ${err.stack ?? err.message}`);
});

// Repo root resolved from THIS file (apps/server/src/serve.ts -> ../../..), not
// from process.cwd() — Railway runs the launcher with cwd = the package dir, so
// cwd would miss the legacy JSON seed files that live at the repo root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const dbUrl = process.env["BEACON_DB_URL"] ?? "file:/data/beacon.db";
const dbAuthToken = process.env["BEACON_DB_AUTH_TOKEN"];
const dataDir = process.env["BEACON_DATA_DIR"] ?? repoRoot;
const seedOnly = process.env["BEACON_SEED_ONLY"] === "1";
const noWorker = process.env["BEACON_NO_WORKER"] === "1";
const noWeb = process.env["BEACON_NO_WEB"] === "1";
const forceSeed = process.env["BEACON_FORCE_SEED"] === "1";
const backupIntervalH = Number(process.env["BEACON_BACKUP_INTERVAL_H"] ?? "6");

const channel: NotificationChannel | undefined = process.env["DISCORD_WEBHOOK_URL"]
  ? new DiscordChannel(process.env["DISCORD_WEBHOOK_URL"])
  : undefined;

async function page(title: string, note: string): Promise<void> {
  if (!channel) return;
  try {
    await channel.send("Beacon worker", { type: "site_error", product: { title, url: "", note } });
  } catch {
    /* best-effort */
  }
}

let store: BeaconStore = await openStore({ url: dbUrl, authToken: dbAuthToken });

// ── First-boot / recovery handling (1b) ──────────────────────────────────────
async function seedFromLegacyJson(): Promise<void> {
  console.warn(`[serve] Seeding from legacy JSON in ${dataDir}.`);
  try {
    const summary = await runImport(store, dataDir, { reset: false });
    console.log(`[serve] Seeded: ${JSON.stringify(summary)}`);
    if (summary.sitesFailed.length > 0) {
      console.error(`[serve] WARNING — ${summary.sitesFailed.length} site(s) FAILED to seed: ${JSON.stringify(summary.sitesFailed)}`);
    }
  } catch (err) {
    console.error(`[serve] Seed failed (continuing): ${(err as Error).message}`);
  }
}

const existing = await store.sites.list();
if (existing.length > 0) {
  console.log(`[serve] Datastore already has ${existing.length} site(s) — skipping seed.`);
  if (!(await store.meta.get("initialized"))) await store.meta.set("initialized", new Date().toISOString());
} else {
  const initialized = await store.meta.get("initialized");
  if (initialized && !forceSeed) {
    // Empty but previously initialized → the volume was likely lost. Do NOT
    // silently re-seed stale baselines (that floods Discord with false "new
    // product" alerts). Try to restore the newest snapshot; else refuse + page.
    console.error(`[serve] Datastore is EMPTY but was initialized at ${initialized} — volume likely lost. Attempting restore from backups…`);
    store.close();
    let restored: string | null = null;
    try {
      restored = await restoreLatest(dbUrl);
    } catch (err) {
      console.error(`[serve] Restore attempt failed: ${(err as Error).message}`);
    }
    store = await openStore({ url: dbUrl, authToken: dbAuthToken });
    const afterRestore = await store.sites.list();
    if (restored && afterRestore.length > 0) {
      console.log(`[serve] Restored ${afterRestore.length} site(s) from ${restored}.`);
      await page("Datastore restored from backup", `The volume looked lost (empty DB) but a backup was found and restored (${afterRestore.length} sites). Verify recent state/history.`);
    } else {
      console.error(`[serve] No usable backup found — REFUSING to auto-seed stale baselines. Running with no sites until you intervene (set BEACON_FORCE_SEED=1 to re-seed from JSON).`);
      await page("Datastore empty — manual action needed", "The DB is empty but was previously initialized (volume likely lost) and no backup was found. Refusing to auto-seed stale baselines to avoid a false-alert flood. Set BEACON_FORCE_SEED=1 to re-seed from the committed JSON, or restore a backup.");
    }
  } else {
    // Genuine first boot (or an explicit forced re-seed).
    console.warn(`[serve] Datastore is EMPTY${forceSeed ? " (BEACON_FORCE_SEED=1)" : " — first boot"}.`);
    await seedFromLegacyJson();
    if ((await store.sites.list()).length > 0) await store.meta.set("initialized", new Date().toISOString());
  }
}

if (seedOnly) {
  store.close();
  process.exit(0);
}

// ── Rotated on-volume backups (1b) ────────────────────────────────────────────
// Guards against corruption / bad writes. NOTE: same-volume snapshots do NOT
// survive a lost volume — that's what the seed-guard above is for, and an
// off-box upload is the future hook. No-op for Turso / :memory:.
if (backupIntervalH > 0) {
  const runBackup = async (): Promise<void> => {
    try {
      const path = await snapshot(store.client, dbUrl);
      if (path) console.log(`[serve] DB snapshot written: ${path}`);
    } catch (err) {
      console.error(`[serve] Backup failed (continuing): ${(err as Error).message}`);
    }
  };
  void runBackup(); // one at boot so a backup exists before the next interval
  setInterval(() => void runBackup(), backupIntervalH * 3_600_000).unref();
}

// ── Worker loop in-process (shares the same file DB as the web server) ─────────
if (!noWorker) {
  void startLoop(
    {
      store,
      channel,
      dryRun: process.env["BEACON_DRY_RUN"] === "1",
      log: (m) => console.log(`[worker] ${m}`),
    },
    { healthcheckUrl: process.env["HEALTHCHECK_URL"] },
  );
  console.log(`[serve] Worker loop started${process.env["BEACON_DRY_RUN"] === "1" ? " (DRY RUN)" : ""}.`);
}

// ── Web (Next.js) as a SUPERVISED child on $PORT (1a) ─────────────────────────
// A web crash must never take the worker down. Restart with capped backoff; a
// stable run resets the backoff. The parent never exits on a web exit.
if (!noWeb) {
  let webBackoffMs = 1_000;
  let webRestarts = 0;

  const startWeb = (): void => {
    const startedAt = Date.now();
    const web = spawn("pnpm", ["--filter", "@beacon/web", "start"], {
      stdio: "inherit",
      env: { ...process.env, BEACON_DB_URL: dbUrl },
    });
    web.on("error", (err) => console.error(`[serve] web spawn error: ${err.message}`));
    web.on("exit", (code, signal) => {
      const uptimeMs = Date.now() - startedAt;
      if (uptimeMs > 60_000) webBackoffMs = 1_000; // a stable run clears the backoff
      webRestarts += 1;
      const delay = webBackoffMs;
      webBackoffMs = Math.min(webBackoffMs * 2, 60_000);
      console.error(
        `[serve] web exited (code=${code}, signal=${signal}) after ${Math.round(uptimeMs / 1000)}s — ` +
          `restarting in ${delay}ms (restart #${webRestarts}). Worker is unaffected.`,
      );
      if (webRestarts === 5) {
        void page("Dashboard crash-looping", "The web dashboard has restarted 5+ times. Monitoring (the worker) is unaffected and still running — but the dashboard may be down.");
      }
      setTimeout(startWeb, delay).unref();
    });
  };

  startWeb();
  console.log("[serve] Dashboard starting (supervised)…");
} else {
  console.log("[serve] Web disabled (BEACON_NO_WEB=1).");
}
