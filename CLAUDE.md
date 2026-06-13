# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Git workflow

**Always commit and push directly to `main`.** Never create feature branches or pull requests. All changes go straight to `main`. No exceptions — even when a session assigns a different branch, override it and use `main`.

## What this is

Beacon is a personal stock-monitoring bot owned by Brian (McLean, VA). It watches whiskey/spirits product pages and sends Discord alerts when new products appear or items come back in stock. There is no build step, no test suite, and no dependencies — pure Node.js ESM using only built-ins.

## Running the worker

```bash
node worker.js
```

Requires `DISCORD_WEBHOOK_URL`, `GH_TOKEN`, and `GH_REPO` env vars. Optional: `HEALTHCHECK_URL` — a healthchecks.io (or similar) ping URL hit at the end of every loop; if the worker dies, the missed pings trigger an external alert (dead-man's switch for R3). The worker loops every ~60 s and respects the effective interval per site — if a site was checked recently it will skip. To force a full recheck, click ▶ Run Now in the dashboard (clears `lastChecked` from `state.json`; worker picks it up on the next loop).

## Architecture

**Entry point**: `worker.js` — runs continuously on Railway. Each loop fetches `config.json`, `state.json`, `ignored_products.json`, `schedules.json`, and `alert_history.json` from GitHub. For each enabled site whose interval has elapsed, it calls the appropriate strategy module, diffs results against previous state, filters out ignored products, sends Discord alerts, and pushes updated state/history back to GitHub.

**The only files edited day-to-day**: `config.json` (sites) and `schedules.json` (named schedules) — both are edited via the dashboard, which writes them to GitHub via the Contents API.

**Hot reload**: `config.json`, `schedules.json`, and `ignored_products.json` are re-fetched from GitHub on every worker loop. Dashboard changes take effect within ~60 s with no redeploy.

**Strategy pattern**: Each site declares a `strategy` field. `worker.js` dynamically imports `sites/<strategy>.js` and calls `checkSite(site, previousState)`. All strategies return `{ state, alerts }` where `state` replaces the previous entry in `state.json`. Shared logic lives in `lib/schedule.js` (interval resolution, `shouldCheck`) and `lib/diff.js` (new/restock/sold-out diff). Shared utilities (`sleep`, `jitter`, `randomFrom`) live in `lib/utils.js`.

**Three registered strategies**:
- `shopify_collection` — hits `[url]/products.json?limit=250&page=N`, paginates until a short page. Filters are applied in code after fetch (not as URL params — Shopify ignores client-side filter params like `rb_vendor` on the JSON API). The `sharedpour_reveries` site uses `url: "https://sharedpour.com"` (store root) with `titleContains: ["Reveries"]` filter because there is no dedicated collection.
- `shopify_storefront` — queries the Shopify Storefront GraphQL API using a public access token and collection GID. Used for `reveries_official` because the Reveries shop embed on thereveries.co uses a Shopify Buy Button backed by a collection that is only published to the Buy Button channel (not Online Store), making the REST `/products.json` API return empty.
- `site_status_monitor` — lightweight Squarespace frontend monitor. Fetches the page HTML and checks for reset signals (`sqs-pw-form`, "coming soon", "enter password", HTTP 401/403). Fires `site_reset` once when transitioning open → blocked; clears silently when the page comes back. Intentionally decoupled from inventory tracking — used alongside `shopify_storefront` for `reveries_official` so both the Shopify backend and the Squarespace frontend are watched independently.

**State persistence**: `worker.js` pushes `state.json` to GitHub via the Contents API (`lib/github.js`) after a changed run. Uses the file's SHA for optimistic concurrency. On 409 conflict it re-fetches the remote state and **merges** — entries the worker touched this loop keep the worker's value (fresher), entries it didn't touch keep the remote value (so a concurrent writer is not silently overwritten). **State-push throttle**: not every changed loop commits. If anything noteworthy happened (any alert/baseline/error/recovery — i.e. `newHistory` is non-empty) the push is immediate; if the only change was routine `checkHistory`/`lastChecked` ticking over, the push is held in memory and flushed at most once per `STATE_PUSH_MIN_INTERVAL_MS` (5 min). Nothing is lost — state always lives in memory; only the dashboard's view lags up to ~5 min (well inside its >10/>20 min "worker late" thresholds). This is the main lever that cut the old per-loop commit spam.

**Check history (PulseStrip data)**: Each site state entry carries a `checkHistory` array of `{ ts, ok }` records — one per check attempt, success or failure — capped at the most recent 100 entries. Populated by `worker.js` on both the success path (`ok: true`) and the error path (`ok: false`). Consumed by the dashboard's per-tile PulseStrip to render the last 60 minutes of activity.

**Consecutive-error alerting**: When a site fails `ERROR_ALERT_THRESHOLD` (currently 5) loops in a row, the worker fires a Discord `site_error` alert (orange) and sets `errorAlertSent: true` on that site's state to suppress repeats. The next successful check clears the flag and fires `site_recovered` (teal).

**Anti-bot / politeness behaviors** (in addition to the long-standing jitter at every level): `lib/fetch.js` holds one browser header profile per hostname for 6–24 h (rotating identity per request from one IP is itself a bot signature); conditional GET (`If-None-Match`/`If-Modified-Since`, stored as `httpValidators` in site state) lets unchanged pages answer 304 with no body — used by `site_status_monitor` always and by `shopify_collection` when the catalog fit one page on the previous check; `shouldCheck()` applies a deterministic per-cycle ±jitter factor (0.9–1.15× interval, skipped in imminent mode) so checks never land on a metronome; and a per-site circuit breaker cools a site down 5→15→60 min after a 429/403 (`cooldownUntil`/`cooldownLevel` in state, cleared on the next success). HTTP errors from `lib/fetch.js` and `shopify_storefront` carry `err.statusCode` for this.

**Startup quiet mode**: any check where the site has no previous state entry (fresh site, or empty/corrupt state.json) records state but suppresses `new_product` alerts, logging a `baseline` history entry instead — prevents a mass false-alert flood (R1). A site whose previous check legitimately saw 0 products still alerts on a 0→N drop.

**Config validation**: the worker validates every config.json site each loop (id present/unique, known strategy, parseable url) and skips invalid entries with a once-per-start Discord warning; the dashboard runs the same checks (`configValidationError`) before any config.json PUT.

**Ignored products**: `ignored_products.json` — a flat object keyed by product handle (`{ "some-handle": true }`). The worker filters matching products from alerts before Discord/history. Ignored products still exist in `state.json` so unignoring never triggers a false "new product" alert. The dashboard writes this file via the GitHub API.

**Scheduling**: `worker.js` loops every ~60 s on Railway; `shouldCheck()` in `lib/schedule.js` gates whether a site is actually fetched. Fixed schedules (`"5"`, `"15"`, `"20"`, `"30"`, `"60"`) parse directly to minutes. Named schedules (e.g. `"working_hours_heavy"`) are resolved by looking up the key in `schedules.json` and evaluating the `rules` array in order (time windows checked against ET hour, first match wins, `defaultInterval` catches everything else). Time windows support midnight-crossing ranges — `{ fromHour: 22, toHour: 9 }` correctly matches 10 pm–9 am. Falls back to `intervalMinutes` if `schedule` is absent or unresolvable. `imminentIntervalMinutes` overrides everything when `imminent: true`. The loop itself tightens from ~60 s to `IMMINENT_LOOP_MS` (~10 s) whenever any enabled site is in imminent mode, so `imminentIntervalMinutes` below 1 minute is actually achievable (the loop is the floor). `schedules.json` is also validated each loop (`validateSchedules`) — malformed definitions are dropped with a once-per-start Discord warning and the valid ones still load.

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

**Alerts**: Discord webhook with rich embeds. Color coded: blue = new product, green = restock, red = sold out, orange = site reset (🌊 — the Reveries password/"coming soon" wall fires *this*), dark orange = site error, teal = site recovered, yellow = imminent timed out. `purple = site changed` is a **reserved** type with a color/label defined but **not currently emitted by any strategy** — kept for a future "page content changed" signal. Rate limit retries are built into `notifiers/discord.js` (429 → parse `retry_after` with JSON fallback → sleep → retry up to 4 times).

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

The dashboard is a single static HTML file fetching raw GitHub files every 2 minutes. Fetches: `state.json`, `alert_history.json`, `config.json`, `ignored_products.json`, `schedules.json`, `reminders.json`.

**Header**: Shows `v0.4 · App update: [date/time] EST` under the Beacon title.

**Sections (top to bottom):**
1. **Sites** — cards for each configured site showing last checked, product count, and three token-gated controls: Schedule dropdown, Monitoring toggle, Imminent toggle. Edits write to `config.json` via the GitHub Contents API. **Edits are confirmed before the UI updates** — a failed write reverts to the previous value rather than showing a stale change. Each card also has a **PulseStrip** — a compact 60-minute activity strip (green circle = success, red diamond = failure, position = time, right edge = now) with a per-tile show/hide toggle persisted in `localStorage` under `beacon_pulse_open`. The strip turns red and pulses when the most recent check is older than `effectiveInterval × 2.5` (stalled); turns amber when any of the last 4 checks failed.
2. **✨ Reveries** — grid of product cards for any product whose title contains "reveries" OR whose siteId is `reveries_official`/`sharedpour_reveries`.
3. **Products** — filterable table with search, site filter, availability filter, and ignored filter.
4. **Alert History** — last 100 alerts, color-coded.

**Header actions**: Refresh, ▶ Run Now (clears `lastChecked` so worker re-checks all sites on next ~60s loop), ⚙ Schedules, GitHub Token, Discord Webhook.

**Drop Reminders sidebar**: A collapsible left drawer (`📅` floating toggle) holding date-ordered drop reminders — a mix of to-do list / scratchpad / calendar-in-list-form for tracking drops on sites Beacon doesn't monitor. Each item has a required date, optional time, text, a done checkbox (strikes through), and a priority flag (★, red accent). Sorted date-ascending (untimed items first within a day). Open/closed state is a per-browser pref in `localStorage` under `beacon_sidebar_open`; the **data is synced to GitHub** in `reminders.json` (`{ items: [...] }`) so reminders appear on every device. Reads use raw URLs (no token needed); add/done/priority/delete write via the Contents API and require the GitHub token (controls disable with a hint when absent). Writes go through `commitReminders(mutate, msg)` — fetch sha → mutate → PUT, retry once on 409, UI updates only after the write succeeds (same write-confirmed discipline as `updateSiteField`). The worker never reads `reminders.json`.

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

**~~Alert history archiving~~** ✅ Done (2026-06-13)
`MAX_HISTORY` is now 500. When `appendAndPushHistory()` trims, the evicted oldest entries are appended to `alert_history_archive.json` (a `MAX_ARCHIVE`-capped 5000-entry file, written best-effort — a failure there logs but never blocks the main history write). The dashboard ignores the archive file.

---

### Features (new capability)

**Collapsible rails + side-panel display mode for Reveries and Pending Bottles**
The left (Drop Reminders) and right (Pending/Collection) rails should be independently collapsible via a toggle button on each rail header. Additionally, a new "side panel" display mode should be available so that Reveries tiles and the Pending Bottles list can optionally float as a persistent side list alongside the main content, instead of living only in the fixed-width rails. Possible approach: a per-panel mode toggle (rail / side-list / hidden) persisted in localStorage; the main `.app` grid reflows to accommodate an open side panel.
- Effort: medium (layout + state management for 3-way mode)
- Risk: low if purely additive; don't disrupt the fixed rail layout for users who don't opt in

**~~Imminent mode: sub-60s floor~~** ✅ Done (2026-06-13, Option A)
`run()` sets `anyImminentActive` from the live config each loop; `startLoop()` then sleeps `IMMINENT_LOOP_MS` (~10 s ± 2 s) instead of ~60 s whenever any enabled site is `imminent: true`, and ~60 s otherwise. Non-imminent sites stay gated by `shouldCheck()`, so they don't over-check during the fast loop.

---

### Infrastructure / security

**Dashboard auth: Cloudflare Access (replace hardcoded password)**
`DASH_PASSWORD = 'beam'` is hardcoded in the public GitHub Pages HTML. Anyone who can read the HTML source has the password. The real risk is the GitHub PAT stored in `localStorage` — accessible to anyone with DevTools access on a shared machine.
- Best option: Cloudflare Access (free for personal use) with Google login. Put the dashboard behind a Cloudflare proxy or move it to Cloudflare Pages. 5-minute setup once Cloudflare is wired up.
- Alternative: move dashboard to own webspace with HTTP basic auth
- ~~Alternative (minimal): stop storing the PAT in localStorage~~ ✅ Done (2026-06-13) — the PAT now lives in `sessionStorage` (cleared on tab/browser close), and any token left in `localStorage` by an older build is migrated to `sessionStorage` and purged on first load. The hardcoded `DASH_PASSWORD = 'beam'` and the Cloudflare Access option remain open.
- Note: Brian's own webspace and Google Workspace are available if hosting needs to move

**Move primary state off GitHub** *(partially mitigated 2026-06-13 — see state-push throttle in Architecture)*
`state.json` is written to GitHub by the worker whenever a site is actually checked. The **state-push throttle** now cuts most of the commit spam: routine checks that only tick `checkHistory`/`lastChecked` are held in memory and flushed at most every `STATE_PUSH_MIN_INTERVAL_MS` (5 min); anything noteworthy (alerts/errors/recovery → `newHistory` non-empty) still pushes immediately. This is a stopgap, not the real fix — full migration options below.
- *Option A (simplest)*: Railway Volume — SQLite or a JSON file on persistent disk. Worker reads/writes directly. Syncs a read-only copy to GitHub every N loops (e.g. every 5 min) for the dashboard. No new services.
- *Option B*: Railway Postgres (free tier) — proper relational storage. More setup but enables future features like query-based history.
- *Option C*: Upstash Redis (free tier) — key-value, very fast, no Railway dependency for storage.
- Recommendation: evaluate Option A first — Railway Volume is already available, no new account/service needed.
- Dashboard impact: dashboard still reads from GitHub raw URLs (the synced copy). No dashboard changes needed.
- Risk: medium complexity. Don't do until Railway is confirmed stable.

---

### Nice-to-have / future research

**~~Alert history cap increase~~** ✅ Done (2026-06-13) — cap raised 250 → 500 alongside the archiving feature.

**HTTP client consolidation (plan — not yet done)**
Four hand-rolled `node:https` clients (`lib/fetch.js`, `lib/github.js`, `sites/shopify_storefront.js`, `notifiers/discord.js`) with inconsistent timeout/retry. `shopify_storefront.js` notably lacks the wall-clock deadline the others have.
- *Plan*: extract a shared `lib/http.js` exposing `httpRequest({ method, url, headers, body, deadlineMs, retry })` that owns the wall-clock-deadline + socket-timeout pattern. Migrate in order of least risk: storefront (smallest, currently disabled) → github → discord (keep its 429/`retry_after` logic) → fetch (keep its browser-identity/profile + conditional-GET layer on top). `lib/fetch.js` stays the "browser-like GET" wrapper; the others become thin callers.
- *Risk*: medium — touches the most load-bearing code; do incrementally, one client per commit, verifying each.

**Decouple datastore from deploy source (plan — not yet done)**
Root cause behind the commit spam, 409 risk, and single-dependency blast radius: GitHub is simultaneously the repo, the config store, and the live DB.
- *Plan, phased*: (1) **done** — state-push throttle (above) removes most routine commits cheaply. (2) Move `state.json` + `alert_history*.json` to a Railway Volume (JSON or SQLite); worker reads/writes the volume directly. (3) Sync a read-only snapshot to GitHub every ~5 min purely for the dashboard's raw-URL reads — dashboard code unchanged. (4) Keep `config.json`/`schedules.json`/`ignored_products.json`/`reminders.json`/`pending_bottles.json` on GitHub (they're human-edited and low-frequency). Net: GitHub stays the editing surface, the volume becomes the hot datastore.
- *Risk*: medium; gated on Railway being confirmed stable. Don't start before phase-1 throttle is proven in production.

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
| ✅ | Startup quiet mode — no-prior-products checks baseline silently instead of mass-alerting (R1) |
| ✅ | `HEALTHCHECK_URL` dead-man ping after every loop + dashboard "worker late/stalled" chip (R3) |
| ✅ | Empty-collection guard re-alerts every 24 h while stuck at 0 instead of going silent (R2) |
| ✅ | Worker + dashboard config.json validation (invalid sites skipped/refused, not silently broken) |
| ✅ | Per-site 429/403 circuit breaker — 5→15→60 min cooldowns (`cooldownUntil` in state) |
| ✅ | Conditional GET (ETag/If-Modified-Since → 304) in `site_status_monitor` + single-page `shopify_collection` |
| ✅ | Stable per-host browser identity (6–24 h) replacing per-request profile rotation |
| ✅ | Deterministic ±jitter (0.9–1.15×) on effective intervals in `shouldCheck()` |
| ✅ | Alert history archiving (`alert_history_archive.json`) + cap raised 250→500 (2026-06-13) |
| ✅ | GitHub-down / token-expiry detection — skips healthcheck + pages Discord after 3 failed config reads (R4, 2026-06-13) |
| ✅ | `schedules.json` validation — malformed definitions dropped + once-per-start Discord warning (2026-06-13) |
| ✅ | Imminent sub-60s floor — loop tightens to ~10s when any site is imminent (2026-06-13) |
| ✅ | State-push throttle — routine `checkHistory`-only changes flushed ≤ every 5 min, noteworthy pushes immediate (2026-06-13) |
| ✅ | Dashboard PAT moved from `localStorage` → `sessionStorage` (cleared on tab close; legacy token migrated + purged) (2026-06-13) |
| ✅ | Storefront API `2024-01`→`2025-01`; `historyFileSha` localized; stale `reveries_squarespace` sandbox value renamed; `handoff/` dir removed (2026-06-13) |


