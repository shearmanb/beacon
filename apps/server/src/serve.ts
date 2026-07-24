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

// ── One-time config amendments (idempotent, safe to delete once applied) ──────
// 2026-07: sharedpour.com's bot protection started 403-ing datacenter IPs,
// killing the REST checkers while the store loads fine in a browser. Give the
// SharedPour shopify_rest sites the Storefront-API fallback (the adapter fails
// over to the token-authenticated GraphQL channel on the canonical myshopify
// domain when REST is blocked). No-ops on every boot after the first.
{
  const FALLBACK = { domain: "shared-pour.myshopify.com", accessTokenRef: "reveries_official_storefront_token" };
  try {
    const secrets = await store.secrets.all();
    if (secrets[FALLBACK.accessTokenRef]) {
      for (const row of await store.sites.list()) {
        const src = row.definition.source as Record<string, unknown>;
        if (src["kind"] !== "shopify_rest" || src["storefrontFallback"]) continue;
        if (new URL(String(src["baseUrl"] ?? "")).hostname.replace(/^www\./, "") !== "sharedpour.com") continue;
        await store.sites.upsert({ ...row.definition, source: { ...src, storefrontFallback: FALLBACK } });
        console.log(`[serve] Amended ${row.id}: added Storefront-API fallback for blocked REST.`);
      }
    } else {
      console.warn(`[serve] Skipping SharedPour fallback amendment — secret "${FALLBACK.accessTokenRef}" not found.`);
    }
  } catch (err) {
    console.error(`[serve] Config amendment failed (continuing): ${(err as Error).message}`);
  }
}

// ── One-time config amendment: dedicated SharedPour "Provenance" watcher ──────
// 2026-07: the sharedpour_t8ke tile is scoped to the /collections/t8ke JSON, so
// its title keywords only narrow THAT collection. A "Provenance" keyword there
// matches nothing — Provenance bottles live in the general catalog, not the T8KE
// collection (store search finds them; the collection JSON doesn't). Add a
// separate store-root watcher that title-filters the whole catalog for
// "Provenance" (same shape as sharedpour_reveries). Idempotent: creates the site
// only once, and only when the Storefront token exists (sharedpour.com 403s
// datacenter IPs, so the token-authed fallback is what actually carries it).
// Safe to delete once confirmed applied in prod.
{
  const PROVENANCE_ID = "sharedpour_provenance";
  const TOKEN_REF = "reveries_official_storefront_token";
  try {
    if (!(await store.sites.get(PROVENANCE_ID))) {
      const secrets = await store.secrets.all();
      if (secrets[TOKEN_REF]) {
        await store.sites.upsert({
          id: PROVENANCE_ID,
          name: "SharedPour Provenance",
          enabled: true,
          schedule: "working_hours_heavy",
          intervalMinutes: 20,
          alerts: { onNew: true, onRestock: true, onSoldOut: true },
          filters: { titleContains: ["Provenance"] },
          source: {
            kind: "shopify_rest",
            baseUrl: "https://sharedpour.com",
            storefrontFallback: { domain: "shared-pour.myshopify.com", accessTokenRef: TOKEN_REF },
          },
        });
        console.log(`[serve] Added ${PROVENANCE_ID}: store-root SharedPour watcher for "Provenance" titles.`);
      } else {
        console.warn(`[serve] Skipping ${PROVENANCE_ID} amendment — secret "${TOKEN_REF}" not found.`);
      }
    }
  } catch (err) {
    console.error(`[serve] Provenance amendment failed (continuing): ${(err as Error).message}`);
  }
}

// ── One-time config amendment: silence reveries_site_status content-change noise ─
// 2026-07: thereveries.co/shop (Squarespace) rotates a same-length token the page
// fingerprint can't strip, so `watchContentChange` fires "content changed" on pure
// noise (≈61319→61319 chars). The signals that matter — the coming-soon/password
// wall going UP (site_reset) and LIFTING (site_changed) — don't use the content
// hash, so turn the generic net off. Idempotent (only acts while it's still on).
// Safe to delete once confirmed applied in prod.
{
  try {
    const row = await store.sites.get("reveries_site_status");
    const src = row?.definition.source as Record<string, unknown> | undefined;
    if (row && src?.["kind"] === "http_status" && src["watchContentChange"] !== false) {
      await store.sites.upsert({ ...row.definition, source: { ...src, watchContentChange: false } });
      console.log("[serve] Amended reveries_site_status: watchContentChange off (same-length token noise).");
    }
  } catch (err) {
    console.error(`[serve] reveries_site_status amendment failed (continuing): ${(err as Error).message}`);
  }
}

