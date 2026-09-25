import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { AUTH_MAX_AGE_S, configuredPassword, issueAuthToken, verifyAuthToken } from "./auth";

describe("dashboard auth token (4b)", () => {
  beforeAll(() => {
    process.env.BEACON_AUTH_SECRET = "test-secret-123";
  });
  afterEach(() => vi.unstubAllEnvs());

  it("issues a token that verifies", async () => {
    const token = await issueAuthToken();
    expect(token).toMatch(/^\d+\.[0-9a-f]{64}$/); // issuedAt.hex-sha-256
    expect(await verifyAuthToken(token)).toBe(true);
  });

  it("rejects a forged / hand-typed value (the old '1' attack)", async () => {
    expect(await verifyAuthToken("1")).toBe(false);
    expect(await verifyAuthToken("deadbeef")).toBe(false);
    expect(await verifyAuthToken(undefined)).toBe(false);
    expect(await verifyAuthToken("")).toBe(false);
  });

  it("rejects a token whose issue time was edited (signature covers it)", async () => {
    const token = await issueAuthToken(1_000_000);
    const forged = token.replace(/^\d+/, String(Math.floor(Date.now() / 1000)));
    expect(await verifyAuthToken(forged)).toBe(false);
  });

  it("expires server-side after AUTH_MAX_AGE_S, even if the browser keeps the cookie", async () => {
    const now = 2_000_000_000;
    const token = await issueAuthToken(now);
    expect(await verifyAuthToken(token, now + AUTH_MAX_AGE_S - 60)).toBe(true);
    expect(await verifyAuthToken(token, now + AUTH_MAX_AGE_S + 60)).toBe(false);
    expect(await verifyAuthToken(token, now - 3600)).toBe(false); // issued in the future
  });

  it("fails closed in production when no password is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BEACON_DASH_PASSWORD", "");
    vi.stubEnv("BEACON_AUTH_SECRET", "");
    expect(configuredPassword()).toBeNull();
    const devToken = "1.".padEnd(66, "0");
    expect(await verifyAuthToken(devToken)).toBe(false);
    await expect(issueAuthToken()).rejects.toThrow(/BEACON_DASH_PASSWORD/);
  });

  it("keeps the local-dev fallback outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("BEACON_DASH_PASSWORD", "");
    expect(configuredPassword()).toBe("beam");
  });
});
