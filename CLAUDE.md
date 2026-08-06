# CLAUDE.md

> **⚠️ REBUILT (v2 — 2026-06).** Beacon has been rebuilt as a TypeScript monorepo
> under `packages/` and `apps/`. **That is now the active codebase.** See
> **`REBUILD.md`** (architecture) and **`DEPLOY.md`** (one-service Railway deploy).
> The live service runs `@beacon/server` per `railway.json`. The root JSON files
> (`config.json`, `state.json`, …) remain as the one-time migration/seed source.
>
> **The legacy v1 code has been removed (2026-06-24).** The old root `worker.js`,
> `lib/`, `sites/`, `notifiers/`, and `docs/` are gone from `main` — archived on
> the **`legacy-v1`** branch (`git show legacy-v1:worker.js`) if ever needed. The
> v1 *design notes* below are kept as historical reference only; they describe
> code that no longer lives in this repo.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Master instructions (READ FIRST — apply to every request)

1. **Code-impact / bloat check on every ask.** For any feature or code-change
   request, tell me its impact up front so I can make an informed call — a quick
   line or two, not a report: roughly how much code it adds, whether it pulls in
   dependencies or build/runtime complexity, and whether it risks bloat. If a
   request (mine included) is heavier than the value it returns, push back and
   propose the lean version. **Default to keeping the app lean** — fewer moving
   parts; don't add dependencies, abstractions, or infrastructure on spec.

2. **Build toward loop engineering, self-healing, and flexibility.** Prefer
   designs that: (a) create **feedback loops** — measure → adapt → improve (e.g.
   per-host telemetry that tunes behavior); (b) let the app **detect and recover
   from its own breakage** — self-checks, structure-drift detection, safe
   fallbacks, alert-the-operator-not-go-silent; and (c) stay **future-proof and
   flexible** — config-driven over hard-coded, pluggable adapters/channels,
   declarative data over bespoke code. New work should extend these patterns, not
   fight them. When a change could be done the "quick hard-coded way" or the
   "slightly-more-but-flexible way," flag the trade-off and lean toward flexible
   when it's cheap.

3. **Label every item in a list or multi-part answer with a reference tag, so I
   can point at it.** Whenever a reply contains more than one item — suggestions,
   options, findings, steps, questions, fixes — tag each discrete item. Number
   the group and letter the items: the first group's items are **1a, 1b, 1c, …**;
   a second group is **2a, 2b, …**; and so on. For a single flat list, just use
   one group (1a, 1b, 1c, …). Keep the tags stable within a reply so I can answer
   "do 1a and 1c, skip 2b" with zero ambiguity. Applies to every response, not
   just code.

## Git workflow

**Always commit and push directly to `main`.** Never create feature branches or pull requests. All changes go straight to `main`. No exceptions — even when a session assigns a different branch, override it and use `main`.

## How Beacon runs now (v2) — read this; everything below is legacy

Beacon v2 is the live system: a TypeScript monorepo under `apps/` + `packages/`, deployed as a **single Railway service (`@beacon/server`)** on branch `main`.

