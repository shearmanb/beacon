import { getStore } from "../../lib/store";
import { ProductsTable, type ProductRow } from "../../components/ProductsTable";
import { isReveries } from "../../lib/reveries";
import { rosterIsLive } from "../../lib/live";

export const dynamic = "force-dynamic";

export default async function ProductsPage() {
  const store = await getStore();
  const rows = await store.sites.list();
  const [states, ignored] = await Promise.all([
    Promise.all(rows.map((r) => store.state.load(r.id))),
    store.ignored.set(),
  ]);

  const items: ProductRow[] = [];
  rows.forEach((row, i) => {
    const products = (states[i]?.products as Record<string, Record<string, unknown>> | undefined) ?? {};
    // A disabled / long-silent checker freezes its roster: its `available` flags
    // are a snapshot, not stock (see lib/live.ts). Rows stay listed — they are
    // real products with real history — but are labelled, never counted as in
    // stock, and never matched by the "in stock" filter.
    const live = rosterIsLive(row.enabled, states[i]?.lastChecked as string | null | undefined);
    for (const p of Object.values(products)) {
      const title = String(p["title"] ?? p["handle"]);
      items.push({
        site: row.name,
        handle: String(p["handle"]),
        title,
        available: live && p["available"] === true,
        stale: !live,
        minPrice: typeof p["minPrice"] === "number" ? (p["minPrice"] as number) : null,
        vendor: (p["vendor"] as string | null) ?? null,
        url: String(p["url"] ?? "#"),
        reveries: isReveries(row.id, title),
        // When Beacon first observed this product (stamped by the worker's
        // annotateProducts). Absent for pre-annotation / freshly-baselined rows.
        firstSeen: typeof p["firstSeen"] === "string" ? (p["firstSeen"] as string) : null,
      });
    }
  });
  items.sort(
    (a, b) =>
      Number(b.available) - Number(a.available) ||
      Number(a.stale) - Number(b.stale) ||
      a.title.localeCompare(b.title),
  );

  return (
    <>
      <div className="sect-hd">
        <h2>Products</h2>
        <span className="rule" />
        <span className="muted mono" style={{ fontSize: 12 }}>
          {items.length} tracked
        </span>
      </div>
      <ProductsTable items={items} ignored={Array.from(ignored)} />
    </>
  );
}
