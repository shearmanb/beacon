// "Recent" on the Sites tile: the newest alert-history rows for this site —
// ▲ new / ↻ restock / ▼ sold out (🌊 wall up / ◇ changed for a signal site),
// title, price, when. Server component; rows come from lib/activity.ts.

import type { ActivityRow } from "../lib/activity";
import { ago } from "../lib/health";

export function RecentActivity({ rows, now }: { rows: ActivityRow[]; now: number }) {
  return (
    <div className="recent">
      <div className="recent-hd">recent</div>
      {rows.length === 0 && <div className="recent-empty faint">nothing recent</div>}
      {rows.map((r) => (
        <div key={r.id} className={`recent-row ${r.type}`} title={`${r.label} · ${new Date(r.ts).toLocaleString("en-US", { timeZone: "America/New_York" })} ET`}>
          <span className="glyph">{r.glyph}</span>
          <span className="title">
            {r.url ? (
              <a href={r.url} target="_blank" rel="noreferrer">
                {r.title}
              </a>
            ) : (
              r.title
            )}
          </span>
          <span className="price mono">{r.price != null ? `$${r.price.toFixed(r.price % 1 === 0 ? 0 : 2)}` : ""}</span>
          <span className="when mono">{ago(r.ts, now)}</span>
        </div>
      ))}
    </div>
  );
}
