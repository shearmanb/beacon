# Beacon — Rebuild (v2)

A ground-up rebuild of Beacon as a TypeScript monorepo. The legacy app (root
`worker.js`, `lib/`, `sites/`, `docs/`) still runs on `main`; this rebuild lives
on `claude/app-rebuild-strategy-2xbedp` until cutover. See
`.claude/plans/if-i-want-to-reactive-moonbeam.md` for the full design.

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
  db/       Drizzle (libSQL) schema + repositories + openStore()
  notify/   NotificationChannel interface + DiscordChannel
apps/
  worker/   the loop: shouldCheck gate, circuit breaker, quiet mode, command
            drain, imminent auto-off, DB-down detection, healthcheck
  web/      Next.js dashboard (Sites/Products/History/Reminders) + single-user auth
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
pnpm test          # vitest (118 tests)
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

Env: `BEACON_DB_URL` (libSQL/Turso URL or `file:`), `BEACON_DB_AUTH_TOKEN`
(Turso), `DISCORD_WEBHOOK_URL`, `HEALTHCHECK_URL`, `BEACON_DRY_RUN=1`
(compute + log, send/persist nothing), `BEACON_DASH_PASSWORD` (dashboard login).

## Cutover (when ready)

1. Run the importer against a **prod** Turso DB.
2. Run the worker with `BEACON_DRY_RUN=1` for one loop and confirm **zero**
   `new_product` alerts (baselines preserved).
3. Point worker + web at the prod DB; keep the old Railway worker deployable for
   ~1 week as a fallback; retire GitHub Pages.

## Still open (next iterations)

- Dashboard visual polish / parity pass (this is the functional foundation).
- Schedules manager, Sandbox (add-site preview), System-health panel.
- Adaptive anti-bot (telemetry table + policy) and Total Wine / Costco (phase 2,
  will need the headless/proxy tier).
- Bottle tracking handoff to the Cellar app.
