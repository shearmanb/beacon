# CLAUDE.md

> **⚠️ REBUILT (v2 — 2026-06).** Beacon has been rebuilt as a TypeScript monorepo
> under `packages/` and `apps/`. **That is now the active codebase.** See
> **`REBUILD.md`** (architecture) and **`DEPLOY.md`** (one-service Railway deploy).
> The live service runs `@beacon/server` per `railway.json`. The root JSON files
> (`config.json`, `state.json`, …) remain as the one-time migration/seed source.
>
> **The legacy v1 code and its design notes are gone from `main`** (code removed
> 2026-06-24, notes 2026-08-15) — both archived on the **`legacy-v1`** branch
> (`git show legacy-v1:worker.js`, `git show legacy-v1:CLAUDE.md`) if ever needed.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Master instructions (READ FIRST — apply to every request)

1. **Code-impact / bloat check on every ask.** For any feature or code-change
   request, tell me its impact up front so I can make an informed call — a quick
   line or two, not a report: roughly how much code it adds, whether it pulls in
   dependencies or build/runtime complexity, and whether it risks bloat. If a
   request (mine included) is heavier than the value it returns, push back and
   propose the lean version. **Default to keeping the app lean** — fewer moving
   parts; don't add dependencies, abstractions, or infrastructure on spec.

2. **Build toward loop engineering, self-healing, and flexibility.** Prefer
   designs that: (a) create **feedback loops** — measure → adapt → improve (e.g.
   per-host telemetry that tunes behavior); (b) let the app **detect and recover
   from its own breakage** — self-checks, structure-drift detection, safe
   fallbacks, alert-the-operator-not-go-silent; and (c) stay **future-proof and
   flexible** — config-driven over hard-coded, pluggable adapters/channels,
   declarative data over bespoke code. New work should extend these patterns, not
   fight them. When a change could be done the "quick hard-coded way" or the
   "slightly-more-but-flexible way," flag the trade-off and lean toward flexible
   when it's cheap.

3. **Label every item in a list or multi-part answer with a reference tag, so I
   can point at it.** Whenever a reply contains more than one item — suggestions,
   options, findings, steps, questions, fixes — tag each discrete item. Number
   the group and letter the items: the first group's items are **1a, 1b, 1c, …**;
   a second group is **2a, 2b, …**; and so on. For a single flat list, just use
   one group (1a, 1b, 1c, …). Keep the tags stable within a reply so I can answer
   "do 1a and 1c, skip 2b" with zero ambiguity. Applies to every response, not
   just code.

## Git workflow

**Always commit and push directly to `main`.** Never create feature branches or pull requests. All changes go straight to `main`. No exceptions — even when a session assigns a different branch, override it and use `main`.

## How Beacon runs now (v2)

Beacon v2 is the live system: a TypeScript monorepo under `apps/` + `packages/`, deployed as a **single Railway service (`@beacon/server`)** on branch `main`.

