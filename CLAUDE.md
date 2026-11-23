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

## How Beacon runs now (v2) — the map

Beacon v2 is a TypeScript monorepo under `apps/` + `packages/`, deployed as a **single Railway service (`@beacon/server`)** on branch `main`. One line per subsystem here: what it is, where it lives, what not to break. **The detail and the numbers are in `REBUILD.md` → "Subsystem reference" — read that bullet before changing a subsystem.**

- **Build/deploy** (`railway.json`): a push to `main` touching `apps/**`, `packages/**`, `package.json`, `pnpm-lock.yaml` or `railway.json` auto-deploys. The build runs `pnpm typecheck`, so a type error fails the deploy. The watch patterns MUST track the v2 layout.
- **Datastore**: SQLite (libSQL) at `file:/data/beacon.db` on a Railway **Volume** — *not* GitHub. `apps/server/src/serve.ts` seeds once from the root JSON, and on volume loss restores a snapshot / the backup bundle instead of re-seeding stale baselines.
- **One process**: the worker loop is the parent; the Next.js dashboard (`apps/web`) is a supervised child. Single-user signed-cookie auth.
- **Durability**: on-volume `VACUUM INTO` snapshots (`packages/db/src/backup.ts`) guard corruption, not volume loss; the off-box copy is the daily backup bundle below.
- **Dead-man**: public `GET /api/health`, probed every 10 min by `.github/workflows/deadman.yml`; `HEALTHCHECK_URL` (healthchecks.io) is the optional tighter layer.
- **Systemic self-heal** (`apps/worker/src/self-heal.ts`): connect failures are retried, named, closed by an all-clear, and answered with one self-redeploy a day (needs `RAILWAY_API_TOKEN`; never on blocks).
- **Fetch channels** (`packages/core/src/sources/`): `shopify_rest` fails over to the Storefront GraphQL API when blocked, and pins there after repeated fallbacks. Token harvest: `apps/worker/src/harvest.ts`. 🩺 Diagnose: `packages/core/src/diagnose.ts`.
- **Alerting** (`apps/worker/src/run.ts`, `process-site.ts`, `packages/notify`): shadow (deprecated) checkers stay Discord-silent while a live one covers the host; per-store dedupe; digest for bursts; failed sends go to the `alert_outbox`; blind-time invariant; quarantine.
- **Cadence** (`@beacon/shared` `schedule.ts` + `backoff.ts`): shared schedule `fast_hours`; `cadenceAdjust` is the ONE function the worker and the dashboard both call; imminent mode; auto-imminent (`apps/worker/src/auto-imminent.ts`). **One checker per host.** `sharedpour_channel` runs `storefront_fast` — don't put a REST checker on it. **For current per-site cadence trust `/schedules` or the backup bundle, not a doc.**
- **Analytics + off-box backup** (needs `GH_TOKEN` + `GH_REPO`): daily `[skip ci]` commits of `analytics/alert_history.jsonl` and `analytics/backup/beacon-restore.json`. The history file is over 1 MB — read it raw (`git show origin/main:analytics/alert_history.jsonl`); an empty contents-API read is not "no file". Mine `lagSec` there before changing cadence.
- **Unicorn Auctions** (`apps/worker/src/unicorn.ts`, `packages/core/src/unicorn.ts`, page `/unicorn`): an isolated daily side job; all state in the `unicorn_config` / `unicorn_scan_state` meta blobs.
- **Reveries Registry links** (`apps/web/lib/registry.ts`): exact match or the registry homepage — never a guess.
- **Dashboard stock display**: gated by `apps/web/lib/live.ts` + `apps/web/lib/stock.ts` (standing rule 1).
- **Sites tile** (`apps/web/components/SiteTile.tsx`, `SiteControls.tsx`, `lib/tile-status.ts`, `lib/activity.ts`): one design, no density modes. Keep edits in the ⚙ panel and the face read-only.
- **Themes** (`apps/web/lib/themes.ts`, `globals.css`): CSS variables only; never a literal colour in a component rule. Palettes must stay matched with drop-tracker — **add or change a theme in both repos**.
- **Header**: Sites · Products · History · Cadence + "More ▾", then shop quick links on the far right (`apps/web/lib/quick-links.ts`).
- **Boot config fixes** (`apps/server/src/config-fixes.ts`): `CORRECTIONS` (idempotent, every boot) vs `ONE_SHOTS` (latched on `fix:<id>` meta). `store.sites.remove()` drops config + state, keeps history.
- **History / the why**: every dated design note and post-mortem is in **`CHANGELOG.md`** (newest first; format note at the top of the file). Add an entry when a change ships.
- **Architecture, commands, env vars**: `REBUILD.md`. Deploy setup: `DEPLOY.md`. Backlog: `TODO.md`.

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
7. **Docs**: the map above + `REBUILD.md` describe the running system; v1 code + design notes live only on the `legacy-v1` branch (see header).
