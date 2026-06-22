# Beacon v2 — TODO / Backlog

Consolidated after the v2 rebuild + cutover (2026-06-22). **This supersedes the
legacy v1 backlog** in `CLAUDE.md` (most of which is now done or obsolete).

Each item tags rough **impact** so we can decide with the lean-by-default rule in
mind: size `XS/S/M/L` (code volume) · whether it adds **deps** · **risk**.
"On-demand" = don't build on spec; build when a real need forces it.

---

## ✅ Done this session (rebuild + cutover)
- TS monorepo; declarative engine (all 4 legacy strategies → config + adapters);
  libSQL/Turso datastore; Discord notify; worker runtime; migration importer;
  Next.js dashboard; one-service Railway deploy with auto-seed; 118 tests + CI.
- Dashboard: sites + health dots, products table, alert history, reminders,
  per-site schedule dropdown, Schedules manager, activity timeline (PulseStrip),
  lightweight theme switcher (4 palettes), single-user auth.
- Cutover: live on Railway (one service + volume, no new accounts), old v1
  worker stopped, product baselines preserved (no alert flood).

---

## Near-term — dashboard completeness
- [ ] **Add-site flow + Sandbox** — paste a URL → auto-probe (is it Shopify?
      Squarespace? HTML?) → suggest the recipe → preview parsed products → save.
      The core "add a site without code" UX. _Impact: **M**, no deps (reuses
      adapters)._
- [ ] **Full site-config editing** — edit filters, alert flags, and source/URL
      from the UI, not just schedule/monitoring/imminent. _Impact: **M**, no deps
      (validate via existing Zod schema)._
- [ ] **System-Health panel** — per-site parse-success / error / block rates
      rolled up from checkHistory. _Impact: **S–M**._
- [ ] **Schedules manager: day-of-week (`days`) rules** — schema already supports
      it; expose in the builder. _Impact: **S**._
- [ ] **Reminder priority (★) toggle** — add/done/delete exist; add a toggle.
      _Impact: **XS**._

## Reliability / self-healing (loop engineering)
- [ ] **Structure-drift alerts** — generalize the empty-guard into "site normally
      returns N, now 0 / selector matched nothing → likely broken" pings,
      distinct from "legitimately empty." _Impact: **S** (extends existing guard)._
- [ ] **Adaptive anti-bot** — `host_telemetry` table + a policy module that tunes
      cooldown/identity/jitter from per-host block rates. _Impact: **M**.
      On-demand (build when blocks actually appear)._
- [ ] **SQLite concurrency hardening** — if "database is locked" ever appears
      (worker + web on one file), set `busy_timeout` / WAL pragmas. _Impact:
      **XS**. Reactive._
- [ ] **More notification channels** — email/SMS via the existing
      `NotificationChannel` interface (Discord stays primary). _Impact: **S** each
      (+1 dep per channel, e.g. an email SDK)._

## Flexibility / future
- [ ] **Declarative `html` adapter** — selector/JSON-LD recipe so simple HTML
      sites become config (today only `custom`/campari_v1 exists). _Impact: **M**.
      On-demand._
- [ ] **Total Wine & Costco** — phase 2; needs the headless-browser + (likely)
      residential-proxy tier. _Impact: **L** + real $ + upkeep. Set honest
      reliability expectations._
- [ ] **Products-as-rows analytics** — optional price-history / restock-frequency
      table (alert_history already covers most). _Impact: **M**. On-demand._
- [ ] **Cellar handoff** — a "send to Cellar" action pushing a spotted product to
      the Cellar API. _Impact: **S** once Cellar's endpoint is confirmed._

## Infra / housekeeping
- [ ] **Railway auto-deploy** — wire Settings → Source to deploy on push to
      `main`. _User-side, no code._
- [ ] **Auth hardening** — single-password cookie is fine for solo use; Cloudflare
      Access (Google login) is the real shared-machine fix. _Impact: **S** code +
      Cloudflare setup. (Carried from v1 backlog.)_
- [ ] **Prune legacy v1** — once v2 is proven (~1 week stable), delete root
      `worker.js`/`lib/`/`sites/`/`notifiers/`/`docs/` (keep the JSON seed files
      until the DB is the sole source). _Impact: **S** (deletions). After the
      stability window._
- [ ] **Compiled prod build (optional)** — worker/launcher run via `tsx` (TS at
      runtime); a `dist` build + dual exports would be a tidier prod story.
      _Impact: **M**. Low priority — `tsx` works fine._
- [ ] **CI: add `next build`** to the web job (currently typecheck only). _Impact:
      **XS**._

---

## Watch / known
- `reveries_official` (shopify_graphql) is **disabled** and shows a stale `404`
  ("collection: null" — the old R2 collection-ID staleness). Re-enable only after
  confirming the current Storefront collection ID in the shop's page source.
- Discord-on-ignore notice (a v1 nicety) was dropped; re-add only if wanted
  (_Impact: **XS**_).
