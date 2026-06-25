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

const PAYLOAD = "beacon-auth-v1";
const encoder = new TextEncoder();

function authSecret(): string {
  return process.env.BEACON_AUTH_SECRET ?? process.env.BEACON_DASH_PASSWORD ?? "beam";
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

/** The signed cookie value to set after a correct password. */
export function issueAuthToken(): Promise<string> {
  return hmacHex(PAYLOAD, authSecret());
}

/** Constant-time-ish compare of a presented cookie against the expected token. */
export async function verifyAuthToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const expected = await issueAuthToken();
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}
