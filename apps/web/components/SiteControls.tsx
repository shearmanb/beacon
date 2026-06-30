"use client";

import { useState, useTransition } from "react";
import { runNow, setImminent, setImminentTuning, setMonitoring, setSchedule, setSiteFilters } from "../app/actions";
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
}: {
  siteId: string;
  enabled: boolean;
  imminent: boolean;
  schedule: string;
  scheduleOptions: ScheduleOption[];
  imminentInterval: number | null;
  imminentDuration: number | null;
  titleContains: string[];
}) {
  const [pending, start] = useTransition();
  const [kw, setKw] = useState(titleContains.join(", "));

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
    </>
  );
}
