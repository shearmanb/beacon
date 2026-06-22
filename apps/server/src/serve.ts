// Combined single-process launcher for a one-service deploy (Railway): the
// worker loop runs in-process and the Next.js dashboard runs as a child, both
// sharing ONE libSQL file on a mounted volume. This is what lets Beacon v2 run
// on Railway alone — no separate database service, no new accounts. (For a
// split worker/web topology, use a network DB like Turso instead.)
//
// On first boot, if the datastore has no sites, it auto-seeds from the legacy
// JSON files baked into the image (config.json/state.json/...), preserving the
// product baselines.
//
// Env: BEACON_DB_URL (default file:/data/beacon.db), DISCORD_WEBHOOK_URL,
// HEALTHCHECK_URL, BEACON_DRY_RUN=1, BEACON_DATA_DIR (legacy JSON location),
// and toggles BEACON_SEED_ONLY / BEACON_NO_WORKER / BEACON_NO_WEB.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openStore } from "@beacon/db";
import { DiscordChannel } from "@beacon/notify";
import { startLoop } from "@beacon/worker";
import { runImport } from "@beacon/migrate";

// Repo root resolved from THIS file (apps/server/src/serve.ts -> ../../..), not
// from process.cwd() — Railway runs the launcher with cwd = the package dir, so
// cwd would miss the legacy JSON seed files that live at the repo root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const dbUrl = process.env["BEACON_DB_URL"] ?? "file:/data/beacon.db";
const dataDir = process.env["BEACON_DATA_DIR"] ?? repoRoot;
const seedOnly = process.env["BEACON_SEED_ONLY"] === "1";
const noWorker = process.env["BEACON_NO_WORKER"] === "1";
const noWeb = process.env["BEACON_NO_WEB"] === "1";

const store = await openStore({ url: dbUrl, authToken: process.env["BEACON_DB_AUTH_TOKEN"] });

// Auto-seed on first boot (only when the datastore is empty).
const existing = await store.sites.list();
if (existing.length === 0) {
  console.log(`[serve] Empty datastore — seeding from legacy JSON in ${dataDir}…`);
  try {
    const summary = await runImport(store, dataDir, { reset: false });
    console.log(`[serve] Seeded: ${JSON.stringify(summary)}`);
  } catch (err) {
    console.error(`[serve] Seed failed (continuing): ${(err as Error).message}`);
  }
} else {
  console.log(`[serve] Datastore already has ${existing.length} site(s) — skipping seed.`);
}

if (seedOnly) {
  store.close();
  process.exit(0);
}

// Worker loop in-process — shares the same file DB as the web server.
if (!noWorker) {
  const channel = process.env["DISCORD_WEBHOOK_URL"]
    ? new DiscordChannel(process.env["DISCORD_WEBHOOK_URL"])
    : undefined;
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

// Web (Next.js) as a child on $PORT, sharing the same DB file.
if (!noWeb) {
  const web = spawn("pnpm", ["--filter", "@beacon/web", "start"], {
    stdio: "inherit",
    env: { ...process.env, BEACON_DB_URL: dbUrl },
  });
  web.on("exit", (code) => {
    console.error(`[serve] web process exited (${code}) — shutting down service.`);
    process.exit(code ?? 1);
  });
  console.log("[serve] Dashboard starting…");
} else {
  console.log("[serve] Web disabled (BEACON_NO_WEB=1).");
}
