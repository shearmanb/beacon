# Browser Tier + Off-Railway Plan

_Last updated: 2026-07-25 (supersedes the shelved Fly.io plan note where they conflict — see §3)._

> **What this doc is.** The single source of truth for two linked threads:
> (1) the **real-browser check tier** we shipped this session and how we're
> **testing** it, and (2) the still-open **move-off-Railway** decision. They are
> linked because the same experiment answers both — see §3.
>
> **Reconciliation note.** The saved plan (`move to Fly.io + local Playwright`)
> predates the mid-session decision to **stay on Railway and use Browserbase**
> (a remote real-browser service). That plan is **shelved, not executed**. What
> is actually live is described here. The Fly option is still on the table as a
> *later, separate* call (§3) — not a thing in flight.

---

## 0. Status at a glance (verified live 2026-07-25 19:2x UTC)

- **Platform:** unchanged — one Railway service `beacon`, **Online**, worker
  heartbeat ~17 s fresh. SQLite on the Railway volume. **No migration has
  happened.**
- **Browser module:** shipped, live, running as a **dry-run twin** only
  (alerts OFF). Nothing about the production alerting path changed.
- **Twin result so far:** across ~38 h of hourly checks (first check midnight
  ET Jul 24 → latest Jul 25 18:33 ET), the browser twin `sharedpour_browser`
  returns **4 Reveries products, matching the live REST checker exactly (4=4),
  with zero error-log entries**. First real evidence that a real browser from
  Railway's datacenter IP is **not** being blocked by SharedPour. Necessary,
  **not yet sufficient** — the real test is a daytime **drop window** (§2.4).
- **Decision status:** stay-on-Railway is the current state; the browser tier
  is being validated before promotion; Railway-vs-Fly is deferred until the
  twin answers the datacenter-IP question (§3).

---

## 1. What shipped this session — the browser module

**New package `packages/browser`** — the only package that depends on a browser
driver (`playwright-core`). Core stays driver-free; the worker **lazily imports**
`@beacon/browser` only when an enabled `browser`-kind site is due, and registers
it via `registerAdapter()`. Chromium is **never** in the Railway image.

**Engine = Browserbase (remote real Chrome), not local Playwright.** The adapter
attaches over CDP (`chromium.connectOverCDP`) to a Browserbase session. So we get
a real browser — real TLS fingerprint, real JS execution (WAF challenges actually
run), persistent per-retailer cookies — **without** baking Chromium into the
Railway service or paying its RAM cost locally.

**It implements the standard `SourceAdapter` contract**, so every downstream
guarantee (filters, diff, alerts, reappearance-guard, circuit breaker, empty-
guard) applies unchanged. Flow (`packages/browser/src/adapter.ts`):

1. `resolveAuth()` — needs only `BROWSERBASE_API_KEY`. `ensureProjectId()`
   auto-discovers the project from the key (2026-07 onboarding; no project id
   required), cached process-wide.
2. `createContext()` — persistent per-retailer cookie profile (stored id reused
   across checks via `bbContextId` in site state; a failed context downgrades
   gracefully to no-persistence, noted in state — never hard-fails the check).
