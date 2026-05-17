# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Beacon is a personal stock-monitoring bot owned by Brian (McLean, VA). It watches whiskey/spirits product pages and sends Discord alerts when new products appear or items come back in stock. There is no build step, no test suite, and no dependencies — pure Node.js ESM using only built-ins.

## Running the checker

```bash
node checker.js
```

Requires `DISCORD_WEBHOOK_URL` env var to send alerts. Run without it to check silently. The checker respects `intervalMinutes` per site — if a site was checked recently it will skip. To force a full recheck, set `state.json` to `{}` before running (will re-alert on all existing products, so only do this intentionally).

## Architecture

**Entry point**: `checker.js` — loads `state.json`, iterates `config.js` sites, calls the appropriate strategy module, diffs results against previous state, sends alerts, writes updated `state.json` and appends to `alert_history.json`.

**The only file edited day-to-day**: `config.js` — add/remove sites, change intervals, flip `imminent: true` on drop days, adjust filters.

**Strategy pattern**: Each site declares a `strategy` field. `checker.js` dynamically imports `sites/<strategy>.js` and calls `checkSite(site, previousState)`. Both strategies return `{ state, alerts }` where `state` replaces the previous entry in `state.json`.

**Two strategies today**:
- `shopify_collection` — hits `[url]/products.json?limit=250&page=N`, paginates until a short page. Filters are applied in code after fetch (not as URL params — Shopify ignores client-side filter params like `rb_vendor` on the JSON API). The `sharedpour_reveries` site uses `url: "https://sharedpour.com"` (store root) with `titleContains: ["Reveries"]` filter because there is no dedicated collection.
- `reveries_squarespace` — fetches HTML, parses `<h4>` tags. Availability is always assumed `true` (static HTML doesn't expose stock status). Only detects new releases, not restocks.

**State persistence**: `state.json` is committed back to the repo after every run by `beacon-bot` in the GitHub Actions workflow (`[skip ci]` prevents loops). If a push fails due to non-fast-forward (code commit raced the state commit), `git pull --rebase && git push` resolves it.

**Scheduling**: One GitHub Actions cron at `*/5 * * * *` (platform minimum). Each site has its own `intervalMinutes` — `checker.js` skips a site if it was checked within that window. This lets T8KE check every 20 min and Reveries Official every 30 min from the same 5-min cron. The `imminentIntervalMinutes` field is reserved for a future Render.com worker (GitHub Actions cannot honor sub-5-min intervals).

**Alerts**: Discord webhook with rich embeds. Color coded: blue = new product, green = restock, red = sold out. Rate limit retries are built into `notifiers/discord.js` (429 → parse `retry_after` → sleep → retry up to 4 times). `notifiers/ntfy.js` is stubbed and disabled.

## Current monitored sites

| ID | URL | Strategy | Notes |
|----|-----|----------|-------|
| `sharedpour_t8ke` | sharedpour.com/collections/t8ke | shopify_collection | 37 products baselined |
| `sharedpour_reveries` | sharedpour.com (filtered by title) | shopify_collection | 1 product: THE DEEP (sold out) |
| `reveries_official` | thereveries.co/shop | reveries_squarespace | 3 real releases baselined |

## Infrastructure

- **GitHub Actions**: `.github/workflows/check.yml` — cron + `workflow_dispatch`. Needs `permissions: contents: write` to commit state back.
- **GitHub Secret**: `DISCORD_WEBHOOK_URL` — the Discord channel webhook. Never put this in code.
- **GitHub Pages**: served from `/docs`, password is `beam` (client-side gate, hardcoded in `docs/index.html`). Dashboard auto-refreshes every 2 min by fetching raw files from GitHub. `REPO_OWNER` and `REPO_NAME` constants are set at the top of `docs/index.html`.
- **Default branch**: `main`. The cron fires on the default branch — if it ever runs on the wrong branch again, check repo Settings → Default branch.

## Adding a new site

1. Add a strategy file in `sites/` exporting `checkSite(site, previousState)` returning `{ state, alerts }`.
2. Register the strategy name in the `strategies` map in `checker.js`.
3. Add the site object to `config.js`.
4. Run once manually to establish the baseline before alerts go live.

## Known quirks

- The `package.json` warning about `MODULE_TYPELESS_PACKAGE_JSON` should not appear — `"type": "module"` is set. If it reappears, the cron may have switched to the wrong branch.
- The Squarespace parser skip list (`SKIP_STRINGS` in `sites/reveries_squarespace.js`) needs updating if thereveries.co restructures their page and detail lines start appearing as products again.
- Filters in `shopify_collection.js` are applied **after** fetching all pages. A store with thousands of products and a narrow filter will still paginate the full catalog.