// ── One-time config amendment: reveries_official self-healing embed watch (R2) ──
// 2026-07: thereveries.co/shop stopped embedding a collection — its Buy Button now
// embeds a single PRODUCT (id 9001382805659), so the old collection query
// (367215214747) returns 0 forever and nags. Point it at the product AND turn on
// `discoverEmbedFrom` so the adapter re-reads the live ShopifyBuyInit embed off the
// shop page each check — following the shop when it swaps product/collection again.
// Clears state so the current (leftover) bottle re-baselines silently instead of
// firing a false "new drop". Idempotent (acts only until discovery is configured).
{
  try {
    const row = await store.sites.get("reveries_official");
    const src = row?.definition.source as Record<string, unknown> | undefined;
    if (row && src?.["kind"] === "shopify_graphql" && !src["discoverEmbedFrom"]) {
      await store.sites.upsert({
        ...row.definition,
        source: { ...src, productId: "9001382805659", discoverEmbedFrom: "https://www.thereveries.co/shop" },
      });
      await store.state.clear("reveries_official");
      console.log("[serve] Amended reveries_official: product-embed watch + self-healing id discovery (re-baselined).");
    }
  } catch (err) {
    console.error(`[serve] reveries_official amendment failed (continuing): ${(err as Error).message}`);
  }
}

// ── One-time config amendment: scope bourbon_concierge to its Reveries collection ─
// 2026-07: thebourbonconcierge.com's checker scanned the WHOLE catalog (8+ pages
// of 250) just to keyword-filter for "Reveries", and the host tar-pits the scan
// pages deep (stalls on ~page 8) while a small probe passes. The store has a
// dedicated /collections/reveries (~9 products) — scope the source to it so a
// check is ONE request. Keyword filters still apply after fetch, unchanged.
// Clears state so the next check re-baselines quietly and the stuck error/
// cooldown bookkeeping is dropped. Idempotent (acts only while collectionPath is
// unset). Safe to delete once confirmed applied in prod.
{
  try {
    const row = await store.sites.get("bourbon_concierge");
    const src = row?.definition.source as Record<string, unknown> | undefined;
    if (row && src?.["kind"] === "shopify_rest" && !src["collectionPath"]) {
      await store.sites.upsert({ ...row.definition, source: { ...src, collectionPath: "/collections/reveries" } });
      await store.state.clear("bourbon_concierge");
      console.log("[serve] Amended bourbon_concierge: scoped to /collections/reveries (was a full-catalog scan) — re-baselined.");
    }
  } catch (err) {
    console.error(`[serve] bourbon_concierge amendment failed (continuing): ${(err as Error).message}`);
  }
}

