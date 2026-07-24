// Minimal Browserbase REST client — deliberately fetch-based, no SDK dep
// (lean rule: it's three endpoints). Creates persistent Contexts (a real
// browser user-data-dir that survives between sessions — cookies/localStorage
// continuity per retailer) and Sessions (a live Chromium we attach to over CDP
// with playwright-core).
//
// Project resolution (2026-07 onboarding change): Browserbase no longer hands
// users a project id — the API key alone identifies the account, and clients
// resolve the project themselves. So only BROWSERBASE_API_KEY is required;
// the project id is fetched once via GET /v1/projects and cached for the
// process (BROWSERBASE_PROJECT_ID still works as an explicit override).
//
// Policy: CAPTCHA auto-solving is EXPLICITLY disabled on every session
// (solveCaptchas: false). Beacon detects and reports walls; it never defeats
// them. If Browserbase rejects the field (API drift), we retry once without
// browserSettings rather than silently flipping the policy — see createSession.

const API_BASE = "https://api.browserbase.com/v1";
const HTTP_TIMEOUT_MS = 20_000;

/** What we can resolve from env/secrets alone — project id may be unknown. */
export interface BrowserbaseAuth {
  apiKey: string;
  projectId: string | null;
}

/** Fully-resolved credentials (project id known) used by the API calls. */
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

/** Resolve auth from env (Railway variables) with a secrets-table fallback.
 *  Only the API key is required; a configured project id is an override. */
export function resolveAuth(resolveSecret?: (ref: string) => string | null | undefined): BrowserbaseAuth | null {
  const apiKey = process.env["BROWSERBASE_API_KEY"] ?? resolveSecret?.("browserbase_api_key") ?? null;
  if (!apiKey) return null;
  const projectId = process.env["BROWSERBASE_PROJECT_ID"] ?? resolveSecret?.("browserbase_project_id") ?? null;
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
  apiKey: string,
  op: string,
  path: string,
  body: unknown | undefined,
  parentSignal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const res = await fetchImpl(`${API_BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "X-BB-API-Key": apiKey,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signalFor(parentSignal),
  });
  const text = await res.text();
  if (!res.ok) throw new BrowserbaseApiError(res.status, op, text.slice(0, 200));
  return JSON.parse(text) as unknown;
}

// Process-level cache: the account's project id never changes mid-run.
let cachedProjectId: string | null = null;

/** Test-only: clear the cached project id. */
export function _resetProjectIdCache(): void {
  cachedProjectId = null;
}

/** Turn auth into full creds, discovering the project id from the API when it
 *  wasn't configured. Handles both response shapes ([{id}] and {projects:[{id}]}). */
export async function ensureProjectId(
  auth: BrowserbaseAuth,
  parentSignal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<BrowserbaseCreds> {
  if (auth.projectId) return { apiKey: auth.apiKey, projectId: auth.projectId };
  if (cachedProjectId) return { apiKey: auth.apiKey, projectId: cachedProjectId };
  const json = await api(auth.apiKey, "project list", "/projects", undefined, parentSignal, fetchImpl);
  const list = Array.isArray(json)
    ? json
    : Array.isArray((json as { projects?: unknown[] }).projects)
      ? ((json as { projects: unknown[] }).projects)
      : [];
  const id = (list[0] as { id?: unknown } | undefined)?.id;
  if (typeof id !== "string" || !id) {
    throw new Error(`Browserbase project discovery returned no projects for this API key`);
  }
  cachedProjectId = id;
  return { apiKey: auth.apiKey, projectId: id };
}

/** Create a persistent Context (the durable browser profile). Returns its id. */
export async function createContext(
  creds: BrowserbaseCreds,
  parentSignal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const json = (await api(creds.apiKey, "context create", "/contexts", { projectId: creds.projectId }, parentSignal, fetchImpl)) as Record<string, unknown>;
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
    json = (await api(creds.apiKey, "session create", "/sessions", sessionBody(creds, opts), parentSignal, fetchImpl)) as Record<string, unknown>;
  } catch (err) {
    // API drift guard: if browserSettings is rejected (400), retry bare rather
    // than dying — losing context persistence for one check beats losing the
    // check. Anything else (auth, quota) propagates.
    if (err instanceof BrowserbaseApiError && err.statusCode === 400) {
      json = (await api(creds.apiKey, "session create (bare retry)", "/sessions", { projectId: creds.projectId }, parentSignal, fetchImpl)) as Record<string, unknown>;
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