3. `createSession()` — **`solveCaptchas` is hard-wired `false`** (policy: never
   defeat CAPTCHAs). Residential proxy is an **unset** opt-in (`proxy:"none"` by
   default → Railway's own egress IP).
4. `page.goto(visitUrl)` → `classifyWall()` (Cloudflare "just a moment",
   Incapsula, PerimeterX, Squarespace/Shopify password walls, login, consent).
   A challenge gets a **state-based** settle wait (`waitForFunction`, marker
   gone), never a fixed sleep; consent overlays are ignored (they don't hide the
   catalog); anything harder is **thrown with a `statusCode`** so the existing
   cooldown ladder / circuit breaker treat it exactly like an HTTP-tier block.
5. Roster via the **page's own `fetch`** of `products.json` (same-origin,
   cookie-bearing — indistinguishable from the storefront's own XHRs),
   paginated with the shared Shopify normalizer (`normalizeShopifyProduct`,
   now exported from `shopify_rest.ts` so both tiers share one code path).
6. **Evidence on failure:** screenshot + final HTML to
   `/data/evidence/<siteId>/` (keep newest 10), path referenced in the error so
   it surfaces in `errorLog` / `site_error`.

**Safety posture (unchanged from the operator's stated goals):** browser realism
only — no IP rotation by default, `solveCaptchas:false` always, no fake
mouse/scroll theater, state-based waits only, small politeness jitter between
paginated fetches. Explicitly **not** defeating CAPTCHAs, auth, access controls,
or purchase limits.

**Ops surface (also shipped):** token-auth read-only JSON at
`apps/web/app/api/ops/{status,errors,evidence}` (`BEACON_OPS_TOKEN`), gated by
`middleware.ts` (fails **closed** when the token is unset — security-reviewed
this session, no critical findings). This is how I read prod headlessly to
produce the numbers in §0/§2 without a dashboard login.

**Key files:** `packages/browser/src/{adapter,browserbase,classify,evidence,index}.ts`
(+ tests); `packages/core/src/schema.ts` (`browser` source member);
`packages/core/src/sources/registry.ts` (`registerAdapter`);
`packages/core/src/sources/shopify_rest.ts` (exported normalizer);
`apps/worker/src/run.ts` (lazy import + kind-aware 120 s budget);
`apps/server/src/serve.ts` (one-time twin amendment).

---

## 2. The testing plan (the twin experiment)

### 2.1 Method — a risk-free shadow check
`serve.ts` self-arms a one-time amendment (idempotent; runs once; gated on
`BROWSERBASE_API_KEY` being present) that adds **`sharedpour_browser`**:

- Same target as the proven `sharedpour_reveries` REST checker
  (sharedpour.com root, `titleContains:["Reveries"]`), so their rosters are
  directly comparable.
- **All alerts OFF**, hourly schedule (`"60"`), `maxPages:3`, `extract:page_json`.
- Because alerts are off, the twin **cannot** produce a false page no matter what
  it returns — it's pure measurement. The worst case is a wasted Browserbase
  minute.

### 2.2 Current results (live)
| Checker | Kind | Count | Errors | Notes |
|---|---|---|---|---|
| `sharedpour_reveries` | shopify_rest (live) | 4 | 0 | the incumbent |
| `sharedpour_browser` | **browser twin** | **4** | **0** | matches, no error-log rows in ~38 h |

- Two snapshots ~38 h apart both match (4=4); the browser twin has **never**
  appeared in `/api/ops/errors`.
- **First check did not get blocked** — the datacenter-IP-block hypothesis is
  not confirmed for SharedPour at low-traffic times.

### 2.3 Promotion criteria (what "pass" means)
Promote the browser tier only when **all** hold over a multi-day window that
includes normal daytime traffic:
1. Twin roster **matches or beats** (never silently misses vs.) the combined
   REST + Storefront checkers.
2. Browser-tier error rate stays low and every error is an *honest* block
   (classified + evidence), not a code/parse fault.
3. It survives at least one **drop window** (the SharedPour evening window,
   §2.4) without going blind.

Then promote by **one** of:
- **(A) Fallback tier** — wire the browser as the **3rd** channel behind
  REST → Storefront, engaged only when both HTTP channels fail. (Design
  doc pending — §4.) This is the lean default: browser minutes spent only when
  needed.
- **(B) Primary for a known-blocking host** — e.g. Russell's Reserve (§4),
  where HTTP never works, so the browser is the first and only channel.

### 2.4 Decisive experiments still outstanding
1. **Drop-window comparison** — the midnight match is necessary, not
   sufficient. SharedPour blocks **hardest at drop time** (the whole reason
   Beacon has missed bottles). The twin must be observed across a real evening
   drop window before we trust it. *This is the single most important pending
   data point.*
2. **🩺 Diagnose browser probe from Railway's egress IP** — a browser step in
   `diagnoseSite` that runs REST → fresh-identity → Storefront → **browser** and
   reports which channels the datacenter IP can and can't reach. **Not yet
   wired** (planned). This makes "works in my browser, not in Beacon" directly
   testable on demand.
3. **High-value blocking site (Russell's Reserve)** — the operator's use case
   (c): point the browser tier at a host known to block hard (Imperva/Incapsula)
   and see whether a real browser from a datacenter IP gets through or whether
   the residential-proxy slot must be armed. Decision-gated design doc (§4).

---

## 3. The move-off-Railway question (the open fork)

There are **two different answers** to "add a real browser," and the choice is
still open:

| | **Railway + Browserbase** (current, live) | **Fly.io + local Playwright** (saved plan, shelved) |
|---|---|---|
| Migration | none | one-time (Dockerfile + fly.toml + DB copy) |
| Browser | remote managed service | Chromium baked into the image |
| Egress IP | Railway datacenter (unless residential proxy armed — paid) | Fly datacenter (`iad`, matches operator geo) |
| Browser cost | free 1 h/mo; **$20/mo** for 100 h (Developer) | none per-use (you run it); +RAM/swap on the box |
| Ops friction | Railway's manual dashboard (the original gripe) | Claude-administrable via `flyctl` (deploy/logs/ssh/secrets) |
| All-in $/mo | Railway (~$5–10) + Browserbase (0 or $20) | ~$11–14 verified |
| Risk today | **low — already running** | one migration + a new browser runtime to babysit |

### 3.1 Why the twin experiment *is* the migration experiment
The pivotal unknown is the same for both: **does a real browser from a
*datacenter* IP beat SharedPour's drop-time block?**

- **If YES** (twin keeps matching through drop windows): residential egress is
  unnecessary → a **datacenter-IP** real browser is enough → **Fly + local
  Playwright** becomes the attractive long-term home (no Browserbase bill, off
  Railway's manual ops, Claude-administrable). Browserbase would then be
  optional backup for only the very hardest hosts.
- **If NO** (real browser from a datacenter IP still blocked at drop time): you
  **need residential egress**, which Browserbase provides (paid proxy) and
  local-Playwright-on-Fly does **not** (you'd bolt on a separate proxy anyway) →
  **keep Browserbase**, and Railway-vs-Fly collapses to a pure ops-preference
  call with no reliability difference.

Either way, **the twin tells us which world we're in before we spend a migration
on it.** That is the whole reason to run the twin before touching platforms.

### 3.2 Recommendation & sequencing
1. **Do not migrate yet.** Let the twin run through ≥1 real drop window (§2.4).
   The system is healthy and the browser tier is already delivering its test
   data on Railway at ~$0.
2. **Promote the browser tier** (fallback (A) by default) once §2.3 passes.
3. **Then** decide Railway vs Fly as a *separate, lower-stakes* call informed by
   §3.1:
   - datacenter-IP browser works → schedule the Fly migration (saved plan is
     ~90% reusable; swap "local Playwright" in for "Browserbase" or keep both).
   - datacenter-IP browser still blocked → stay on Railway + Browserbase (+arm
     residential proxy for the blocking host); revisit Fly only for the ops
     ergonomics, not for reliability.

**Net:** one platform, one service, real browser only where cheap channels fail
— exactly the operator's constraints — with the platform decision deferred to
the point where evidence makes it obvious instead of a guess.

---

## 4. Pending sub-plans (design docs to write)
- **Browser-as-3rd-fallback promotion** — how the `browser` channel slots behind
  REST → Storefront in the failover ladder (`process-site.ts`): engage
  conditions, `fetchVia:"browser"` state + tile chip, flap/preferFallback
  interaction, per-host propagation, Browserbase-minute budget guardrail.
- **Russell's Reserve / Imperva / proxy decision gate** — enable the disabled
  `russells_reserve_limited`, point a browser check at it, and a **decision
  gate**: datacenter-IP browser passes → done; still blocked → arm
  `proxy:"residential"` for that one site only (schema slot already exists).

_(Both were queued for the Fable review/design burn, which was blocked by the
account session limit + Fable's content classifier. They can be written on Opus
inline whenever you want.)_

---

## 5. Open ops item — unrelated, needs a call
**`cgf` is failing hard:** 88 consecutive `HTTP 404` on
`reservebar.com/products/wild-turkey-...-gold-foil-edition/00721059003940`,
every ~15 min. That's a dead/changed product URL on an **enabled** `custom`
site — it has almost certainly been paging `site_error`. **Fix the URL or
disable the site.** Not part of the browser/migration work; surfaced because I
was reading prod state.

---

## 6. Environment variables (names only)
Already set: `BROWSERBASE_API_KEY`, `BEACON_OPS_TOKEN`, `BEACON_DB_URL`,
`BEACON_AUTH_SECRET` / `BEACON_DASH_PASSWORD`, `DISCORD_WEBHOOK_URL`, `GH_TOKEN`,
`GH_REPO`. Optional / unset: `BROWSERBASE_PROJECT_ID` (auto-discovered if
absent), `BEACON_EVIDENCE_DIR` (defaults `/data/evidence`), **`HEALTHCHECK_URL`
(still unset — the standing dead-man TODO)**. If Fly is ever chosen:
`FLY_API_TOKEN`.
