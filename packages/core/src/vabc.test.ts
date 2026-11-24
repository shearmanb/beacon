import { describe, it, expect } from "vitest";
import {
  diffVabc,
  formatVabcChange,
  judgeVabcRead,
  looksLikeBotChallenge,
  parseVabcPage,
  parseVabcState,
  vabcFingerprint,
  type VabcItem,
} from "./vabc.js";

// Trimmed from the real page (2026-11-24 save): nav noise, the on-shelf card
// (incl. the "A<a>braham" split-letter quirk and &nbsp;), and the limited card.
const li = (slug: string, name: string, code: string): string => `
                            <li>
                                <a href="/products/bourbon/${slug}?productSize=0">
                                    ${name}
                                </a>
                                | ${code}
                            </li>`;

function page(limited: Array<[string, string, string]>): string {
  return `
<nav><ul>
  <li class="menu-item"><a href="/products/limited-availability/lottery">Lottery</a></li>
  <li><a href="/products">Products</a></li>
</ul></nav>
<div class="header"><h2>
Store Purchase Only Products                </h2></div>
<p style="text-align: right;"><em>Updated July 11, 2025</em></p>
<div class="header"><h3>
Available On-Shelf                </h3></div>
<ul style="list-style-type: disc;">
    <li><a href="https://www.abc.virginia.gov/products/bourbon/buffalo-trace-bourbon?productSize=1" target="_self">Buffalo Trace Bourbon 750ml</a>&nbsp;| 018006 | 1 per person per day</li>
    <li>A<a href="https://www.abc.virginia.gov/products/whiskey/abraham-bowman-cider-cask-virginia-special-release?productSize=0">braham Bowman Cider Cask Virginia Special Release</a> | 024844 | 1 per person per day</li>
</ul>
<div class="header"><h3>
Limited Availability Products | One Bottle Per Person                </h3></div>
<div class="abc-card abc-multiproduct-card"><div class="content-body">
  <div class="row"><div class="col-xs-12 slug"><strong>Updated:&nbsp; 11.23.26</strong></div></div>
  <div class="row"><ul>${limited.map(([s, n, c]) => li(s, n, c)).join("")}
  </ul></div>
</div></div>
<footer><h3>Social Media</h3><ul><li><a href="/x">Facebook</a></li></ul></footer>`;
}

const BASE: Array<[string, string, string]> = [
  ["1792-aged-12-year-bourbon", "1792 Aged 12 Year Bourbon 750ml", "021443"],
  ["1792-single-barrel-bourbon", "1792 Single Barrel Bourbon 750ml", "021244"],
  ["blade-and-bow-22", "Blade &amp; Bow 22 Year Bourbon 750ml", "016480"],
  ["willett-wheated-8-year-bourbon", "Willett Wheated 8 Year Bourbon 750ml", "022076"],
  ["woodford-double-double", "Woodford Reserve Double Double Oaked Bourbon 700ml", "022316"],
  ["abraham-bowman-cider-cask", "Abraham Bowman Cider Cask Virginia Special Release 750ml", "024844"],
];

describe("parseVabcPage", () => {
  const parsed = parseVabcPage(page(BASE));

  it("reads both sections, keyed by code, ignoring nav/footer lists", () => {
    const limited = parsed.items.filter((i) => i.section === "limited");
    const onShelf = parsed.items.filter((i) => i.section === "onShelf");
    expect(limited.map((i) => i.code)).toEqual(["021443", "021244", "016480", "022076", "022316", "024844"]);
    expect(onShelf.map((i) => i.code)).toEqual(["018006", "024844"]);
  });

  it("cleans names (split first letter, entities, whitespace) and absolutizes urls", () => {
    const bowman = parsed.items.find((i) => i.section === "onShelf" && i.code === "024844")!;
    expect(bowman.name).toBe("Abraham Bowman Cider Cask Virginia Special Release");
    expect(parsed.items.find((i) => i.code === "016480")!.name).toBe("Blade & Bow 22 Year Bourbon 750ml");
    expect(parsed.items.find((i) => i.code === "021443")!.url).toBe(
      "https://www.abc.virginia.gov/products/bourbon/1792-aged-12-year-bourbon?productSize=0",
    );
  });

  it("captures the list's own Updated stamp, not the older prose date", () => {
    expect(parsed.updatedLabel).toBe("11.23.26");
  });
});

describe("looksLikeBotChallenge", () => {
  it("spots the Cloudflare interstitial and passes the real page", () => {
    const cf = `<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><script>(function(){window._cf_chl_opt = {cType: 'non-interactive'}})();</script></body></html>`;
    expect(looksLikeBotChallenge(cf)).toBe(true);
    expect(looksLikeBotChallenge(page(BASE))).toBe(false);
  });
});

