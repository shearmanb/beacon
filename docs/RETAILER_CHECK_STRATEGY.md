# Retailer Check Strategy — tiers, sessions, blocking, escalation

> Companion to `HOSTING_AND_EXECUTION_ARCHITECTURE.md` (the platform decision) and
> `MIGRATION_CHECKLIST.md` (the phased plan). This document is **platform-neutral**:
> it defines how any retailer gets checked, regardless of where the check executes.
>
> Status: **design / planning only** (2026-07-23). Nothing here is implemented yet
> beyond what already exists in `packages/core` + `apps/worker` (Tier 1 is live today).

---

## 1. Principles

- **1a. Least-complex-that-works.** Every retailer runs on the cheapest tier that
  reliably produces the truth. A browser is an escalation, not a default. Beacon's
  live Shopify checkers prove this daily: a JSON endpoint + a token-authenticated
  API fallback has carried monitoring through weeks of WAF blocks.
- **1b. Session realism over IP games.** A coherent, persistent, boring identity
  (same browser, same cookies, same timezone, same region, human-ish cadence)
  beats IP rotation. Rotating IPs with an incoherent client is a bot signature;
  a stable client on one IP is a repeat visitor.
- **1c. Never bypass access controls.** The goal is to see the same page state a
  normal signed-out user in the operator's region would see. CAPTCHAs, logins,
  purchase limits, and password walls are *detected and reported* (that's what
  `site_reset` is for), never defeated.
- **1d. Evidence or it didn't happen.** Any ambiguous or failed check must leave
  behind enough evidence (status, body/HTML, screenshot when a browser was
  involved, error class) to diagnose from the dashboard without re-running.
- **1e. An ambiguous result is never "out of stock."** Only a successfully
  parsed roster may drive the diff. Blocks, challenges, timeouts, and structure
  drift preserve the previous product state (the existing empty-guard/drift-guard
  behavior generalizes to every tier).

---

## 2. The three tiers

### Tier 1 — Direct structured-data check (today's system)

**What:** plain HTTPS from the worker process. No JS, no cookies, no browser.

- Shopify `/products.json` pagination (`shopify_rest`)
- Shopify Storefront GraphQL API (`shopify_graphql`, and the `storefrontFallback`
  channel inside `shopify_rest`)
- Page-state probes (`http_status`) and server-rendered HTML parsing
  (`custom`/`campari_v1`)

**When it's the right tier:** the data is *designed* to be fetched without a
browser (a public JSON endpoint, a documented API) or the HTML is fully
server-rendered and stable. Note the subtlety: for Shopify stores, a real
browser is **not** more realistic for `products.json` — no human browses that
endpoint. The Storefront API is even better: it's Shopify's *designed-for-programs*
channel, token-authenticated, hosted on `*.myshopify.com` outside the custom
domain's WAF. Tier 1 is not a compromise for these; it's correct.

**Known Tier-1 honesty limits** (why Tier 2 exists at all):

- The Node TLS handshake does not look like Chrome's, no matter how good the
  headers are. A WAF that fingerprints TLS will see "claims Chrome, shakes hands
  like a script." This cannot be fixed at Tier 1 without heavy dependencies
  (deliberately parked in `TODO.md`).
- No cookie continuity: the client never carries the cookies a real repeat
  visitor would.
- Egress is a hosting-provider datacenter IP with shared reputation.

### Tier 2 — Standard browser check

**What:** a real Chromium via Playwright, with a **persistent per-retailer
profile** (cookies + localStorage survive between runs), stable
locale/timezone/viewport, default browser behavior. The check *navigates* like a
person: land on the collection/product page, wait for the page's own signals
(selector visible, network idle, app state present), then read stock state from
the rendered DOM, embedded JSON (e.g. `ShopifyAnalytics`/JSON-LD), or by
observing the page's *own* data requests.

**When to use:** the site requires JS/client rendering, sets cookie-gated
content, or Tier 1 is demonstrably blocked while a browser session succeeds.
Future targets in `TODO.md` (Total Wine, Costco) are Tier-2-or-3 by nature.

