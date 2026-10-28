// Cadence control panel (/schedules) — every site, its check windows, today's
// resolved cadence, last/next check, and inline controls. Answers "how often is
// each site checked, when, and let me change it" in one place instead of
// hopping between tiles. Per-hour resolution goes through the same
// @beacon/shared engine the worker uses, so the strip can never drift from
// real behavior. Day-scoped rules resolve for TODAY's ET weekday.

import type { SchedulableSite, Schedules } from "@beacon/shared";
import { getEtDay, getEtHour, imminentInterval } from "@beacon/shared";
import { cadenceByHour, formatRange, groupCadence, nowInterval } from "../lib/cadence";
import { formatEta, predictedNextCheckAt } from "../lib/nextcheck";
import { ago } from "../lib/health";
import { parseWindowRules } from "../lib/site-forms";
import { CadenceControls } from "./CadenceControls";
import { ImminentBadge } from "./ImminentBadge";
import { NextCheckIn } from "./NextCheckIn";
import type { ScheduleOption } from "./SiteControls";

export interface CadenceSite {
  id: string;
  name: string;
  enabled: boolean;
  deprecated: boolean;
  definition: SchedulableSite & {
    imminentSince?: string | null;
    imminentDurationMinutes?: number | null;
  };
  lastChecked: string | null;
  cooldownUntil: string | null;
}

// Check-intensity tier for the strip color: t0 ≤5m · t1 ≤15m · t2 ≤60m · t3 slower.
function tier(interval: number): string {
  if (interval <= 5) return "t0";
  if (interval <= 15) return "t1";
  if (interval <= 60) return "t2";
  return "t3";
}

// ISO instant imminent mode auto-reverts (mirrors the tile's imminentUntil).
function imminentUntil(def: CadenceSite["definition"], fallbackDuration: number): string | null {
  if (!def.imminent || !def.imminentSince) return null;
  const until = Date.parse(def.imminentSince) + (def.imminentDurationMinutes ?? fallbackDuration) * 60_000;
  return Number.isFinite(until) ? new Date(until).toISOString() : null;
}

/** The fixed-interval choices the tile offers, followed by every named schedule. */
export function scheduleOptionsFor(schedules: Schedules): ScheduleOption[] {
  return [
    { value: "5", label: "5 min" },
    { value: "15", label: "15 min" },
    { value: "20", label: "20 min" },
    { value: "30", label: "30 min" },
    { value: "60", label: "60 min" },
    ...Object.entries(schedules).map(([k, d]) => ({ value: k, label: d.label ?? k })),
  ];
}

export function CadenceTable({
  sites,
  schedules,
  defaultImminentDuration,
}: {
  sites: CadenceSite[];
  schedules: Schedules;
  defaultImminentDuration: number;
}) {
  const day = getEtDay();
  const nowHour = getEtHour();
  const now = Date.now();
  const scheduleOptions = scheduleOptionsFor(schedules);
  // Enabled sites first (dashboard convention), then alphabetical.
  const rows = [...sites].sort(
    (a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name),
  );
  return (
    <table className="ptable cadence-table">
      <thead>
        <tr>
          <th>Site</th>
          <th>Now</th>
          <th>Checks</th>
          <th>Windows today (ET)</th>
          <th>Controls</th>
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
          const cur = nowInterval(def, schedules);
          const imminent = def.imminent === true;
          const nextAt = predictedNextCheckAt(s.enabled, def, s.lastChecked, s.cooldownUntil, schedules, now);
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
                {s.deprecated && (
                  <span className="kind-chip" style={{ marginLeft: 6 }} title="Deprecated: still checks and records history, Discord-silent while another checker covers the store.">
                    shadow
                  </span>
                )}
                <div className="faint" style={{ fontSize: 11, marginTop: 2 }}>{schedLabel}</div>
                {imminent && s.enabled && (
                  <div className="imm-row" style={{ marginTop: 4 }}>
                    <ImminentBadge
                      everyMin={imminentInterval(def)}
                      untilIso={imminentUntil(def, defaultImminentDuration)}
                      initialNow={now}
                    />
                  </div>
                )}
              </td>
              <td data-label="now">
                {!s.enabled ? (
                  "—"
                ) : imminent ? (
                  <span
                    style={{ color: "var(--warn)" }}
                    title="Imminent mode — temporary fast checks; auto-reverts to the schedule."
                  >
                    ⚡ {cur}m
                  </span>
                ) : (
                  <span title="Effective check interval right now (schedule-resolved).">{cur}m</span>
                )}
              </td>
              <td data-label="checks">
                <div className="cad-kv">
                  <span className="k">last</span>
                  <span className="mono">{ago(s.lastChecked)}</span>
                </div>
                <div className="cad-kv">
                  <span className="k">next</span>
                  <span className="mono">
                    <NextCheckIn predictedAt={nextAt} initialLabel={formatEta(nextAt, now)} />
                  </span>
                </div>
              </td>
              <td data-label="windows">
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
                    <span className={`rule-chip${s.enabled && !imminent && g.interval === hours[nowHour] ? " now" : ""}`} key={g.interval}>
                      {g.interval}m → {g.ranges.map(formatRange).join(", ")}
                    </span>
                  ))}
                </div>
              </td>
              <td data-label="controls">
                <CadenceControls
                  siteId={s.id}
                  siteName={s.name}
                  enabled={s.enabled}
                  imminent={imminent}
                  schedule={schedVal}
                  scheduleOptions={scheduleOptions}
                  imminentInterval={def.imminentIntervalMinutes ?? null}
                  imminentDuration={def.imminentDurationMinutes ?? null}
                  currentWindow={parseWindowRules(schedules[`${s.id}_window`]?.rules)}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
