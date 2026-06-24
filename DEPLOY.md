# Deploy — get the new dashboard on a URL

> ✅ **Already deployed (2026-06-24):** one Railway service `beacon` on branch
> `main`, with a `/data` volume, the old v1 worker stopped. This doc is the
> **setup reference** — don't re-run it against a different branch.

The v2 dashboard is a **server app** (not the static GitHub Pages page), so it
needs a host + the database.

## Recommended: Railway only (no new accounts)

You already use Railway for the worker. This runs the **whole thing as one
Railway service** — the worker loop and the dashboard in one process, sharing a
single SQLite file on a Railway **Volume**. No second database service, no Turso,
no new signups. On first boot it auto-seeds from the legacy JSON in the repo
(preserving your product baselines).

1. **New service** in your Railway project → **Deploy from GitHub repo** →
   `shearmanb/beacon`, branch `main`.
   (The root `railway.json` already sets the build + start commands.)
2. **Add a Volume** to the service, mount path **`/data`**.
3. **Variables:**
   - `BEACON_DB_URL` = `file:/data/beacon.db`
   - `BEACON_DASH_PASSWORD` = a password you pick (dashboard login)
   - `DISCORD_WEBHOOK_URL` = your webhook (same as the old worker)
   - *(optional)* `HEALTHCHECK_URL`, and `BEACON_DRY_RUN=1` for the first deploy
     (worker computes + logs but sends/persists nothing — verify zero false
     alerts, then remove it).
4. **Generate a domain** (Settings → Networking → Generate Domain) → open the
   URL, log in. Done — that's your live dashboard, editable from there on.

When you're happy, **stop the old worker service** so only v2 runs. (Both can run
briefly in parallel during validation; they use different storage.)

> How it works: one process seeds the DB if empty, runs the worker loop
> in-process, and spawns `next start` for the dashboard on Railway's `$PORT`,
> all against `file:/data/beacon.db`. See `apps/server/src/serve.ts`.

## Alternative: split services + Turso (a network DB)

If you'd rather run the worker and dashboard as **separate** services (or host
the dashboard on Vercel), they can't share a file — use a network database
(Turso, free). Create a Turso DB, seed it:

```bash
pnpm --filter @beacon/migrate exec tsx src/cli.ts \
  --db "libsql://<db>.turso.io" --auth-token "<token>" --data "$PWD" --reset
```

Then deploy worker (`pnpm --filter @beacon/worker start`) and web
(`pnpm --filter @beacon/web start`, or Vercel with Root Directory `apps/web`),
each with `BEACON_DB_URL` + `BEACON_DB_AUTH_TOKEN` set.

## View locally (no host at all)

```bash
pnpm install
pnpm --filter @beacon/migrate exec tsx src/cli.ts --db file:beacon.db --data "$PWD" --reset
BEACON_DB_URL=file:beacon.db pnpm --filter @beacon/web dev   # localhost:3000
```
