// "Recent" on the Sites tile: the newest alert-history rows for this site.
// Each row reads left to right as a sentence: WHAT HAPPENED (a word chip:
// new / restock / sold out, or wall up / changed for a signal site), the
// bottle, its price, what it is doing NOW (in stock / sold out / behind wall /
// delisted, from the site's live roster), and when the event happened. The old
// ▲/▼ glyphs read as current stock ("green up = in"), which they never were.
// Server component; rows come from lib/activity.ts.

import { NOW_LABEL, type ActivityRow, type NowStatus } from "../lib/activity";
import { ago } from "../lib/health";

export function RecentActivity({
  rows,
  now,
  status,
}: {
  rows: ActivityRow[];
  now: number;
  /** Current status per row id (absent/null = no claim: signal row, or roster not live). */
  status: Map<number, NowStatus>;
}) {
  return (
    <div className="recent">
      <div className="recent-hd">recent · what happened · now</div>
      {rows.length === 0 && <div className="recent-empty faint">nothing recent</div>}
      {rows.map((r) => {
        const st = status.get(r.id) ?? null;
        return (
          <div key={r.id} className={`recent-row ${r.type}`} title={`${r.label} · ${new Date(r.ts).toLocaleString("en-US", { timeZone: "America/New_York" })} ET`}>
            <span className="kind">{r.label}</span>
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
            <span className={`now ${st ? `now-${st}` : ""}`} title="What this bottle is doing NOW, from the site's latest check (the chip on the left is what happened back then)">{st ? NOW_LABEL[st] : ""}</span>
            <span className="when mono">{ago(r.ts, now).replace(/ ago$/, "")}</span>
          </div>
        );
      })}
    </div>
  );
}
