// Systemic-failure self-heal (2026-11-20). run.ts decides THAT a pass was
// systemic (every checked site failed, 2+ stores); this module owns what
// happens next:
//   • the EPISODE — when it opened, persisted in the `systemic_episode` meta
//     blob so the all-clear can say how long the outage lasted, across restarts;
//   • the CONTROL PROBE — one request to a neutral host that tells "Railway has
//     no outbound network at all" from "Railway cannot reach these stores";
//   • the AUTO-REDEPLOY — after REDEPLOY_AFTER_MS of nothing but connect
//     failures, with the control host answering, ask Railway to redeploy this
//     service (a redeploy can land a different egress route/IP).
// Guard rails, because nobody is watching when this fires:
//   • inert unless RAILWAY_API_TOKEN is set (the service/environment ids are
//     injected by Railway);
//   • at most one redeploy per REDEPLOY_COOLDOWN_MS, and the latch is written
//     BEFORE the API call — the restart it causes can never loop;
//   • connect failures only. A block (403/429/430) is the store saying no;
//     that stays the operator's call.

import { httpGet, httpPost } from "@beacon/fetch";
import type { BeaconStore } from "@beacon/db";

export const REDEPLOY_AFTER_MS = 30 * 60_000;
export const REDEPLOY_COOLDOWN_MS = 24 * 3_600_000;
const META_KEY = "systemic_episode";
const RAILWAY_API = "https://backboard.railway.com/graphql/v2";
const DEFAULT_CONTROL_URL = "https://www.gstatic.com/generate_204";

export interface SystemicState {
  /** The open episode, or null when checks are healthy. */
  open: { since: string; redeployedAt?: string } | null;
  lastRedeployAt: string | null;
}

/** Injectable so tests never touch the network (run.ts RunContext.selfHeal). */
export interface SelfHealDeps {
  /** True when a neutral host answered — our outbound network works. */
  probe: () => Promise<boolean>;
  /** Null when auto-redeploy is not armed. */
  redeploy: (() => Promise<void>) | null;
}

export const controlUrl = (): string => process.env["BEACON_CONTROL_URL"] || DEFAULT_CONTROL_URL;

export async function controlProbe(): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10_000);
  try {
    await httpGet(controlUrl(), { signal: ctl.signal });
    return true;
  } catch (err) {
    // ANY HTTP answer, even an error status, proves the network is up.
    return (err as { statusCode?: number }).statusCode != null;
  } finally {
    clearTimeout(timer);
  }
}

async function railwayRedeploy(token: string, serviceId: string, environmentId: string): Promise<void> {
  const res = await httpPost(
    RAILWAY_API,
    JSON.stringify({
      query:
        "mutation($environmentId: String!, $serviceId: String!) { serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId) }",
      variables: { environmentId, serviceId },
    }),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const errors = (JSON.parse(res.body) as { errors?: Array<{ message?: string }> }).errors;
  if (errors?.length) throw new Error(`Railway API: ${errors[0]?.message ?? "error"}`);
}

export function defaultSelfHeal(env: NodeJS.ProcessEnv = process.env): SelfHealDeps {
  const token = env["RAILWAY_API_TOKEN"];
  const serviceId = env["RAILWAY_SERVICE_ID"];
  const environmentId = env["RAILWAY_ENVIRONMENT_ID"];
  return {
    probe: controlProbe,
    redeploy: token && serviceId && environmentId ? () => railwayRedeploy(token, serviceId, environmentId) : null,
  };
}

export async function loadSystemic(store: BeaconStore): Promise<SystemicState> {
  try {
    const raw = JSON.parse((await store.meta.get(META_KEY)) ?? "null") as Partial<SystemicState> | null;
    if (raw && typeof raw === "object") {
      return {
        open: raw.open && typeof raw.open.since === "string" ? raw.open : null,
        lastRedeployAt: typeof raw.lastRedeployAt === "string" ? raw.lastRedeployAt : null,
      };
    }
  } catch {
    /* unreadable blob = no open episode */
  }
  return { open: null, lastRedeployAt: null };
}

export async function saveSystemic(store: BeaconStore, state: SystemicState): Promise<void> {
  await store.meta.set(META_KEY, JSON.stringify(state));
}

/** True when the redeploy conditions hold (the caller has already established
 *  that this pass saw nothing but connect failures). */
export function redeployDue(state: SystemicState, now: number = Date.now()): boolean {
  if (!state.open || state.open.redeployedAt) return false;
  if (now - Date.parse(state.open.since) < REDEPLOY_AFTER_MS) return false;
  return !state.lastRedeployAt || now - Date.parse(state.lastRedeployAt) >= REDEPLOY_COOLDOWN_MS;
}
