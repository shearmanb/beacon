# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git workflow

**Always commit and push directly to `main`.** Never create feature branches or pull requests. All changes go straight to `main`.

## What this is

Beacon is a personal stock-monitoring bot owned by Brian (McLean, VA). It watches whiskey/spirits product pages and sends Discord alerts when new products appear or items come back in stock. There is no build step, no test suite, and no dependencies — pure Node.js ESM using only built-ins.

## Running the worker

```bash
node worker.js
```

Requires `DISCORD_WEBHOOK_URL`, `GH_TOKEN`, and `GH_REPO` env vars. The worker loops every ~60 s and respects the effective interval per site — if a site was checked recently it will skip. To force a full recheck, click ▶ Run Now in the dashboard (clears `lastChecked` from `state.json`; worker picks it up on the next loop).

## Architecture

**Entry point**: `worker.js` — runs continuously on Railway. Each loop fetches `config.json`, `state.json`, `ignored_products.json`, `schedules.json`, and `alert_history.json` from GitHub. For each enabled site whose interval has elapsed, it calls the appropriate strategy module, diffs results against previous state, filters out ignored products, sends Discord alerts, and pushes updated state/history back to GitHub.

**The only files edited day-to-day**: `config.json` (sites) and `schedules.json` (named schedules) — both are edited via the dashboard, which writes them to GitHub via the Contents API.

**Hot reload**: `config.json`, `schedules.json`, and `ignored_products.json` are re-fetched from GitHub on every worker loop. Dashboard changes take effect within ~60 s with no redeploy.

**Strategy pattern**: Each site declares a `strategy` field. `worker.js` dynamically imports `sites/<strategy>.js` and calls `checkSite(site, previousState)`. All strategies return `{ state, alerts }` where `state` replaces the previous entry in `state.json`. Shared logic lives in `lib/schedule.js` (interval resolution, `shouldCheck`) and `lib/diff.js` (new/restock/sold-out diff). Shared utilities (`sleep`, `jitter`, `randomFrom`) live in `lib/utils.js`.

**Five registered strategies**:
- `shopify_collection` — hits `[url]/products.json?limit=250&page=N`, paginates until a short page. Filters are applied in code after fetch (not as URL params — Shopify ignores client-side filter params like `rb_vendor` on the JSON API). The `sharedpour_reveries` site uses `url: "https://sharedpour.com"` (store root) with `titleContains: ["Reveries"]` filter because there is no dedicated collection.
- `shopify_storefront` — queries the Shopify Storefront GraphQL API using a public access token and collection GID. Used for `reveries_official` because the Reveries shop embed on thereveries.co uses a Shopify Buy Button backed by a collection that is only published to the Buy Button channel (not Online Store), making the REST `/products.json` API return empty.
- `reveries_squarespace` — registered but not currently used by any active site. Primary: fetches `[url]?format=json`. Fallback: parses `<h4>` tags from HTML. Detects page resets via HTTP errors, HTML signals (`sqs-pw-form`, "coming soon"), or zero products when state had products.
- `html_text_monitor` — generic SSR page monitor. Searches for `watchTexts` near an optional `anchorText`.
- `squarespace_json_monitor` — fingerprints Squarespace `?format=json` product data (SHA-256 of titles + variant fields) and fires a `site_changed` alert on any change.

**State persistence**: `worker.js` pushes `state.json` to GitHub via the Contents API (`lib/github.js`) after each changed run. Uses the file's SHA for optimistic concurrency. On 409 conflict it re-fetches the remote state and **merges** — entries the worker touched this loop keep the worker's value (fresher), entries it didn't touch keep the remote value (so a concurrent writer is not silently overwritten).

**Consecutive-error alerting**: When a site fails `ERROR_ALERT_THRESHOLD` (currently 5) loops in a row, the worker fires a Discord `site_error` alert (orange) and sets `errorAlertSent: true` on that site's state to suppress repeats. The next successful check clears the flag and fires `site_recovered` (teal).

**Ignored products**: `ignored_products.json` — a flat object keyed by product handle (`{ "some-handle": true }`). The worker filters matching products from alerts before Discord/history. Ignored products still exist in `state.json` so unignoring never triggers a false "new product" alert. The dashboard writes this file via the GitHub API.

