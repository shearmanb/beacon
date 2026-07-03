"use client";

import { useState, useTransition } from "react";
import { runNow, setImminent, setImminentTuning, setMonitoring, setSchedule, setSiteFilters, updateSiteSource } from "../app/actions";
import { splitList } from "../lib/site-forms";

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
  enabled,
  imminent,
  schedule,
  scheduleOptions,
  imminentInterval,
  imminentDuration,
  titleContains,
  sourceJson,
}: {
  siteId: string;
  enabled: boolean;
  imminent: boolean;
  schedule: string;
  scheduleOptions: ScheduleOption[];
  imminentInterval: number | null;
  imminentDuration: number | null;
  titleContains: string[];
  sourceJson: string;
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
          title="Only alert on products whose title contains one of these words (comma-separated, case-insensitive). Leave blank to match everything. Changing this re-baselines the site so existing matches don't flood as new."
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
