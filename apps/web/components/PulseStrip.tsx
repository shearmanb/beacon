"use client";

// Last-60-minutes activity strip, rendered from a site's checkHistory
// ({ ts, ok }[]). Green dot = successful check, red ring = failed check,
// positioned by time (right edge = now).
//
// Health overlays (computed server-side, passed in): `stalled` (last check older
// than effectiveInterval × 2.5) turns the strip red and pulses; `degraded` (any
// of the last few checks failed) tints it amber. Always shown (the 2026-10-30
// tile simplification dropped the per-tile show/hide toggle — one less button).

import { useEffect, useState } from "react";

interface Check {
  ts: string;
  ok: boolean;
}

const WINDOW_MS = 60 * 60 * 1000;

export function PulseStrip({
  history,
  stalled = false,
  degraded = false,
}: {
  history: Check[];
  stalled?: boolean;
  degraded?: boolean;
}) {
  // `mounted` gates the time-based dot positions so SSR and the first client
  // render agree (both render an empty track) — no hydration mismatch. After
  // mount every render uses a fresh Date.now(), so a soft router.refresh()
  // repositions the dots correctly instead of freezing at first-mount time.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const now = Date.now();
  const recent = mounted
    ? history.filter((h) => {
        const t = new Date(h.ts).getTime();
        return !Number.isNaN(t) && now - t <= WINDOW_MS;
      })
    : [];
  const fails = recent.filter((h) => !h.ok).length;

  const cls = stalled ? "stalled" : degraded ? "degraded" : "";
  const summary = stalled
    ? "⚠ stalled"
    : `${recent.length} checks${fails > 0 ? ` · ${fails} failed` : ""}`;

  return (
    <div className={`pulse ${recent.length === 0 ? "empty" : ""} ${cls}`}>
      <div className="cap">
        <span>last 60 min</span>
        <span>{summary}</span>
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
