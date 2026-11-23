# Beacon — Rebuild (v2)

A ground-up rebuild of Beacon as a TypeScript monorepo — **now live on `main`**
(cutover 2026-06-22), deployed as one Railway service (`@beacon/server`). The
legacy v1 app was removed from `main` on 2026-06-24 and lives only on the
`legacy-v1` branch. Operational history (what shipped when, and why) is in
`CHANGELOG.md`; the backlog is `TODO.md`.

## Why

- **Adding a site is now data, not code.** Strategies collapsed into a generic
  pipeline driven by a declarative, Zod-validated `SiteDefinition`.
- **A real database (libSQL/Turso) replaces GitHub-as-DB** — no more per-loop
  commits, 409 merges, or corruption-flood risk.
- **A componentized Next.js dashboard** replaces the 3,278-line single file.

## Structure

```
packages/
  shared/   domain types + utils + schedule (ET windows/jitter) + diff
  fetch/    anti-bot HTTP layer (stable host identity, conditional GET/304,
            deadline, gzip/br, 429/503 retry) + httpPost
  core/     the engine: Zod SiteDefinition + discriminated source union,
            pipeline (normalize/filter/diff/empty-guard/signal), source adapters
            (shopify_rest, shopify_graphql, http_status, custom) + campari_v1
  db/       Drizzle (libSQL) schema + repositories + openStore() + VACUUM INTO
            snapshots
  notify/   NotificationChannel interface + DiscordChannel
apps/
  server/   the Railway entrypoint: seed/restore guard, config fixes
            (config-fixes.ts), in-process worker loop + supervised web child
  worker/   the loop: shouldCheck gate, circuit breaker, quiet mode, command
            drain, imminent auto-off, systemic/host rollups, quarantine,
            blind-time invariant, cross-site dedupe, plus daily side-jobs
            (token harvest, history mirror, off-box backup, Unicorn scan)
  web/      Next.js dashboard (Sites/Products/History/Schedules/Unicorn/…),
            single-user signed-cookie auth, /api/ops/* + /api/export/history
  migrate/  one-time legacy-JSON -> libSQL importer (+ CLI)
```

## Source recipes (adding a site = config)

| `source.kind`     | Replaces                     | Notes |
|-------------------|------------------------------|-------|
| `shopify_rest`    | `shopify_collection`         | paginated `/products.json`, single-page 304 |
| `shopify_graphql` | `shopify_storefront`         | Storefront API; token via secrets ref |
| `http_status`     | `site_status_monitor`        | page-state probe -> SiteSignal (once-only site_reset) |
| `custom`          | `purchasable_state_monitor`  | escape hatch; ships `campari_v1` |
| `html`            | —                            | declarative selector adapter (deferred; not yet needed) |

## Develop

```bash
pnpm install
pnpm test          # vitest
pnpm typecheck     # tsc -b (all packages + worker + migrate)
pnpm --filter @beacon/web build
```

## Run

```bash
# 1) migrate the legacy data into a libSQL DB (preserves product baselines)
pnpm --filter @beacon/migrate exec tsx src/cli.ts \
  --db file:beacon.db --data "$PWD" --reset

# 2) worker
BEACON_DB_URL=file:beacon.db DISCORD_WEBHOOK_URL=... \
  pnpm --filter @beacon/worker start

# 3) dashboard
BEACON_DB_URL=file:beacon.db pnpm --filter @beacon/web dev
```

Env (production runs `@beacon/server`, see `DEPLOY.md`):

| Var | Purpose |
|-----|---------|
| `BEACON_DB_URL`, `BEACON_DB_AUTH_TOKEN` | libSQL URL (`file:/data/beacon.db` in prod) / Turso token |
| `DISCORD_WEBHOOK_URL` | alert channel |
| `HEALTHCHECK_URL` | optional external dead-man ping each pass (healthchecks.io). Without it the floor is the GitHub Actions probe of `/api/health` (`.github/workflows/deadman.yml`) |
| `BEACON_DASH_PASSWORD` | dashboard login. **Required in production**: without it the dashboard refuses every login (no public default) |
| `BEACON_AUTH_SECRET` | optional cookie-signing key (defaults to the password); rotate to log out every session |
| `BEACON_OPS_TOKEN` | enables `Authorization: Bearer` access to `/api/ops/{status,errors}` for headless inspection |
| `GH_TOKEN`, `GH_REPO` | arm the daily history mirror + off-box backup to `analytics/` |
| `BEACON_BACKUP_INTERVAL_H` | on-volume snapshot cadence (default 6, 0 disables) |
| `BEACON_FORCE_SEED=1`, `BEACON_SEED_ONLY=1`, `BEACON_DATA_DIR` | seed-guard override / seed then exit / legacy JSON location |
| `BEACON_NO_WEB=1`, `BEACON_NO_WORKER=1` | run one half of the process only |
| `BEACON_DRY_RUN=1` | compute + log, send/persist nothing |

