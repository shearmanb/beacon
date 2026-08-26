// "Site cadence" listing (/schedules) — answers "how often is each site
// checked, and when?" at a glance instead of mining the DB/backup. Server
// component (no client JS); per-hour resolution goes through the same
// @beacon/shared engine the worker uses, so the strip can never drift from
// real behavior. Day-scoped rules resolve for TODAY's ET weekday.

import type { SchedulableSite, Schedules } from "@beacon/shared";
import { getEtDay, getEtHour } from "@beacon/shared";
import { cadenceByHour, formatRange, groupCadence, nowInterval } from "../lib/cadence";

export interface CadenceSite {
  id: string;
  name: string;
  enabled: boolean;
  definition: SchedulableSite;
}

// Check-intensity tier for the strip color: t0 ≤5m · t1 ≤15m · t2 ≤60m · t3 slower.
function tier(interval: number): string {
  if (interval <= 5) return "t0";
  if (interval <= 15) return "t1";
  if (interval <= 60) return "t2";
  return "t3";
}

export function CadenceTable({
  sites,
  schedules,
}: {
  sites: CadenceSite[];
  schedules: Schedules;
}) {
  const day = getEtDay();
  const nowHour = getEtHour();
  // Enabled sites first (dashboard convention), then alphabetical.
  const rows = [...sites].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name),
  );
  return (
    <table className="ptable cadence-table">
      <thead>
        <tr>
          <th>Site</th>
          <th>Schedule</th>
          <th>Now</th>
          <th>Cadence over the day (ET)</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((s) => {
          const def = s.definition;
          const schedVal = String(def.schedule ?? def.intervalMinutes ?? "");
          const named = schedules[schedVal];
          const schedLabel = named
            ? named.label ?? schedVal
            : schedVal
              ? `every ${schedVal}m (flat)`
              : "—";
          const hours = cadenceByHour(def, schedules, day);
          const groups = groupCadence(hours);
          const now = nowInterval(def, schedules);
          const imminent = def.imminent === true;
          return (
            <tr key={s.id} className={s.enabled ? "" : "cad-off"}>
              <td>
                {s.name}{" "}
                <span className="mono faint" style={{ fontSize: 11 }}>
                  {s.id}
                </span>
                {!s.enabled && (
                  <span className="kind-chip" style={{ marginLeft: 6 }}>
                    off
                  </span>
                )}
              </td>
              <td data-label="schedule">{schedLabel}</td>
              <td data-label="now">
                {!s.enabled ? (
                  "—"
                ) : imminent ? (
                  <span
                    style={{ color: "var(--warn)" }}
                    title="Imminent mode — temporary fast checks; auto-reverts to the schedule."
                  >
                    ⚡ {now}m
                  </span>
                ) : (
                  <span title="Effective check interval right now (schedule-resolved).">{now}m</span>
                )}
              </td>
              <td data-label="cadence">
                <div className="cad-strip">
                  {hours.map((iv, h) => (
                    <span
                      key={h}
                      className={`cad-h ${tier(iv)}${s.enabled && h === nowHour ? " now" : ""}`}
                      title={`${h}:00–${h + 1}:00 ET → every ${iv}m`}
                    />
                  ))}
                </div>
                <div className="cad-ticks mono">
                  <span>0</span>
                  <span>6</span>
                  <span>12</span>
                  <span>18</span>
                  <span>24</span>
                </div>
                <div className="cad-groups">
                  {groups.map((g) => (
                    <span className="rule-chip" key={g.interval}>
                      {g.interval}m → {g.ranges.map(formatRange).join(", ")}
                    </span>
                  ))}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
