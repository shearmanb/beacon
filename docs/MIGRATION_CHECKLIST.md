# Migration Checklist — phased, reversible, no big-bang cutover

> Companion to `HOSTING_AND_EXECUTION_ARCHITECTURE.md` (the decision + rationale)
> and `RETAILER_CHECK_STRATEGY.md` (tiering rules). Status: **planning only**
> (2026-07-23); no production changes have been made.
>
> The recommended path is **evolve-in-place**: keep the single resident worker
> (Railway today), add the tiered browser-execution layer, escalate individual
> retailers to a managed remote browser only on evidence. That means most
> "migration" phases here are *additive* — the current checker never stops
> running, so rollback at every phase is "delete the new thing."

Legend: `[ ]` = to do · `[op]` = operator (dashboard/console) action, no code ·
`[code]` = repo change · `[infra]` = platform/config change.

---

## Phase 0 — Prerequisites & Claude-operability wiring (do first; no risk)

- [ ] [op] Set `HEALTHCHECK_URL` on the Railway service (healthchecks.io check,
      period 2 m / grace 5 m). This is the standing dead-man gap from `TODO.md`
      and is a **precondition for measuring anything else** — Phase 1 baselines
      are meaningless if worker death is invisible.
- [ ] [op] Fix the history mirror: check Railway logs for `History mirror error`
      and the `GH_TOKEN` PAT expiry (mirror silent since Jul 20). The mirror is
      the baseline-measurement data source.
- [ ] [op] Create a **Railway project token**; store it locally as
      `RAILWAY_TOKEN` (see the security model in the architecture doc — never
      committed). Verify from a dev shell: `railway status`, `railway logs`,
      `railway variables` all work headlessly.
- [ ] [op] Add the same token to the Claude Code environment configuration so
      remote sessions can run the Railway CLI.
- [ ] [code] Add the **ops surface** to the web app: authenticated JSON
      endpoints under `/api/ops/` (status, recent errors, per-site health,
      last-N check records) mirroring what the dashboard shows. This makes prod
      inspectable by Claude via plain HTTPS + a bearer token, independent of any
      platform's CLI. (Small; reuses existing repositories + middleware auth.)
- [ ] [op] Confirm rollback works **now**, before anything changes: Railway →
      previous deployment → redeploy. Note the steps in the runbook section of
      the architecture doc.

**Exit criteria:** external dead-man live; Claude can read logs/vars/status via
CLI and app state via `/api/ops/*`; rollback rehearsed.

---

## Phase 1 — Baseline measurement (1–2 weeks of data; mostly free)

Representative set: `sharedpour_reveries` (hostile WAF, fallback-carried),
`bourbon_concierge` (tar-pit history), `fountain_inn_dc` (never blocked),
`russells_reserve_limited` (custom HTML), `reveries_official` (token API).

- [ ] [code] Tiny exporter or SQL notebook over `check_history`/`error_log`/
      `alert_history` (the data already exists in state + history) producing,
      per site per week:
  - success rate; block/challenge rate (`blocked`-class statuses + stalls)
  - fallback-engagement share (`fetchVia`), flap/pin events
  - false out-of-stock incidents (operator-confirmed; expected ≈0 given the
    empty/drift guards)
  - mean/95p check duration (derivable from budget aborts + logs going forward)
  - alert latency for any real drop that occurs in the window
- [ ] [op] Record current cost (Railway invoice) and logging quality
      (subjective note: what was diagnosable from dashboard alone vs needing logs).
- [ ] [ ] Snapshot the numbers into `docs/BASELINE_2026-07.md` for the Phase 4
      comparison.

**Exit criteria:** a written baseline table — the thing Phase 4 compares against.

---

## Phase 2 — Easy-retailer proof of concept (Tier 2 exists, off the critical path)

Goal: prove the browser tier end-to-end on a *friendly* target before pointing
it at a hostile one.

- [ ] [code] `packages/browser` package: Playwright wrapper exposing the same
      `SourceAdapter` contract (`fetch(site, prev, deps) → FetchResult`), with:
  - persistent per-host profile storage (volume dir keyed by host)
  - state-based waits; hard wall-clock cap wired to the existing per-site
    `AbortSignal` budget
  - screenshot + HTML + console capture on failure/ambiguity (evidence rows)
  - result classification per `RETAILER_CHECK_STRATEGY.md` §5
- [ ] [code] New `browser` source kind in the Zod schema (config-driven:
      start URL, nav steps, wait signals, indicators — see the config model in
      the architecture doc §9).
- [ ] [infra] Railway build gains Chromium (Dockerfile or Nixpacks package) +
      memory headroom; keep the image change behind a branch deploy or a
      second scratch service first so the live service is untouched.
- [ ] [ ] Pick the easy target: `fountain_inn_dc` **duplicate** site
      (`fountain_inn_dc_browser`, alerts off / dry-run) running Tier 2 alongside
      the live Tier 1 checker.
