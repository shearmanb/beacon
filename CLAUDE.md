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

**Three registered strategies**:
- `shopify_collection` — hits `[url]/products.json?limit=250&page=N`, paginates until a short page. Filters are applied in code after fetch (not as URL params — Shopify ignores client-side filter params like `rb_vendor` on the JSON API). The `sharedpour_reveries` site uses `url: "https://sharedpour.com"` (store root) with `titleContains: ["Reveries"]` filter because there is no dedicated collection.
- `shopify_storefront` — queries the Shopify Storefront GraphQL API using a public access token and collection GID. Used for `reveries_official` because the Reveries shop embed on thereveries.co uses a Shopify Buy Button backed by a collection that is only published to the Buy Button channel (not Online Store), making the REST `/products.json` API return empty.
- `site_status_monitor` — lightweight Squarespace frontend monitor. Fetches the page HTML and checks for reset signals (`sqs-pw-form`, "coming soon", "enter password", HTTP 401/403). Fires `site_reset` once when transitioning open → blocked; clears silently when the page comes back. Intentionally decoupled from inventory tracking — used alongside `shopify_storefront` for `reveries_official` so both the Shopify backend and the Squarespace frontend are watched independently.

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
| `reveries_site_status` | thereveries.co/shop | site_status_monitor | Squarespace frontend status — fires site_reset if COMING SOON / password wall detected |
| `reveries_official` | thereveries.co/shop | shopify_storefront | Storefront API via shared-pour.myshopify.com collection 367215214747 |

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

## Feature backlog & to-do list

Items are grouped by effort/type. "Done" section captures what was completed so context isn't lost across sessions.

---

### Quick wins (low effort, high value)

**Activate ignore→Discord notifications** *(one-time browser setup)*
The dashboard already sends a Discord embed when a product is ignored or unignored, but it reads the webhook URL from `localStorage` — not from an env var. Nothing happens until you do the setup.
- Open dashboard → click **Discord Webhook** in the header → paste the same URL that's in the `DISCORD_WEBHOOK_URL` Railway env var → Save
- One-time per browser. That's it.

**Alert history archiving**
History is hard-capped at 250 entries in `alert_history.json`. When entry 251 arrives, entry 1 is permanently gone. Fix: when trimming, append the evicted entries to `alert_history_archive.json` (separate file, never trimmed, dashboard ignores it).
- Effort: ~30 min (small change in `appendAndPushHistory()` in `worker.js`)
- Risk: none — additive change, archive file starts empty

---

### Features (new capability)

**Dashboard: Railway health indicator**
There is no GitHub Actions fallback anymore. If Railway dies, nothing checks until it recovers. The site cards go red after 4× their interval, but there's no single header-level "is the worker alive?" signal.
- Add a "Last run: X min ago" line to the header, derived from the most-recent `lastChecked` timestamp across all enabled sites in `state.json`
- Color it yellow after 10 min, red after 20 min — independent of any per-site schedule
- Effort: ~1 hr (dashboard-only change, no worker changes)
- Risk: none — read-only display

**Imminent mode: sub-60s floor**
`imminentIntervalMinutes: 2` is currently floored at ~60s by the worker loop. During a drop you want to check every 2 minutes, not every 60s. Two options:
- *Option A (simple)*: when any enabled site has `imminent: true`, reduce the loop sleep from ~60s to ~10s. All sites still respect `shouldCheck()` so non-imminent sites don't over-check.
- *Option B (precise)*: inner fast-loop that only runs imminent sites; outer loop handles everything else. More code, more precise.
- Recommendation: Option A first — it's one line change in `startLoop()` and gets you to ~10s effective floor with no new complexity.
- Risk: low. The 10s floor only applies when at least one site is in imminent mode.

---

### Infrastructure / security

