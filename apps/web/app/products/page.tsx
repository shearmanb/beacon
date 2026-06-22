import { getStore } from "../../lib/store";
import { IgnoreButton } from "../../components/IgnoreButton";

export const dynamic = "force-dynamic";

interface Item {
  site: string;
  handle: string;
  title: string;
  available: boolean;
  minPrice: number | null;
  vendor: string | null;
  url: string;
}

export default async function ProductsPage() {
  const store = await getStore();
  const rows = await store.sites.list();
  const [states, ignored] = await Promise.all([
    Promise.all(rows.map((r) => store.state.load(r.id))),
    store.ignored.set(),
  ]);

  const items: Item[] = [];
  rows.forEach((row, i) => {
    const products = (states[i]?.products as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const p of Object.values(products)) {
      items.push({
        site: row.name,
        handle: String(p["handle"]),
        title: String(p["title"] ?? p["handle"]),
        available: p["available"] === true,
        minPrice: typeof p["minPrice"] === "number" ? (p["minPrice"] as number) : null,
        vendor: (p["vendor"] as string | null) ?? null,
        url: String(p["url"] ?? "#"),
      });
    }
  });
  items.sort((a, b) => Number(b.available) - Number(a.available) || a.title.localeCompare(b.title));

  return (
    <>
      <div className="sect-hd">
        <h2>Products</h2>
        <span className="rule" />
        <span className="muted mono" style={{ fontSize: 12 }}>
          {items.length} tracked
        </span>
      </div>
      <table className="ptable">
        <thead>
          <tr>
            <th>Product</th>
            <th>Site</th>
            <th>Price</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const isIgnored = ignored.has(it.handle);
            return (
              <tr key={`${it.site}:${it.handle}`} style={isIgnored ? { opacity: 0.5 } : undefined}>
                <td>
                  <a href={it.url} target="_blank" rel="noreferrer">
                    {it.title}
                  </a>
                  {it.vendor && <span className="faint"> · {it.vendor}</span>}
                </td>
                <td className="muted">{it.site}</td>
                <td className="mono">{it.minPrice != null ? `$${it.minPrice.toFixed(2)}` : "—"}</td>
                <td>
                  <span className={`pill ${it.available ? "yes" : "no"}`}>
                    {it.available ? "in stock" : "sold out"}
                  </span>
                </td>
                <td>
                  <IgnoreButton handle={it.handle} ignored={isIgnored} />
                </td>
              </tr>
            );
          })}
          {items.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No products yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
