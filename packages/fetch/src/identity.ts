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