## Known quirks

- Filters in `shopify_collection.js` are applied **after** fetching all pages. A store with thousands of products and a narrow filter will still paginate the full catalog.
- On thereveries.co, the Reveries products on SharedPour (`sharedpour_reveries`) may have a vendor of "SharedPour" rather than "The Reveries". The dashboard handles this by flagging "reveries" in the title OR matching the siteId — not by vendor field.
- If `state.json` is corrupted on GitHub, the worker logs a parse error at startup and runs with empty state — which would re-alert on all existing products. Fix: hand-repair state.json in the repo.

---

## Risk register (biggest fragile points)

**R1 — State corruption → mass false alert flood** *(mitigated 2026-06-12)*
If `state.json` is corrupt or missing at startup, the worker runs with empty state. Startup quiet mode now suppresses `new_product` alerts on any check where the site had no previous state entry at all — the products are baselined silently (logged + a `baseline` history entry, no Discord). Keyed on the entry being absent, not the product map being empty, so a site whose last real check saw 0 products still alerts on a 0→N wave drop.

**R2 — Reveries collection ID changes silently after one alert** *(partially mitigated 2026-06-12)*
`storefrontCollectionId: "367215214747"` in `config.json` is hardcoded. If thereveries.co updates their Shopify Buy Button to a new collection, the strategy returns 0 products and fires `site_reset` — and now re-fires it every 24 h while the collection stays empty (`emptyAlertAt` in state), so a swapped ID nags instead of going permanently silent. Still no automatic recovery: find the new collection ID in page source and update config.json.