**Conduct rules for Tier 2:**

- 2a. One persistent context per retailer, reused across runs. Never a fresh
  incognito context per check.
- 2b. Fixed identity per retailer: one UA/browser version (whatever the bundled
  Chromium actually is — don't lie about the version), `en-US` locale,
  `America/New_York` timezone, a common desktop viewport. Matches the operator's
  real region.
- 2c. Plausible navigation only where it changes what the server shows:
  first-ever visit lands on the homepage/collection page (letting the site set
  its cookies and run its scripts), subsequent visits go straight to the watched
  page — exactly what a returning visitor with a bookmark does. **No fake mouse
  wiggles, no decorative scrolling, no random clicks.** Interact only when the
  page genuinely hides state behind an interaction (e.g. a "load more" that
  reveals the roster).
- 2d. Wait on *state*, not time: `waitForSelector`/response-received/app-state
  predicates with a hard cap. No fixed `sleep(5000)`.
- 2e. Screenshots + final HTML captured on every failure/ambiguous result;
  optionally on success at low frequency (daily) as a drift baseline.

### Tier 3 — Hardened browser check

**What:** the *same* Playwright script as Tier 2, pointed at a managed remote
browser (Browserbase or equivalent) via CDP `connect`, with:

- a persistent named cloud context (cookies/profile survive),
- provider stealth/fingerprint hygiene (a real Chrome fingerprint end-to-end),
- **optionally** residential/ISP proxy egress, per-retailer, only where direct
  datacenter egress is demonstrably the blocked variable,
- richer capture (session recording, network log),
- *lower* frequency and stronger backoff than the site's Tier-1 cadence — a
  hardened check is expensive and conspicuous; use it sparingly.

**When to use:** Tier 2 run from the hosting provider remains blocked or
challenge-looped, AND the 🩺-style evidence shows the block is IP/fingerprint
reputation (page loads fine for the operator's own browser at home). Tier 3 is
per-retailer, never global.

**Cost discipline:** Tier 3 minutes are the scarcest resource in the system.
A Tier-3 retailer should also have a cheap Tier-1 *sentinel* where possible
(e.g. an HTTP probe that at least distinguishes "site up" from "site down") so
the expensive browser only runs at the cadence stock actually changes.

---

## 3. Tier assignment — current retailers

| Retailer / site id | Assigned tier | Rationale |
|---|---|---|
| `sharedpour_t8ke`, `sharedpour_reveries`, `sharedpour_provenance` | **Tier 1** (REST → Storefront-API fallback, already live) | The Storefront channel has carried monitoring through the WAF blocks; drops were ultimately caught. Tier 2 only if *both* channels fail during a verified-live listing again. |
| `bourbon_concierge` | **Tier 1** (collection-scoped REST) | Post-scoping (one request/check) it passes; tar-pit only hit deep pagination. |
| `fountain_inn_dc` | **Tier 1** | No observed blocking. |
| `reveries_official` (`shopify_graphql` + embed discovery) | **Tier 1** | Token API; no WAF in path. |
| `reveries_site_status` (`http_status`) | **Tier 1** | Status probe by design. |
| `russells_reserve_limited`, `wild_turkey_limited` (`custom`/campari_v1) | **Tier 1**, watch for Incapsula walls | Server-rendered HTML parses today. Campari brands run Imperva/Incapsula; if 401/403 walls appear from the host, these are the most likely **first Tier-2 promotions**. |
| Total Wine, Costco (future, `TODO.md`) | **Tier 2 start, expect Tier 3** | Heavy bot defense; browsers + possibly residential egress. Set honest expectations before onboarding. |

The Jul 22 post-mortem's open question (Reveries barrel picks possibly published
outside both Shopify feeds) is a **source-coverage** question, not a tier
question — the next escalation there is the product **sitemap.xml** or
collection-page HTML at Tier 1, decided with the operator first.

---

## 4. Sessions and identity

- 4a. **Identity unit = retailer host.** One profile per host (matches the
  existing `host_identities` design). All checkers on the same host share it —
  the same reason host-level pin propagation exists.
- 4b. **Tier 1** keeps today's persisted header identity (6–24 h UA profile,
  persisted across restarts). Improvement worth taking regardless of platform:
  pin `Accept-Language` to `en-US` variants only (an `en-GB` header from a US IP
  is a needless inconsistency) — one-line change in `packages/fetch/src/profiles.ts`.