describe("diffVabc", () => {
  it("flags additions and deletions per section", () => {
    const prev = parseVabcPage(page(BASE)).items;
    const next = parseVabcPage(
      page([...BASE.filter(([, , c]) => c !== "021244"), ["eh-taylor-barrel-proof", "E.H. Taylor Barrel Proof 750ml", "018370"]]),
    ).items;
    const d = diffVabc(prev, next);
    expect(d.added.map((i) => i.code)).toEqual(["018370"]);
    expect(d.removed.map((i) => i.code)).toEqual(["021244"]);
  });

  it("treats a move between sections as removed-from-one, added-to-the-other", () => {
    const a: VabcItem[] = [{ code: "111111", name: "X", url: null, section: "limited" }];
    const b: VabcItem[] = [{ code: "111111", name: "X", url: null, section: "onShelf" }];
    const d = diffVabc(a, b);
    expect(d.added).toHaveLength(1);
    expect(d.removed).toHaveLength(1);
  });

  it("ignores a name-only edit (same code)", () => {
    const a: VabcItem[] = [{ code: "111111", name: "X 750ml", url: null, section: "limited" }];
    const b: VabcItem[] = [{ code: "111111", name: "X 750 ml", url: null, section: "limited" }];
    expect(diffVabc(a, b)).toEqual({ added: [], removed: [] });
  });
});

describe("judgeVabcRead", () => {
  const items = (n: number): VabcItem[] =>
    Array.from({ length: n }, (_, k) => ({ code: String(100000 + k), name: `B${k}`, url: null, section: "limited" as const }));

  it("rejects a read that no longer sees the list (structure drift)", () => {
    expect(judgeVabcRead(items(40), { items: items(2), updatedLabel: null }, null).kind).toBe("invalid");
  });

  it("holds a mass shrink until the next read confirms the identical list", () => {
    const shrunk = { items: items(12), updatedLabel: null };
    const first = judgeVabcRead(items(40), shrunk, null);
    expect(first.kind).toBe("hold");
    const fp = first.kind === "hold" ? first.fingerprint : null;
    expect(judgeVabcRead(items(40), shrunk, fp).kind).toBe("ok");
  });

  it("passes ordinary churn and the first-ever read", () => {
    expect(judgeVabcRead(items(40), { items: items(38), updatedLabel: null }, null).kind).toBe("ok");
    expect(judgeVabcRead([], { items: items(40), updatedLabel: null }, null).kind).toBe("ok");
  });

  it("fingerprint is order-independent", () => {
    expect(vabcFingerprint(items(5))).toBe(vabcFingerprint(items(5).reverse()));
  });
});

describe("formatVabcChange / parseVabcState", () => {
  it("lists additions then removals with codes and links", () => {
    const note = formatVabcChange({
      added: [{ code: "018370", name: "E.H. Taylor BP", url: "https://x/1", section: "limited" }],
      removed: [{ code: "018006", name: "Buffalo Trace", url: null, section: "onShelf" }],
      updatedLabel: "11.24.26",
    });
    expect(note).toContain("➕ Added (1)");
    expect(note).toContain("[E.H. Taylor BP](https://x/1) · 018370");
    expect(note).toContain("➖ Removed (1)");
    expect(note).toContain("Buffalo Trace · 018006 (on-shelf list)");
    expect(note.indexOf("Added")).toBeLessThan(note.indexOf("Removed"));
  });

  it("stays under Discord's 4096-char embed limit when the whole list turns over", () => {
    const many: VabcItem[] = Array.from({ length: 90 }, (_, k) => ({
      code: String(500000 + k),
      name: `Some Very Long Limited Availability Bottle Name Number ${k} Kentucky Straight Bourbon 750ml`,
      url: `https://www.abc.virginia.gov/products/bourbon/some-very-long-slug-${k}?productSize=0`,
      section: "limited",
    }));
    const note = formatVabcChange({ added: many, removed: many, updatedLabel: "11.24.26" });
    expect(note.length).toBeLessThan(4096);
    expect(note).toMatch(/…and \d+ more \(full list on \/vabc\)/);
    expect(note).toContain("➖ Removed (90)");
    expect(note).not.toContain("](https://"); // links dropped for big changes
    const typical = formatVabcChange({ added: many.slice(0, 30), removed: [], updatedLabel: null });
    expect(typical.length).toBeLessThan(4096);
  });

  it("tolerates missing/garbage state", () => {
    expect(parseVabcState(null).items).toEqual([]);
    expect(parseVabcState("not json").consecutiveFailures).toBe(0);
    expect(parseVabcState('{"items":"x"}').items).toEqual([]);
  });
});
