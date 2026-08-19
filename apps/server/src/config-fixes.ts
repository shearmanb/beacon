// Config fixes applied at boot — extracted from serve.ts (2026-08-14).
//
// WHY THIS FILE EXISTS
// Beacon's config lives in the datastore, not in the repo, so a config change
// that must reach prod (a source scoped to a collection, a fallback armed, a
// site retired) ships as a small idempotent block that runs on boot. That was
// the right instinct, but seven deploys later it was ~230 lines inside the
// launcher, and two of the blocks had a real bug: they were guarded by "does
// this site exist?", which means DELETING the site on the dashboard silently
// RESURRECTED it on the next deploy.
//
// The shape now:
//   • CORRECTIONS run every boot and are idempotent by inspection ("if the
//     source is still missing X, add X"). They are safe to re-run and they
//     matter: if the volume is ever lost and the DB is re-seeded from the
//     legacy JSON at the repo root, these are what re-apply the fixes the JSON
//     seed doesn't carry. They no-op in microseconds otherwise.
//   • ONE_SHOTS run at most once ever, latched on a `meta` flag. Anything that
//     CREATES, DELETES, or DISABLES a site belongs here, so an operator's later
//     decision on the dashboard is never overridden by a redeploy.
//
// Every fix is individually try/caught: a broken fix must never stop the worker
// from starting.

import type { BeaconStore } from "@beacon/db";

export interface ConfigFix {
  id: string;
  description: string;
  /** Meta key an earlier hand-rolled version of this fix latched on. Checked as
   *  well as the standard `fix:<id>` key so moving a fix into this file never
   *  re-runs it in prod. */
  legacyFlag?: string;
  run: (store: BeaconStore, log: (msg: string) => void) => Promise<void>;
}

const SHAREDPOUR_FALLBACK = {
  domain: "shared-pour.myshopify.com",
  accessTokenRef: "reveries_official_storefront_token",
};

// ── Corrections: idempotent, run every boot ──────────────────────────────────
export const CORRECTIONS: ConfigFix[] = [
  {
    id: "sharedpour_storefront_fallback",
    description: "Arm the Storefront-API fallback on sharedpour.com REST checkers",
    // 2026-07: sharedpour.com's bot protection 403s datacenter IPs, killing the
    // REST checkers while the store loads fine in a browser. The adapter fails
    // over to the token-authenticated GraphQL channel on the canonical
    // myshopify domain when REST is blocked.
    async run(store, log) {
      const secrets = await store.secrets.all();
      if (!secrets[SHAREDPOUR_FALLBACK.accessTokenRef]) {
        log(`Skipping SharedPour fallback — secret "${SHAREDPOUR_FALLBACK.accessTokenRef}" not found.`);
        return;
      }
      for (const row of await store.sites.list()) {
        const src = row.definition.source as Record<string, unknown>;
        if (src["kind"] !== "shopify_rest" || src["storefrontFallback"]) continue;
        if (new URL(String(src["baseUrl"] ?? "")).hostname.replace(/^www\./, "") !== "sharedpour.com") continue;
        await store.sites.upsert({ ...row.definition, source: { ...src, storefrontFallback: SHAREDPOUR_FALLBACK } });
        log(`Amended ${row.id}: added Storefront-API fallback for blocked REST.`);
      }
    },
  },
  {
    id: "reveries_site_status_content_noise",
    description: "Turn off content-change watching on thereveries.co/shop",
    // The Squarespace page rotates a same-length token the fingerprint can't
    // strip, so watchContentChange fired on pure noise (≈61319→61319 chars).
    // The signals that matter (wall up / wall lifted) don't use the hash.
    async run(store, log) {
      const row = await store.sites.get("reveries_site_status");
      const src = row?.definition.source as Record<string, unknown> | undefined;
      if (!row || src?.["kind"] !== "http_status" || src["watchContentChange"] === false) return;
      await store.sites.upsert({ ...row.definition, source: { ...src, watchContentChange: false } });
      log("Amended reveries_site_status: watchContentChange off (same-length token noise).");
    },
  },
  {
    id: "reveries_official_embed_discovery",
    description: "Follow thereveries.co's live Buy Button embed (R2 self-healing)",
    // The shop embeds a single PRODUCT now, not a collection, so the old
    // collection query returned 0 forever. discoverEmbedFrom re-reads the live
    // ShopifyBuyInit block each check and follows whatever is embedded.
    async run(store, log) {
      const row = await store.sites.get("reveries_official");
      const src = row?.definition.source as Record<string, unknown> | undefined;
      if (!row || src?.["kind"] !== "shopify_graphql" || src["discoverEmbedFrom"]) return;
      await store.sites.upsert({
        ...row.definition,
        source: { ...src, productId: "9001382805659", discoverEmbedFrom: "https://www.thereveries.co/shop" },
      });
      await store.state.clear("reveries_official");
      log("Amended reveries_official: product-embed watch + self-healing id discovery (re-baselined).");
    },
  },
  {
    id: "bourbon_concierge_collection_scope",
    description: "Scope thebourbonconcierge.com to /collections/reveries",
    // It scanned the WHOLE catalog (8+ pages of 250) just to keyword-filter for
    // "Reveries", and the host tar-pits deep scan pages while a small probe
    // passes. The dedicated collection makes a check ONE request.
    async run(store, log) {
      const row = await store.sites.get("bourbon_concierge");
      const src = row?.definition.source as Record<string, unknown> | undefined;
      if (!row || src?.["kind"] !== "shopify_rest" || src["collectionPath"]) return;
      await store.sites.upsert({ ...row.definition, source: { ...src, collectionPath: "/collections/reveries" } });
      await store.state.clear("bourbon_concierge");
      log("Amended bourbon_concierge: scoped to /collections/reveries — re-baselined.");
    },
  },
];