**Dashboard auth: Cloudflare Access (replace hardcoded password)**
`DASH_PASSWORD = 'beam'` is hardcoded in the public GitHub Pages HTML. Anyone who can read the HTML source has the password. The real risk is the GitHub PAT stored in `localStorage` — accessible to anyone with DevTools access on a shared machine.
- Best option: Cloudflare Access (free for personal use) with Google login. Put the dashboard behind a Cloudflare proxy or move it to Cloudflare Pages. 5-minute setup once Cloudflare is wired up.
- Alternative: move dashboard to own webspace with HTTP basic auth
- Alternative (minimal): stop storing the PAT in localStorage; require it to be pasted each session — eliminates the main risk with zero infra change
- Note: Brian's own webspace and Google Workspace are available if hosting needs to move

**Move primary state off GitHub**
`state.json` is written to GitHub ~every 60s by the worker (one commit per loop when anything ran). This pollutes commit history, creates 409 conflict risk when the dashboard also writes, and adds ~200–300ms GitHub API latency to every loop.
- *Option A (simplest)*: Railway Volume — SQLite or a JSON file on persistent disk. Worker reads/writes directly. Syncs a read-only copy to GitHub every N loops (e.g. every 5 min) for the dashboard. No new services.
- *Option B*: Railway Postgres (free tier) — proper relational storage. More setup but enables future features like query-based history.
- *Option C*: Upstash Redis (free tier) — key-value, very fast, no Railway dependency for storage.
- Recommendation: evaluate Option A first — Railway Volume is already available, no new account/service needed.
- Dashboard impact: dashboard still reads from GitHub raw URLs (the synced copy). No dashboard changes needed.
- Risk: medium complexity. Don't do until Railway is confirmed stable.

---

### Nice-to-have / future research

**Alert history cap increase**
Current cap is 250. Raising to 500 costs nothing — each entry is ~300 bytes, total file stays under 200 KB. Do at the same time as the archiving feature above.

**Google Workspace / webspace integration**
- Own webspace could host the dashboard with proper server-side auth (nginx basic auth, or behind Cloudflare)
- Google Workspace email as a secondary alert channel alongside Discord (useful if Discord is down during a drop)
- Neither is urgent — Discord has been reliable

**Dashboard sandbox mode**
The dashboard already has a Sandbox section for testing site checkers (Shopify/Squarespace). This could be expanded to: (a) preview what a new site config would return before adding it to `config.json`, or (b) test schedule rule sets against the current ET time before saving.

---

### Completed (session log — do not re-implement)

These were completed during the Phase 1 / Phase 2 sessions. Listed so future Claude sessions don't suggest them as improvements.