- [ ] Validate, each via the normal machinery (not ad-hoc scripts):
  - [ ] correct stock detection (roster matches the Tier-1 checker's)
  - [ ] manual execution (dashboard ▶ Run Now command path)
  - [ ] scheduled execution (named schedule honored; jitter applied)
  - [ ] notifications (flip alerts on for one synthetic ignored-product test)
  - [ ] logs + evidence (screenshot/HTML rows visible from the dashboard)
  - [ ] Claude administration (read the run's evidence via `/api/ops/*`,
        tail the deploy via `railway logs`)

**Exit criteria:** a browser-tier check runs on schedule inside the existing
loop, produces identical rosters to Tier 1 on a friendly site, and leaves
evidence Claude can retrieve. **Rollback:** disable the duplicate site; revert
the image change.

---

## Phase 3 — Difficult-retailer proof of concept (escalation ladder, evidence-driven)

Target: `sharedpour_reveries` (or whichever SharedPour checker is currently the
most blocked — pick from Phase 1 data). Run as a **duplicate dry-run site**;
the live Tier-1 checker keeps carrying real monitoring throughout.

Test progressively — stop at the first step that holds a ≥95 % 7-day success
rate, and record the result of each step in the decision log:

1. [ ] Standard Playwright browser from Railway (fresh context) — does a real
       browser + real TLS from the same datacenter IP already pass?
2. [ ] - persistent cookies/profile (second run onward — does continuity help?)
3. [ ] - normal navigation path (collection page first, read roster from the
       page's own data requests instead of hitting `products.json` cold)
4. [ ] - retailer-specific waits + block/challenge indicators tuned
5. [ ] - lower frequency / stronger backoff (does politeness alone clear it?)
6. [ ] Remote managed browser (Browserbase session, named persistent context,
       stealth defaults, **no proxy**) via the same adapter behind a CDP
       connect option
7. [ ] Only if 6 still blocks: per-retailer **residential/ISP proxy** on the
       remote session, one pinned US geo, lowest justifiable cadence

- [ ] Document which step actually moved reliability (the architecture doc's
      cost table assumes most retailers stop at 1–5; validate that).
- [ ] Feed the outcome back into `RETAILER_CHECK_STRATEGY.md` §3 tier
      assignments.

**Exit criteria:** a written answer to "what does SharedPour actually require?"
with 7-day evidence per step. **Rollback:** delete the duplicate site; no live
path was touched.

---

## Phase 4 — Side-by-side production comparison (2+ weeks)

- [ ] Promote the winning configuration for 1–2 retailers to **live-parallel**:
      new-tier checker alerts into a *separate* Discord channel (second webhook)
      so duplicates are visible, not confusing.
- [ ] Compare against the Phase 1 baseline, per retailer:
  - [ ] in-stock detections (count + latency vs the Tier-1 twin)
  - [ ] out-of-stock detections
  - [ ] ambiguous results (must not exceed Tier 1's)
  - [ ] blocks/challenges (should be materially lower on promoted retailers)
  - [ ] page-change / structure incidents caught
  - [ ] execution failures (browser crashes, timeouts)
  - [ ] duplicate/false alerts (reappearance guard must hold across tiers)
  - [ ] cost delta (Railway RAM increase + any Browserbase minutes, actuals)
  - [ ] maintenance effort (honest note: hours spent babysitting each path)

**Exit criteria:** the comparison table filled in, reviewed with the operator.

---

## Phase 5 — Cutover (per-retailer, not per-platform)

Because the recommendation keeps the platform, "cutover" means **switching a
retailer's live checker to its new tier** and retiring its duplicate — one
retailer at a time.

Cutover criteria — ALL must hold for that retailer over the Phase-4 window:

- [ ] detection accuracy ≥ the Tier-1 twin (no drop missed that the twin caught)
- [ ] fewer blocks *and* no increase in ambiguous results
- [ ] diagnostics strictly better (evidence present for every non-green check)
- [ ] scheduling reliability proven (no missed windows; wedge watchdog clean)
- [ ] notifications proven (real or synthetic alert delivered end-to-end)
- [ ] cost within the agreed envelope (architecture doc §"Cost assumptions")
- [ ] Claude administration verified on the live path (logs, evidence, env,
      redeploy, rollback)
- [ ] rollback tested: flip the site's config back to the old tier via the
      dashboard ⚙ source editor (config-only, no deploy) and confirm the old
      path still works
- [ ] Only then: retire the duplicate site + its extra webhook.

If, and only if, a later decision moves the whole app off Railway (the fallback
architecture in the decision doc), that migration reuses this same checklist
shape: stand up the replacement, run Phases 2–4 against it, and keep Railway
deployable until the replacement passes the same criteria for **every** site.
The application code is platform-neutral (env-driven config, one process, one
volume path) precisely so that move stays boring.

---

## Standing rules during all phases

- Never run two *alerting* checkers for one retailer into the same Discord
  channel (duplicate-alert confusion was a hard-won July lesson — the
  reappearance guard exists because of it).
- Every new checker starts in dry-run / alerts-off until its roster matches.
- No phase may reduce the politeness posture of the live checker (cooldowns,
  jitter, sequential per-host execution stay as-is).
- Anything learned that contradicts the architecture doc gets written back into
  it — the docs are the decision record, not a snapshot.