- 4c. **Tier 2/3** persist the *actual browser profile*: local checks store the
  Playwright `userDataDir`/`storageState` on the volume keyed by host; remote
  checks use the provider's named persistent context. Profile re-roll is the
  existing `expireIdentity` escalation, applied to browser profiles: only after
  repeated blocks, never routinely.
- 4d. **Geographic/session coherence:** ET timezone, `en-US`, US egress. If a
  Tier-3 retailer uses proxy egress, pin the proxy geo to one US region and keep
  it stable — don't hop cities between checks.
- 4e. **One check per host at a time.** The current sequential loop guarantees
  this for free; any future fan-out executor must add an explicit per-host mutex
  before it ships. Overlapping checks to one retailer are both impolite and a
  detection signal.

---

## 5. Identifying blocking (vs. outage, vs. sold out)

A check result must be classified before it may touch product state. Result
categories (superset of today's behavior — see the observability model in the
architecture doc):

`in_stock` · `out_of_stock` · `page_unavailable` · `blocked` ·
`challenge_page` · `login_required` · `consent_interrupt` ·
`structure_changed` · `extraction_failed` · `timeout` · `ambiguous`

Detection signals, in order of reliability:

- 5a. **HTTP status:** 401/403/429/430 → `blocked`; 503 → `challenge_page`
  *suspected* (verified by body sniff — challenge HTML from Cloudflare/Imperva
  has recognizable markers) else `page_unavailable`. (Already implemented as
  `BLOCKED_STATUSES` in `shopify_rest.ts`; 503's dual nature is why the
  fallback tries the alternate channel either way.)
- 5b. **Stall/tar-pit:** connection accepted, no bytes → `blocked` (status-less).
  Already implemented (`isRestStall`, `STALL_RE`).
- 5c. **Body/DOM markers (Tier 2/3):** challenge iframes/scripts (Cloudflare
  "Just a moment", Imperva `_Incapsula_Resource`, PerimeterX), consent overlays,
  login redirects, password walls (`sqs-pw-form` — already in `http_status`).
  Each retailer config carries `blockIndicators` / `consentIndicators` /
  `loginIndicators` selectors+phrases.
- 5d. **Expected-page indicators:** every retailer defines what a *healthy*
  page must contain (a product grid selector, a JSON key, a title fragment).
  A 200 with the expected indicator absent is `structure_changed` or
  `extraction_failed`, **never** `out_of_stock`.
- 5e. **Drift guard:** anomalously small yield vs. baseline → `structure_changed`
  (already implemented, `drift_guard.ts`).

**Sold-out is a positive claim**: it requires a successfully parsed page whose
availability signal affirmatively reads unavailable. Everything else preserves
prior state and, at most, alerts about the check itself.

---

## 6. Retries, backoff, and cooldowns

Retries are justified **by failure class**, not by habit:

| Failure class | Inline retry? | Backoff behavior |
|---|---|---|
| Network blip (reset, DNS) | 1 retry after short jitter | none beyond the miss |
| 429 with short `Retry-After` (≤5 s) | yes, honoring header (existing `MAX_INLINE_RETRY_MS`) | none |
| 429 long / 403 / 430 / stall / challenge | **no inline retry** | circuit-breaker ladder 5→15→60→180 min (existing), clamped to ≤15 min inside a data-tuned drop window (existing) |
| `structure_changed` / `extraction_failed` | no — retrying identical parse re-fails | alert once, daily re-page (existing 3e) |
| Timeout at budget | no | counts toward consecutive errors |
| Tier 2/3 browser crash | 1 relaunch | escalating if repeated |

Additional rules:

