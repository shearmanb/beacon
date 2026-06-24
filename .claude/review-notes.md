# Automated Review Notes

> ⚠️ **SUPERSEDED (v1).** These notes review the legacy v1 design (root
> `worker.js`, `lib/`, `sites/`, `docs/`). Beacon has since been rebuilt as the
> v2 monorepo (`apps/` + `packages/`) — most risks/cleanups below are done or
> obsolete. Current backlog: `TODO.md`; architecture: `REBUILD.md`. Kept for
> history only.

_Last updated: 2026-06-05_

## Top risks (most fragile first)
1. **Railway is the only runner, no independent liveness alert (R3).** If it dies mid-drop, zero alerts; first `site_error` is ~100 min out and can't post if the worker is fully dead. Mitigate with a dashboard "last run" header + external dead-man ping (healthchecks.io).
2. **State-corruption false-alert flood (R1).** Empty/corrupt state.json at boot re-alerts every product as new. Add startup quiet mode (suppress alerts on first check per site when state loaded empty).
3. **Discord POST has no timeout (R5/D6).** Stalled webhook hangs the whole sequential loop. Add `req.setTimeout(10000)` in `notifiers/discord.js` postWebhook.
4. **Hardcoded `storefrontCollectionId` (R2).** Collection swap → one `site_reset` then permanent silence. Generalize "went from N products to 0" guard to all strategies.

## Cleanup backlog (safe, batchable)
- D1 remove dead `reveries_squarespace` option (docs/index.html:464)
- D2 collapse `weekend_light_20_mins` → `"20"`, delete entry
- D3 remove unreachable `defaultInterval` in `bar_schedule_fi` AND `working_hours_heavy`
- D4 fix stale `checker.js` comment (lib/schedule.js:1)
- D5 remove dead module-level `historyFileSha` (worker.js:21) — make it local
- D6 add timeout to Discord postWebhook
- D7 bump Shopify Storefront API off `2024-01`
- D8 strip unused `tags` from stored state (~30% of state.json)

## Architecture notes
- State in git = one commit per loop (`checkHistory` mutates every check). Consider Railway volume/Redis, or push state on a slower cadence than alerts/history.
- Four hand-rolled https clients (lib/fetch, lib/github, shopify_storefront, discord) with inconsistent timeout/retry. Consolidate.
- No tests/CI; hand-edited JSON with no schema validation → silent self-inflicted blackout risk. Add config sanity check on load + before dashboard PUT.

## Pending features
Alert-history archiving + cap 250→500 · Railway-health header indicator · imminent sub-60s floor · startup quiet mode · move state off GitHub · dashboard sandbox config/schedule preview · replace hardcoded dashboard password / stop storing PAT in localStorage · Google Workspace secondary alert channel.
