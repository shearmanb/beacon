import { describe, it, expect } from "vitest";
import { assessYield } from "./drift_guard.js";
import { siteDefinitionSchema, type SiteDefinition } from "./schema.js";
import type { NormalizedProduct } from "@beacon/shared";

function site(): SiteDefinition {
  return siteDefinitionSchema.parse({
    id: "t",
    name: "Test Site",
    source: { kind: "shopify_rest", baseUrl: "https://x.com" },
  });
}
function products(n: number): Record<string, NormalizedProduct> {
  const m: Record<string, NormalizedProduct> = {};
  for (let i = 0; i < n; i++) m[`p${i}`] = { handle: `p${i}`, title: `p${i}`, url: "https://x.com", tags: [], available: true };
  return m;
}

describe("assessYield (structure-drift guard)", () => {
  it("grows the baseline on a healthy yield and never drifts", () => {
    const r = assessYield({ site: site(), prev: { countBaseline: 10 }, prevProducts: products(10), rawCount: 25 });
    expect(r.drift).toBeNull();
    expect(r.tracking.countBaseline).toBe(25);
    expect(r.tracking.driftStreak).toBe(0);
  });

  it("does NOT engage for small sites below the baseline floor", () => {
    const r = assessYield({ site: site(), prev: { countBaseline: 5 }, prevProducts: products(5), rawCount: 1 });
    expect(r.drift).toBeNull();
  });

  it("preserves products but stays silent on the first suspicious drop", () => {
    const prevProducts = products(60);
    const r = assessYield({ site: site(), prev: { countBaseline: 60 }, prevProducts, rawCount: 2 });
    expect(r.drift).not.toBeNull();
    expect(r.drift!.alerts).toHaveLength(0); // streak 1 < threshold 2
    expect(r.drift!.state.products).toBe(prevProducts); // preserved, not wiped
    expect(r.tracking.countBaseline).toBe(60); // baseline held, not redefined by the drop
  });

  it("fires site_changed once the drop persists past the threshold", () => {
    const prevProducts = products(60);
    const r = assessYield({ site: site(), prev: { countBaseline: 60, driftStreak: 1 }, prevProducts, rawCount: 3 });
    expect(r.drift!.alerts).toHaveLength(1);
    expect(r.drift!.alerts[0]!.type).toBe("site_changed");
    expect(r.drift!.state.products).toBe(prevProducts);
    expect(r.tracking.driftAlertSent).toBe(true);
  });

  it("resets the streak once yield recovers", () => {
    const r = assessYield({ site: site(), prev: { countBaseline: 60, driftStreak: 1 }, prevProducts: products(60), rawCount: 55 });
    expect(r.drift).toBeNull();
    expect(r.tracking.driftStreak).toBe(0);
  });
});
