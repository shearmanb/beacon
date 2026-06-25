// One browser identity per hostname, held for 6–24 h. Re-rolling the profile on
// every request would mean the same IP presents a different browser every
// minute — itself a bot signature. A stable identity looks like a repeat
// visitor.

import { randomFrom, jitter } from "@beacon/shared";
import { ACCEPT_LANGUAGES, BROWSER_PROFILES, type BrowserProfile } from "./profiles.js";

export interface HostIdentity {
  profile: BrowserProfile;
  acceptLanguage: string;
  expiresAt: number;
}

const hostIdentities = new Map<string, HostIdentity>();

export function identityForHost(hostname: string): HostIdentity {
  const existing = hostIdentities.get(hostname);
  if (existing && Date.now() < existing.expiresAt) return existing;
  const identity: HostIdentity = {
    profile: randomFrom(BROWSER_PROFILES),
    acceptLanguage: randomFrom(ACCEPT_LANGUAGES),
    expiresAt: Date.now() + jitter(15 * 3_600_000, 9 * 3_600_000), // 6–24 h
  };
  hostIdentities.set(hostname, identity);
  return identity;
}

/** Test-only: clear cached identities so a test can assert fresh selection. */
export function _resetIdentities(): void {
  hostIdentities.clear();
}

// ── Persistence (2i) ─────────────────────────────────────────────────────────
// The identity map is in-memory, so every process restart re-rolls a fresh
// browser for every host — and "the same IP suddenly presents a brand-new
// browser" is exactly the bot signature a stable identity exists to avoid. The
// worker persists these to the datastore and rehydrates them on boot. This
// module stays storage-agnostic (no DB dependency) — it only serializes.

export interface SerializedIdentity {
  host: string;
  profile: BrowserProfile;
  acceptLanguage: string;
  expiresAt: number;
}

/** Snapshot the live (non-expired) identities for persistence. */
export function exportIdentities(): SerializedIdentity[] {
  const now = Date.now();
  const out: SerializedIdentity[] = [];
  for (const [host, id] of hostIdentities) {
    if (id.expiresAt > now) {
      out.push({ host, profile: id.profile, acceptLanguage: id.acceptLanguage, expiresAt: id.expiresAt });
    }
  }
  return out;
}

/** Rehydrate persisted identities, skipping any that have since expired. Does
 *  not clobber a fresher in-memory identity for the same host. */
export function importIdentities(entries: SerializedIdentity[]): void {
  const now = Date.now();
  for (const e of entries) {
    if (!e?.host || !e.profile?.ua || e.expiresAt <= now) continue;
    const existing = hostIdentities.get(e.host);
    if (existing && existing.expiresAt >= e.expiresAt) continue;
    hostIdentities.set(e.host, {
      profile: e.profile,
      acceptLanguage: e.acceptLanguage,
      expiresAt: e.expiresAt,
    });
  }
}
