import { describe, expect, it } from "vitest";
import { recentBySite, toActivityRow, type HistoryRowLike } from "./activity";

const row = (id: number, siteId: string, type: string, extra: Partial<HistoryRowLike> = {}): HistoryRowLike => ({
  id,
  ts: new Date(Date.UTC(2026, 9, 30, 12, id)).toISOString(),
  siteId,
  type,
  title: `t${id}`,
  url: `https://x/${id}`,
  payload: { minPrice: id * 10 },
  ...extra,
});

const kinds = { sp: "shopify_rest", wall: "http_status" };

describe("recentBySite", () => {
  it("caps each site at perSite rows, newest (highest id) first, regardless of input order", () => {
    const rows = [row(1, "sp", "new_product"), row(3, "sp", "sold_out"), row(2, "sp", "restock"), row(4, "sp", "new_product")];
    const got = recentBySite(rows, kinds, 3).get("sp")!;
    expect(got.map((r) => r.id)).toEqual([4, 3, 2]);
    expect(got[0]).toMatchObject({ glyph: "▲", label: "new", price: 40, title: "t4", url: "https://x/4" });
    expect(got[1]).toMatchObject({ glyph: "▼", label: "sold out" });
    expect(got[2]).toMatchObject({ glyph: "↻", label: "restock" });
  });

  it("product sites keep product events only; signal sites keep wall events only", () => {
    const rows = [
      row(1, "sp", "site_reset"),
      row(2, "sp", "new_product"),
      row(3, "wall", "site_reset"),
      row(4, "wall", "new_product"),
      row(5, "wall", "site_changed"),
    ];
    const got = recentBySite(rows, kinds);
    expect(got.get("sp")!.map((r) => r.type)).toEqual(["new_product"]);
    expect(got.get("wall")!.map((r) => r.type)).toEqual(["site_changed", "site_reset"]);
    expect(got.get("wall")![1]).toMatchObject({ glyph: "🌊", label: "wall up", title: "wall up" });
  });

  it("a signal row's title is the event (plus the payload note), not the site name", () => {
    const r = toActivityRow(row(7, "wall", "site_reset", { title: "The Reveries Site Status", payload: { note: "password wall detected" } }));
    expect(r.title).toBe("password wall detected");
  });

  it("ignores rows for unknown sites (unicorn has its own page), null siteIds, and non-activity types", () => {
    const rows = [row(1, "unicorn_auctions", "new_product"), row(2, "sp", "baseline"), row(3, "sp", "self_healed"), { ...row(4, "sp", "new_product"), siteId: null }];
    expect(recentBySite(rows, kinds).size).toBe(0);
  });

  it("tolerates a missing/invalid payload price and a '#' url", () => {
    const r = toActivityRow(row(9, "sp", "new_product", { payload: { minPrice: "n/a" }, url: "#" }));
    expect(r.price).toBeNull();
    expect(r.url).toBeNull();
    expect(toActivityRow(row(10, "sp", "new_product", { payload: null })).price).toBeNull();
  });
});
