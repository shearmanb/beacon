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

**Entry point**: `checker.js` — loads `state.json` and `ignored_products.json`, iterates `config.js` sites, calls the appropriate strategy module, diffs results against previous state, filters out ignored products, sends alerts, writes updated `state.json` and appends to `alert_history.json`.

**The only file edited day-to-day**: `config.js` — add/remove sites, change intervals, flip `imminent: true` on drop days, adjust filters.

**Strategy pattern**: Each site declares a `strategy` field. `checker.js` dynamically imports `sites/<strategy>.js` and calls `checkSite(site, previousState)`. Both strategies return `{ state, alerts }` where `state` replaces the previous entry in `state.json`.

**Two strategies today**:
- `shopify_collection` — hits `[url]/products.json?limit=250&page=N`, paginates until a short page. Filters are applied in code after fetch (not as URL params — Shopify ignores client-side filter params like `rb_vendor` on the JSON API). The `sharedpour_reveries` site uses `url: "https://sharedpour.com"` (store root) with `titleContains: ["Reveries"]` filter because there is no dedicated collection.
- `reveries_squarespace` — primary: fetches `[url]?format=json` (Squarespace JSON API) for clean product data with real stock status. Fallback: parses `<h4>` tags from HTML with `SKIP_STRINGS` filtering. Also detects page resets (Coming Soon / password wall) via HTTP errors, HTML signals (`sqs-pw-form`, "coming soon", etc.), or zero products when state had products — fires a one-time `site_reset` Discord alert and preserves previous state. Does NOT fire the reset alert again on subsequent checks while still in reset state.

**State persistence**: `state.json` is committed back to the repo after every run by `beacon-bot` in the GitHub Actions workflow (`[skip ci]` prevents loops). If a push fails due to non-fast-forward (code commit raced the state commit), `git pull --rebase && git push` resolves it.

**Ignored products**: `ignored_products.json` — a flat object keyed by product handle (`{ "some-handle": true }`). `checker.js` loads this and filters matching products from alerts before Discord/history. Ignored products still exist in `state.json` so unignoring never triggers a false "new product" alert. The dashboard writes this file via the GitHub API.

**Scheduling**: One GitHub Actions cron at `*/5 * * * *` (platform minimum). Each site has its own `intervalMinutes` — `checker.js` skips a site if it was checked within that window. This lets T8KE check every 20 min and Reveries Official every 30 min from the same 5-min cron. The `imminentIntervalMinutes` field is reserved for a future Render.com worker (GitHub Actions cannot honor sub-5-min intervals).

**Alerts**: Discord webhook with rich embeds. Color coded: blue = new product, green = restock, red = sold out, orange = site reset. Rate limit retries are built into `notifiers/discord.js` (429 → parse `retry_after` → sleep → retry up to 4 times). `notifiers/ntfy.js` is stubbed and disabled.

## Current monitored sites

| ID | URL | Strategy | Notes |
|----|-----|----------|-------|
| `sharedpour_t8ke` | sharedpour.com/collections/t8ke | shopify_collection | 37 products baselined |
| `sharedpour_reveries` | sharedpour.com (filtered by title) | shopify_collection | 1 product: THE DEEP (sold out) |
| `fountain_inn_dc` | shop.fountaininndc.com (filtered by title) | shopify_collection | titleContains: ["Reveries"]; The Deep + 8yr expected |
| `bourbon_concierge` | thebourbonconcierge.com (filtered by title) | shopify_collection | titleContains: ["Reveries"]; large catalog, Reveries only |
| `reveries_official` | thereveries.co/shop | reveries_squarespace | 3 real releases, all sold out |

## Infrastructure

- **GitHub Actions**: `.github/workflows/check.yml` — cron + `workflow_dispatch`. Needs `permissions: contents: write` to commit state back. Commits `state.json`, `alert_history.json`, and `ignored_products.json`.
- **GitHub Secret**: `DISCORD_WEBHOOK_URL` — the Discord channel webhook. Never put this in code.
- **GitHub Pages**: served from `/docs`, password is `beam` (client-side gate, hardcoded in `docs/index.html`). Dashboard auto-refreshes every 2 min by fetching raw files from GitHub. `REPO_OWNER` and `REPO_NAME` constants are set at the top of `docs/index.html`.
- **Default branch**: `main`. The cron fires on the default branch — if it ever runs on the wrong branch again, check repo Settings → Default branch.
- **GitHub token**: A fine-grained PAT stored in browser localStorage (`beacon_gh_token`). Needs Contents + Actions read/write on the `beacon` repo. Required for dashboard write actions: Monitoring toggle, Imminent mode toggle, Ignore/Unignore products. Tokens can be created at github.com → Settings → Developer settings → Fine-grained tokens.

