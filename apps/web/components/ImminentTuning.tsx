"use client";

// ⚡ imminent tuning — "every Xm · for Ym" — shared by the site tile
// (SiteControls) and the cadence control panel (/schedules, CadenceControls)
// so the two can never offer different options or defaults.

import { useTransition } from "react";
import { DEFAULT_IMMINENT_DURATION_MIN, DEFAULT_IMMINENT_INTERVAL_MIN } from "@beacon/shared";
import { setImminentTuning } from "../app/actions";

// Cadence options while imminent. 1 min is the tightest offered — tighter risks
// tripping anti-bot on sites like the Campari/Incapsula ones.
const INTERVAL_OPTS = [1, 2, 5, 10];
// How long imminent stays on before auto-revert.
const DURATION_OPTS = [20, 45, 60, 90, 120];

export function ImminentTuning({
  siteId,
  imminentInterval,
  imminentDuration,
  compact = false,
}: {
  siteId: string;
  imminentInterval: number | null;
  imminentDuration: number | null;
  /** Panel mode: no leading label / trailing hint, just the two selects. */
  compact?: boolean;
}) {
  const [pending, start] = useTransition();
  // Current effective values. Defaults are the shared constants the worker
  // itself falls back to, so what the select shows for an un-tuned site is
  // what actually runs. Ensure the stored value is always selectable.
  const curInterval = imminentInterval ?? DEFAULT_IMMINENT_INTERVAL_MIN;
  const curDuration = imminentDuration ?? DEFAULT_IMMINENT_DURATION_MIN;
  const intervalOpts = INTERVAL_OPTS.includes(curInterval) ? INTERVAL_OPTS : [curInterval, ...INTERVAL_OPTS];
  const durationOpts = DURATION_OPTS.includes(curDuration) ? DURATION_OPTS : [curDuration, ...DURATION_OPTS];

  return (
    <div className={`row tune${compact ? " compact" : ""}`}>
      {!compact && (
        <span
          className="tune-label"
          title="What the ⚡ button does for this site: the check cadence while imminent, and how long it stays on before reverting to the schedule. Takes effect on the next loop, including mid-imminent."
        >
          ⚡ imminent
        </span>
      )}
      <select
        className="in"
        value={String(curInterval)}
        disabled={pending}
        onChange={(e) => start(() => setImminentTuning(siteId, Number(e.target.value), curDuration))}
        title="Check cadence while imminent (1m is the floor — tighter trips anti-bot)"
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
        title="How long imminent stays on before it auto-reverts to the schedule"
      >
        {durationOpts.map((m) => (
          <option key={m} value={m}>
            for {m}m
          </option>
        ))}
      </select>
      {!compact && <span className="faint" style={{ fontSize: 10 }}>then back to schedule</span>}
    </div>
  );
}
