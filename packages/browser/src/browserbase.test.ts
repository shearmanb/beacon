import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sessionBody,
  createSession,
  createContext,
  ensureProjectId,
  _resetProjectIdCache,
  BrowserbaseApiError,
} from "./browserbase.js";

const CREDS = { apiKey: "key", projectId: "proj" };

function fetchReturning(status: number, json: unknown): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(json), { status })) as unknown as typeof fetch;
}

describe("sessionBody (policy)", () => {
  it("ALWAYS disables CAPTCHA auto-solving", () => {
    const body = sessionBody(CREDS, {});
    expect((body["browserSettings"] as Record<string, unknown>)["solveCaptchas"]).toBe(false);
  });

  it("attaches a persistent context when given one", () => {
    const body = sessionBody(CREDS, { contextId: "ctx1" });
    expect((body["browserSettings"] as Record<string, unknown>)["context"]).toEqual({ id: "ctx1", persist: true });
  });

  it("omits proxies unless residential is requested", () => {
    expect("proxies" in sessionBody(CREDS, {})).toBe(false);
    expect(sessionBody(CREDS, { residentialProxy: true })["proxies"]).toBe(true);
  });
});

describe("createSession", () => {
  it("returns id + connectUrl and sends the API key header", async () => {
    const impl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["X-BB-API-Key"]).toBe("key");
      return new Response(JSON.stringify({ id: "s1", connectUrl: "wss://connect/s1" }), { status: 200 });
    }) as unknown as typeof fetch;
    const s = await createSession(CREDS, {}, undefined, impl);
    expect(s).toEqual({ id: "s1", connectUrl: "wss://connect/s1" });
  });

  it("retries once with a bare body when browserSettings is rejected (400)", async () => {
    let calls = 0;
    const impl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (calls === 1) {
        expect(body["browserSettings"]).toBeDefined();
        return new Response("bad field", { status: 400 });
      }
      expect(body["browserSettings"]).toBeUndefined();
      return new Response(JSON.stringify({ id: "s2", connectUrl: "wss://connect/s2" }), { status: 200 });
    }) as unknown as typeof fetch;
    const s = await createSession(CREDS, { contextId: "ctx" }, undefined, impl);
    expect(s.id).toBe("s2");
    expect(calls).toBe(2);
  });

  it("propagates auth/quota errors instead of retrying", async () => {
    await expect(createSession(CREDS, {}, undefined, fetchReturning(401, { error: "no" }))).rejects.toBeInstanceOf(
      BrowserbaseApiError,
    );
  });
});

describe("ensureProjectId (no PROJECT_ID configured — 2026-07 onboarding)", () => {
  beforeEach(() => _resetProjectIdCache());

  it("passes through a configured project id without any API call", async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    const creds = await ensureProjectId({ apiKey: "key", projectId: "explicit" }, undefined, impl);
    expect(creds).toEqual({ apiKey: "key", projectId: "explicit" });
    expect(impl).not.toHaveBeenCalled();
  });

  it("discovers the project via GET /projects (array shape) and caches it", async () => {
    const impl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain("/projects");
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify([{ id: "proj-auto", name: "Default" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const first = await ensureProjectId({ apiKey: "key", projectId: null }, undefined, impl);
    expect(first.projectId).toBe("proj-auto");
    const second = await ensureProjectId({ apiKey: "key", projectId: null }, undefined, impl);
    expect(second.projectId).toBe("proj-auto");
    expect(impl).toHaveBeenCalledTimes(1); // cached after the first discovery
  });

  it("handles the { projects: [...] } wrapper shape", async () => {
    const impl = vi.fn(async () =>
      new Response(JSON.stringify({ projects: [{ id: "proj-wrapped" }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const creds = await ensureProjectId({ apiKey: "key", projectId: null }, undefined, impl);
    expect(creds.projectId).toBe("proj-wrapped");
  });

  it("throws a clear error when the key has no projects", async () => {
    const impl = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })) as unknown as typeof fetch;
    await expect(ensureProjectId({ apiKey: "key", projectId: null }, undefined, impl)).rejects.toThrow(
      /no projects/,
    );
  });
});

describe("createContext", () => {
  it("returns the context id", async () => {
    await expect(createContext(CREDS, undefined, fetchReturning(200, { id: "ctx9" }))).resolves.toBe("ctx9");
  });

  it("throws a clear error when the id is missing", async () => {
    await expect(createContext(CREDS, undefined, fetchReturning(200, {}))).rejects.toThrow(/no id/);
  });
});