**Scheduling**: `worker.js` loops every ~60 s on Railway; `shouldCheck()` in `lib/schedule.js` gates whether a site is actually fetched. Fixed schedules (`"5"`, `"15"`, `"20"`, `"30"`, `"60"`) parse directly to minutes. Named schedules (e.g. `"working_hours_heavy"`) are resolved by looking up the key in `schedules.json` and evaluating the `rules` array in order (time windows checked against ET hour, first match wins, `defaultInterval` catches everything else). Time windows support midnight-crossing ranges — `{ fromHour: 22, toHour: 9 }` correctly matches 10 pm–9 am. Falls back to `intervalMinutes` if `schedule` is absent or unresolvable. `imminentIntervalMinutes` overrides everything when `imminent: true`.

**Named schedule definitions** (`schedules.json`): A repo-level JSON file mapping schedule IDs to definitions. Each definition has a `label`, optional `builtin: true`, and a `rules` array. Rules are evaluated top-to-bottom; a rule is either a time window `{ fromHour, toHour, interval }` (ET, 24h, supports midnight-crossing) or a default `{ defaultInterval }`. Written by the dashboard via GitHub API; read fresh on every worker loop so schedule changes take effect within ~60 s without a redeploy. Example:
```json
{
  "working_hours_heavy": {
    "label": "⏰ Working Hours Heavy",
    "builtin": true,
    "rules": [
      { "fromHour": 9,  "toHour": 18, "interval": 5   },
      { "fromHour": 18, "toHour": 22, "interval": 20  },
      { "fromHour": 22, "toHour": 9,  "interval": 120 },
      { "defaultInterval": 300 }
    ]
  }
}
```

**Alerts**: Discord webhook with rich embeds. Color coded: blue = new product, green = restock, red = sold out, orange = site reset, dark orange = site error, teal = site recovered, purple = site changed. Rate limit retries are built into `notifiers/discord.js` (429 → parse `retry_after` with JSON fallback → sleep → retry up to 4 times).

## Current monitored sites

| ID | URL | Strategy | Notes |
|----|-----|----------|-------|
| `sharedpour_t8ke` | sharedpour.com/collections/t8ke | shopify_collection | T8KE collection |
| `sharedpour_reveries` | sharedpour.com (filtered by title) | shopify_collection | titleContains: ["Reveries"] |
| `fountain_inn_dc` | shop.fountaininndc.com (filtered by title) | shopify_collection | titleContains: ["Reveries"] |
| `bourbon_concierge` | thebourbonconcierge.com (filtered by title) | shopify_collection | titleContains: ["Reveries"] |
| `reveries_official` | thereveries.co/shop | shopify_storefront | Storefront API via shared-pour.myshopify.com collection 367215214747 |

Disabled (not running):
| `reveries_official_monitor` | thereveries.co/shop | squarespace_json_monitor | Superseded by shopify_storefront; all alerts off |

## Infrastructure

