// Last-60-minutes activity strip, rendered from a site's checkHistory
// ({ ts, ok }[]). Green dot = successful check, red ring = failed check,
// positioned by time (right edge = now). Server-rendered (static positions).

interface Check {
  ts: string;
  ok: boolean;
}

const WINDOW_MS = 60 * 60 * 1000;

export function PulseStrip({ history }: { history: Check[] }) {
  const now = Date.now();
  const recent = history.filter((h) => {
    const t = new Date(h.ts).getTime();
    return !Number.isNaN(t) && now - t <= WINDOW_MS;
  });
  const fails = recent.filter((h) => !h.ok).length;

  return (
    <div className={`pulse ${recent.length === 0 ? "empty" : ""}`}>
      <div className="cap">
        <span>last 60 min</span>
        <span>
          {recent.length} checks{fails > 0 ? ` · ${fails} failed` : ""}
        </span>
      </div>
      <div className="track">
        <span className="rail" />
        {recent.map((h, i) => {
          const left = 100 - ((now - new Date(h.ts).getTime()) / WINDOW_MS) * 100;
          return <span key={i} className={`pd ${h.ok ? "ok" : "fail"}`} style={{ left: `${left}%` }} />;
        })}
        <span className="now" />
      </div>
    </div>
  );
}
