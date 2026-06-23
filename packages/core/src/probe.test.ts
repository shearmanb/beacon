import { describe, it, expect } from "vitest";
import { probeSite } from "./probe.js";

// Only the input-validation branches are covered here — they return before any
// network call, so the test stays hermetic. The detection branches exercise the
// real fetch layer and are covered indirectly by the adapter tests.
describe("probeSite", () => {
  it("rejects a non-URL string without hitting the network", async () => {
    const r = await probeSite("not a url");
    expect(r.error).toBeTruthy();
    expect(r.kind).toBeNull();
    expect(r.source).toBeUndefined();
  });

  it("rejects a non-http(s) protocol", async () => {
    const r = await probeSite("ftp://example.com/file");
    expect(r.error).toBeTruthy();
    expect(r.kind).toBeNull();
  });

  it("trims and still validates", async () => {
    const r = await probeSite("   javascript:alert(1)   ");
    expect(r.error).toBeTruthy();
  });
});
