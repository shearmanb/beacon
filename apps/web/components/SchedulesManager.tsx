"use client";

import { useState, useTransition } from "react";
import type { ScheduleRule } from "@beacon/shared";
import { deleteSchedule, saveSchedule } from "../app/actions";

export interface ScheduleEntry {
  id: string;
  label: string;
  rules: ScheduleRule[];
  builtin: boolean;
}

interface WindowRow {
  from: string;
  to: string;
  interval: string;
  days: string[];
}

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABEL: Record<string, string> = {
  mon: "Mo",
  tue: "Tu",
  wed: "We",
  thu: "Th",
  fri: "Fr",
  sat: "Sa",
  sun: "Su",
};

function isWindow(r: ScheduleRule): r is Extract<ScheduleRule, { fromHour: number }> {
  return "fromHour" in r;
}

function ruleDays(r: ScheduleRule): string[] {
  return Array.isArray((r as { days?: string[] }).days) ? (r as { days: string[] }).days : [];
}

function ruleChip(r: ScheduleRule): string {
  const base = isWindow(r) ? `${r.fromHour}:00–${r.toHour}:00 → ${r.interval}m` : `default → ${r.defaultInterval}m`;
  const days = ruleDays(r);
  return days.length ? `${base} · ${days.join(",")}` : base;
}

// 7-button Mon–Sun toggle. Empty selection = applies every day (the common case).
function DayPicker({ value, onChange }: { value: string[]; onChange: (days: string[]) => void }) {
  const toggle = (d: string) =>
    onChange(value.includes(d) ? value.filter((x) => x !== d) : [...value, d]);
  return (
    <div className="day-picker" title="Days this rule applies on (none selected = every day)">
      {DAYS.map((d) => (
        <button
          type="button"
          key={d}
          className={`day ${value.includes(d) ? "on" : ""}`}
          onClick={() => toggle(d)}
          aria-pressed={value.includes(d)}
        >
          {DAY_LABEL[d]}
        </button>
      ))}
    </div>
  );
}

const blankRow = (): WindowRow => ({ from: "9", to: "18", interval: "5", days: [] });

export function SchedulesManager({ initial }: { initial: ScheduleEntry[] }) {
  const [pending, start] = useTransition();
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [windows, setWindows] = useState<WindowRow[]>([blankRow()]);
  const [def, setDef] = useState("60");
  const [defDays, setDefDays] = useState<string[]>([]);

  const loadForEdit = (e: ScheduleEntry) => {
    setId(e.id);
    setLabel(e.label);
    const wins = e.rules
      .filter(isWindow)
      .map((r) => ({ from: String(r.fromHour), to: String(r.toHour), interval: String(r.interval), days: ruleDays(r) }));
    setWindows(wins.length ? wins : [blankRow()]);
    const d = e.rules.find((r) => !isWindow(r)) as { defaultInterval: number; days?: string[] } | undefined;
    setDef(d ? String(d.defaultInterval) : "60");
    setDefDays(d?.days ?? []);
  };

  const reset = () => {
    setId("");
    setLabel("");
    setWindows([blankRow()]);
    setDef("60");
    setDefDays([]);
  };

  const save = () => {
    const rules: ScheduleRule[] = [];
    for (const w of windows) {
      const fromHour = parseInt(w.from, 10);
      const toHour = parseInt(w.to, 10);
      const interval = parseInt(w.interval, 10);
      if ([fromHour, toHour, interval].some(Number.isNaN)) continue;
      rules.push({ fromHour, toHour, interval, ...(w.days.length ? { days: w.days } : {}) });
    }
    const d = parseInt(def, 10);
    if (!Number.isNaN(d)) rules.push({ defaultInterval: d, ...(defDays.length ? { days: defDays } : {}) });
    if (!id.trim() || rules.length === 0) return;
    start(async () => {
      await saveSchedule(id, label, rules);
      reset();
    });
  };

  return (
    <div>
      {initial.map((e) => (
        <div className="sched-card" key={e.id}>
          <div className="top">
            <span className="lbl">{e.label}</span>
            <span className="id">{e.id}</span>
            {e.builtin && <span className="kind-chip">builtin</span>}
            <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
              <button className="btn" disabled={pending} onClick={() => loadForEdit(e)}>
                edit
              </button>
              <button className="btn" disabled={pending} onClick={() => start(() => deleteSchedule(e.id))}>
                delete
              </button>
            </span>
          </div>
          <div className="rules">
            {e.rules.map((r, i) => (
              <span className="rule-chip" key={i}>
                {ruleChip(r)}
              </span>
            ))}
          </div>
        </div>
      ))}

      <div className="card" style={{ marginTop: 14 }}>
        <div className="sect-hd" style={{ margin: "0 0 10px" }}>
          <h2 style={{ fontSize: 13 }}>{id && initial.some((e) => e.id === id) ? "Edit schedule" : "New schedule"}</h2>
          <span className="rule" />
        </div>
        <div className="rule-row">
          <input className="in wide" placeholder="id (e.g. bar_hours)" value={id} onChange={(e) => setId(e.target.value)} />
          <input className="in wide" placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>

        <div className="muted mono" style={{ fontSize: 11, margin: "8px 0 4px" }}>
          Time windows (ET, 24h — supports overnight like 22→9; day buttons optional, none = every day):
        </div>
        {windows.map((w, i) => (
          <div className="rule-row" key={i}>
            <input className="in" type="number" min={0} max={24} value={w.from}
              onChange={(e) => setWindows((ws) => ws.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)))} />
            <span className="faint">→</span>
            <input className="in" type="number" min={0} max={24} value={w.to}
              onChange={(e) => setWindows((ws) => ws.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)))} />
            <span className="faint">=</span>
            <input className="in" type="number" min={1} value={w.interval}
              onChange={(e) => setWindows((ws) => ws.map((x, j) => (j === i ? { ...x, interval: e.target.value } : x)))} />
            <span className="faint">min</span>
            <DayPicker
              value={w.days}
              onChange={(days) => setWindows((ws) => ws.map((x, j) => (j === i ? { ...x, days } : x)))}
            />
            <button className="btn" onClick={() => setWindows((ws) => ws.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        ))}
        <button className="btn" onClick={() => setWindows((ws) => [...ws, blankRow()])}>
          + window
        </button>

        <div className="rule-row" style={{ marginTop: 10 }}>
          <span className="faint">default every</span>
          <input className="in" type="number" min={1} value={def} onChange={(e) => setDef(e.target.value)} />
          <span className="faint">min (catches all other times)</span>
          <DayPicker value={defDays} onChange={setDefDays} />
        </div>

        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn on" disabled={pending} onClick={save}>
            Save schedule
          </button>
          <button className="btn" disabled={pending} onClick={reset}>
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