**R3 — Railway down = complete monitoring blackout** *(mitigated 2026-06-12)*
Still no backup runner, but two independent detectors now exist: (1) the worker pings `HEALTHCHECK_URL` after every loop — configure a healthchecks.io check (~2 min period, ~5 min grace) and the external service alerts when pings stop, even if the worker is fully dead; (2) the dashboard's worker chip turns "worker late/stalled" when the earliest-due site check is >10/>20 min overdue, schedule-aware. **Setup required**: create the healthchecks.io check and set `HEALTHCHECK_URL` on Railway.

**R4 — GH_TOKEN expiration = silent total failure** *(mitigated 2026-06-13)*
If the fine-grained PAT expires, every `readFile`/`writeFile` call throws and the worker can't read config or persist state. Detection now exists: the worker counts consecutive loops where the top-of-`run()` config read fails (`githubFailureStreak`), and once it hits `GITHUB_FAILURE_THRESHOLD` (3) it (1) **skips the healthcheck ping** so the external dead-man fires — closing the old "healthcheck still green while blind" gap — and (2) **pages Discord directly** (the webhook needs no GH_TOKEN, so it works precisely when GitHub auth is the broken thing). The page is sent once per outage (`githubFailureAlerted`); both flags reset on the first successful config read. Still no auto-recovery of the token itself — rotate the PAT and the worker recovers on the next good read. Check token expiry proactively.

