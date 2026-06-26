# Beacon v2 — TODO / Backlog

Consolidated after the v2 rebuild + cutover (2026-06-22). **This supersedes the
legacy v1 backlog** in `CLAUDE.md` (most of which is now done or obsolete).

Each item tags rough **impact** so we can decide with the lean-by-default rule in
mind: size `XS/S/M/L` (code volume) · whether it adds **deps** · **risk**.
"On-demand" = don't build on spec; build when a real need forces it.

---

## Review follow-ups (2026-06-25)

Big reliability / self-healing batch from the code+feature review. **Shipped this
session** (all typechecked, 148 tests green):

- **1a/2a — web/worker isolation.** `serve.ts` now SUPERVISES the Next.js child
  (backoff restart, pages on crash-loop); a web crash never takes the worker
  down. (Scale-out path = split services on Turso — see REBUILD.md.)
- **1b/2b — datastore durability.** Rotated on-volume `VACUUM INTO` snapshots
  (`packages/db/backup.ts`) + restore; a `meta.initialized` latch refuses to
  auto-seed stale baselines when the DB is empty-but-initialized (volume loss),
  auto-restores the newest backup if present, else pages. New env:
  `BEACON_FORCE_SEED`, `BEACON_BACKUP_INTERVAL_H`.
- **2c — bounded work.** `shopify_rest` `MAX_PAGES` cap + a per-site `AbortSignal`
  wall-clock budget (45s) threaded via `AdapterDeps.signal`.
- **2d — systemic-failure detection.** All-sites-failing pass → ONE
  `system_degraded` page, per-site error spam suppressed.
- **2e — crash guards + heartbeat.** `unhandledRejection`/`uncaughtException`
  handlers (worker + serve); per-loop heartbeat in `meta`, surfaced on the
  dashboard worker banner.
- **2g/2h — header coherence.** `document` vs `api` request kinds (JSON endpoints
  no longer send navigation headers); context-aware `Sec-Fetch-Site` + `Referer`.
- **2i — identity persistence.** `host_identities` table; identities rehydrate on
  boot and flush periodically (no more fresh-browser-per-restart from one IP).
- **3a — structure-drift guard.** Yield ≪ baseline → preserve products + once-daily
  `site_changed` ping (catches a broken parser returning garbage, not just 0).
- **3d — quiet-site canary.** `lastAlertAt` tracked; dashboard "💤 quiet" chip.
  (Surface-only by design — no Discord ping, to avoid alert fatigue.)
- **3e — daily re-page** on a stuck `site_error` (mirrors the empty-guard).
- **3f — defensive `state.load`** (corrupt blob → re-baseline, never crash).
- **4b — signed auth cookie** (HMAC; kills the forgeable `beacon_auth=1`). New env
  `BEACON_AUTH_SECRET` (falls back to `BEACON_DASH_PASSWORD`).
- **4d — shared `sourceUrl()`** helper (de-duped across 4 files).
- Discord link-button omitted when an alert has no URL (system-level alerts).

### Deferred — Section 4 (weakest/sloppiest), for your review
- [ ] **4c — `history.count()` loads every row** to produce a number → use SQL
      `COUNT(*)`; and trim history NOT on every append (every Nth / time-based).
- [ ] **4e — `commands.drainPending()` is non-atomic** (select then N UPDATEs) →
      single `UPDATE … WHERE processed_at IS NULL` or a transaction.
- [ ] **4d (remaining) — `SiteState` is `[key:string]: unknown`.** The most
      bug-prone area gets no compiler help; consider a typed state interface.
- [x] **4f — unbounded pagination** → done via 2c page cap.

### Deferred — Section 5 (efficiency, no feature loss), for your review
- [ ] **5a** — `history.count()` → `COUNT(*)` (same as 4c).
- [ ] **5b** — trim alert_history periodically, not every append.
- [ ] **5c** — `runOnce` loads `sites.list()` twice + per-site `state.load`;
      bulk-load states / collapse the list calls.
- [ ] **5d** — `drainPending` as a single statement (also fixes 4e).
- [ ] **5e** — strip unused `tags` (and maybe `image`) from the persisted state
      blob (~30% of size); verify the Products table doesn't render tags first.
- [ ] **5f** — split hot (`lastChecked`/`checkHistory`) from cold (`products`)
      writes; only re-serialize the product map when it actually changed.

### Also deferred (from this batch)
- [ ] **1b Layer 2 — off-box backup.** On-volume snapshots guard corruption but
      NOT volume loss. Wire an off-box upload (GitHub commit or Turso) behind the
      existing backup hook so a lost volume is fully recoverable. _Impact: S–M._
- [ ] **2f — proxy tier.** Header polish (2g/2h/2i) does NOT beat datacenter-IP
      reputation (Campari/Total Wine/Costco). Residential/mobile proxy is the only
      real fix for the hard tier — its own deliberate project (real $ + upkeep).

---

## ✅ Done this session (rebuild + cutover)
- TS monorepo; declarative engine (all 4 legacy strategies → config + adapters);
  libSQL/Turso datastore; Discord notify; worker runtime; migration importer;
  Next.js dashboard; one-service Railway deploy with auto-seed; 118 tests + CI.
- Dashboard: sites + health dots, products table, alert history, reminders,
  per-site schedule dropdown, Schedules manager, activity timeline (PulseStrip),
  lightweight theme switcher (4 palettes), single-user auth.
