"use client";

// Inline controls for one row of the cadence control panel (/schedules):
// monitoring on/off · ⚡ imminent toggle · schedule picker · ▶ run, plus the
// shared ⚡ tuning selects and 🕒 window editor. Every button goes through the
// same server actions the site tile uses, so the panel and the tile can never
// disagree about what a click does.

import { useTransition } from "react";
import { runNow, setImminent, setMonitoring, setSchedule } from "../app/actions";
import type { WindowSpec } from "../lib/site-forms";
import { ImminentTuning } from "./ImminentTuning";
import { WindowEditor } from "./WindowEditor";
import type { ScheduleOption } from "./SiteControls";

export function CadenceControls({
  siteId,
  siteName,
  enabled,
  imminent,
  schedule,
  scheduleOptions,
  imminentInterval,
  imminentDuration,
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
  currentWindow: WindowSpec | null;
}) {
  const [pending, start] = useTransition();
  const opts = scheduleOptions.some((o) => o.value === schedule)
    ? scheduleOptions
    : [{ value: schedule, label: schedule || "(default)" }, ...scheduleOptions];
  return (
    <div className="cad-controls">
      <div className="row">
        <button
          className={`btn ${enabled ? "on" : ""}`}
          disabled={pending}
          onClick={() => start(() => setMonitoring(siteId, !enabled))}
        >
          {enabled ? "● On" : "○ Off"}
        </button>
        <button
          className={`btn bolt ${imminent ? "on" : ""}`}
          disabled={pending}
          title={
            imminent
              ? "Imminent is ON: fast checks that ignore rate-limit cooldowns, auto-off after the duration. Click to stop now."
              : "Go imminent: fast checks that ignore rate-limit cooldowns for the duration set below, then revert to the schedule."
          }
          onClick={() => start(() => setImminent(siteId, !imminent))}
        >
          {imminent ? "⚡ ON" : "⚡"}
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
        <button className="btn" disabled={pending} title="Check this site on the worker's next loop (≤60s)" onClick={() => start(() => runNow(siteId))}>
          ▶
        </button>
      </div>
      <ImminentTuning siteId={siteId} imminentInterval={imminentInterval} imminentDuration={imminentDuration} compact />
      <WindowEditor siteId={siteId} siteName={siteName} currentWindow={currentWindow} />
    </div>
  );
}
