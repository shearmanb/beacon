"use client";

import { useTransition } from "react";
import { runNow, setImminent, setMonitoring, setSchedule } from "../app/actions";

export interface ScheduleOption {
  value: string;
  label: string;
}

export function SiteControls({
  siteId,
  enabled,
  imminent,
  schedule,
  scheduleOptions,
}: {
  siteId: string;
  enabled: boolean;
  imminent: boolean;
  schedule: string;
  scheduleOptions: ScheduleOption[];
}) {
  const [pending, start] = useTransition();
  const opts = scheduleOptions.some((o) => o.value === schedule)
    ? scheduleOptions
    : [{ value: schedule, label: schedule || "(default)" }, ...scheduleOptions];
  return (
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
  );
}
