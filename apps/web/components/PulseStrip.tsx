"use client";

// Last-60-minutes activity strip, rendered from a site's checkHistory
// ({ ts, ok }[]). Green dot = successful check, red ring = failed check,
// positioned by time (right edge = now).
//
// Health overlays (computed server-side, passed in): `stalled` (last check older
// than effectiveInterval × 2.5) turns the strip red and pulses; `degraded` (any
// of the last few checks failed) tints it amber. A per-tile show/hide toggle is
// persisted in localStorage under `beacon_pulse_open`, keyed by site id — same
// behavior as the v1 dashboard.

import { useEffect, useState } from "react";

interface Check {
  ts: string;
  ok: boolean;
}

const WINDOW_MS = 60 * 60 * 1000;
const STORE_KEY = "beacon_pulse_open";

export function PulseStrip({
  history,
  siteId,
  stalled = false,
  degraded = false,
}: {
  history: Check[];
  siteId: string;
  stalled?: boolean;
  degraded?: boolean;
}) {
  // `mounted` gates the time-based dot positions so SSR and the first client
  // render agree (both render an empty track) — no hydration mismatch. After
  // mount every render uses a fresh Date.now(), so a soft router.refresh()
  // repositions the dots correctly instead of freezing at first-mount time.
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setMounted(true);
    try {
      const map = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, boolean>;
      if (siteId in map) setOpen(map[siteId] !== false);
    } catch {
      /* ignore malformed pref */
    }
  }, [siteId]);

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      try {
        const map = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, boolean>;
        map[siteId] = next;
        localStorage.setItem(STORE_KEY, JSON.stringify(map));
      } catch {
        /* ignore quota / serialization errors */
      }
      return next;
    });
  };

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
        <button type="button" className="pulse-toggle" onClick={toggle} aria-expanded={open}>
          {open ? "▾" : "▸"} last 60 min
        </button>
        <span>{summary}</span>
      </div>
      {open && (
        <div className="track">
          <span className="rail" />
          {recent.map((h, i) => {
            const left = 100 - ((now - new Date(h.ts).getTime()) / WINDOW_MS) * 100;
            return <span key={i} className={`pd ${h.ok ? "ok" : "fail"}`} style={{ left: `${left}%` }} />;
          })}
          <span className="now" />
        </div>
      )}
    </div>
  );
}