### Ops API (headless prod inspection)

`GET /api/health` is **public** (the only unauthenticated route): `{ok, workerHeartbeatAgeSec}`,
200 while the worker heartbeat is under 15 min old, 503 otherwise — the dead-man probe target.

`GET /api/ops/status` (worker heartbeat + per-site health summary, failure
timestamps) and `GET /api/ops/errors` (per-site error-log tail). Auth is
the dashboard cookie or the `BEACON_OPS_TOKEN` bearer. The product map never
leaves the box through these routes. `GET /api/export/history` (cookie only)
downloads the full alert history as JSONL.

## Subsystem reference (how it runs, in detail)

Moved here from `CLAUDE.md` on 2026-11-23 so every session doesn't load it;
`CLAUDE.md` keeps a one-line map of the same subsystems plus the standing rules.
Read the bullet for a subsystem before changing it, and its `CHANGELOG.md` entry
for the why.

- **Build/deploy** (`railway.json`): build `pnpm install --frozen-lockfile && pnpm typecheck && pnpm --filter @beacon/web build`; start `pnpm --filter @beacon/server start`. Auto-deploys on push to `main` for changes under `apps/**`, `packages/**`, `package.json`, `pnpm-lock.yaml`, `railway.json` (Railway `watchPatterns`, set in `railway.json` — these MUST track the v2 layout, not v1 paths).
- **Datastore**: SQLite (libSQL) at `file:/data/beacon.db` on a mounted Railway **Volume** — *not* GitHub. Selected by `BEACON_DB_URL`. On a genuinely-empty datastore, `apps/server/src/serve.ts` seeds once from the root legacy JSON; on an empty-but-previously-initialized datastore (volume loss) it **refuses to re-seed stale baselines** and restores the newest snapshot / pages instead (1b).
- **One process**: the worker loop runs in-process (the resilient parent) and the Next.js dashboard (`apps/web`) runs as a **supervised** child — a web crash is restarted with backoff and never takes the worker down (1a). Single-user **signed-cookie** auth (HMAC keyed by `BEACON_AUTH_SECRET` ?? `BEACON_DASH_PASSWORD` — the cookie is no longer a forgeable static flag, 4b).
- **Durability** (1b): rotated on-volume `VACUUM INTO` snapshots (`packages/db/src/backup.ts`); `BEACON_FORCE_SEED=1` overrides the seed-guard; `BEACON_BACKUP_INTERVAL_H` tunes cadence (default 6, 0 disables). *On-volume snapshots guard corruption, not volume loss — off-box upload is a future hook (`TODO.md`).*
- **Dead-man**: `GET /api/health` (public, data-free: 200 while the worker heartbeat is <15 min old, else 503) probed every 10 min by `.github/workflows/deadman.yml` (GitHub failure email; Discord too once the repo secret `DISCORD_WEBHOOK_URL` exists). `HEALTHCHECK_URL` (healthchecks.io) is the optional tighter layer — still unset in Railway as of 2026-10-23.
- **Systemic self-heal** (2026-11-20, `apps/worker/src/self-heal.ts`): a check that never reached the store (`failureKind` = `connect`) is retried once in-pass; a systemic page names its cause (control probe, `BEACON_CONTROL_URL`), is closed by an all-clear, and after 30 min of connect-only failure the worker redeploys itself via Railway's API (≤1/day, needs `RAILWAY_API_TOKEN`; never on blocks). State: `systemic_episode` meta blob.
- **Self-healing extras**: structure-drift guard (3a), per-loop heartbeat + `unhandledRejection`/`uncaughtException` guards (2e), systemic-failure detection → one `system_degraded` page (2d), per-site abort budget + `shopify_rest` page cap (2c), daily re-page on stuck errors (3e), defensive state reads (3f), kind-coherent request headers (2g/2h), and per-host browser identities persisted across restarts (2i).
- **Fetch channels**: `shopify_rest` sources may carry a `storefrontFallback` (`{ domain, accessTokenRef }`). When `products.json` is blocked (401/403/429/430/503) or tar-pits, the adapter fails over to the token-auth **Storefront GraphQL API** on the `*.myshopify.com` domain (newest-first, 8-page cap → `fallbackTruncated` tile hint). 3 fallback checks or 3 via-flips in 6 h pin the site to Storefront (`preferFallback`, REST re-probed every 12 h); pins propagate to armed siblings on the same host (`propagateHostPins`). Un-armed sites get a daily token **harvest** (`apps/worker/src/harvest.ts`). Each tile has 🩺 **Diagnose** (`packages/core/src/diagnose.ts`) and a ⚙ source JSON editor.
- **Alerting**: `baseline` and `self_healed` rows are history/dashboard-only — **never Discord**. A **deprecated** checker is a *shadow*: still checks, still records history, but is Discord-silent while an enabled non-deprecated checker covers the same host (`shadowSiteIds` in `run.ts`); the last live checker on a store always pages. Cross-site dedupe keys on the store (`storeOf` in `run.ts`), 60 min. >6 alerts from one site in one pass → one digest. `site_error` pages at 5 consecutive failures (3 inside a ≤15m window, 2 in imminent mode), with an auto-run 🩺 verdict, re-paged daily. A Discord send that fails is retried (twice inline, then from the `alert_outbox` meta blob every pass for 24 h) — never just logged. **Blind-time invariant** (`checkBlindTime`) pages a site that has gone too long without a successful check, whatever guard is holding it. **Quarantine** (`maybeQuarantine`) auto-disables a site failing identically (non-block) for ≥25 checks AND ≥72 h.
- **Cadence**: one shared schedule **`fast_hours`** (5m 08–15 & 17–20 ET, 8m 06–08 / 15–17 / 20–22, 60m overnight — mined from 127 drop events, none ever 22–06) on every live product checker except Russell's Reserve (flat 20m, Campari anti-bot); the older `drop_windows` / `bar_evening` rows remain selectable, plus per-site `<siteId>_window` (🕒 editor in the tile's ⚙ panel). Inside a ≤15m window at most 15 min of a breaker cooldown is honored. **Cadence loop** (`cadenceAdjust` in `@beacon/shared` `backoff.ts`, read-side, auto-reverting, the ONE function the worker and the dashboard both call): a block-like failure in the last 6 h stretches the interval ×1.5 (⏳); three answers far slower than the site's own median do the same (🐢, early tar-pit warning, from `checkHistory[].ms`); a site with `adaptiveFloorMinutes` runs ×0.8/×0.6 faster after 3/7 block-free days (🚀). Imminent mode = cooldown + back-off bypass at `imminentIntervalMinutes` (default `DEFAULT_IMMINENT_INTERVAL_MIN` = 2) for `imminentDurationMinutes` (default 20); the tile's ⚡ split control picks the duration per click. **One checker per host** (sharedpour.com = the Watchlist only). `sharedpour_channel` alone runs **`storefront_fast`** (2m peak / 4m shoulders): it is a Storefront-API call, no WAF — don't put a REST checker on it. `shopify_graphql` embed checkers (`reveries_official`, `t8ke_releases` = t8ke.com's purchase page, same shared-pour store) re-read their shop page only every `discoverEveryMinutes` (default 10; every check while imminent). **Auto-imminent** (`apps/worker/src/auto-imminent.ts`, groups in the `auto_imminent` meta blob): a new bottle / restock / lifted wall on one member of the Reveries group puts the group's shops on imminent for 20 min, ≤4×/day; an auto run (`imminentAutoMinutes` set) honors cooldowns and reverts without a Discord ping. **For current per-site cadence trust `/schedules` (the Cadence control panel) or the backup bundle — not this file.**
- **Analytics + off-box backup** (needs `GH_TOKEN` + `GH_REPO`): daily `[skip ci]` commits to `main` of `analytics/alert_history.jsonl` (mine with `git show origin/main:analytics/alert_history.jsonl`) and `analytics/backup/beacon-restore.json` (config + baselines, **never secrets**; `serve.ts` auto-restores from it on volume loss). Dashboard **Export** → `GET /api/export/history` (JSONL). The history file is over 1 MB: GitHub's contents API returns EMPTY content above that, so read it raw (`mirror.ts` does; never treat an empty read of a non-empty file as "no file"). **Detection lag**: `new_product` / `restock` rows carry `lagSec` + `lagBasis` in their payload (store's publish/update time → alert), shown in Discord and on `/history` — mine it before changing cadence.
- **Unicorn Auctions** (`apps/worker/src/unicorn.ts` + `packages/core/src/unicorn.ts`, page `/unicorn`): an isolated daily side job, not a pipeline site. All state lives in meta blobs `unicorn_config` / `unicorn_scan_state`. Bottles/terms/ignore list, all-in fee math, cross-auction `seenTitles` memory.
- **Reveries Registry links** (`apps/web/lib/registry.ts`): every Reveries bottle on the ✨ panel and /products links to its page on reveriesregistry.com when the registry has it (exact `#barrel` = `series`, or exact quoted name, never a group name — never a guess), else to the registry homepage. The dashboard server fetches the registry's static `data.js` ≤ every 12 h, in memory only, never evaluated; health in `/api/ops/status` → `reveriesRegistry`.
- **Dashboard stock display**: gated by `apps/web/lib/live.ts` (`rosterIsLive`, `walledHosts`/`behindWall`) + `apps/web/lib/stock.ts`. Frozen rosters render "not checked", walled hosts "🌊 behind wall"; neither counts as in stock.
- **Sites tile** (`apps/web/components/SiteTile.tsx`, 2026-10-30): one design, no density modes. Face = health dot · name · ⚡ split control (go imminent **every** N **for** N) · ONE status line (`lib/tile-status.ts`) · 🕒 cadence lines (`cadenceLines`: "every N min now", then "→ every M min from 8 AM ET · schedule name · change ›" to `/schedules#cad-<id>`) · secondary notes · last-60-min pulse · **Recent** (5 newest history rows for the site, `lib/activity.ts`, site-scoped query `history.recentBySitesAndTypes`; each row = event word chip + what the bottle is doing NOW via `nowStatus`, gated by `rosterIsLive`/`behindWall`) · collapsed ⚙ settings panel (`SiteControls.tsx`: on/off, schedule, run, deprecate, keywords with explicit Save, 🕒 window, ⚙ source, 🩺 Diagnose). Keep edits in the panel and the face read-only.
- **Themes** (2026-11-06): palettes are CSS variables only, `:root[data-theme="…"]` in `globals.css`; the list is `apps/web/lib/themes.ts` (default `rr-hh`, Russell's 13 navy/gold). Bottle and light palettes are copied from drop-tracker's `index.html` and must stay matched — **add or change a theme in both repos**. Never write a literal colour in a component rule; derive it from the tokens (`color-mix`). Header nav = Sites · Products · History · Cadence + "More ▾", then the shop quick links on the far right (list in `apps/web/lib/quick-links.ts`, new-tab chips); picker, version and deploy stamp live in the footer.
- **Boot config fixes**: `apps/server/src/config-fixes.ts` — `CORRECTIONS` (idempotent, every boot; survive a re-seed, keep them) vs `ONE_SHOTS` (latched on `fix:<id>` meta). SharedPour runs as one consolidated "SharedPour Watchlist" checker; the retired checkers and the browser tier (`@beacon/browser`) were deleted 2026-11-13 (`store.sites.remove()` drops config + state, keeps history).

## Cutover (completed 2026-06-22)

1. Run the importer against a **prod** Turso DB.
2. Run the worker with `BEACON_DRY_RUN=1` for one loop and confirm **zero**
   `new_product` alerts (baselines preserved).
3. Point worker + web at the prod DB; keep the old Railway worker deployable for
   ~1 week as a fallback; retire GitHub Pages.

## Scale-out path (when one process isn't enough)

Today the worker + dashboard share one process and one libSQL **file** on a
volume (the worker supervises the web child; a web crash can't take monitoring
down). To split them into independent services (separate deploy/scale), the file
can't be shared — move to a **network DB (Turso)** and point both services at it.
That's also where off-box durability comes for free (Turso replication), folding
in the 1b "off-box backup" follow-up.

## Still open (next iterations)

- Dashboard visual polish / parity pass (this is the functional foundation).
- Schedules manager, Sandbox (add-site preview), System-health panel.
- Total Wine / Costco (phase 2): would need a real-browser tier; the Browserbase
  experiment (`@beacon/browser`) was removed 2026-11-13 — it is in git history.
- Bottle tracking handoff to the Cellar app.