- **Build/deploy** (`railway.json`): build `pnpm install --frozen-lockfile && pnpm typecheck && pnpm --filter @beacon/web build`; start `pnpm --filter @beacon/server start`. Auto-deploys on push to `main` for changes under `apps/**`, `packages/**`, `package.json`, `pnpm-lock.yaml`, `railway.json` (Railway `watchPatterns`, set in `railway.json` — these MUST track the v2 layout, not v1 paths).
- **Datastore**: SQLite (libSQL) at `file:/data/beacon.db` on a mounted Railway **Volume** — *not* GitHub. Selected by `BEACON_DB_URL`. On a genuinely-empty datastore, `apps/server/src/serve.ts` seeds once from the root legacy JSON; on an empty-but-previously-initialized datastore (volume loss) it **refuses to re-seed stale baselines** and restores the newest snapshot / pages instead (1b).
- **One process**: the worker loop runs in-process (the resilient parent) and the Next.js dashboard (`apps/web`) runs as a **supervised** child — a web crash is restarted with backoff and never takes the worker down (1a). Single-user **signed-cookie** auth (HMAC keyed by `BEACON_AUTH_SECRET` ?? `BEACON_DASH_PASSWORD` — the cookie is no longer a forgeable static flag, 4b).
- **Durability** (1b): rotated on-volume `VACUUM INTO` snapshots (`packages/db/backup.ts`); `BEACON_FORCE_SEED=1` overrides the seed-guard; `BEACON_BACKUP_INTERVAL_H` tunes cadence (default 6, 0 disables). *On-volume snapshots guard corruption, not volume loss — off-box upload is a future hook (`TODO.md`).*
- **Self-healing extras**: structure-drift guard (3a), per-loop heartbeat + `unhandledRejection`/`uncaughtException` guards (2e), systemic-failure detection → one `system_degraded` page (2d), per-site abort budget + `shopify_rest` page cap (2c), daily re-page on stuck errors (3e), defensive state reads (3f), kind-coherent request headers (2g/2h), and per-host browser identities persisted across restarts (2i).
- **Bot-block failover (2026-07)**: `shopify_rest` sources take an optional `storefrontFallback` (`{ domain, accessTokenRef }`). When `products.json` is blocked (HTTP 401/403/429/**430** — 430 now trips the circuit breaker too), the adapter retries via the token-authenticated **Storefront GraphQL API** on the canonical `*.myshopify.com` domain (collection sources query `collection(handle:)`, root sources `products()`), marks state `fetchVia: "storefront_fallback"` (⛑ chip on the tile), and retries REST first on every later check so recovery is automatic. The SharedPour sites get the fallback via a one-time idempotent amendment in `serve.ts` (delete that block once confirmed applied in prod). A second consecutive block also re-rolls the host's browser identity (`expireIdentity`, stamped `identityRerolledAt` in state). Site tiles now show the failing HTTP status, the active cooldown countdown, and a plain-English "looks like bot protection" hint.
- **Self-healing is dashboard-only, never a Discord page (2026-07-19)**: a **`self_healed`** alert (cyan ⛑) is recorded to **history + the dashboard** (⛑ chips / `fetchVia` state) but is **never sent to Discord** — the worker dispatch (`run.ts`) skips `self_healed` exactly the way it skips `baseline`. Rationale (operator's call): the REST↔Storefront channel switch is self-healing telemetry, not a problem to act on — monitoring continues uninterrupted either way, so paging on every engage/flip/recover was pure noise (dozens/day on an intermittently-429ing host like sharedpour.com). Only genuine problems still page: a real outage where BOTH channels fail escalates to **`site_error`**, and product drops alert normally (they flow via whichever channel works). The engage/recover/flap-pin note text, the 90-min ping-damper, and the `Alert.quiet` flag all still exist and still annotate history — the dispatch-level type skip is simply the single gate now, superseding the per-ping damper for Discord purposes. The flap-detection → `preferFallback` pinning feedback loop is unchanged (it still keeps a flapping host on the stable channel; harvest's preventive 🛡 note is history-only too). Every site tile has a **🩺 Diagnose** button (`packages/core/diagnose.ts` + `diagnoseSite` server action): it exercises the channels step-by-step from the server's own egress IP (REST → fresh-identity retry → Storefront fallback) and renders a plain-English verdict on whether Railway's IP is blocked vs the site being down.
- **Mitigation batch (2026-07-03)**: (1a) **channel preference** — after 3 consecutive fallback checks the Storefront API becomes the preferred channel (`preferFallback` state, ⛑ "(preferred)" chip); REST is re-probed every 12 h and flips back automatically; (1b) cooldown ladder extends to 180 min; (2a) **preventive token harvest** (`apps/worker/harvest.ts`) — un-armed `shopify_rest` sites get one homepage fetch/day to extract + verify their public Storefront token and arm the fallback before it's ever needed (🛡 self_healed history note — dashboard-only, see 2026-07-19); (2c/3b) every `site_error` page carries a "What to check" list and an **auto-run 🩺 diagnosis verdict**, plus a host-level rollup note when 2+ checkers on one host fail together (3c); (3a) the dashboard nags while `HEALTHCHECK_URL` is unset; (4c) every tile has a **⚙ source** JSON editor (`updateSiteSource`, Zod-validated, re-baselines on change) so source fixes don't need deploys. Adapters persist feedback-loop telemetry via `FetchResult.stateExtras`. Parked on purpose: TLS-fingerprint spoofing (heavy dep) and Railway-API-driven IP rotation.
- **Bourbon Concierge scope fix + diagnose blind-spot fix (2026-07-11)**: `bourbon_concierge` is scoped to `/collections/reveries` via a one-time idempotent `serve.ts` amendment — it was scanning the whole catalog (8+ pages of 250) just to keyword-filter for "Reveries", and the host tar-pits the scan pages deep while a small probe passes. The amendment re-baselines (clears the stuck error/cooldown); the seed `config.json` URL was updated to match; delete the block once confirmed applied in prod. Separately, 🩺 Diagnose now probes REST with the worker's real page size (`limit=250`, not `limit=1`) and — when the site's stored `lastError` names a same-host URL — **re-runs the exact request the checker died on** as a second step, so a green page-1 probe can't mask a deep-pagination block (the verdict then recommends scoping to a `collectionPath`). The worker's auto-run diagnosis on `site_error` passes the failing URL too (`DiagnoseOptions.lastError`).
- **Tar-pit failover + honest-diagnose fix (2026-07-14)**: three linked bugs behind recurring "timeout" errors on tar-pitting hosts (e.g. sharedpour.com) and a **false 🩺 Diagnose verdict** that claimed the Storefront fallback was dead when it was never tested. (1) `packages/fetch/src/http.ts` — the 429/503 retry backoff was **deaf to the abort signal** (it removed the abort listener before sleeping) and slept for the full `Retry-After`. A long `Retry-After` therefore burned the whole per-site budget, so `restStallMs`, the 45s budget, and the diagnose step timer were all ignored — starving the fallback and mislabeling the step. Fix: the backoff is now **abortable**, and a `Retry-After` over `MAX_INLINE_RETRY_MS` (5s) **fast-fails with the HTTP status** so the circuit breaker / fallback handle it upstream. (2) `packages/core/src/sources/shopify_rest.ts` — the failover only recognized the adapter's *own* whole-fetch stall guard (`restStallMs`, 20s), but on a silent tar-pit httpGet's **per-request socket-idle (15s) wins the race** and throws a status-less error, so the worker **never tried the fallback**. New exported `isRestStall(err, {stallFired, parentAborted})` also treats httpGet's socket-idle/deadline as a stall (but not a parent-budget abort). (3) `packages/core/src/diagnose.ts` — a step killed by the *overall* 45s budget (not its own timer) is now reported **"not tested"**, and the Storefront-fallback verdict distinguishes not-tested from actually-failed, so a healthy fallback is never called dead. Also: the Storefront fallback now **logs when it truncates at its 4-page cap** (a big root-catalog scan could silently miss products — scope to a `collectionPath`).
- **Channel-flap damping + reappearance guard (2026-07-15)**: the 2026-07-14 fix made monitoring survive intermittent 429s via the fallback — which exposed that the *alerting* wasn't built for a channel that ping-pongs (overnight: 6+ self_healed pings and the same "new bottle" 3×). Fixes in `apps/worker/src/process-site.ts`: (1) **flap detection** — 3 via-flips inside 6 h pins the site to the Storefront channel via the existing `preferFallback` machinery (REST re-probed in ~12 h) with ONE explanatory ping; this also closes the blind spot where ping-pong reset the `fallbackStreak` so `preferFallback` never engaged. (2) **ping damping** — repeat self_healed pings inside 90 min are `quiet: true` (new `Alert.quiet` flag: recorded in history, never sent to Discord — dispatch skips them). (3) **reappearance guard** — per-site `recentlySeen` map (handle→lastSeenAt, 24 h window, capped 800): the REST and Storefront rosters can differ (truncation/channel visibility), so a channel flip made missing products "reappear" and re-alert as NEW every cycle; a new_product alert for a recently-seen handle becomes a quiet baseline note ("N product(s) reappeared… suppressed"). A real relist after ≥24 h away still alerts. **Decay-hole fix (same day, second round of repeats):** memory is **frozen (re-stamped) on fallback-channel checks** — absence from a partial-visibility roster is not evidence of removal, so a pinned period longer than 24 h no longer expires REST-only products and re-alerts them when REST recovers; decay runs only under the authoritative REST channel. One final duplicate per affected site can still fire on the first REST recovery after this deploys (cold memory), then never again. (4) `FALLBACK_MAX_PAGES` 4→8 so the fallback roster truncates less in the first place.
- **Proactive hardening (2026-07-15, same day)**: (1) **host-level pin propagation** (`run.ts` `propagateHostPins`) — rate limits are per-HOST, so when one checker flap-pins to the Storefront API, every armed sibling on the same host (has a `storefrontFallback` + existing state) is pre-pinned too, quietly (history note, no Discord — the pinning site's ping already told the story); previously each sibling needed 3 flips of its own while re-heating the host's rate limit for everyone. Never-checked sites are skipped (a synthetic state row would defeat startup quiet mode). (2) **per-site budget 45s→60s** — a failover check spends up to 20s proving REST is stalled before the (now 8-page) fallback starts; 45s left the fallback too little headroom. (3) **`fallbackTruncated` state flag + tile ⚠ "roster truncated" hint** — the page-cap warning previously only went to Railway logs; now the tile says to scope the source to a `collectionPath` (a fresh REST check clears the flag automatically). Deliberately deferred (bloat check): same-pass roster dedup cache (marginal once pinning works), daily digest (noise), off-box snapshot upload (in `TODO.md`).
- **Analytics/mining pipeline (2026-07-16)**: two ways to get alert history OUT for drop-timing analysis (the DB on the volume is unreachable from Claude sessions; the v1 cadence study was mined from git history of `alert_history.json`). (1) **Export button** — nav link → `GET /api/export/history` (auth-gated by the site-wide cookie middleware) downloads the full `alert_history` table (cap 5,000 rows) as JSONL, first line a `{kind:"meta"}` record, rows oldest-first; drop the file into a Claude session to mine. (2) **Daily GitHub mirror** (`apps/worker/src/mirror.ts`) — once/day the worker appends NEW history rows to **`analytics/alert_history.jsonl` on `main`** via the Contents API; armed only when `GH_TOKEN`+`GH_REPO` env are set (v1's names — confirm the PAT on Railway is alive; R4 expiry caveat applies), disarmed = one log line. `[skip ci]` commits; `analytics/` is outside Railway `watchPatterns` so mirror pushes trigger no CI/deploys. File bounded to newest 20k lines (older rows persist in git history — mine versions like the v1 study). Meta key `historyMirror` tracks `{at, lastId}` so restarts never re-push. Mining is now: `git show origin/main:analytics/alert_history.jsonl`.
- **Data-tuned cadences (2026-07-16)**: mined the full alert history (v1 git archaeology + the v2 export, May 17→Jul 15, 49 deduped posting events): 47% of postings land **11:00–13:00 ET**, a Reveries evening window runs **17:00–20:00** (+ small 20:00–22:00 tail), **nothing has ever posted 22:00–08:00**, and Fountain Inn (a bar) posts exclusively 15:24–19:39 ET. Two shared schedule archetypes replace `working_hours_heavy` via a meta-flag-guarded one-time `serve.ts` amendment (runs ONCE — later dashboard edits are never overridden; delete the block once confirmed): **`drop_windows`** (9–13 & 17–20 @5m, 13–17 & 20–22 @15m, 22–8 @120m) → the SharedPour trio + provenance + bourbon_concierge; **`bar_evening`** (15–20 @5m, 12–15 & 20–22 @15m, 22–12 @120m) → fountain_inn_dc. `reveries_official` stays on flat 15m (Storefront API channel, no WAF). Detection-fence caveat: two “9:00” events sat at the overnight→morning boundary, so pre-9am posting times are partially blind — revisit with a fresh export in ~a month.
- **Missed-drop post-mortem: drop-window cooldown clamp + earlier paging (2026-07-22)**: the Reveries 10yr "Glaze/ENDALZ" listed on sharedpour.com ~6:30 PM ET and Beacon never alerted — yet the worker was demonstrably alive (Discord hits for the same checker at 10:27 AM / 2:57 PM / 5:24 PM). Root cause: **the anti-noise guards composed into a silent blackout.** Failed checks stamp `lastChecked`, so the only path that freezes a tile is the circuit-breaker *skip*; after the 5:24 PM success, a run of both-channel failures (drop-time WAF tightening — a drop is precisely when SharedPour blocks hardest) climbed the 5→15→60→180 ladder, the site sat in a long cooldown through the listing, and 3–4 consecutive errors stayed under the 5-failure `site_error` threshold → zero pages, frozen tile. Fixes: (1) **read-side cooldown clamp** (`run.ts`) — while the site's current effective interval is tight (≤15 min = a data-tuned drop window), at most 15 min of any stored cooldown is honored (measured from the last attempt); stored state untouched, full ladder still applies overnight, and a stuck long cooldown un-sticks on the first pass after deploy; (2) **`TIGHT_ERROR_ALERT_THRESHOLD = 3`** (`process-site.ts`) — inside a tight window, blocking failures page at 3 consecutive instead of 5 (imminent stays at 2); (3) **Storefront fallback sorts newest-first** (root `CREATED_AT` / collection `CREATED`, `reverse: true`) — the API's default id-ascending sort meant a truncated roster hid exactly the *newest* products, i.e. drops; now a fresh listing is always on page 1. Same-day hardening (shipped first, before the Discord screenshots falsified the initial dead-worker theory — kept, it closes real gaps): **wedge watchdog** in `loop.ts` (no completed pass in 15 min → dashboard-only `self_healed` row + `exit(1)` so Railway restarts and checks resume unattended), `serve.ts` no longer fire-and-forgets `startLoop` (loop rejection → exit(1) instead of a dashboard serving with a dead worker), and the mirror's GitHub calls — the loop's only unbounded HTTP — are capped at 20s (`AbortSignal.timeout`). Ops follow-ups (no code): the daily mirror has NOT committed since Jul 20 22:21 ET while the worker runs fine → check `GH_TOKEN` PAT expiry on Railway (R4) and the logs for `History mirror error`; set `HEALTHCHECK_URL` (still the missing dead-man); on known drop days, **Imminent mode remains the designed cooldown bypass** (2-min cadence, auto-off after `imminentDurationMinutes`). **Same-night findings, round 2 (operator screenshots + 🩺):** the product page stayed live/buyable 2+ h through ~24 *green* checks — cooldown wasn't the whole story. (a) **Green-but-blind 304s**: `pipeline.ts` records a 304 as a green check with the old roster, and conditional GET trusted its validator indefinitely → `FULL_REVALIDATE_MS` (15 min) now bounds it: a validator is only used while a full REST body backs it (`stateExtras.lastFullFetchAt`, stamped only on real REST 200s — never 304s/fallback fetches); first post-deploy check force-fetches everything. (b) **Challenge-503 blind spot, caught live by 🩺 from Railway's IP** (`REST products.json → HTTP 503` while browsers load the store fine): challenge-mode WAFs answer suspect IPs with 503, but 503 was in neither `BLOCKED_STATUSES` (adapter — fallback never engaged on the one status SharedPour actually uses at drop time) nor diagnose's `BLOCKED` (verdict mislabeled it "outage/misconfiguration" and skipped the fresh-identity/fallback steps). Both sets now include 503; `blockPhrase` names it a challenge. Net drop-night path: full REST fetch (304 cap) → 503 → Storefront GraphQL channel (myshopify domain, bypasses the WAF; newest-first) → alert. Open question if a product *still* never appears via the Storefront channel: the store may publish private barrel picks outside both feeds → next surface would be the product **sitemap** or collection-page HTML (decide with operator before building).
- **Unicorn Auctions watcher (2026-08-04)**: a new, deliberately **ISOLATED** module — NOT a pipeline site. Scans unicornauctions.com's weekly lot listing (≈6k lots) once/day against a term watchlist (per-term name/description checkboxes; all-words-present matching; desc-terms degrade to name-only when the feed carries no descriptions, with a dashboard note). NEW matched lots page Discord + land in `alert_history` (siteId `unicorn_auctions`); daily bid refreshes and auction-end vanishes are silent; the first-ever scan baselines quietly. Shape: harvest/mirror-style side-job (`apps/worker/src/unicorn.ts`, guarded call in `run.ts` after the site loop) + pure core (`packages/core/src/unicorn.ts`: Zod config, tolerant 3-format parser `json_api`/`next_data`/`html`, matcher) + its own `/unicorn` page (matched-lots table with client-side filters — text / matched-term / min-max bid — and a per-lot **ignore** button, collapsible terms editor, enable/Scan-now, ⚙ fetch-recipe JSON editor, paste-payload sandbox). **All state in two meta blobs** (`unicorn_config`, `unicorn_scan_state`) — no sites row, no tile, no `site_error` paging, no systemic-failure/breaker/host-pin participation, and site failures never touch it (shared fate only at process level). Failures are caught in-job: `lastError` on `/unicorn` only, one Discord warning after 3 consecutive failed days; 180s abort budget; daily stamp written BEFORE the fetch. The real listing format/path is **config, not code**: discover via browser DevTools, validate in the `/unicorn` sandbox, save in ⚙ — no deploy. `cookieRef` (secrets table) + `requestHeaders` cover a login/API-key requirement.
- **Unicorn API discovered + defaults are the live recipe (2026-08-05)**: the listing is a **GraphQL POST** to `https://graphql.beta.unicornauctions.com/graphql` (op `SearchLots`), **no authentication needed** for browsing — so the shipped Zod defaults are the verified working config and "Enable" needs zero typing. Non-obvious API behavior, all encoded in the defaults + asserted by tests (don't "tidy" these): (1) **`state: "LIVE"` is what scopes to the currently-running auction** — no `auctionUuid`, so the weekly Sunday rollover needs no config change; (2) the API **FAILS OPEN** — an unrecognized filter value (e.g. `"live"` lowercase) silently returns the **entire 725,872-lot historical archive** instead of erroring, so `maxExpectedLots` (25k) aborts the scan on page 1 rather than walking it; (3) **`offset` is a 1-INDEXED PAGE NUMBER, not a record offset** (offset 2 @ limit 500 → lots 503+), hence `"offset": "{page}"` — `{pageIndex}`/`{offset}`/`{limit}` also exist for other APIs; (4) **`next` stays `"true"` past the end of the roster**, so paging stops on empty/short/all-repeat pages instead of trusting it; (5) lots carry no URL field — `lotUrlTemplate` `/auction/{auctionUuid}/lot/{id}` (any `{field}` resolves against the raw lot); (6) money is nested (`currentBid { amount }`) and images are a numbered set (`photos { photoN }`, bare filenames). GraphQL introspection is disabled, so the input type was mapped via validation errors. The default query is **trimmed to the fields used** — deliberately NOT the site's own, which pulls `consignor { name email }` (seller PII a stock watcher has no business fetching). Verified live: 4,635 lots, **100% description coverage** (so desc-matching genuinely works — "stitzel" as a description term correctly surfaces Michter's 20 Year), 500/page, ~10 pages.
- **Unicorn politeness / anti-fingerprint (2026-08-05)**: footprint is **~10 requests/day total** (4,635 lots ÷ 500 per page, 400 ms apart, once daily) — a single human page-load of unicornauctions.com fires 200+. Two fingerprints were closed anyway: (1) `httpPost` sends **no browser identity** by design (it exists for Shopify/Discord server-to-server), so the GraphQL POST was going out with **no `User-Agent` at all** — louder than the traffic it carried. It now sends coherent headers via the same `identityForHost` machinery site checks use (stable 6–24 h profile + matching Sec-CH-UA + `Origin`/`Referer`/`Apollo-Require-Preflight`, mirroring the site's own XHR). (2) The daily gate fired every 24.000 h — a metronome. Now `nextDueAt` is stamped with **±2 h jitter (22–26 h)** and stored in scan state (shown on `/unicorn` as "next in ~19h"). Requests carry **no auth token**, so nothing links the traffic to the operator's account — a block would land on the IP, not on Brad. Deliberately NOT done (bloat): TLS-fingerprint spoofing, proxy rotation, randomized page sizes.
- **Unicorn dashboard batch (2026-08-06)**: (1) terms editor collapsed into a `<details>` (auto-open only while the list is empty, so setup is still obvious); (2) **per-lot ignore** for false hits — dismissed ids live in `unicorn_config.ignoredLots` (**config, not scan state**, so the decision survives a re-baseline; stored with title + timestamp, capped at 500 since lot ids are per-auction) and are filtered inside `matchLots` so a dismissed lot never alerts, never lands in `scan_state.lots`, and never renders; the action also drops it from state immediately so the row disappears without waiting for the next scan; restore via a collapsed "Ignored lots (N)" list; (3) matched-lots table moved to a client component (`UnicornLots.tsx`) with text / matched-term / min-max-bid filters — un-bid lots (`currentBidDollars: null`) are only excluded when a bound is actually set. The per-row matched-keyword chips already existed.
- **Unicorn bottles + all-in pricing (2026-08-06)**: a **Bottles** object sits above keywords as the organizing layer. A bottle carries `{rank, name, why, targetLow/HighDollars, maxHammerDollars, notes, links[]}`; a term gets an optional `bottleId`, so a matched lot inherits *which bottle it's a candidate for* and *the walk-away price*. All in `unicorn_config` (still no new tables). **Fee model** (`config.fees`, editable): hammer × (1 + buyerPremium 15%) × (1 + tax/CC 10.25%) + $25 shipping — verified against the operator's own reference point ($375 hammer ≈ $500 delivered; note he has called the second component both "sales tax" and "CC fee", hence the neutral UI label). `estimateAllInDollars()` in core is mirrored by a small copy in `UnicornLots.tsx` (client component; keep the two in sync). The lots table gains **All-in** (next to Current bid) with an under/over-max pill, a **Target bottle** column, a bottle filter and an "under max hammer" toggle; **Discord alerts carry the target, the max hammer, the delivered cost and a ✅/⛔ verdict** — the buy decision shouldn't require a spreadsheet on a phone. Deleting a bottle unlinks its terms rather than leaving dangling ids. Brad's A1–A10 list + B1–B6 buying rules ship as `apps/web/lib/unicorn-starter.ts` behind a **"Load starter list" button** (deliberately NOT a serve.ts seed — nothing written behind his back, nothing to delete later). Also fixed: `.pill`/`.kind-chip` were plain inline spans, so a multi-word keyword ("virgin bourbon") wrapped into two bordered fragments and read as two chips — now `inline-block` + `nowrap`.
- **Mobile layout (2026-08-06)**: the dashboard shipped with **zero media queries** in 1,100+ lines of `globals.css`, so on a phone the `.hdr` flex row squeezed `.nav` into a one-link-per-line column (~600px of chrome before any content) and the 5-column `.ptable` crushed lot titles into 8-line slivers. One `@media (max-width: 720px)` block at the end of `globals.css` fixes both: `.nav` gets `order:10` + `flex:1 1 100%` so it owns a full-width second row (wordmark/version/theme stay on row 1), and `.ptable` becomes **stacked label/value cards** — `thead` hidden, each `td` carrying its column head via a **`data-label` attribute** (added to every `.ptable` consumer: `UnicornLots`, `ProductsTable`, `UnicornSandbox`, `CampariSandbox`, `AddSiteWizard`), first cell rendered as a full-width headline, action cell as a full-width button. **When adding a column to any `.ptable`, add `data-label` or it loses its label on mobile.** Card grids already used `auto-fill/minmax` and needed nothing. `layout.tsx` now exports `viewport` explicitly (losing it silently reverts every rule to a 980px zoomed-out render). Verified by Playwright screenshots at 390px and 1280px — desktop is byte-identical in behavior.
- **Architecture**: see `REBUILD.md`. Backlog: `TODO.md` (latest: the 2026-06-25 review batch).

### v1 → v2 leftover checklist (catch stale-v1 config that survives the rebuild)
When touching infra/config, confirm none of these still point at v1:
1. **Railway watch paths** target `apps/`/`packages/` (in `railway.json`), not `worker.js`/`lib/`/`sites/`. *(Stale here silently SKIPPED every deploy — the 2026-06-24 outage.)*
2. **Start/build commands** run `@beacon/server` + the monorepo build, not `node worker.js`.
3. **CI** (`.github/workflows/ci.yml`) triggers only on live branches (no dead rebuild branch) and on the **same Node major as Railway** (20).
4. **Deploy branch** is `main` everywhere — Railway Source, `DEPLOY.md`, `REBUILD.md`.
5. **Seed JSON** at the repo root stays until the DB is confirmed the sole source.
6. **Node version** pinned in `.nvmrc` + `engines` + `packageManager` so CI and prod match.
7. **Docs**: this section describes the running system; everything below is legacy v1.

---

> ⚠️ **Everything below documents the legacy v1 design** (root `worker.js`,
> `lib/`, `sites/`, `notifiers/`, `docs/`). Kept for reference only and scheduled
> for deletion — for the *running* system use the v2 section above + `REBUILD.md`.
> The per-section details below were written for v1 and may not match v2.

## What this is

Beacon is a personal stock-monitoring bot owned by Brad (McLean, VA). It watches whiskey/spirits product pages and sends Discord alerts when new products appear or items come back in stock. There is no build step, no test suite, and no dependencies — pure Node.js ESM using only built-ins.

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

**Four registered strategies**:
- `shopify_collection` — hits `[url]/products.json?limit=250&page=N`, paginates until a short page. Filters are applied in code after fetch (not as URL params — Shopify ignores client-side filter params like `rb_vendor` on the JSON API). The `sharedpour_reveries` site uses `url: "https://sharedpour.com"` (store root) with `titleContains: ["Reveries"]` filter because there is no dedicated collection.
- `shopify_storefront` — queries the Shopify Storefront GraphQL API using a public access token and collection GID. Used for `reveries_official` because the Reveries shop embed on thereveries.co uses a Shopify Buy Button backed by a collection that is only published to the Buy Button channel (not Online Store), making the REST `/products.json` API return empty.
- `site_status_monitor` — lightweight Squarespace frontend monitor. Fetches the page HTML and checks for reset signals (`sqs-pw-form`, "coming soon", "enter password", HTTP 401/403). Fires `site_reset` once when transitioning open → blocked; clears silently when the page comes back. Intentionally decoupled from inventory tracking — used alongside `shopify_storefront` for `reveries_official` so both the Shopify backend and the Squarespace frontend are watched independently.
- `purchasable_state_monitor` — server-rendered HTML monitor for the Campari "campari-wdf" WordPress theme (Wild Turkey, Russell's Reserve). Fetches the brand product page and parses product cards by anchoring on each `sn_btn` CTA whose href is a product-detail URL (`/products/<slug>/` or `/our-products/<slug>/`), then reading the nearest preceding `<h3>` as the title — template-agnostic across WT's `el-title` and RR's `bb_posts_grid__item-title` layouts (so it can't be broken by one site's markup). The **CTA text is the availability signal**: "Add to cart"/"Buy now" → `available: true` (buyable); "See details"/"Discover more" → `available: false` (info only). Reuses the shared `diff()`, so a card flipping info→buyable fires `restock` and a newly listed card fires `new_product` (`alertOnSoldOut` is kept off — only "became buyable" matters). HTML comments, `<script>`, and `<style>` are stripped before the scan so stray markup can't masquerade as a product card; product handle = the URL slug. Optional per-site `useCollectionSchema: true` also ingests a JSON-LD `CollectionPage → ItemList` roster (adds products not yet in the visible grid as `available: false` — catches password-`Protected:` staged pages before a drop). HTTP 401/403 (e.g. an Incapsula/age wall) are left to throw to the worker's normal error path (→ `site_error` + 429/403 circuit breaker), unlike `site_status_monitor` which treats them as an expected password wall. The pure `parseProductCards(html, opts)` export is mirrored by the dashboard Sandbox's `sandboxParseCampari` (paste-HTML preview).

**State persistence**: `worker.js` pushes `state.json` to GitHub via the Contents API (`lib/github.js`) after a changed run. Uses the file's SHA for optimistic concurrency. On 409 conflict it re-fetches the remote state and **merges** — entries the worker touched this loop keep the worker's value (fresher), entries it didn't touch keep the remote value (so a concurrent writer is not silently overwritten). **State-push throttle**: not every changed loop commits. If anything noteworthy happened (any alert/baseline/error/recovery — i.e. `newHistory` is non-empty) the push is immediate; if the only change was routine `checkHistory`/`lastChecked` ticking over, the push is held in memory and flushed at most once per `STATE_PUSH_MIN_INTERVAL_MS` (5 min). Nothing is lost — state always lives in memory; only the dashboard's view lags up to ~5 min (well inside the dashboard's "worker late" thresholds — `getSiteHealth`/`renderWorkerHealth` add an 8-min `STALE_GRACE_MIN` so this throttle lag plus the ~2-min raw-CDN + ~2-min refresh delay never reads as a false "late", which is what used to make a healthy worker show e.g. "2/5 ok" on short working-hours intervals). This is the main lever that cut the old per-loop commit spam.

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
| `wild_turkey_limited` | wildturkeybourbon.com/en-us/products/ | purchasable_state_monitor | **Staged, disabled until validated.** titleContains: ["Gold Foil","Generations","Keep"] — Keep catches all Master's Keep bottles. Alerts when a target flips See details → Add to cart |
| `russells_reserve_limited` | russellsreserve.com/en-us/our-products/ | purchasable_state_monitor | **Live — enabled (schedule `15`).** Whole section (titleContains: []) to catch new/unlisted drops; useCollectionSchema:true surfaces the password-Protected staged combo |

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

**Header actions**: Refresh, ▶ Run Now (clears `lastChecked` so worker re-checks all sites on next ~60s loop), ⚙ Schedules, GitHub Token, 🍾 Cellar, Discord Webhook.

**Cellar integration (Pending Bottles → master DB)**: The right-rail "→ cellar" action does two things now: (1) registers the bottle in the **Cellar master database** (`POST {cellarUrl}/api/pending`, `Authorization: Bearer <CELLAR_API_TOKEN>`) and (2) moves it into the local Collection list, same as before. The Cellar base URL + token are set via the header **🍾 Cellar** button and remembered per-device in `localStorage` (`beacon_cellar_url`, `beacon_cellar_token`) — never committed; the button shows green ✓ when configured. Cellar is the source of truth for bottle **identity**, so ownership stays in Beacon's `collection` array but each entry is now tagged with the Cellar result: `cellarBottleId` (mapped to a real master bottle → green 🍾 #id badge), `cellarPendingId`+`cellarStatus` (queued in Cellar's pending review → amber ⏳ "queued"; approve it in Cellar to mint the bottle), or `cellarError` (failed → ⚠ retry button). The push is **best-effort and never blocks the local move** — on failure you're asked whether to move it locally anyway, and the Collection card's "↑ cellar / ⚠ retry cellar" button (`syncCollectionItemToCellar`) re-pushes later. Cellar dedupes on `(store, handle)`; Beacon sends `store` = retailer (or `"Beacon"`), `handle` = a slug of the bottle name (`cellarHandle`), so re-pushing the same bottle is idempotent. Needs a GitHub token too (the collection write goes through `commitBottles`). The worker is uninvolved.

**Shared Pour order import (Pending Bottles auto-feed)**: Pulls your Shared Pour order history into the Pending Bottles feed. The orders page is behind Shopify's customer-account login (`shopify.com/<shop-id>/account/orders`, session-scoped JWT in `buyer_flags`) and the order-email tracking links 403 datacenter IPs, so **the worker can't reach orders** — this is a dashboard-only, browser-session feature (worker uninvolved). Flow: the **⤵ Import Shared Pour orders** button (top of the Pending pane) opens `#sharedpour-modal`, which generates a **bookmarklet** with the dashboard URL baked in (`sharedPourBookmarklet()`). Run on the logged-in Orders page, the bookmarklet reads `document.body.innerText` and hands it to the dashboard via `window.open(<dash>#beaconimport=<base64{text,url}>)` (clipboard + paste-box fallback if popups are blocked). On load the hash is captured into `_pendingImport` (and cleared); after unlock `maybeRunPendingImport()` opens the modal pre-filled. Parsing: `spParseOrders()` reads the orders-page text into `{orderNumber, products, status, total}` blocks; `spSplitProducts()` splits multi-bottle orders on `, ` (re-merging fragments with an unclosed `(` so an internal comma like `(123.6 Proof, II.I)` stays one product; drops the `…and N more products` placeholder); `spMapStatus()` maps the live status — `On its way`/`Ready for pickup` → stage `ordered` (active), `Delivered`/`Picked up` → stage `pickup` (terminal). `spPlanImport()` is a **pure planner used for both the preview and the write** (so they can't drift): it matches each scraped product against existing pending **and** collection items on normalized order# + name (exact or substring), so re-running **updates** status instead of duplicating; new **active** orders are added (terminal ones skipped unless the "also add picked-up/delivered" box is checked); imported/updated items get `source:"sharedpour"`, a live `spStatus`, and a `syncedAt` stamp. The dashboard's own GitHub token does the `pending_bottles.json` write through `commitBottles` — **no credentials live in the bookmarklet or the worker**. Tiles render the `spStatus` as a chip plus `synced <ago>`. **Discord on Ready-for-pickup**: when a re-sync flips a tracked bottle into `Ready for pickup` *and it had a prior, different `spStatus`*, `notifyBottleReady()` posts a green 🥃 embed via the dashboard's stored webhook (`_sessionWebhook`, the header **Webhook** button — same one the ignore/unignore notices use; silently no-ops if unset). A first sync with no prior `spStatus` is treated as baseline (no ping) so the initial import never floods — same spirit as the worker's startup-quiet mode. Parser/planner are mirrored by a Node check during development; verified against a real 11-order dump (parse, paren-comma, dedup-vs-manual, idempotency, baseline-vs-flip).

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

> **⚠️ For v2, see `TODO.md` at the repo root** — it's the current, consolidated
> backlog. The list below is the **legacy v1 backlog**, kept for history; most of
> it is now done or obsolete after the rebuild.

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
- Alternative (minimal): ~~stop storing the PAT in localStorage~~ — tried 2026-06-13 (sessionStorage, session-only) but **reverted 2026-06-15**: re-entering the token every session was too much friction for a personal dashboard, so the PAT is again remembered in `localStorage` (`beacon_gh_token`) until cleared, same as the webhook (a token left in `sessionStorage` by the old build is migrated to `localStorage` on first load). The header **Token** button now shows "🔑 Token ✓" in green when a token is loaded and "🔑 Add token" in amber when not, so it's obvious whether the dashboard has it. The hardcoded `DASH_PASSWORD = 'beam'` and the Cloudflare Access option (the real shared-machine fix — don't re-do the sessionStorage stopgap, do this instead) remain open.
- Note: Brad's own webspace and Google Workspace are available if hosting needs to move

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
| ✅ | Dashboard PAT moved from `localStorage` → `sessionStorage` (2026-06-13) — **reverted 2026-06-15** back to persistent `localStorage` (re-entry every session was too much friction); header Token button now shows loaded/missing state |
| ✅ | Storefront API `2024-01`→`2025-01`; `historyFileSha` localized; stale `reveries_squarespace` sandbox value renamed; `handoff/` dir removed (2026-06-13) |


## Known quirks

- Filters in `shopify_collection.js` are applied **after** fetching all pages. A store with thousands of products and a narrow filter will still paginate the full catalog.
- On thereveries.co, the Reveries products on SharedPour (`sharedpour_reveries`) may have a vendor of "SharedPour" rather than "The Reveries". The dashboard handles this by flagging "reveries" in the title OR matching the siteId — not by vendor field.
- If `state.json` is corrupted on GitHub, the worker logs a parse error at startup and runs with empty state — which would re-alert on all existing products. Fix: hand-repair state.json in the repo.

---

## Risk register (biggest fragile points)

**R1 — State corruption → mass false alert flood** *(mitigated 2026-06-12)*
If `state.json` is corrupt or missing at startup, the worker runs with empty state. Startup quiet mode now suppresses `new_product` alerts on any check where the site had no previous state entry at all — the products are baselined silently (logged + a `baseline` history entry, no Discord). Keyed on the entry being absent, not the product map being empty, so a site whose last real check saw 0 products still alerts on a 0→N wave drop.

**R2 — Reveries collection ID changes silently after one alert** *(v1 risk — RESOLVED in v2, 2026-07)*
*(v1 problem)* `storefrontCollectionId` was hardcoded; if thereveries.co swapped its Shopify Buy Button to a new collection the strategy returned 0 products and fired `site_reset` (re-fired every 24 h via `emptyAlertAt`) with no automatic recovery — you had to find the new ID in page source and hand-edit config.
*(v2 fix — self-healing)* The `shopify_graphql` source now (a) watches a **single product** by id (`productId`), not just a collection — for a shop that embeds one SKU (a collection sold down to one bottle), and (b) with **`discoverEmbedFrom`** set (`reveries_official` → `https://www.thereveries.co/shop`) re-reads the live `ShopifyBuyInit` embed on every check and **follows whatever's embedded** — product *or* collection, any id — with last-known (persisted `discoveredEmbed`) then static-config fallbacks so a wall-up/timeout never loses the target. A swapped or sold-down embed is followed automatically instead of nagging. See `packages/core/src/sources/shopify_graphql.ts` (`parseShopifyBuyEmbed`) + the one-time `serve.ts` amendment (delete once confirmed applied in prod).

**R3 — Railway down = complete monitoring blackout** *(mitigated 2026-06-12)*
Still no backup runner, but two independent detectors now exist: (1) the worker pings `HEALTHCHECK_URL` after every loop — configure a healthchecks.io check (~2 min period, ~5 min grace) and the external service alerts when pings stop, even if the worker is fully dead; (2) the dashboard's worker chip turns "worker late/stalled" when the earliest-due site check is overdue by more than `10/20 + STALE_GRACE_MIN` (≈18/28) min, schedule-aware — the grace absorbs the state-push throttle + raw-CDN + refresh lag so a healthy worker isn't falsely flagged. **Setup required**: create the healthchecks.io check and set `HEALTHCHECK_URL` on Railway.

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
