import { describe, it, expect } from "vitest";
import { htmlToText, jitter, randomFrom, sleep } from "./utils.js";

describe("jitter", () => {
  it("stays within [base-spread, base+spread]", () => {
    for (let i = 0; i < 1000; i++) {
      const v = jitter(1000, 200);
      expect(v).toBeGreaterThanOrEqual(800);
      expect(v).toBeLessThanOrEqual(1200);
    }
  });

  it("floors at 0 even when spread exceeds base", () => {
    for (let i = 0; i < 1000; i++) {
      expect(jitter(100, 1000)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("randomFrom", () => {
  it("returns a member of the array", () => {
    const arr = ["a", "b", "c"] as const;
    for (let i = 0; i < 100; i++) {
      expect(arr).toContain(randomFrom(arr));
    }
  });
});

describe("sleep", () => {
  it("resolves after roughly the requested delay", async () => {
    const start = Date.now();
    await sleep(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});

describe("htmlToText", () => {
  it("turns description HTML into readable lines", () => {
    const html =
      "<p><strong>Proof:</strong> 115.8&nbsp;</p><p>Tasting notes &amp; more:</p><ul><li>Nose: caramel</li><li>Palate: oak &#8212; spice</li></ul><script>x()</script>";
    expect(htmlToText(html)).toBe("Proof: 115.8\nTasting notes & more:\n• Nose: caramel\n• Palate: oak — spice");
  });

  it("returns null for empty/whitespace-only input", () => {
    expect(htmlToText(null)).toBeNull();
    expect(htmlToText("<p> &nbsp; </p>")).toBeNull();
  });

  it("caps long text on a word boundary", () => {
    const out = htmlToText("word ".repeat(100), 50)!;
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.endsWith("word…")).toBe(true);
  });
});