## Dashboard features (`docs/index.html`)

The dashboard is a single static HTML file fetching raw GitHub files every 2 minutes.

**Sections (top to bottom):**
1. **Sites** — cards for each configured site showing last checked, product count, interval, and two toggles (both require GitHub token):
   - **Monitoring ON/OFF** (green toggle) — writes `enabled: true/false` to `config.js` via `flipEnabled()`
   - **Imminent mode** (yellow toggle) — writes `imminent: true/false` to `config.js` via `flipImminent()`
2. **✨ New Reveries** — grid of product cards for any product whose title contains "reveries" (case-insensitive), across all sites
3. **Products** — filterable table with search, site filter, availability filter, and ignored filter (Hide ignored / Show all / Ignored only). Each row has:
   - Purple **✨ Reveries** badge if title contains "reveries" OR siteId is `reveries_official`/`sharedpour_reveries`
   - **Ignore / Unignore** button (always visible; prompts for token if not set). Writes to `ignored_products.json` via GitHub API. Ignored rows dim out.
4. **Alert History** — last 100 alerts, color-coded. Types: 🆕 New, ✅ Restock, ❌ Sold Out, ⚠️ Reset

**Header actions**: Refresh, ▶ Run Now (token required — triggers `workflow_dispatch`), GitHub Token (save/clear PAT).

**Config parsing**: `parseConfigSites()` uses regex to extract `name`, `id`, `enabled`, `imminent`, `intervalMinutes` from `config.js` text — not `eval()`. The `flipEnabled()` and `flipImminent()` functions do line-by-line replacement to write back.

## Adding a new site

1. Add a strategy file in `sites/` exporting `checkSite(site, previousState)` returning `{ state, alerts }`.
2. Register the strategy name in the `strategies` map in `checker.js`.
3. Add the site object to `config.js`.
4. Run once manually to establish the baseline before alerts go live.

## config.js site object fields

```js
{
  name: "Human-readable name",
  id: "snake_case_unique_id",
  enabled: true,                    // false = skip entirely (togglable from dashboard)
  strategy: "shopify_collection",   // or "reveries_squarespace"
  url: "https://...",
  intervalMinutes: 20,              // how often to check (normal mode)
  imminentIntervalMinutes: 2,       // reserved for future sub-5-min worker
  imminent: false,                  // flip true on drop days (togglable from dashboard)
  alertOnNewProduct: true,
  alertOnRestock: true,
  alertOnSoldOut: false,
  filters: {
    titleContains: [],              // shopify_collection only
    titleExcludes: [],
    vendorIs: [],
    productType: [],
    tags: [],
    minPriceDollars: null,
    maxPriceDollars: null,
    availableOnly: false,
  },
}
```

## Open features (backlog)

- **Scheduling (feature 2)** — per-site schedule dropdown in the dashboard replacing fixed `intervalMinutes`. Options: 5 / 15 / 30 / 60 min, plus "Working Hours Heavy" (9am–6pm every 5 min, 6–10pm every 20 min, 10pm–8am twice ≈ every 5 hrs). Requires: new `schedule` field in `config.js`, `getEffectiveInterval(site)` logic in `checker.js`, dropdown UI in site cards (token-gated write).
- **Add site wizard (feature 3)** — modal form in the dashboard to add a new site to `config.js` via GitHub API. Fields: name, ID (auto-slugged from name), strategy dropdown, URL, schedule, filters. Tricky part: serializing a JS object back into `config.js` format cleanly. Deferred — for small numbers of new sites, direct edits to `config.js` are simpler.

## Known quirks

- The `package.json` warning about `MODULE_TYPELESS_PACKAGE_JSON` should not appear — `"type": "module"` is set. If it reappears, the cron may have switched to the wrong branch.
- Squarespace `?format=json` is the primary data source for `reveries_official`. If it ever stops returning product data, the HTML fallback (`<h4>` parsing with `SKIP_STRINGS`) kicks in — but the fallback cannot determine stock status and always marks products as available.
- Filters in `shopify_collection.js` are applied **after** fetching all pages. A store with thousands of products and a narrow filter will still paginate the full catalog.
- On thereveries.co, the Reveries products on SharedPour (`sharedpour_reveries`) may have a vendor of "SharedPour" rather than "The Reveries". The dashboard handles this by flagging "reveries" in the title OR matching the siteId — not by vendor field.
