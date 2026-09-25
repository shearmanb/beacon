# Beacon — Rebuild (v2)

A ground-up rebuild of Beacon as a TypeScript monorepo — **now live on `main`**
(cutover 2026-06-22), deployed as one Railway service (`@beacon/server`). The
legacy v1 app was removed from `main` on 2026-06-24 and lives only on the
`legacy-v1` branch. Operational history (what shipped when, and why) is in
`CLAUDE.md`; the backlog is `TODO.md`.

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
  browser/  the `browser` source adapter: real Chromium via Browserbase over CDP
            (playwright-core), wall classification, failure evidence capture.
            Lazy-loaded: imported only when an enabled browser site exists
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
| `browser`         | —                            | real Chromium via Browserbase (`@beacon/browser`); needs `BROWSERBASE_API_KEY` |
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
| `HEALTHCHECK_URL` | external dead-man ping each pass (healthchecks.io) |
| `BEACON_DASH_PASSWORD` | dashboard login. **Required in production**: without it the dashboard refuses every login (no public default) |
| `BEACON_AUTH_SECRET` | optional cookie-signing key (defaults to the password); rotate to log out every session |
| `BEACON_OPS_TOKEN` | enables `Authorization: Bearer` access to `/api/ops/{status,errors,evidence}` for headless inspection |
| `GH_TOKEN`, `GH_REPO` | arm the daily history mirror + off-box backup to `analytics/` |
| `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID` | `browser` source kind |
| `BEACON_EVIDENCE_DIR` | browser failure screenshots/HTML (default `/data/evidence`) |
| `BEACON_BACKUP_INTERVAL_H` | on-volume snapshot cadence (default 6, 0 disables) |
| `BEACON_FORCE_SEED=1`, `BEACON_SEED_ONLY=1`, `BEACON_DATA_DIR` | seed-guard override / seed then exit / legacy JSON location |
| `BEACON_NO_WEB=1`, `BEACON_NO_WORKER=1` | run one half of the process only |
| `BEACON_DRY_RUN=1` | compute + log, send/persist nothing |

### Ops API (headless prod inspection)

`GET /api/ops/status` (worker heartbeat + per-site health summary, failure
timestamps), `GET /api/ops/errors` (per-site error-log tail), and
`GET /api/ops/evidence[?site=&file=]` (browser-check screenshots/HTML). Auth is
the dashboard cookie or the `BEACON_OPS_TOKEN` bearer. The product map never
leaves the box through these routes. `GET /api/export/history` (cookie only)
downloads the full alert history as JSONL.

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
- Total Wine / Costco (phase 2): the headless tier exists (`browser` kind) but
  its Browserbase quota is unfunded, so its twin checker is disabled.
- Bottle tracking handoff to the Cellar app.
