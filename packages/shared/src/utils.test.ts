import { describe, it, expect } from "vitest";
import { htmlToText, jitter, randomFrom, shopifyCartUrl, sleep } from "./utils.js";

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

describe("shopifyCartUrl", () => {
  it("builds the cart permalink on the store's origin from a numeric id or a Storefront GID", () => {
    expect(shopifyCartUrl("https://sharedpour.com/products/x", [{ id: 4455, available: true }])).toBe("https://sharedpour.com/cart/4455:1");
    expect(shopifyCartUrl("https://shop.example.com", [{ id: "gid://shopify/ProductVariant/987654321", available: true }])).toBe(
      "https://shop.example.com/cart/987654321:1",
    );
  });

  it("prefers the first buyable variant, else the first", () => {
    expect(shopifyCartUrl("https://s.com", [{ id: 1, available: false }, { id: 2, available: true }])).toBe("https://s.com/cart/2:1");
    expect(shopifyCartUrl("https://s.com", [{ id: 1, available: false }, { id: 2, available: false }])).toBe("https://s.com/cart/1:1");
  });

  it("is null without a usable variant id or store URL", () => {
    expect(shopifyCartUrl("https://s.com", [])).toBeNull();
    expect(shopifyCartUrl("https://s.com", undefined)).toBeNull();
    expect(shopifyCartUrl("https://s.com", [{ available: true }])).toBeNull();
    expect(shopifyCartUrl("https://s.com", [{ id: "not-an-id" }])).toBeNull();
    expect(shopifyCartUrl("not a url", [{ id: 1 }])).toBeNull();
  });
});