- **Build/deploy** (`railway.json`): build `pnpm install --frozen-lockfile && pnpm typecheck && pnpm --filter @beacon/web build`; start `pnpm --filter @beacon/server start`. Auto-deploys on push to `main` for changes under `apps/**`, `packages/**`, `package.json`, `pnpm-lock.yaml`, `railway.json` (Railway `watchPatterns`, set in `railway.json` — these MUST track the v2 layout, not v1 paths).
- **Datastore**: SQLite (libSQL) at `file:/data/beacon.db` on a mounted Railway **Volume** — *not* GitHub. Selected by `BEACON_DB_URL`. On a genuinely-empty datastore, `apps/server/src/serve.ts` seeds once from the root legacy JSON; on an empty-but-previously-initialized datastore (volume loss) it **refuses to re-seed stale baselines** and restores the newest snapshot / pages instead (1b).
- **One process**: the worker loop runs in-process (the resilient parent) and the Next.js dashboard (`apps/web`) runs as a **supervised** child — a web crash is restarted with backoff and never takes the worker down (1a). Single-user **signed-cookie** auth (HMAC keyed by `BEACON_AUTH_SECRET` ?? `BEACON_DASH_PASSWORD` — the cookie is no longer a forgeable static flag, 4b).
- **Durability** (1b): rotated on-volume `VACUUM INTO` snapshots (`packages/db/backup.ts`); `BEACON_FORCE_SEED=1` overrides the seed-guard; `BEACON_BACKUP_INTERVAL_H` tunes cadence (default 6, 0 disables). *On-volume snapshots guard corruption, not volume loss — off-box upload is a future hook (`TODO.md`).*
- **Dead-man**: `GET /api/health` (public, data-free: 200 while the worker heartbeat is <15 min old, else 503) probed every 10 min by `.github/workflows/deadman.yml` (GitHub failure email; Discord too once the repo secret `DISCORD_WEBHOOK_URL` exists). `HEALTHCHECK_URL` (healthchecks.io) is the optional tighter layer — still unset in Railway as of 2026-10-23.
- **Self-healing extras**: structure-drift guard (3a), per-loop heartbeat + `unhandledRejection`/`uncaughtException` guards (2e), systemic-failure detection → one `system_degraded` page (2d), per-site abort budget + `shopify_rest` page cap (2c), daily re-page on stuck errors (3e), defensive state reads (3f), kind-coherent request headers (2g/2h), and per-host browser identities persisted across restarts (2i).
- **Fetch channels**: `shopify_rest` sources may carry a `storefrontFallback` (`{ domain, accessTokenRef }`). When `products.json` is blocked (401/403/429/430/503) or tar-pits, the adapter fails over to the token-auth **Storefront GraphQL API** on the `*.myshopify.com` domain (newest-first, 8-page cap → `fallbackTruncated` tile hint). 3 fallback checks or 3 via-flips in 6 h pin the site to Storefront (`preferFallback`, REST re-probed every 12 h); pins propagate to armed siblings on the same host (`propagateHostPins`). Un-armed sites get a daily token **harvest** (`apps/worker/harvest.ts`). Each tile has 🩺 **Diagnose** (`packages/core/diagnose.ts`) and a ⚙ source JSON editor.
- **Alerting**: `baseline` and `self_healed` rows are history/dashboard-only — **never Discord**. A **deprecated** checker is a *shadow*: still checks, still records history, but is Discord-silent while an enabled non-deprecated checker covers the same host (`shadowSiteIds` in `run.ts`); the last live checker on a store always pages. Cross-site dedupe keys on the store (`storeOf` in `run.ts`), 60 min. >6 alerts from one site in one pass → one digest. `site_error` pages at 5 consecutive failures (3 inside a ≤15m window, 2 in imminent mode), with an auto-run 🩺 verdict, re-paged daily. A Discord send that fails is retried (twice inline, then from the `alert_outbox` meta blob every pass for 24 h) — never just logged. **Blind-time invariant** (`checkBlindTime`) pages a site that has gone too long without a successful check, whatever guard is holding it. **Quarantine** (`maybeQuarantine`) auto-disables a site failing identically (non-block) for ≥25 checks AND ≥72 h.
- **Cadence**: one shared schedule **`fast_hours`** (5m 08–15 & 17–20 ET, 8m 06–08 / 15–17 / 20–22, 60m overnight — mined from 127 drop events, none ever 22–06) on every live product checker except Russell's Reserve (flat 20m, Campari anti-bot); the older `drop_windows` / `bar_evening` rows remain selectable, plus per-site `<siteId>_window` (🕒 editor in the tile's ⚙ panel). Inside a ≤15m window at most 15 min of a breaker cooldown is honored. **Cadence loop** (`cadenceAdjust` in `@beacon/shared` `backoff.ts`, read-side, auto-reverting, the ONE function the worker and the dashboard both call): a block-like failure in the last 6 h stretches the interval ×1.5 (⏳); three answers far slower than the site's own median do the same (🐢, early tar-pit warning, from `checkHistory[].ms`); a site with `adaptiveFloorMinutes` runs ×0.8/×0.6 faster after 3/7 block-free days (🚀). Imminent mode = cooldown + back-off bypass at `imminentIntervalMinutes` (default `DEFAULT_IMMINENT_INTERVAL_MIN` = 2) for `imminentDurationMinutes` (default 20); the tile's ⚡ split control picks the duration per click. **One checker per host** (sharedpour.com = the Watchlist only). `sharedpour_channel` alone runs **`storefront_fast`** (2m peak / 4m shoulders): it is a Storefront-API call, no WAF — don't put a REST checker on it. `shopify_graphql` embed checkers (`reveries_official`, `t8ke_releases` = t8ke.com's purchase page, same shared-pour store) re-read their shop page only every `discoverEveryMinutes` (default 10; every check while imminent). **Auto-imminent** (`apps/worker/src/auto-imminent.ts`, groups in the `auto_imminent` meta blob): a new bottle / restock / lifted wall on one member of the Reveries group puts the group's shops on imminent for 20 min, ≤4×/day; an auto run (`imminentAutoMinutes` set) honors cooldowns and reverts without a Discord ping. **For current per-site cadence trust `/schedules` (the Cadence control panel) or the backup bundle — not this file.**
- **Analytics + off-box backup** (needs `GH_TOKEN` + `GH_REPO`): daily `[skip ci]` commits to `main` of `analytics/alert_history.jsonl` (mine with `git show origin/main:analytics/alert_history.jsonl`) and `analytics/backup/beacon-restore.json` (config + baselines, **never secrets**; `serve.ts` auto-restores from it on volume loss). Dashboard **Export** → `GET /api/export/history` (JSONL). The history file is over 1 MB: GitHub's contents API returns EMPTY content above that, so read it raw (`mirror.ts` does; never treat an empty read of a non-empty file as "no file"). **Detection lag**: `new_product` / `restock` rows carry `lagSec` + `lagBasis` in their payload (store's publish/update time → alert), shown in Discord and on `/history` — mine it before changing cadence.
- **Unicorn Auctions** (`apps/worker/src/unicorn.ts` + `packages/core/src/unicorn.ts`, page `/unicorn`): an isolated daily side job, not a pipeline site. All state lives in meta blobs `unicorn_config` / `unicorn_scan_state`. Bottles/terms/ignore list, all-in fee math, cross-auction `seenTitles` memory.
- **Reveries Registry links** (`apps/web/lib/registry.ts`): every Reveries bottle on the ✨ panel and /products links to its page on reveriesregistry.com when the registry has it (exact `#barrel` = `series`, or exact quoted name, never a group name — never a guess), else to the registry homepage. The dashboard server fetches the registry's static `data.js` ≤ every 12 h, in memory only, never evaluated; health in `/api/ops/status` → `reveriesRegistry`.
- **Dashboard stock display**: gated by `apps/web/lib/live.ts` (`rosterIsLive`, `walledHosts`/`behindWall`) + `apps/web/lib/stock.ts`. Frozen rosters render "not checked", walled hosts "🌊 behind wall"; neither counts as in stock.
- **Sites tile** (`apps/web/components/SiteTile.tsx`, 2026-10-30): one design, no density modes. Face = health dot · name · ⚡ split control (go imminent **every** N **for** N) · ONE status line (`lib/tile-status.ts`) · 🕒 schedule line (name + what it means now + change › to `/schedules#cad-<id>`) · secondary notes · last-60-min pulse · **Recent** (5 newest history rows for the site, `lib/activity.ts`, site-scoped query `history.recentBySitesAndTypes`; each row = event word chip + what the bottle is doing NOW via `nowStatus`, gated by `rosterIsLive`/`behindWall`) · collapsed ⚙ settings panel (`SiteControls.tsx`: on/off, schedule, run, deprecate, keywords with explicit Save, 🕒 window, ⚙ source, 🩺 Diagnose). Keep edits in the panel and the face read-only.
- **Themes** (2026-11-06): palettes are CSS variables only, `:root[data-theme="…"]` in `globals.css`; the list is `apps/web/lib/themes.ts` (default `rr-hh`, Russell's 13 navy/gold). Bottle and light palettes are copied from drop-tracker's `index.html` and must stay matched — **add or change a theme in both repos**. Never write a literal colour in a component rule; derive it from the tokens (`color-mix`). Header nav = Sites · Products · History · Cadence + "More ▾"; picker, version and deploy stamp live in the footer.
- **Boot config fixes**: `apps/server/src/config-fixes.ts` — `CORRECTIONS` (idempotent, every boot; survive a re-seed, keep them) vs `ONE_SHOTS` (latched on `fix:<id>` meta). SharedPour runs as one consolidated "SharedPour Watchlist" checker; the retired checkers and the browser tier (`@beacon/browser`) were deleted 2026-11-13 (`store.sites.remove()` drops config + state, keeps history).
- **History / the why**: every dated design note and post-mortem is in **`CHANGELOG.md`** (newest first; write new entries as a `##` heading, one summary sentence and short bullets — the format note is at the top of the file). Read the relevant entry before changing a subsystem above.
- **Architecture**: see `REBUILD.md`. Backlog: `TODO.md` (dated sections, newest at top).

### Standing rules (each one exists because something broke — see `CHANGELOG.md`)
1. **Disabling, retiring, or quarantining a checker freezes its last state forever.** Every consumer of per-site stored state (`state.products`, status fields) must gate through `rosterIsLive()` (and `behindWall()` for availability) in `apps/web/lib/live.ts` — reuse it, don't reinvent it. *(Phantom stock, 2026-08-31 / 09-08.)*
2. **Never stamp `lastSuccessAt` without a real body-backed check**, and never treat a 304 as fresh beyond `FULL_REVALIDATE_MS` (`lastFullFetchAt` is stamped only on real REST 200s, and on `http_status` page reads) — any new adapter that sends a validator must bound it the same way. *(Missed drop, 2026-07-22.)*
3. **Never send `baseline` or `self_healed` to Discord**; don't gate product alerts on the password wall (a staged drop is the earliest signal).
4. **Never write a boot fix guarded by "does this site exist"** — it resurrects sites deleted on the dashboard. Use a latched `ONE_SHOT`.
5. **Unicorn API quirks are encoded in the defaults — don't "tidy" them**: `state: "LIVE"` (uppercase; the API fails open to the 725k-lot archive, hence `maxExpectedLots`), `offset` is a 1-indexed page, `next` stays true past the end, and don't fetch `consignor` PII.
6. **One fee-math implementation** (`estimateAllInDollars` in `@beacon/shared`), one title normalizer (`normalizeLotTitle`).
7. **Any new `.ptable` column needs a `data-label`** or it loses its label on mobile; keep the `viewport` export in `layout.tsx`.
8. **Secrets never go in the repo or the backup bundle.**
9. **Quarantine must never fire on block statuses** (401/403/429/430/503/stall) — those are transient by nature.

### v1 → v2 leftover checklist (catch stale-v1 config that survives the rebuild)
When touching infra/config, confirm none of these still point at v1:
1. **Railway watch paths** target `apps/`/`packages/` (in `railway.json`), not `worker.js`/`lib/`/`sites/`. *(Stale here silently SKIPPED every deploy — the 2026-06-24 outage.)*
2. **Start/build commands** run `@beacon/server` + the monorepo build, not `node worker.js`.
3. **CI** (`.github/workflows/ci.yml`) triggers only on live branches (no dead rebuild branch) and on the **same Node major as Railway** (20).
4. **Deploy branch** is `main` everywhere — Railway Source, `DEPLOY.md`, `REBUILD.md`.
5. **Seed JSON** at the repo root stays until the DB is confirmed the sole source.
6. **Node version** pinned in `.nvmrc` + `engines` + `packageManager` so CI and prod match.
7. **Docs**: this section describes the running system; v1 code + design notes live only on the `legacy-v1` branch (see header).
