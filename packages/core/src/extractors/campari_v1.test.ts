import { describe, it, expect } from "vitest";
import { parseCampariCards } from "./campari_v1.js";

const HTML = `
<html><body>
  <nav><a class="sn_btn" href="javascript:;">Buy now</a></nav>
  <div class="grid">
    <div class="item">
      <h3>Russell's Reserve 13 Year</h3>
      <a class="sn_btn primary" href="/our-products/russells-reserve-13/">Add to cart</a>
    </div>
    <div class="item">
      <h3>Russell&#8217;s Reserve Single Barrel</h3>
      <a class="sn_btn" href="/our-products/single-barrel/">See details</a>
    </div>
    <a class="sn_btn" href="/bourbon-cocktails/">Discover more</a>
  </div>
  <div class="carousel">
    <h3>Russell's Reserve 13 Year (carousel)</h3>
    <a class="sn_btn" href="/our-products/russells-reserve-13/">Buy now</a>
  </div>
  <!-- <a class="sn_btn" href="/our-products/ghost-in-comment/">Add to cart</a> -->
  <script type="application/ld+json">
    {"@type":"CollectionPage","mainEntity":{"itemListElement":[
      {"url":"https://x.com/our-products/staged-combo/","name":"Protected: Staged Combo"}
    ]}}
  </script>
</body></html>
`;

describe("parseCampariCards", () => {
  it("parses product cards with CTA-text availability and nearest-preceding-h3 titles", () => {
    const products = parseCampariCards(HTML, { baseUrl: "https://x.com", vendorName: "Russell's" });
    const byHandle = Object.fromEntries(products.map((p) => [p.handle, p]));

    expect(Object.keys(byHandle).sort()).toEqual(["russells-reserve-13", "single-barrel"]);

    expect(byHandle["russells-reserve-13"]!.available).toBe(true); // "Add to cart"
    expect(byHandle["russells-reserve-13"]!.title).toBe("Russell's Reserve 13 Year");
    expect(byHandle["russells-reserve-13"]!.url).toBe("https://x.com/our-products/russells-reserve-13/");
    expect(byHandle["russells-reserve-13"]!.vendor).toBe("Russell's");

    expect(byHandle["single-barrel"]!.available).toBe(false); // "See details"
    expect(byHandle["single-barrel"]!.title).toBe("Russell's Reserve Single Barrel"); // entity decoded
  });

  it("excludes non-product sn_btns (nav javascript:, cocktails, commented-out)", () => {
    const handles = parseCampariCards(HTML, { baseUrl: "https://x.com" }).map((p) => p.handle);
    expect(handles).not.toContain("bourbon-cocktails");
    expect(handles).not.toContain("ghost-in-comment");
  });

  it("de-dups: the listing card wins over the carousel duplicate", () => {
    const products = parseCampariCards(HTML, { baseUrl: "https://x.com" });
    const thirteen = products.filter((p) => p.handle === "russells-reserve-13");
    expect(thirteen).toHaveLength(1);
    expect(thirteen[0]!.title).toBe("Russell's Reserve 13 Year"); // not the "(carousel)" h3
  });

  it("overlays JSON-LD staged items as not-yet-buyable when useCollectionSchema", () => {
    const products = parseCampariCards(HTML, { baseUrl: "https://x.com", useCollectionSchema: true });
    const staged = products.find((p) => p.handle === "staged-combo");
    expect(staged).toBeDefined();
    expect(staged!.available).toBe(false);
    expect(staged!.title).toBe("Staged Combo"); // "Protected: " stripped
  });

  it("ignores the JSON-LD overlay when useCollectionSchema is off", () => {
    const handles = parseCampariCards(HTML, { baseUrl: "https://x.com" }).map((p) => p.handle);
    expect(handles).not.toContain("staged-combo");
  });
});