// ── One-shots: latched on a meta flag, never re-run ──────────────────────────
export const ONE_SHOTS: ConfigFix[] = [
  {
    id: "amendment_cadence_20260716",
    description: "Data-tuned schedules (drop_windows / bar_evening) + site assignment",
    legacyFlag: "amendment_cadence_20260716", // the key serve.ts used before this refactor
    // Mined from the full alert history (May 17 → Jul 15, 49 deduped posting
    // events): 47% of postings land 11:00–13:00 ET, a Reveries evening window
    // runs 17:00–20:00, nothing has EVER posted 22:00–08:00, and Fountain Inn
    // (a bar) posts exclusively 15:24–19:39. One-shot so later manual schedule
    // edits on the dashboard are never overridden by a redeploy.
    async run(store, log) {
      await store.schedules.upsert("drop_windows", {
        label: "📊 Drop Windows (data-tuned)",
        rules: [
          { fromHour: 9, toHour: 13, interval: 5 },
          { fromHour: 17, toHour: 20, interval: 5 },
          { fromHour: 8, toHour: 9, interval: 15 },
          { fromHour: 13, toHour: 17, interval: 15 },
          { fromHour: 20, toHour: 22, interval: 15 },
          { fromHour: 22, toHour: 8, interval: 120 },
          { defaultInterval: 120 },
        ],
      });
      await store.schedules.upsert("bar_evening", {
        label: "🍸 Bar Evening (data-tuned)",
        rules: [
          { fromHour: 15, toHour: 20, interval: 5 },
          { fromHour: 12, toHour: 15, interval: 15 },
          { fromHour: 20, toHour: 22, interval: 15 },
          { fromHour: 22, toHour: 12, interval: 120 },
          { defaultInterval: 120 },
        ],
      });
      const assign: Record<string, string> = {
        sharedpour_t8ke: "drop_windows",
        sharedpour_t8ke_all: "drop_windows",
        sharedpour_reveries: "drop_windows",
        sharedpour_provenance: "drop_windows",
        bourbon_concierge: "drop_windows",
        fountain_inn_dc: "bar_evening",
      };
      for (const [id, schedule] of Object.entries(assign)) {
        const row = await store.sites.get(id);
        if (!row) continue; // site absent in this datastore — skip quietly
        await store.sites.upsert({ ...row.definition, schedule });
        log(`Amended ${id}: schedule → ${schedule}.`);
      }
    },
  },
  {
    id: "retire_browser_twin_20260814",
    description: "Disable the Browserbase twin — 362 consecutive HTTP 402s",
    // The real-browser experiment (2026-07-24) ran out of Browserbase quota and
    // has been answering 402 ever since: 300+ consecutive failures, a site_error
    // page every day, and — because it sits on sharedpour.com — a permanent
    // second "failing checker" polluting the host-block rollup for the checkers
    // that actually matter. Disable, don't delete: the state and the config stay
    // put, so re-enabling after topping up Browserbase is one dashboard click.
    async run(store, log) {
      const row = await store.sites.get("sharedpour_browser");
      if (!row) return;
      if (row.definition.enabled) {
        await store.sites.upsert({ ...row.definition, enabled: false });
        log("Disabled sharedpour_browser (Browserbase quota exhausted — re-enable on the dashboard when funded).");
      }
    },
  },
];

/** Apply corrections (every boot) then pending one-shots (once ever). */
export async function applyConfigFixes(store: BeaconStore, log: (msg: string) => void): Promise<void> {
  for (const fix of CORRECTIONS) {
    try {
      await fix.run(store, log);
    } catch (err) {
      log(`Config fix "${fix.id}" failed (continuing): ${(err as Error).message}`);
    }
  }
  for (const fix of ONE_SHOTS) {
    const flag = `fix:${fix.id}`;
    try {
      if (await store.meta.get(flag)) continue;
      if (fix.legacyFlag && (await store.meta.get(fix.legacyFlag))) {
        await store.meta.set(flag, "migrated-from-legacy-flag");
        continue;
      }
      await fix.run(store, log);
      await store.meta.set(flag, new Date().toISOString());
      log(`One-shot applied: ${fix.id} — ${fix.description}.`);
    } catch (err) {
      log(`One-shot "${fix.id}" failed (will retry next boot): ${(err as Error).message}`);
    }
  }
}