- **Railway** (`worker.js`): the only runner. Loops every ~60 s, pushes state/history to GitHub via Contents API. Env vars: `DISCORD_WEBHOOK_URL`, `GH_TOKEN`, `GH_REPO` (`shearmanb/beacon`). Configured via `railway.json` (`startCommand: node worker.js`). **There is no GitHub Actions backup runner.** If Railway is down, no checks happen until it recovers — watch for `site_error` Discord alerts if Railway dies (you'll get one per active site after 5 consecutive failures).
- **GitHub Pages**: served from `/docs`, password is `beam` (client-side gate, hardcoded in `docs/index.html`). Dashboard auto-refreshes every 2 min by fetching raw files from GitHub. `REPO_OWNER` and `REPO_NAME` constants are set at the top of `docs/index.html`.
- **Default branch**: `main`.
- **GitHub token**: A fine-grained PAT stored in browser localStorage (`beacon_gh_token`). Needs Contents read/write on the `beacon` repo. Required for dashboard write actions: Monitoring toggle, Imminent mode toggle, Schedule dropdown, Ignore/Unignore products, Schedule manager saves, Run Now. Tokens can be created at github.com → Settings → Developer settings → Fine-grained tokens.

## Dashboard features (`docs/index.html`)

The dashboard is a single static HTML file fetching raw GitHub files every 2 minutes. Fetches: `state.json`, `alert_history.json`, `config.json`, `ignored_products.json`, `schedules.json`.

**Header**: Shows `v0.4 · App update: [date/time] EST` under the Beacon title.

**Sections (top to bottom):**
1. **Sites** — cards for each configured site showing last checked, product count, and three token-gated controls: Schedule dropdown, Monitoring toggle, Imminent toggle. Edits write to `config.json` via the GitHub Contents API. **Edits are confirmed before the UI updates** — a failed write reverts to the previous value rather than showing a stale change.
2. **✨ Reveries** — grid of product cards for any product whose title contains "reveries" OR whose siteId is `reveries_official`/`sharedpour_reveries`.
3. **Products** — filterable table with search, site filter, availability filter, and ignored filter.
4. **Alert History** — last 100 alerts, color-coded.

**Header actions**: Refresh, ▶ Run Now (clears `lastChecked` so worker re-checks all sites on next ~60s loop), ⚙ Schedules, GitHub Token, Discord Webhook.

**Config edits**: All site field edits go through `updateSiteField(siteId, field, value, commitMsg)` which fetches `config.json`, mutates the field, PUTs JSON back, and **only updates local UI after the write succeeds**. Eliminates the old class of bug where a failed GitHub write would leave the dashboard showing a value that wasn't actually saved.

## Adding a new site

1. Add a strategy file in `sites/` exporting `checkSite(site, previousState)` returning `{ state, alerts }`.
2. Register the strategy name in the `strategies` map in `lib/strategies.js`.
3. Add the site object to `config.json` (via dashboard or directly in repo).
4. Worker picks it up on its next ~60s loop.

## config.json site object fields

```json
{
  "name": "Human-readable name",
  "id": "snake_case_unique_id",
  "enabled": true,
  "strategy": "shopify_collection",
  "url": "https://...",
  "intervalMinutes": 20,
  "schedule": "20",
  "imminentIntervalMinutes": 2,
  "imminent": false,
  "alertOnNewProduct": true,
  "alertOnRestock": true,
  "alertOnSoldOut": false,
  "filters": {
    "titleContains": [],
    "titleExcludes": [],
    "vendorIs": [],
    "productType": [],
    "tags": [],
    "minPriceDollars": null,
    "maxPriceDollars": null,
    "availableOnly": false
  }
}
```

`schedule` accepts `"5"|"15"|"20"|"30"|"60"` or any key in `schedules.json`. `intervalMinutes` is the fallback when `schedule` is missing or unresolvable. `imminentIntervalMinutes` overrides everything when `imminent: true`.

## Open features (backlog)

- **Site reset detector for thereveries.co** — `reveries_official` (shopify_storefront) detects when the Shopify collection goes empty but does NOT detect when the Squarespace frontend at thereveries.co/shop shows a "COMING SOON" / password-protected page. Need a new lightweight `site_status_monitor` strategy that fetches the HTML and flags `sqs-pw-form`, "coming soon", 401, or password indicators.
- **Surface `consecutiveErrors` / `lastError` on dashboard site cards** — both fields are already in `state.json`; just need to render them.
- **Cloudflare Access for dashboard auth** — replace the hardcoded `DASH_PASSWORD = 'beam'` with Google-login-gated access via Cloudflare. Free for personal use.
- **Move primary state off GitHub** — research Railway volume / Railway Postgres as source-of-truth; periodically sync read-only state.json to GitHub for dashboard. Reduces 409s and write churn.
- **Alert history archiving** — current cap is 250; older entries are evicted. Consider appending evicted entries to a never-trimmed `alert_history_archive.json`.
- **Activate ignore→Discord notifications** — the dashboard sends a Discord embed when a product is ignored/unignored, but the webhook URL must be saved in the browser first (Discord Webhook button in header).

## Known quirks

- Filters in `shopify_collection.js` are applied **after** fetching all pages. A store with thousands of products and a narrow filter will still paginate the full catalog.
- On thereveries.co, the Reveries products on SharedPour (`sharedpour_reveries`) may have a vendor of "SharedPour" rather than "The Reveries". The dashboard handles this by flagging "reveries" in the title OR matching the siteId — not by vendor field.
- If `state.json` is corrupted on GitHub, the worker logs a parse error at startup and runs with empty state — which would re-alert on all existing products. Fix: hand-repair state.json in the repo.
