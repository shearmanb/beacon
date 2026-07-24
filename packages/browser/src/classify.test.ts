import { describe, it, expect } from "vitest";
import { classifyWall, wallToError, BrowserCheckError } from "./classify.js";

describe("classifyWall", () => {
  it("returns null for a normal storefront page", () => {
    expect(classifyWall("<html><body><div class='product-grid'>Reveries 10yr</div></body></html>", "Shared Pour")).toBeNull();
  });

  it("detects a Cloudflare challenge by title", () => {
    const v = classifyWall("<html></html>", "Just a moment...");
    expect(v?.kind).toBe("challenge");
  });

  it("detects Incapsula/Imperva resources", () => {
    const v = classifyWall('<script src="/_Incapsula_Resource?x=1"></script>');
    expect(v?.kind).toBe("challenge");
  });

  it("detects a Shopify password wall", () => {
    const v = classifyWall("<form>Enter store using password</form>");
    expect(v?.kind).toBe("password_wall");
  });

  it("detects access-denied block pages", () => {
    const v = classifyWall("<h1>Access Denied</h1>");
    expect(v?.kind).toBe("blocked");
  });
});

describe("wallToError", () => {
  it("carries the real HTTP status when present", () => {
    const err = wallToError({ kind: "challenge", marker: "just a moment" }, 503, "https://x.test");
    expect(err).toBeInstanceOf(BrowserCheckError);
    expect(err.statusCode).toBe(503);
    expect(err.message).toContain("challenge");
  });

  it("maps status-less walls to 403 so the circuit breaker engages", () => {
    const err = wallToError({ kind: "blocked", marker: "access denied" }, 200, "https://x.test");
    expect(err.statusCode).toBe(403);
  });
});
