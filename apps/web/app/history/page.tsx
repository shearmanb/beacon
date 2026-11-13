import { getStore } from "../../lib/store";
import { formatLag, LAG_PLAUSIBLE_MAX_SEC } from "@beacon/shared";
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
  const all = await store.history.recent(1000);
  const events = all.slice(0, 100);
  // Detection lag: how long after a product went live Beacon alerted. New
  // products only — a restock's clock is an upper bound, not a measurement.
  const lagOf = (e: (typeof all)[number]): number | null => {
    const p = e.payload as { lagSec?: number | null; lagBasis?: string } | null;
    return p && typeof p.lagSec === "number" && p.lagSec <= LAG_PLAUSIBLE_MAX_SEC ? p.lagSec : null;
  };
  const lags = all
    .filter((e) => e.type === "new_product" && (e.payload as { lagBasis?: string } | null)?.lagBasis === "listed")
    .map(lagOf)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const median = lags.length ? lags[Math.floor(lags.length / 2)]! : null;

  return (
    <>
      <div className="sect-hd">
        <h2>Alert history</h2>
        <span className="rule" />
        <span className="muted mono" style={{ fontSize: 12 }}>
          last {events.length}
        </span>
      </div>
      <p className="muted mono" style={{ fontSize: 12, margin: "0 0 10px" }} title="Time between a new product going live on the store (Shopify's own publish time) and Beacon's alert, over the newest 1,000 history rows. Products listed more than a day before Beacon saw them are left out — that is a late addition to a collection, not a late check.">
        ⏱ Caught new bottles{" "}
        {median != null
          ? `a median ${formatLag(median)} after they went live · slowest ${formatLag(lags[lags.length - 1])} · ${lags.length} measured`
          : "— no measurements yet (starts with the next new bottle)"}
      </p>
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
              {(e.type === "new_product" || e.type === "restock") && formatLag(lagOf(e)) && (
                <span className="faint mono" title={(e.payload as { lagBasis?: string }).lagBasis === "listed" ? "Alerted this long after the product went live" : "Alerted at most this long after the store last changed the product"}>
                  {" "}· ⏱ {(e.payload as { lagBasis?: string }).lagBasis === "listed" ? "" : "≤ "}
                  {formatLag(lagOf(e))}
                </span>
              )}
            </span>
            <span className="when">{ago(e.ts)}</span>
          </div>
        ))}
        {events.length === 0 && <p className="muted" style={{ padding: 14 }}>No alerts yet.</p>}
      </div>
    </>
  );
}
