import { getStore } from "../../lib/store";
import { ago } from "../../lib/health";

export const dynamic = "force-dynamic";

const TYPE_COLOR: Record<string, string> = {
  new_product: "var(--accent)",
  restock: "var(--ok)",
  sold_out: "var(--err)",
  site_reset: "#f39c12",
  site_changed: "#9b59b6",
  site_error: "#e67e22",
  site_recovered: "#16a085",
  imminent_timeout: "var(--warn)",
  system_degraded: "#c0392b",
  self_healed: "#00bcd4",
  baseline: "var(--faint)",
};

export default async function HistoryPage() {
  const store = await getStore();
  const events = await store.history.recent(100);

  return (
    <>
      <div className="sect-hd">
        <h2>Alert history</h2>
        <span className="rule" />
        <span className="muted mono" style={{ fontSize: 12 }}>
          last {events.length}
        </span>
      </div>
      <div className="card" style={{ padding: 0 }}>
        {events.map((e) => (
          <div className="evt" key={e.id}>
            <span className="type" style={{ color: TYPE_COLOR[e.type] ?? "var(--text)", borderColor: TYPE_COLOR[e.type] ?? "var(--line2)" }}>
              {e.type.replace(/_/g, " ")}
            </span>
            <span>
              {e.url ? (
                <a href={e.url} target="_blank" rel="noreferrer">
                  {e.title ?? e.handle ?? "—"}
                </a>
              ) : (
                (e.title ?? e.handle ?? "—")
              )}
              {e.siteId && <span className="faint"> · {e.siteId}</span>}
            </span>
            <span className="when">{ago(e.ts)}</span>
          </div>
        ))}
        {events.length === 0 && <p className="muted" style={{ padding: 14 }}>No alerts yet.</p>}
      </div>
    </>
  );
}
