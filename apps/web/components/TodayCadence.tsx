// The site's schedule as it resolves TODAY, on the tile — "5m 9–13, 17–20 ·
// 15m 8–9, 13–17, 20–22 · 120m 22–8", current window highlighted. Before this
// the tile showed only the schedule's NAME (and even that was hidden in the
// default density mode), so "what does Drop Windows actually do right now?"
// meant a trip to /schedules. Server component; resolved through the same
// @beacon/shared engine the worker runs (via lib/cadence.ts), so it can never
// disagree with real behavior. Day-scoped rules resolve for today's ET weekday.

import type { SchedulableSite, Schedules } from "@beacon/shared";
import { getEtDay, getEtHour } from "@beacon/shared";
import { cadenceByHour, formatRange, groupCadence } from "../lib/cadence";

export function TodayCadence({ def, schedules }: { def: SchedulableSite; schedules: Schedules }) {
  const hour = getEtHour();
  const hours = cadenceByHour(def, schedules, getEtDay());
  const groups = groupCadence(hours);
  const nowInterval = hours[hour];
  return (
    <div className="site-stat st-windows">
      <span className="k">Today (ET)</span>
      <span className="val win-chips" title="How often this site is checked through the day, per your schedule, resolved for today. Highlighted = the window you're in now.">
        {groups.map((g) => (
          <span key={g.interval} className={`win-chip ${g.interval === nowInterval ? "now" : ""}`}>
            <b>{g.interval}m</b> {g.ranges.map(formatRange).join(", ")}
          </span>
        ))}
      </span>
    </div>
  );
}