---

## Code debt & small fixes (identified 2026-06-03)

These are not in the main backlog but should be done. Safe to batch into one commit.

| Item | File | What | Risk |
|------|------|------|------|
| ~~D1~~ | `docs/index.html` | ✅ Done (2026-06-13) — the stale `reveries_squarespace` sandbox `<option>` value was renamed to `squarespace`. It was never a worker fallback: the sandbox branch only checks `=== 'shopify_collection'`, so any other value routes to the (still-useful) Squarespace fetch path. | — |
| D2/D3 | `schedules.json` | `weekend_light_20_mins` and `bar_schedule_fi` are now orphaned (no site references them) but are **kept intentionally** for possible future use. As of 2026-06-13 every named schedule (built-in included) is deletable from the dashboard Control Panel, so prune them there if/when no longer wanted. | None |
| ~~D4~~ | `lib/schedule.js` | ✅ Done — stale `checker.js` comment removed. | — |
| ~~D5~~ | `worker.js` | ✅ Done (2026-06-13) — `historyFileSha` is now a local in `appendAndPushHistory`. | — |
| ~~D6~~ | `notifiers/discord.js` | ✅ Done — `postWebhook` has a 10s socket timeout and a 15s wall-clock deadline | — |
| ~~D7~~ | `shopify_storefront.js` | ✅ Done (2026-06-13) — Storefront API bumped `2024-01` → `2025-01` (query uses only stable fields; `reveries_official` is currently disabled). | — |
| D8 | `state.json` / `shopify_collection.js` | Product `tags` arrays stored in state add ~30% file size but are never used post-storage (filters run pre-state). **Still open** — verify the dashboard Products table doesn't display tags before stripping them from the product map. | Low |
