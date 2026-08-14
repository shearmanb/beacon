# Beacon v2 — TODO / Backlog

Consolidated after the v2 rebuild + cutover (2026-06-22). **This supersedes the
legacy v1 backlog** in `CLAUDE.md` (most of which is now done or obsolete).

Each item tags rough **impact** so we can decide with the lean-by-default rule in
mind: size `XS/S/M/L` (code volume) · whether it adds **deps** · **risk**.
"On-demand" = don't build on spec; build when a real need forces it.

---

## Daily review findings (2026-08-14) — evidence from `analytics/alert_history.jsonl`

Nothing shipped this session; these are the ranked findings from a full-app
review. Reference tags match the review reply.

**Live noise / broken things (act first)**
- [ ] **1a Unicorn weekly-rollover flood.** Lot ids are per-auction, so the
      Sunday rollover re-alerts the whole matched roster: **90 Discord pings
      since Aug 5, only 46 distinct bottles, one bottle sent 26×** (Aug 10 alone:
      75 pings). Fix = title-normalized `recentlySeen` memory (the site-side
      guard already exists in `process-site.ts`) + in-scan title dedup + a
      "N matches" digest embed over ~10. Also makes per-lot **ignore** work
      across auctions — today an ignored id is forgotten next week. _S, no deps._
- [ ] **1b `sharedpour_browser` twin is dead and paging.** 362 consecutive
      **HTTP 402** (Browserbase billing) as of Aug 13, one `site_error` page per
      day, and it pollutes the host rollup + systemic detection for sharedpour.com.
      Disable the site or gate the twin on a live Browserbase quota. _XS._
- [ ] **1c A permanently-broken site poisons the aggregate signals.** `cgf`
      (ReserveBar 404) reached **458 consecutive failures** and caused most of the
      `system_degraded` pages (`SYSTEMIC_MIN_SITES=2`: one dead site + one
      transient = "all sites failing"). Need a quarantine: after N days of
      identical failure, auto-disable (or exclude from systemic/host rollups) with
      one page. _S._
- [ ] **1d Four overlapping sharedpour.com checkers.** `t8ke`, `t8ke_all`,
      `reveries`, `provenance` alerted the same "Eleventh Hour" drop 4× on Aug 7
      and quadruple the request load on the host that blocks us. Collapse to one
      root checker with keyword groups, or dedupe alerts per host+handle. _M._

**Structural**
- [ ] **1e `serve.ts` one-time amendments (7 blocks, ~230 lines).** Two of them
      (`sharedpour_provenance`, `sharedpour_browser`) are guarded by "does the
      site exist" — deleting the site on the dashboard **resurrects it on the next
      deploy**. Move all of them behind `meta` flags (the cadence block already
      does this) and delete the applied ones. _XS–S._
- [ ] **1f Fee math duplicated 3×** (`core/unicorn.ts` + `UnicornLots.tsx` +
      `UnicornBottles.tsx`). Export one shared client-safe helper. _XS._
- [ ] **1g Docs drift.** The browser tier / Browserbase, `/api/ops/*`, and the
      Jul 28 observability batch are in the code but not in the CLAUDE.md v2
      section or REBUILD.md. _XS._
- [ ] **1h Auth secret defaults to `"beam"`** (public in git history) when
      neither `BEACON_AUTH_SECRET` nor `BEACON_DASH_PASSWORD` is set, and the
      cookie is a fixed HMAC with no expiry/rotation. Confirm the env var is set
      in prod; consider refusing to boot on the default. _XS._

---

## SharedPour bot-block incident (2026-07-02)

`sharedpour_reveries` (and by extension every checker on sharedpour.com) started
failing while the store loads fine in a browser — Shopify/WAF bot protection now
403s datacenter IPs (Railway included). **Shipped this session**: `shopify_rest`
`storefrontFallback` (REST blocked → Storefront GraphQL on `*.myshopify.com`,
auto-recovering), 430 added to the circuit-breaker statuses, identity re-roll on
repeated blocks, and dashboard failure diagnostics (HTTP status, cooldown
countdown, ⛑ fallback chip, "looks like bot protection" hint). Second batch
(same day): **`self_healed` alert** (Discord + history, fires once per
engage/recover transition with the why in `fetchViaReason`) and the per-tile
**🩺 Diagnose** button (`core/diagnose.ts`) that tests REST → fresh identity →
Storefront fallback from the server's own IP and verdicts "Railway blocked?"
in plain English. Follow-ups:

- **Delete the one-time `serve.ts` amendment** (SharedPour fallback injection)
  once the prod logs show `[serve] Amended sharedpour_…` (or the ⛑ chip appears).
  Size XS · no deps · no risk.
- **Watch the fallback in prod.** If the Storefront API is *also* blocked from
  Railway, the remaining lever is a residential/rotating egress proxy (adds a
  paid dep — on-demand only) or moving the checker cadence way down. Decide only
  on evidence.
- ~~Host-level block detection~~ ✅ Done (2026-07-03) — site_error pages now
  carry a host rollup note when 2+ checkers on one host fail together.
- ~~Dashboard "edit source JSON" action~~ ✅ Done (2026-07-03) — ⚙ source editor
  on every tile (`updateSiteSource`, Zod-validated, re-baselines on change).

### Mitigation/prevention batch (2026-07-03) — shipped

- **1a Channel preference**: after 3 consecutive fallback checks, the Storefront
  API becomes the preferred channel (`preferFallback` in state, "(preferred)" on
  the ⛑ chip); REST re-probed every 12h, flips back automatically + pings.
- **1b Adaptive backoff**: cooldown ladder extended 5→15→60→**180 min**.
- **2a Preventive token harvest**: un-armed `shopify_rest` sites get one
  homepage fetch/day (`apps/worker/harvest.ts`) to extract + VERIFY their public
  Storefront token from page source; on success the secret is stored, the
  fallback armed, and a 🛡 self_healed ping explains it.
- **2b (lean)** blocked alerts suggest the Railway-redeploy IP-rotation trick.
  Full Railway-API automation stays parked (adds token + moving part).
- **2c Alert enrichment**: every site_error carries a "What to check" list and
  an auto-run 🩺 diagnosis verdict (3b); system_degraded too.
- **3a**: dashboard nags (amber banner) while `HEALTHCHECK_URL` is unset —
  the actual healthchecks.io check is still a **5-min manual setup: DO IT**.
- **Parked deliberately**: 1c TLS-fingerprint spoofing (headless browser /
  curl-impersonate — heavy dep, unnecessary while the token-API path works);
  4a off-box backups (operator: low priority).

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
