# Deploy — get the new dashboard on a URL

The v2 dashboard is a **server app** (not the static GitHub Pages page), so it
needs a host + the database. Fastest path to a URL you can open: **Vercel
(dashboard) + Turso (database)**. Both have free tiers with no credit card.
~15 minutes, one-time.

> For viewing the dashboard you only need Steps 1–3. The worker (Step 4) is what
> actually checks sites and sends Discord alerts — add it when you want v2 live.

## 1. Create a free Turso database

Install the CLI (`brew install tursodatabase/tap/turso` or see turso.tech), then:

```bash
turso auth signup
turso db create beacon
turso db show beacon --url            # -> libsql://beacon-<you>.turso.io
turso db tokens create beacon         # -> the auth token
```

## 2. Seed it with your real data (preserves baselines)

From the repo root on the rebuild branch:

```bash
pnpm install
pnpm --filter @beacon/migrate exec tsx src/cli.ts \
  --db "libsql://beacon-<you>.turso.io" \
  --auth-token "<token>" \
  --data "$PWD" --reset
```

You should see `sites: 8, products: 62, …` and `sitesFailed: []`.

## 3. Deploy the dashboard to Vercel

1. vercel.com → **Add New → Project** → import the `shearmanb/beacon` repo.
2. Set **Root Directory** = `apps/web` (Vercel detects Next.js + the pnpm
   workspace automatically).
3. **Production Branch** = `claude/app-rebuild-strategy-2xbedp` (until cutover).
4. Add **Environment Variables**:
   - `BEACON_DB_URL` = `libsql://beacon-<you>.turso.io`
   - `BEACON_DB_AUTH_TOKEN` = `<token>`
   - `BEACON_DASH_PASSWORD` = a password of your choice
5. **Deploy.** You get a `https://beacon-<you>.vercel.app` URL — open it and log
   in. (With a remote Turso URL, `@libsql/client` uses its HTTP client, so the
   native bindings aren't needed on serverless.)

## 4. (Later) Run the worker so it actually checks

The worker is a long-running process — Railway (where the old one runs) is ideal:

- New Railway service from the repo, **Start Command**:
  `pnpm --filter @beacon/worker start`
- Env: `BEACON_DB_URL`, `BEACON_DB_AUTH_TOKEN`, `DISCORD_WEBHOOK_URL`,
  optional `HEALTHCHECK_URL`, and `BEACON_DRY_RUN=1` for the first run.
- Watch the logs / dashboard for one loop with `BEACON_DRY_RUN=1` and confirm
  **zero** `new_product` alerts, then remove the flag to go live.

## Alternative: everything on Railway

Prefer one platform? Deploy both as Railway services pointing at the same Turso
DB: the worker (`pnpm --filter @beacon/worker start`) and the web app
(`pnpm --filter @beacon/web build` then `pnpm --filter @beacon/web start`).
Railway gives the web service a public URL too.