| Done | What |
|------|------|
| ✅ | `lib/utils.js` — centralized `sleep`, `jitter`, `randomFrom` |
| ✅ | `lib/fetch.js` — 30s wall-clock deadline (guarded mid-body stalls) |
| ✅ | `config.js` → `config.json` migration |
| ✅ | Worker hot-reloads `config.json` every loop (no Railway redeploy needed for site changes) |
| ✅ | State push merge on 409 conflict (worker's touched sites win; remote wins for everything else) |
| ✅ | Consecutive-error Discord alerts: `site_error` (orange) after 5 failures, `site_recovered` (teal) on first success |
| ✅ | Dashboard `updateSiteField()` — write-confirmed config edits (UI only updates after GitHub PUT succeeds) |
| ✅ | `consecutiveErrors` / `lastError` surfaced on site cards (red error banner) |
| ✅ | Alert history cap 200 → 250 |
| ✅ | Deleted `checker.js` and GitHub Actions workflow (Railway is sole runner) |
| ✅ | Deleted `notifiers/ntfy.js` |
| ✅ | Deleted dead strategy files: `reveries_squarespace`, `squarespace_json_monitor`, `html_text_monitor` |
| ✅ | Deleted `wild_turkey_gold_foil` and `reveries_official_monitor` from config |
| ✅ | Fixed Fountain Inn DC schedule: `weekend_light_20_mins` → `bar_schedule_fi` |
| ✅ | New `site_status_monitor` strategy — detects COMING SOON / password wall at thereveries.co/shop |
| ✅ | New `reveries_site_status` site entry using `site_status_monitor` |


## Known quirks

- Filters in `shopify_collection.js` are applied **after** fetching all pages. A store with thousands of products and a narrow filter will still paginate the full catalog.
- On thereveries.co, the Reveries products on SharedPour (`sharedpour_reveries`) may have a vendor of "SharedPour" rather than "The Reveries". The dashboard handles this by flagging "reveries" in the title OR matching the siteId — not by vendor field.
- If `state.json` is corrupted on GitHub, the worker logs a parse error at startup and runs with empty state — which would re-alert on all existing products. Fix: hand-repair state.json in the repo.

---

## Risk register (biggest fragile points)

**R1 — State corruption → mass false alert flood (highest operational risk)**
If `state.json` is corrupt or missing at startup, the worker runs with empty state and re-alerts every known product as "new." 37+ T8KE products alone = 37 Discord alerts in seconds. Fix: startup quiet mode — skip alert generation on first run per site when state was empty at load time. Not yet implemented.

**R2 — Reveries collection ID changes silently after one alert**
`storefrontCollectionId: "367215214747"` in `config.json` is hardcoded. If thereveries.co updates their Shopify Buy Button to a new collection, the strategy returns 0 products, fires one `site_reset` alert, then goes permanently silent. You'd miss a drop. No automatic recovery. Manual fix: find new collection ID in page source and update config.json.

**R3 — Railway down = complete monitoring blackout**
No backup runner. If Railway crashes and `restartPolicyMaxRetries: 10` is exhausted, all checks stop silently. First Discord alert comes after 5 consecutive failures per site (~100 min on a 20-min schedule). During a Reveries drop this is catastrophic.

**R4 — GH_TOKEN expiration = silent total failure**
If the fine-grained PAT expires, every `readFile`/`writeFile` call throws. The worker increments `consecutiveErrors` per site and eventually fires `site_error` alerts — but those alerts can't update state either. Worker continues running but is fully broken. No specific token-expiry detection. Check token expiry proactively.

**R5 — No timeout on Discord webhook POST**
`notifiers/discord.js` `postWebhook()` has no `req.setTimeout()`. If Discord's endpoint stalls, the worker loop hangs indefinitely at that point. All other HTTP code in the project has timeouts. Easy fix: add `req.setTimeout(10000, ...)`.

---

## Code debt & small fixes (identified 2026-06-03)

These are not in the main backlog but should be done. Safe to batch into one commit.

| Item | File | What | Risk |
|------|------|------|------|
| D1 | `docs/index.html:374` | Remove dead `reveries_squarespace` sandbox option — strategy was deleted | None |
| D2 | `schedules.json` | `weekend_light_20_mins` is a named schedule whose only rule is `defaultInterval: 20` — identical to the fixed `"20"` preset. Replace with `"schedule": "20"` on the 4 sites that use it, delete the entry. | None |
| D3 | `schedules.json` | `bar_schedule_fi` has an unreachable `defaultInterval` rule — the midnight-crossing window above it matches all remaining hours. Remove the dead rule. | None |
| D4 | `lib/schedule.js:1` | Stale comment references deleted `checker.js` | None |
| D5 | `worker.js:21` | Module-level `historyFileSha` is dead state — `appendAndPushHistory` always re-fetches fresh SHA and never reads this var. Remove it. | None |
| D6 | `notifiers/discord.js` | Add `req.setTimeout(10000, ...)` to `postWebhook` — only HTTP path in the project without a timeout | None |
| D7 | `shopify_storefront.js:4` | Shopify API version is `2024-01` — aging. Bump to `2025-01` and verify response shape unchanged. | Low |
| D8 | `state.json` / `shopify_collection.js` | Product `tags` arrays stored in state add ~30% file size but are never used post-storage (filters run pre-state). Consider stripping tags from the product map before storing. Verify dashboard doesn't display tags before doing this. | Low |
