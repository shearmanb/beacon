import { describe, it, expect, beforeAll } from "vitest";
import { issueAuthToken, verifyAuthToken } from "./auth";

describe("dashboard auth token (4b)", () => {
  beforeAll(() => {
    process.env.BEACON_AUTH_SECRET = "test-secret-123";
  });

  it("issues a token that verifies", async () => {
    const token = await issueAuthToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/); // hex sha-256
    expect(await verifyAuthToken(token)).toBe(true);
  });

  it("rejects a forged / hand-typed value (the old '1' attack)", async () => {
    expect(await verifyAuthToken("1")).toBe(false);
    expect(await verifyAuthToken("deadbeef")).toBe(false);
    expect(await verifyAuthToken(undefined)).toBe(false);
    expect(await verifyAuthToken("")).toBe(false);
  });

  it("is deterministic for a fixed secret (so middleware + action agree)", async () => {
    expect(await issueAuthToken()).toBe(await issueAuthToken());
  });
});
