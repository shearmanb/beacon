import { describe, it, expect } from "vitest";
import { conditionalHeaders, extractValidators } from "./conditional.js";

describe("conditionalHeaders", () => {
  it("emits If-None-Match / If-Modified-Since when present", () => {
    expect(conditionalHeaders({ etag: '"abc"', lastModified: "Wed, 21 Oct 2025 07:28:00 GMT" })).toEqual({
      "If-None-Match": '"abc"',
      "If-Modified-Since": "Wed, 21 Oct 2025 07:28:00 GMT",
    });
  });

  it("omits absent validators and tolerates null/undefined", () => {
    expect(conditionalHeaders({ etag: '"abc"', lastModified: null })).toEqual({ "If-None-Match": '"abc"' });
    expect(conditionalHeaders(null)).toEqual({});
    expect(conditionalHeaders(undefined)).toEqual({});
  });
});

describe("extractValidators", () => {
  it("pulls etag + last-modified from response headers", () => {
    expect(extractValidators({ etag: '"x"', "last-modified": "yesterday" })).toEqual({
      etag: '"x"',
      lastModified: "yesterday",
    });
  });

  it("returns null when neither header is present", () => {
    expect(extractValidators({})).toBeNull();
    expect(extractValidators(undefined)).toBeNull();
  });
});