- 6a. Repeated blocks (cooldown level ≥2) trigger identity/profile re-roll
  (existing behavior, extended to browser profiles).
- 6b. Blocks during a drop window page the operator at 3 consecutive failures
  (existing `TIGHT_ERROR_ALERT_THRESHOLD`) — the human is the ultimate fallback.
- 6c. A Tier-3 retailer's backoff is *longer* than Tier 1's: minimum step 15 min,
  and never bypassed by imminent mode without operator confirmation.

---

## 7. Evidence capture

| Situation | Tier 1 | Tier 2/3 |
|---|---|---|
| Success | roster + telemetry only (as today) | + optional daily screenshot baseline |
| Block/challenge suspected | **persist first ~64 KB of body** + headers (new — today only the error string survives) | screenshot + final HTML + console errors + failed-request list |
| Ambiguous / extraction failed | body snippet + which rule failed | same + screenshot |
| Timeout | phase reached (connect/headers/body) | navigation phase + screenshot of whatever rendered |

Evidence rows are bounded (cap per site, rotate oldest) and live with the check
record so the dashboard's error panel and 🩺 Diagnose can show *what the site
actually said*, not just "HTTP 403".

---

## 8. Proxy routing — when it is actually justified

Proxy egress (residential/ISP) is the **last** lever, after all of:

1. Tier 1 alternate channel (Storefront API) — already live, already sufficient
   for today's SharedPour blocks.
2. Tier 2 real browser from the host platform (fixes TLS/JS/cookie realism).
3. Tier 3 remote browser with provider fingerprint hygiene, still direct egress.
4. Evidence that the residual variable is IP reputation: the *same* browser,
   *same* profile, *same* script succeeds from the operator's home connection
   and fails from the platform — that's what 🩺 Diagnose's "loads fine in your
   browser?" comparison establishes.

Only then: enable per-retailer proxy egress on the Tier-3 config, pinned to one
US geo, at the lowest cadence that meets the retailer's drop pattern. Never
enable proxying globally; never use rotation-per-request.

---

## 9. Promotion / demotion between tiers

Movement is driven by the per-host telemetry that already exists
(`checkHistory`, `errorLog`, cooldown levels, `fetchVia` flips) plus the new
result classification.

**Promotion (up a tier)** — any of:

- 9a. Block-rate: >30 % of checks over 7 days classified
  `blocked`/`challenge_page` *on both Tier-1 channels* (a single-channel block
  with a healthy fallback is NOT promotion-worthy — that's the designed state).
- 9b. Confirmed miss: a listing verified live (operator screenshot, later
  discovery) that the current tier's checks did not surface.
- 9c. Structural: the site moves stock state behind client-side rendering or
  cookie-gated content (Tier 1 physically can't see it).

Promotion is **operator-confirmed** (a dashboard suggestion, one click), not
automatic — each tier upward adds cost and conspicuousness.

**Demotion (down a tier)** — automatic probing, like today's REST re-probe:

- A promoted retailer keeps a low-frequency probe of the tier below (e.g. daily
  Tier-1 attempt). After 7 consecutive days of clean lower-tier probes, the
  dashboard suggests demotion; operator confirms. (Symmetric with
  `preferFallback`'s 12 h REST re-probe — same feedback-loop pattern, longer
  horizon.)

**Hysteresis:** a retailer may move at most one tier per 7 days in each
direction, so an intermittent WAF can't make the system flap between tiers —
the lesson of the July channel-flap incident, applied at the tier level.

---

## 10. Ambiguity handling

- `ambiguous` results preserve prior product state, increment a per-site
  ambiguity counter, and save full evidence.
- 2 consecutive ambiguous results → dashboard chip; 4 → a `site_error`-class
  page with the evidence links (same cadence philosophy as consecutive errors).
- Ambiguity **resets** the notification-dedup window rather than emitting
  alerts: no alert may be *derived* from an ambiguous check.
- An ambiguous → healthy transition with roster changes runs through the
  existing reappearance guard so partial-visibility windows don't fire false
  "new product" alerts (already implemented for channel flips; the same
  mechanism covers tier flips).
