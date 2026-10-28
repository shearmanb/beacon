"use client";

// 🕒 quick window editor — a fast interval inside [from,to) ET, a slower one
// outside it, every day. Writes through the two existing actions a named
// schedule + the dropdown already use (saveSchedule + setSchedule) as this
// site's own `${siteId}_window` schedule — no new mechanism, just a faster way
// into it. Shared by the site tile (SiteControls) and the cadence control panel
// (/schedules, CadenceControls). Plain async busy-state, NOT useTransition —
// React 18 async transitions swallow rejections silently (see DiagnoseButton).

import { useState } from "react";
import { saveSchedule, setSchedule } from "../app/actions";
import { buildWindowRules, type WindowSpec } from "../lib/site-forms";

export function WindowEditor({
  siteId,
  siteName,
  currentWindow,
}: {
  siteId: string;
  siteName: string;
  /** This site's own quick-window schedule (`${siteId}_window`), parsed back
   *  into the editor's four fields — null if it doesn't have one yet. */
  currentWindow: WindowSpec | null;
}) {
  const [winFrom, setWinFrom] = useState(String(currentWindow?.fromHour ?? 9));
  const [winTo, setWinTo] = useState(String(currentWindow?.toHour ?? 21));
  const [winFast, setWinFast] = useState(String(currentWindow?.fast ?? 5));
  const [winSlow, setWinSlow] = useState(String(currentWindow?.slow ?? 60));
  const [winBusy, setWinBusy] = useState(false);
  const [winMsg, setWinMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function saveWindow(): Promise<void> {
    const fromHour = parseInt(winFrom, 10);
    const toHour = parseInt(winTo, 10);
    const fast = parseInt(winFast, 10);
    const slow = parseInt(winSlow, 10);
    if ([fromHour, toHour, fast, slow].some((n) => Number.isNaN(n))) {
      setWinMsg({ ok: false, text: "all four fields must be numbers" });
      return;
    }
    setWinBusy(true);
    setWinMsg(null);
    try {
      const scheduleId = `${siteId}_window`;
      await saveSchedule(scheduleId, `${siteName} window`, buildWindowRules({ fromHour, toHour, fast, slow }));
      await setSchedule(siteId, scheduleId);
      setWinMsg({ ok: true, text: "✓ saved and applied" });
    } catch (err) {
      setWinMsg({ ok: false, text: `save failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setWinBusy(false);
    }
  }

  return (
    <details style={{ marginTop: 4 }}>
      <summary
        className="tune-label"
        style={{ cursor: "pointer", fontSize: 11 }}
        title="Set a fast check interval for a time-of-day window (ET) and a slower one outside it, every day — instead of a flat interval running around the clock. Saves as this site's own schedule and applies it immediately."
      >
        🕒 window{currentWindow ? ` · ${currentWindow.fromHour}–${currentWindow.toHour} ET @ ${currentWindow.fast}m, else ${currentWindow.slow}m` : ""}
      </summary>
      <div className="rule-row">
        <span className="faint" style={{ fontSize: 11 }}>
          fast
        </span>
        <input
          className="in"
          type="number"
          min={0}
          max={23}
          value={winFrom}
          disabled={winBusy}
          onChange={(e) => setWinFrom(e.target.value)}
          title="Fast-window start hour (ET, 0-23)"
        />
        <span className="faint">→</span>
        <input
          className="in"
          type="number"
          min={0}
          max={23}
          value={winTo}
          disabled={winBusy}
          onChange={(e) => setWinTo(e.target.value)}
          title="Fast-window end hour (ET, 0-23; can be less than start for an overnight window, e.g. 22 → 6)"
        />
        <span className="faint">ET =</span>
        <input
          className="in"
          type="number"
          min={1}
          value={winFast}
          disabled={winBusy}
          onChange={(e) => setWinFast(e.target.value)}
          title="Check interval (minutes) inside the window"
        />
        <span className="faint">min</span>
      </div>
      <div className="rule-row">
        <span className="faint" style={{ fontSize: 11 }}>
          outside
        </span>
        <input
          className="in"
          type="number"
          min={1}
          value={winSlow}
          disabled={winBusy}
          onChange={(e) => setWinSlow(e.target.value)}
          title="Check interval (minutes) outside the window"
        />
        <span className="faint">min</span>
      </div>
      <div className="row" style={{ marginTop: 4, alignItems: "center" }}>
        <button className="btn" disabled={winBusy} onClick={() => void saveWindow()}>
          {winBusy ? "saving…" : "Save window"}
        </button>
        {winMsg && (
          <span className="mono" style={{ fontSize: 11, color: winMsg.ok ? "var(--ok)" : "var(--err)" }}>
            {winMsg.text}
          </span>
        )}
      </div>
    </details>
  );
}
