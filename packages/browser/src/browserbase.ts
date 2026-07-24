// Minimal Browserbase REST client — deliberately fetch-based, no SDK dep
// (lean rule: it's three endpoints). Creates persistent Contexts (a real
// browser user-data-dir that survives between sessions — cookies/localStorage
// continuity per retailer) and Sessions (a live Chromium we attach to over CDP
// with playwright-core).
//
// Policy: CAPTCHA auto-solving is EXPLICITLY disabled on every session
// (solveCaptchas: false). Beacon detects and reports walls; it never defeats
// them. If Browserbase rejects the field (API drift), we retry once without
// browserSettings rather than silently flipping the policy — see createSession.

const API_BASE = "https://api.browserbase.com/v1";
const HTTP_TIMEOUT_MS = 20_000;

export interface BrowserbaseCreds {
  apiKey: string;
  projectId: string;
}

export interface BrowserbaseSession {
  id: string;
  connectUrl: string;
}

export class BrowserbaseApiError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, op: string, detail: string) {
    super(`Browserbase ${op} failed: HTTP ${statusCode} ${detail}`.trim());
    this.name = "BrowserbaseApiError";
    this.statusCode = statusCode;
  }
}

/** Resolve creds from env (Railway variables) with a secrets-table fallback. */
export function resolveCreds(resolveSecret?: (ref: string) => string | null | undefined): BrowserbaseCreds | null {
  const apiKey = process.env["BROWSERBASE_API_KEY"] ?? resolveSecret?.("browserbase_api_key") ?? null;
  const projectId = process.env["BROWSERBASE_PROJECT_ID"] ?? resolveSecret?.("browserbase_project_id") ?? null;
  if (!apiKey || !projectId) return null;
  return { apiKey, projectId };
}

function signalFor(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  if (!parent) return timeout;
  // AbortSignal.any is Node ≥20.3; fall back to just the timeout if absent.
  const any = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return any ? any([parent, timeout]) : timeout;
}

async function api(
  creds: BrowserbaseCreds,
  op: string,
  path: string,
  body: unknown,
  parentSignal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "X-BB-API-Key": creds.apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signalFor(parentSignal),
  });
  const text = await res.text();
  if (!res.ok) throw new BrowserbaseApiError(res.status, op, text.slice(0, 200));
  return JSON.parse(text) as Record<string, unknown>;
}

/** Create a persistent Context (the durable browser profile). Returns its id. */
export async function createContext(
  creds: BrowserbaseCreds,
  parentSignal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const json = await api(creds, "context create", "/contexts", { projectId: creds.projectId }, parentSignal, fetchImpl);
  const id = json["id"];
  if (typeof id !== "string" || !id) throw new Error(`Browserbase context create returned no id: ${JSON.stringify(json).slice(0, 200)}`);
  return id;
}

export interface CreateSessionOptions {
  /** Attach a persistent Context; changes made in the session are written back. */
  contextId?: string | undefined;
  /** Route the session through Browserbase's residential proxies (escalation only). */
  residentialProxy?: boolean;
}

/** Build the session-create request body (exported for tests — the policy that
 *  solveCaptchas stays false lives here and is asserted by a test). */
export function sessionBody(creds: BrowserbaseCreds, opts: CreateSessionOptions): Record<string, unknown> {
  const browserSettings: Record<string, unknown> = { solveCaptchas: false };
  if (opts.contextId) browserSettings["context"] = { id: opts.contextId, persist: true };
  return {
    projectId: creds.projectId,
    browserSettings,
    ...(opts.residentialProxy ? { proxies: true } : {}),
  };
}

export async function createSession(
  creds: BrowserbaseCreds,
  opts: CreateSessionOptions,
  parentSignal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<BrowserbaseSession> {
  let json: Record<string, unknown>;
  try {
    json = await api(creds, "session create", "/sessions", sessionBody(creds, opts), parentSignal, fetchImpl);
  } catch (err) {
    // API drift guard: if browserSettings is rejected (400), retry bare rather
    // than dying — losing context persistence for one check beats losing the
    // check. Anything else (auth, quota) propagates.
    if (err instanceof BrowserbaseApiError && err.statusCode === 400) {
      json = await api(creds, "session create (bare retry)", "/sessions", { projectId: creds.projectId }, parentSignal, fetchImpl);
    } else {
      throw err;
    }
  }
  const id = json["id"];
  const connectUrl = json["connectUrl"];
  if (typeof id !== "string" || typeof connectUrl !== "string" || !connectUrl) {
    throw new Error(`Browserbase session create returned no connectUrl: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return { id, connectUrl };
}