- Cutover: live on Railway (one service + volume, no new accounts), old v1
  worker stopped, product baselines preserved (no alert flood).

---

## Near-term — dashboard completeness
- [x] **Add-site flow + Sandbox** ✅ (2026-06-23) — `/add` page + `AddSiteWizard`:
      probe a URL → auto-detect recipe (Shopify products.json / Squarespace
      status monitor) → editable per-kind config → preview what the real adapter
      parses (reuses the engine + Zod) → save via `sites.upsert`. Probe lives in
      `@beacon/core` (`probeSite`); actions `probeSite`/`previewSite`/`addSite`.
- [ ] **Full site-config editing** — edit filters, alert flags, and source/URL
      from the UI, not just schedule/monitoring/imminent. _Impact: **M**, no deps
      (validate via existing Zod schema)._
- [ ] **System-Health panel** — per-site parse-success / error / block rates
      rolled up from checkHistory. _Impact: **S–M**._
- [x] **Schedules manager: day-of-week (`days`) rules** ✅ (2026-06-25) — Mon–Sun
      buttons per window row + the default rule in `SchedulesManager`; empty =
      every day, and the day scope renders in the rule chips.
- [x] **Reminder priority (★) toggle** ✅ (2026-06-23) — `setReminderPriority`
      action + a ★ control on each reminder.

## Reliability / self-healing (loop engineering)
- [x] **Structure-drift alerts** ✅ (2026-06-25) — `drift_guard.ts` (`assessYield`)
      tracks a yield baseline; an anomalously small fetch vs that baseline
      preserves products + pings `site_changed`, distinct from "legitimately empty."
- [ ] **Adaptive anti-bot** — `host_telemetry` table + a policy module that tunes
      cooldown/identity/jitter from per-host block rates. _Impact: **M**.
      On-demand (build when blocks actually appear)._
- [x] **SQLite concurrency hardening** ✅ (2026-06-23) — `openStore` sets
      `journal_mode=WAL` + `busy_timeout=5000` on `file:` DBs (no-op for Turso /
      `:memory:`), so the worker + web sharing one file don't hit "database is
      locked".
- [ ] **More notification channels** — email/SMS via the existing
      `NotificationChannel` interface (Discord stays primary). _Impact: **S** each
      (+1 dep per channel, e.g. an email SDK)._

## Flexibility / future
- [ ] **Declarative `html` adapter** — selector/JSON-LD recipe so simple HTML
      sites become config (today only `custom`/campari_v1 exists). _Impact: **M**.
      On-demand._
- [ ] **Total Wine & Costco** — phase 2; needs the headless-browser + (likely)
      residential-proxy tier. _Impact: **L** + real $ + upkeep. Set honest
      reliability expectations._
- [ ] **Products-as-rows analytics** — optional price-history / restock-frequency
      table (alert_history already covers most). _Impact: **M**. On-demand._
- [ ] **Cellar handoff** — a "send to Cellar" action pushing a spotted product to
      the Cellar API. _Impact: **S** once Cellar's endpoint is confirmed._

## Infra / housekeeping
- [ ] **Set up the dead-worker alarm (`HEALTHCHECK_URL`)** — R3 mitigation. The
      worker already pings `HEALTHCHECK_URL` after every loop (`apps/worker/src/loop.ts`,
      and skips the ping while the DB is down so a datastore failure also trips
      it) — it just needs the env var set. To finish: create a healthchecks.io
      check (Period 2m / Grace 5m; alert via email + optionally the Beacon Discord
      so the alarm reaches you independently of the dead worker), then set
      `HEALTHCHECK_URL` to its ping URL on the Railway `beacon` service. Until
      then there's no external "worker is dead" alert. _User-side, no code._
- [x] **Railway auto-deploy** ✅ (2026-06-24) — deploys on push to `main`;
      `railway.json` watchPatterns gate it to `apps/**`/`packages/**` + root
      manifests. (The stale-v1 watchPatterns that silently skipped deploys were
      the 2026-06-24 outage — now fixed.)
- [ ] **Auth hardening** — single-password cookie is fine for solo use; Cloudflare
      Access (Google login) is the real shared-machine fix. _Impact: **S** code +
      Cloudflare setup. (Carried from v1 backlog.)_
- [x] **Prune legacy v1** ✅ (2026-06-24) — deleted root
      `worker.js`/`lib/`/`sites/`/`notifiers/`/`docs/` (5,682 lines); full tree
      archived on the `legacy-v1` branch (`git show legacy-v1:worker.js`). JSON
      seed files kept (still the one-time DB bootstrap source).
- [ ] **Compiled prod build (optional)** — worker/launcher run via `tsx` (TS at
      runtime); a `dist` build + dual exports would be a tidier prod story.
      _Impact: **M**. Low priority — `tsx` works fine._
- [x] **CI: add `next build`** ✅ (2026-06-23) — the web job now runs `next build`
      after the typecheck (was typecheck-only).

---

## Watch / known
- `reveries_official` (shopify_graphql) is **disabled** and shows a stale `404`
  ("collection: null" — the old R2 collection-ID staleness). Re-enable only after
  confirming the current Storefront collection ID in the shop's page source.
- Discord-on-ignore notice (a v1 nicety) was dropped; re-add only if wanted
  (_Impact: **XS**_).
