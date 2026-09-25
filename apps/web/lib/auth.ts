// Dashboard auth token (4b). The old scheme set the cookie to a literal "1",
// which anyone could forge with `document.cookie="beacon_auth=1"` — the password
// only gated *issuing* a value you could type by hand. Now the cookie is an
// HMAC-SHA256 over a fixed payload keyed by a server secret, so a valid cookie
// can't be produced without the secret. (Replay of a stolen cookie still works,
// as with any bearer session — Cloudflare Access remains the real shared-machine
// fix; this just closes trivial forgery.)
//
// Uses Web Crypto (globalThis.crypto.subtle), available in both the Edge
// middleware runtime and the Node server-action runtime, so one helper serves
// both. The secret resolves identically in both, so tokens always verify.
// v2 (2026-09): the token carries a signed issue time and expires server-side
// after 30 days, and production never falls back to the public "beam" default.

const PAYLOAD = "beacon-auth-v2";
const encoder = new TextEncoder();
/** Server-side session lifetime, enforced from the signed issue time — a
 *  copied cookie stops working after this even if the browser keeps it. */
export const AUTH_MAX_AGE_S = 60 * 60 * 24 * 30;
const CLOCK_SKEW_S = 300;
// Local-dev convenience only. It is public in git history, so production
// never falls back to it: with no password configured the dashboard fails
// closed (login refused, every cookie invalid) instead of opening to "beam".
const DEV_FALLBACK = "beam";

/** The dashboard password, or null when production has none configured. */
export function configuredPassword(): string | null {
  const p = process.env.BEACON_DASH_PASSWORD;
  if (p) return p;
  return process.env.NODE_ENV === "production" ? null : DEV_FALLBACK;
}

function authSecret(): string | null {
  return process.env.BEACON_AUTH_SECRET || configuredPassword();
}

async function hmacHex(message: string, key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** The signed cookie value to set after a correct password: `<issuedAt>.<hmac>`. */
export async function issueAuthToken(nowS: number = Math.floor(Date.now() / 1000)): Promise<string> {
  const secret = authSecret();
  if (!secret) throw new Error("No dashboard password configured (BEACON_DASH_PASSWORD).");
  return `${nowS}.${await hmacHex(`${PAYLOAD}|${nowS}`, secret)}`;
}

/** Valid signature AND issued within AUTH_MAX_AGE_S. */
export async function verifyAuthToken(
  token: string | undefined | null,
  nowS: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const secret = authSecret();
  if (!token || !secret) return false;
  const dot = token.indexOf(".");
  if (dot <= 0) return false;
  const iatText = token.slice(0, dot);
  if (!/^\d{1,12}$/.test(iatText)) return false;
  const iat = Number(iatText);
  if (nowS - iat > AUTH_MAX_AGE_S || iat - nowS > CLOCK_SKEW_S) return false;
  return safeEqual(token.slice(dot + 1), await hmacHex(`${PAYLOAD}|${iat}`, secret));
}
