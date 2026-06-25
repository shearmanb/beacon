import { describe, it, expect, beforeEach } from "vitest";
import { identityForHost, exportIdentities, importIdentities, _resetIdentities } from "./identity.js";

describe("identity persistence (2i)", () => {
  beforeEach(() => _resetIdentities());

  it("round-trips a live identity through export/import", () => {
    const original = identityForHost("shop.example.com");
    const dumped = exportIdentities();
    expect(dumped.some((d) => d.host === "shop.example.com")).toBe(true);

    _resetIdentities();
    importIdentities(dumped);
    const restored = identityForHost("shop.example.com");
    expect(restored.profile.ua).toBe(original.profile.ua);
    expect(restored.expiresAt).toBe(original.expiresAt);
  });

  it("skips expired entries on import", () => {
    importIdentities([
      { host: "stale.example.com", profile: { ua: "x" }, acceptLanguage: "en", expiresAt: Date.now() - 1000 },
    ]);
    // A fresh identity is rolled instead of using the expired import.
    const id = identityForHost("stale.example.com");
    expect(id.profile.ua).not.toBe("x");
  });

  it("omits already-expired identities from export", () => {
    importIdentities([
      { host: "soon.example.com", profile: { ua: "y" }, acceptLanguage: "en", expiresAt: Date.now() - 1 },
    ]);
    expect(exportIdentities().some((d) => d.host === "soon.example.com")).toBe(false);
  });
});
