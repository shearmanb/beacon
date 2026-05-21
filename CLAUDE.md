# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git workflow

**Always commit and push directly to `main`.** Never create feature branches or pull requests. All changes go straight to `main`.

## What this is

Beacon is a personal stock-monitoring bot owned by Brian (McLean, VA). It watches whiskey/spirits product pages and sends Discord alerts when new products appear or items come back in stock. There is no build step, no test suite, and no dependencies — pure Node.js ESM using only built-ins.

## Running the checker

```bash
node checker.js
```

Requires `DISCORD_WEBHOOK_URL` env var to send alerts. Run without it to check silently. The checker respects the effective interval per site — if a site was checked recently it will skip. To force a full recheck, set `state.json` to `{}` before running (will re-alert on all existing products, so only do this intentionally).

## Architecture

**Entry point**: `checker.js` — loads `state.json`, `ignored_products.json`, and `schedules.json`, iterates `config.js` sites, calls the appropriate strategy module, diffs results against previous state, filters out ignored products, sends alerts, writes updated `state.json` and appends to `alert_history.json`.

**The only file edited day-to-day**: `config.js` — add/remove sites, change schedule, flip `imminent: true` on drop days, adjust filters.

**Strategy pattern**: Each site declares a `strategy` field. `checker.js` dynamically imports `sites/<strategy>.js` and calls `checkSite(site, previousState)`. Both strategies return `{ state, alerts }` where `state` replaces the previous entry in `state.json`.

**Two strategies today**:
- `shopify_collection` — hits `[url]/products.json?limit=250&page=N`, paginates until a short page. Filters are applied in code after fetch (not as URL params — Shopify ignores client-side filter params like `rb_vendor` on the JSON API). The `sharedpour_reveries` site uses `url: "https://sharedpour.com"` (store root) with `titleContains: ["Reveries"]` filter because there is no dedicated collection.
- `reveries_squarespace` — primary: fetches `[url]?format=json` (Squarespace JSON API) for clean product data with real stock status. Fallback: parses `<h4>` tags from HTML with `SKIP_STRINGS` filtering. Also detects page resets (Coming Soon / password wall) via HTTP errors, HTML signals (`sqs-pw-form`, "coming soon", etc.), or zero products when state had products — fires a one-time `site_reset` Discord alert and preserves previous state. Does NOT fire the reset alert again on subsequent checks while still in reset state.

**State persistence**: `state.json` is committed back to the repo after every run by `beacon-bot` in the GitHub Actions workflow (`[skip ci]` prevents loops). The push step does `git push || (git pull --rebase && git push)` to handle race conditions between concurrent runs.

**Ignored products**: `ignored_products.json` — a flat object keyed by product handle (`{ "some-handle": true }`). `checker.js` loads this and filters matching products from alerts before Discord/history. Ignored products still exist in `state.json` so unignoring never triggers a false "new product" alert. The dashboard writes this file via the GitHub API.

**Scheduling**: One GitHub Actions cron at `*/5 * * * *` (platform minimum). Each site has a `schedule` field — `checker.js` calls `getEffectiveInterval(site, schedules)` to determine whether enough time has elapsed. Fixed schedules (`"5"`, `"15"`, `"20"`, `"30"`, `"60"`) parse directly to minutes. Named schedules (e.g. `"working_hours_heavy"`) are resolved by looking up the key in `schedules.json` and evaluating the `rules` array in order (time windows checked against ET hour, last rule wins as default). Falls back to `intervalMinutes` if `schedule` is absent or unresolvable. `imminentIntervalMinutes` overrides everything when `imminent: true`.

**Named schedule definitions** (`schedules.json`): A repo-level JSON file mapping schedule IDs to definitions. Each definition has a `label`, optional `builtin: true`, and a `rules` array. Rules are evaluated top-to-bottom; a rule is either a time window `{ fromHour, toHour, interval }` (ET, 24h) or a default `{ defaultInterval }`. The file is written by the dashboard via GitHub API and read by `checker.js` at startup. If absent, `checker.js` falls back to hardcoded logic for `working_hours_heavy`. Example:
```json
{
  "working_hours_heavy": {
    "label": "⏰ Working Hours Heavy",
    "builtin": true,
    "rules": [
      { "fromHour": 9, "toHour": 18, "interval": 5 },
      { "fromHour": 18, "toHour": 22, "interval": 20 },
      { "defaultInterval": 300 }
    ]
  }
}
```

**Alerts**: Discord webhook with rich embeds. Color coded: blue = new product, green = restock, red = sold out, orange = site reset. Rate limit retries are built into `notifiers/discord.js` (429 → parse `retry_after` with JSON fallback → sleep → retry up to 4 times). `notifiers/ntfy.js` is stubbed and disabled.

## Current monitored sites

