// Preventive fallback arming (2a): while a Shopify site is still friendly,
// harvest its canonical *.myshopify.com domain and public Storefront API token
// from its own page source, VERIFY the token against the Storefront API, then
// write the secret + arm storefrontFallback on the site. Stock the pantry
// before the famine — when the host later starts bot-blocking, the failover
// already exists.
//
// Politeness: one homepage fetch per un-armed site per day (stamped in meta),
// under a 15s guard. Best-effort — a miss just retries tomorrow.

import { httpGet, httpPost } from "@beacon/fetch";
import { sourceUrl, type SiteDefinition, type SourceOf } from "@beacon/core";
import type { Alert } from "@beacon/shared";
import type { BeaconStore, SiteRow } from "@beacon/db";
import type { RunContext } from "./run.js";

const HARVEST_RETRY_MS = 24 * 3_600_000;
const HARVEST_FETCH_MS = 15_000;

// The public Storefront token as it appears in theme/pixel JS. 32 hex chars.
const TOKEN_RES = [
  /storefront[_-]?access[_-]?token["']?\s*[:=]\s*["']([0-9a-f]{32})["']/i,
  /["']accessToken["']\s*:\s*["']([0-9a-f]{32})["']/,
];
const SHOP_DOMAIN_RE = /([a-z0-9][a-z0-9-]*\.myshopify\.com)/i;

export interface HarvestOutcome {
  siteId: string;
  armed: boolean;
  detail: string;
}

/** Extract token + myshopify domain from storefront HTML. Exported for tests. */
export function extractStorefrontCreds(html: string): { token: string; domain: string } | null {
  let token: string | null = null;
  for (const re of TOKEN_RES) {
    const m = html.match(re);
    if (m) {
      token = m[1]!;
      break;
    }
  }
  const domain = html.match(SHOP_DOMAIN_RE)?.[1]?.toLowerCase() ?? null;
  return token && domain ? { token, domain } : null;
}

async function verifyToken(domain: string, token: string, endpoint?: string): Promise<boolean> {
  try {
    const res = await httpPost(
      endpoint ?? `https://${domain}/api/2025-01/graphql.json`,
      JSON.stringify({ query: "{ shop { name } }" }),
      { headers: { "X-Shopify-Storefront-Access-Token": token } },
    );
    const name = (JSON.parse(res.body) as { data?: { shop?: { name?: string } } })?.data?.shop?.name;
    return typeof name === "string" && name.length > 0;
  } catch {
    return false;
  }
}

async function harvestOne(
  store: BeaconStore,
  def: SiteDefinition,
  opts?: { verifyEndpoint?: string },
): Promise<HarvestOutcome> {
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(), HARVEST_FETCH_MS);
  try {
    const html = await httpGet(sourceUrl(def), { kind: "document", signal: controller.signal });
    const creds = extractStorefrontCreds(html);
    if (!creds) return { siteId: def.id, armed: false, detail: "no Storefront token found in page source" };
    if (!(await verifyToken(creds.domain, creds.token, opts?.verifyEndpoint))) {
      return { siteId: def.id, armed: false, detail: `found a token for ${creds.domain} but it failed verification` };
    }
    const ref = `${def.id}_storefront_token`;
    await store.secrets.set(ref, creds.token);
    const src = def.source as SourceOf<"shopify_rest">;
    await store.sites.upsert({
      ...def,
      source: { ...src, storefrontFallback: { domain: creds.domain, accessTokenRef: ref } },
    });
    return { siteId: def.id, armed: true, detail: `Storefront fallback armed via ${creds.domain} (token verified)` };
  } catch (err) {
    return { siteId: def.id, armed: false, detail: `homepage fetch failed: ${(err as Error).message}` };
  } finally {
    clearTimeout(guard);
  }
}

/** Arm missing storefrontFallbacks, at most one attempt per site per day. */
export async function maybeHarvestFallbacks(
  ctx: RunContext,
  rows: SiteRow[],
  opts?: { verifyEndpoint?: string; retryMs?: number },
): Promise<HarvestOutcome[]> {
  const { store, channel, dryRun, log = () => {} } = ctx;
  if (dryRun) return [];
  const retryMs = opts?.retryMs ?? HARVEST_RETRY_MS;
  const out: HarvestOutcome[] = [];

  for (const row of rows) {
    const def = row.definition;
    if (!row.enabled || def.source.kind !== "shopify_rest" || def.source.storefrontFallback) continue;

    const metaKey = `harvest_attempt_${def.id}`;
    const last = await store.meta.get(metaKey);
    if (last && Date.now() - Date.parse(last) < retryMs) continue;
    await store.meta.set(metaKey, new Date().toISOString()); // stamp BEFORE trying — throttle even on crash

    const outcome = await harvestOne(store, def, opts);
    out.push(outcome);
    log(`[${def.name}] Fallback harvest: ${outcome.detail}`);

    if (outcome.armed) {
      const event: Alert = {
        type: "self_healed",
        product: {
          title: def.name,
          url: sourceUrl(def),
          note:
            `🛡 Preventive self-healing: ${outcome.detail}. If this store's products.json ever gets ` +
            `bot-blocked, checks will fail over to the Storefront API automatically — nothing to do now.`,
        },
      };
      await store.history.append(def.id, [event]);
      if (channel) {
        try {
          await channel.send(def.name, event);
        } catch (err) {
          log(`  Discord harvest-note error: ${(err as Error).message}`);
        }
      }
    }
  }
  return out;
}
