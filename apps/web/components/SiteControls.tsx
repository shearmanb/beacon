"use client";

import { useState, useTransition } from "react";
import { runNow, saveSchedule, setImminent, setImminentTuning, setMonitoring, setSchedule, setSiteFilters, updateSiteSource } from "../app/actions";
import { buildWindowRules, splitList, type WindowSpec } from "../lib/site-forms";

export interface ScheduleOption {
  value: string;
  label: string;
}

// Cadence options while imminent. 1 min is the tightest offered — tighter risks
// tripping anti-bot on sites like the Campari/Incapsula ones.
const INTERVAL_OPTS = [1, 2, 5, 10];
// How long imminent stays on before auto-revert.
const DURATION_OPTS = [20, 45, 60, 90, 120];

export function SiteControls({
  siteId,
  siteName,
  enabled,
  imminent,
  schedule,
  scheduleOptions,
  imminentInterval,
  imminentDuration,
  titleContains,
  sourceJson,
  currentWindow,
}: {
  siteId: string;
  siteName: string;
  enabled: boolean;
  imminent: boolean;
  schedule: string;
  scheduleOptions: ScheduleOption[];
  imminentInterval: number | null;
  imminentDuration: number | null;
  titleContains: string[];
  sourceJson: string;
  /** This site's own quick-window schedule (`${siteId}_window`), parsed back
   *  into the editor's four fields — null if it doesn't have one yet. */
  currentWindow: WindowSpec | null;
}) {
  const [pending, start] = useTransition();
  const [kw, setKw] = useState(titleContains.join(", "));
  // Source JSON editor (4c): plain async busy-state (NOT useTransition — see
  // DiagnoseButton: React 18 async transitions swallow rejections silently).
  const [srcText, setSrcText] = useState(sourceJson);
  const [srcBusy, setSrcBusy] = useState(false);
  const [srcMsg, setSrcMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function saveSource(): Promise<void> {
    setSrcBusy(true);
    setSrcMsg(null);
    try {
      const res = await updateSiteSource(siteId, srcText);
      setSrcMsg(res.ok ? { ok: true, text: "✓ saved — site re-baselines on its next check" } : { ok: false, text: res.error ?? "save failed" });
    } catch (err) {
      setSrcMsg({ ok: false, text: `save failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSrcBusy(false);
    }
  }

  // Quick window editor (4 fields, no plain async busy-state — NOT
  // useTransition, same reasoning as saveSource above): a fast interval
  // inside [from,to) ET, a slower one outside it, every day. Writes through
  // the two existing actions a named schedule + the dropdown already use —
  // this control doesn't invent a new mechanism, just a faster way into it.
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

  // Save the keyword filter only when it actually changed. Changing it
  // re-baselines the site server-side so existing matches don't flood as new.
  function commitKeywords(): void {
    const next = splitList(kw);
    if (JSON.stringify(next) === JSON.stringify(titleContains)) return;
    start(() => setSiteFilters(siteId, { titleContains: next }));
  }
  const opts = scheduleOptions.some((o) => o.value === schedule)
    ? scheduleOptions
    : [{ value: schedule, label: schedule || "(default)" }, ...scheduleOptions];

  // Current effective values for the tuning selects (defaults match the worker:
  // 5-min cadence, 20-min window). Ensure the stored value is always selectable.
  const curInterval = imminentInterval ?? 5;
  const curDuration = imminentDuration ?? 20;
  const intervalOpts = INTERVAL_OPTS.includes(curInterval) ? INTERVAL_OPTS : [curInterval, ...INTERVAL_OPTS];
  const durationOpts = DURATION_OPTS.includes(curDuration) ? DURATION_OPTS : [curDuration, ...DURATION_OPTS];

  return (
    <>
      <div className="row">
        <button
          className={`btn ${enabled ? "on" : ""}`}
          disabled={pending}
          onClick={() => start(() => setMonitoring(siteId, !enabled))}
        >
          {enabled ? "● Monitoring" : "○ Off"}
        </button>
        <button
          className={`btn bolt ${imminent ? "on" : ""}`}
          disabled={pending}
          title="Imminent = temporary fast checks that auto-revert to your normal schedule after the timer (default 20 min)."
          onClick={() => start(() => setImminent(siteId, !imminent))}
        >
          {imminent ? "⚡ Imminent" : "⚡ Off"}
        </button>
        <select
          className="in sched"
          value={schedule}
          disabled={pending}
          onChange={(e) => start(() => setSchedule(siteId, e.target.value))}
          title="Schedule"
        >
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button className="btn" disabled={pending} onClick={() => start(() => runNow(siteId))}>
          ▶ Run
        </button>
      </div>
      <div className="row tune">
        <span className="tune-label" title="How often this site checks while imminent, and how long imminent stays on.">
          ⚡ tuning
        </span>
        <select
          className="in"
          value={String(curInterval)}
          disabled={pending}
          onChange={(e) => start(() => setImminentTuning(siteId, Number(e.target.value), curDuration))}
          title="Imminent check cadence"
        >
          {intervalOpts.map((m) => (
            <option key={m} value={m}>
              every {m}m
            </option>
          ))}
        </select>
        <select
          className="in"
          value={String(curDuration)}
          disabled={pending}
          onChange={(e) => start(() => setImminentTuning(siteId, curInterval, Number(e.target.value)))}
          title="How long imminent stays on before auto-revert"
        >
          {durationOpts.map((m) => (
            <option key={m} value={m}>
              for {m}m
            </option>
          ))}
        </select>
      </div>
      <div className="row kw">
        <span
          className="tune-label"
          title={
            "Keep only products whose title contains one of these words (comma-separated, case-insensitive). " +
            "IMPORTANT: this filters what the source already FETCHES — for a collection source (e.g. /collections/t8ke) " +
            "it only narrows that collection, it does NOT search the whole store. A keyword for a bottle that lives " +
            "outside the fetched collection will match nothing (fix the source scope via ⚙ source, or add a separate site). " +
            "Leave blank to keep everything the source returns. Changing this re-baselines the site so existing matches don't flood as new."
          }
        >
          🔎 keywords
        </span>
        <input
          className="in"
          style={{ flex: 1 }}
          value={kw}
          disabled={pending}
          placeholder="any title (e.g. Reveries, T8KE, Jay West)"
          onChange={(e) => setKw(e.target.value)}
          onBlur={commitKeywords}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          title="Title keywords (comma-separated)"
        />
      </div>
      <details style={{ marginTop: 4 }}>
        <summary
          className="tune-label"
          style={{ cursor: "pointer", fontSize: 11 }}
          title="Set a fast check interval for a time-of-day window (ET) and a slower one outside it, every day — instead of a flat interval running around the clock. Saves as this site's own schedule and applies it immediately."
        >
          🕒 window
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
      <details style={{ marginTop: 4 }}>
        <summary
          className="tune-label"
          style={{ cursor: "pointer", fontSize: 11 }}
          title="Edit this site's source recipe (URL, collection path, storefront fallback, …) as JSON. Validated before saving; a change re-baselines the site silently."
        >
          ⚙ source
        </summary>
        <textarea
          className="in mono"
          style={{ width: "100%", marginTop: 4, fontSize: 11 }}
          rows={7}
          value={srcText}
          disabled={srcBusy}
          onChange={(e) => setSrcText(e.target.value)}
          spellCheck={false}
        />
        <div className="row" style={{ marginTop: 4, alignItems: "center" }}>
          <button className="btn" disabled={srcBusy || srcText === sourceJson} onClick={() => void saveSource()}>
            {srcBusy ? "saving…" : "Save source"}
          </button>
          <button className="btn" disabled={srcBusy || srcText === sourceJson} onClick={() => { setSrcText(sourceJson); setSrcMsg(null); }}>
            reset
          </button>
          {srcMsg && (
            <span className="mono" style={{ fontSize: 11, color: srcMsg.ok ? "var(--ok)" : "var(--err)" }}>
              {srcMsg.text}
            </span>
          )}
        </div>
      </details>
    </>
  );
}