// ── One-time config amendment: data-tuned cadences (drop_windows / bar_evening) ─
// 2026-07-16: mined the full alert history (v1 git archaeology + the v2 export,
// May 17 → Jul 15, 49 deduped posting events): 47% of all bottle postings land
// 11:00–13:00 ET, a Reveries-heavy evening window runs 17:00–20:00 with a small
// 20:00–22:00 tail, and NOTHING has ever posted 22:00–08:00. Fountain Inn (a
// bar) posts exclusively 15:24–19:39 ET. Two shared archetypes replace the
// blanket working_hours_heavy: retailers get drop_windows; the bar gets
// bar_evening (its old catch-all crawled overnight at 20 min for zero observed
// postings). Guarded by a meta flag — runs ONCE, so later manual dashboard
// schedule edits are never overridden by a redeploy. Safe to delete once
// confirmed applied in prod.
{
  const FLAG = "amendment_cadence_20260716";
  try {
    if (!(await store.meta.get(FLAG))) {
      await store.schedules.upsert("drop_windows", {
        label: "📊 Drop Windows (data-tuned)",
        rules: [
          { fromHour: 9, toHour: 13, interval: 5 },
          { fromHour: 17, toHour: 20, interval: 5 },
          { fromHour: 8, toHour: 9, interval: 15 },
          { fromHour: 13, toHour: 17, interval: 15 },
          { fromHour: 20, toHour: 22, interval: 15 },
          { fromHour: 22, toHour: 8, interval: 120 },
          { defaultInterval: 120 },
        ],
      });
      await store.schedules.upsert("bar_evening", {
        label: "🍸 Bar Evening (data-tuned)",
        rules: [
          { fromHour: 15, toHour: 20, interval: 5 },
          { fromHour: 12, toHour: 15, interval: 15 },
          { fromHour: 20, toHour: 22, interval: 15 },
          { fromHour: 22, toHour: 12, interval: 120 },
          { defaultInterval: 120 },
        ],
      });
      const assign: Record<string, string> = {
        sharedpour_t8ke: "drop_windows",
        sharedpour_t8ke_all: "drop_windows",
        sharedpour_reveries: "drop_windows",
        sharedpour_provenance: "drop_windows",
        bourbon_concierge: "drop_windows",
        fountain_inn_dc: "bar_evening",
      };
      for (const [id, schedule] of Object.entries(assign)) {
        const row = await store.sites.get(id);
        if (!row) continue; // site absent in this datastore — skip quietly
        await store.sites.upsert({ ...row.definition, schedule });
        console.log(`[serve] Amended ${id}: schedule → ${schedule}.`);
      }
      await store.meta.set(FLAG, new Date().toISOString());
      console.log("[serve] Cadence amendment applied (drop_windows / bar_evening).");
    }
  } catch (err) {
    console.error(`[serve] Cadence amendment failed (continuing): ${(err as Error).message}`);
  }
}

// ── One-time config amendment: SharedPour real-browser TWIN (2026-07-24) ─────
// The decisive experiment for the browser tier: a `browser`-kind checker that
// opens sharedpour.com in a REAL Chromium (Browserbase session, persistent
// profile) and reads the roster via the page's own fetch — from the server's
// egress, through a real browser. Runs as a quiet twin next to the live
// REST/Storefront checkers: hourly (Browserbase free-tier friendly), ALL
// product alerts off — its job is to prove/compare, not to page. Promotion to
// a live alerting tier happens only after its roster matches for several days.
// Self-arming: created only once the Browserbase API key exists on the service
// (the project id resolves automatically from the key — no PROJECT_ID var
// needed); until then this block no-ops with a log line. Safe to delete once
// promoted.
{
  const TWIN_ID = "sharedpour_browser";
  try {
    if (!process.env["BROWSERBASE_API_KEY"]) {
      console.log(`[serve] Browser twin not armed — set BROWSERBASE_API_KEY to create ${TWIN_ID}.`);
    } else if (!(await store.sites.get(TWIN_ID))) {
      await store.sites.upsert({
        id: TWIN_ID,
        name: "SharedPour (browser twin)",
        enabled: true,
        schedule: "60",
        intervalMinutes: 60,
        alerts: { onNew: false, onRestock: false, onSoldOut: false, onSiteReset: false },
        filters: { titleContains: ["Reveries"] },
        source: { kind: "browser", baseUrl: "https://sharedpour.com", extract: "page_json", maxPages: 3 },
      });
      console.log(`[serve] Added ${TWIN_ID}: real-browser twin for sharedpour.com (hourly, alerts off).`);
    }
  } catch (err) {
    console.error(`[serve] Browser-twin amendment failed (continuing): ${(err as Error).message}`);
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
  // Never fire-and-forget the loop (2026-07-22): a dropped rejection here left
  // the dashboard quietly serving with a DEAD worker — the worst failure mode a
  // monitor has. If the loop ever dies, exit non-zero so Railway's ON_FAILURE
  // policy restarts the whole service and checks resume on their own. (A hung —
  // not dead — loop is covered by the wedge watchdog inside startLoop.)
  startLoop(
    {
      store,
      channel,
      dryRun: process.env["BEACON_DRY_RUN"] === "1",
      log: (m) => console.log(`[worker] ${m}`),
    },
    { healthcheckUrl: process.env["HEALTHCHECK_URL"] },
  ).catch((err: unknown) => {
    console.error(
      `[serve] Worker loop died: ${err instanceof Error ? err.stack ?? err.message : String(err)} — exiting for a platform restart.`,
    );
    process.exit(1);
  });
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