| ID | URL | Strategy | Schedule | Notes |
|----|-----|----------|----------|-------|
| `sharedpour_t8ke` | sharedpour.com/collections/t8ke | shopify_collection | 20 min | 37 products baselined |
| `sharedpour_reveries` | sharedpour.com (filtered by title) | shopify_collection | 20 min | 1 product: THE DEEP (sold out) |
| `fountain_inn_dc` | shop.fountaininndc.com (filtered by title) | shopify_collection | 30 min | titleContains: ["Reveries"]; The Deep + 8yr expected |
| `bourbon_concierge` | thebourbonconcierge.com (filtered by title) | shopify_collection | 30 min | titleContains: ["Reveries"]; large catalog, Reveries only |
| `reveries_official` | thereveries.co/shop | reveries_squarespace | 30 min | 3 real releases, all sold out |

## Infrastructure

- **GitHub Actions**: `.github/workflows/check.yml` — cron + `workflow_dispatch`. Needs `permissions: contents: write` to commit state back. Commits `state.json`, `alert_history.json`, and `ignored_products.json`. (`schedules.json` is committed by the dashboard via GitHub API, not by the workflow.)
- **GitHub Secret**: `DISCORD_WEBHOOK_URL` — the Discord channel webhook. Never put this in code.
- **GitHub Pages**: served from `/docs`, password is `beam` (client-side gate, hardcoded in `docs/index.html`). Dashboard auto-refreshes every 2 min by fetching raw files from GitHub. `REPO_OWNER` and `REPO_NAME` constants are set at the top of `docs/index.html`.
- **Default branch**: `main`. The cron fires on the default branch — if it ever runs on the wrong branch again, check repo Settings → Default branch.
- **GitHub token**: A fine-grained PAT stored in browser localStorage (`beacon_gh_token`). Needs Contents + Actions read/write on the `beacon` repo. Required for dashboard write actions: Monitoring toggle, Imminent mode toggle, Schedule dropdown, Ignore/Unignore products, Schedule manager saves. Also used to authenticate the version-date fetch (avoids 60 req/hr unauthenticated rate limit). Tokens can be created at github.com → Settings → Developer settings → Fine-grained tokens. The dashboard warns if a saved value doesn't start with `ghp_` or `github_pat_`.

## Dashboard features (`docs/index.html`) — v0.4

The dashboard is a single static HTML file fetching raw GitHub files every 2 minutes. Fetches: `state.json`, `alert_history.json`, `config.js`, `ignored_products.json`, `schedules.json`.

**Header**: Shows `v0.4 · App update: [date/time] EST` under the Beacon title (populated by `fetchLastCodeCommit()` using the GitHub token if available to avoid rate limits). Refresh status shows `Data Last Updated: [date/time] EST (X min ago)` — turns yellow after 5 min, red after 15 min of no successful refresh.

**Sections (top to bottom):**
1. **Sites** — cards for each configured site showing last checked, product count, and three token-gated controls:
   - **Schedule dropdown** — writes `schedule: "..."` to `config.js` via `flipSchedule()`. Options: 5 / 15 / 20 / 30 / 60 min (fixed), named schedules from `schedules.json`, and custom fixed presets from localStorage. When a named schedule is selected, its rule breakdown shows under the dropdown (e.g. `5min 9am–6pm · 20min 6pm–10pm · 300min default`). Last-checked timestamp turns yellow (>2× overdue) or red (>4×).
   - **Monitoring ON/OFF** (green toggle) — writes `enabled: true/false` via `flipEnabled()`
   - **Imminent mode** (yellow toggle) — writes `imminent: true/false` via `flipImminent()`
2. **✨ Reveries** — grid of product cards for any product whose title contains "reveries" OR whose siteId is `reveries_official`/`sharedpour_reveries`
3. **Products** — filterable table with search, site filter, availability filter, and ignored filter. Each row has a purple **✨ Reveries** badge and an Ignore/Unignore button.
4. **Alert History** — last 100 alerts, color-coded. Types: 🆕 New, ✅ Restock, ❌ Sold Out, ⚠️ Reset

**Header actions**: Refresh, ▶ Run Now (token required), ⚙ Schedules (opens schedule manager), GitHub Token (save/clear PAT with format validation).

**Schedule manager modal** (⚙ Schedules button): Two-view modal.
- *List view*: Named schedules (from `schedules.json`) shown with their rule breakdown and Edit button. Built-in named schedules (e.g. `working_hours_heavy`) can be edited but not deleted. Fixed presets (localStorage) shown below with delete. Add fixed preset form at bottom.
- *Edit view*: Label, ID (auto-slugged from label; locked for built-ins), time windows table (from/to hour dropdowns + interval per row, add/remove rows), default interval fallback. Saves to `schedules.json` via GitHub API (`saveSchedulesToRepo()`). New custom named schedules can be added with any ID — `checker.js` will resolve them if they exist in `schedules.json`.

**Config parsing**: `parseConfigSites()` extracts `name`, `id`, `enabled`, `imminent`, `intervalMinutes`, `schedule` via regex. `flipEnabled()`, `flipImminent()`, `flipSchedule()` do line-by-line replacement. All use `escapeRegex()` to safely build RegExp from siteId. All async write handlers use try/finally to guarantee button re-enable.

**Schedule resolution** (dashboard): `getEffectiveInterval(site)` uses `getNamedSchedules()` which returns loaded `schedules` global if populated, else falls back to `DEFAULT_NAMED_SCHEDULES` (hardcoded `working_hours_heavy`). `getScheduleOptions()` merges fixed built-ins + named schedules + localStorage presets. `safeBtoa()` handles unicode labels when saving to GitHub API.

**Security**: All product titles, URLs, site names, and external strings are passed through `esc()` before `innerHTML` insertion to prevent XSS.

## Adding a new site

1. Add a strategy file in `sites/` exporting `checkSite(site, previousState)` returning `{ state, alerts }`.
2. Register the strategy name in the `strategies` map in `checker.js`.
3. Add the site object to `config.js` — include a `schedule` field.
4. Run once manually to establish the baseline before alerts go live.

## config.js site object fields

```js
{
  name: "Human-readable name",
  id: "snake_case_unique_id",
  enabled: true,                    // false = skip entirely (togglable from dashboard)
  strategy: "shopify_collection",   // or "reveries_squarespace"
  url: "https://...",
  intervalMinutes: 20,              // fallback if schedule is absent
  schedule: "20",                   // "5"|"15"|"20"|"30"|"60" or any key in schedules.json (changeable from dashboard)
  imminentIntervalMinutes: 2,       // reserved for future sub-5-min worker; overrides schedule when imminent: true
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

- **⚠️ TODO (one-time setup): activate ignore→Discord notifications** — the dashboard now sends a Discord embed when a product is ignored/unignored, but the webhook URL must be saved in the browser first. Open the dashboard → click **Discord Webhook** in the header → paste in the Discord webhook URL (same one stored in the `DISCORD_WEBHOOK_URL` GitHub secret). Saved to `localStorage`; only needs to be done once per browser.

- **Wild Turkey Gold Foil Edition monitor** — site entry already added to `config.js` (disabled) using the `html_text_monitor` strategy. Two things needed before enabling: (1) confirm the button text ("SEE DETAILS" → "ADD TO CART" etc.) appears in raw page source (View Source, not DevTools Elements) — if not, the page is JS-rendered and plain fetch won't see it; (2) if JS-rendered, open DevTools → Network, reload the page, and find the API call that returns product availability — use that URL as the `url` in config instead. The `monitor.watchTexts` and `monitor.alertValues` arrays in config.js are already set up; just flip `enabled: true` once the right URL is confirmed.

- **Add site wizard (feature 3)** — modal form in the dashboard to add a new site to `config.js` via GitHub API. Fields: name, ID (auto-slugged from name), strategy dropdown, URL, schedule, filters. Tricky part: serializing a JS object back into `config.js` format cleanly. Deferred — for small numbers of new sites, direct edits to `config.js` are simpler.

- **Move checker to persistent process (feature 4)** — GitHub Actions `*/5` cron is unreliable (15–80 min delays are common under load). True every-minute checking requires a persistent Node.js process running `setInterval(run, 60_000)` on an always-on host. **Fly.io free tier** is the recommended target: 3 shared-CPU VMs stay running (no sleep), `fly secrets set` for env vars, deploy via CLI. Render free tier sleeps after 15 min of inactivity (paid $7/mo needed). Changes required: add `fly.toml`, convert `checker.js` exit-after-one-run model to a loop, keep all GitHub state push logic as-is. The `imminentIntervalMinutes` field on each site is already wired for sub-5-min overrides and would activate automatically once the process runs on a tight loop.

## Known quirks

- The `package.json` warning about `MODULE_TYPELESS_PACKAGE_JSON` should not appear — `"type": "module"` is set. If it reappears, the cron may have switched to the wrong branch.
- Squarespace `?format=json` is the primary data source for `reveries_official`. If it ever stops returning product data, the HTML fallback (`<h4>` parsing with `SKIP_STRINGS`) kicks in — but the fallback cannot determine stock status and always marks products as available.
- Filters in `shopify_collection.js` are applied **after** fetching all pages. A store with thousands of products and a narrow filter will still paginate the full catalog.
- On thereveries.co, the Reveries products on SharedPour (`sharedpour_reveries`) may have a vendor of "SharedPour" rather than "The Reveries". The dashboard handles this by flagging "reveries" in the title OR matching the siteId — not by vendor field.
- If `state.json` is corrupted (bad JSON, merge conflict markers), `checker.js` aborts with a clear error rather than silently treating it as empty state — prevents re-alerting all known products. Fix: delete or repair `state.json` manually.
