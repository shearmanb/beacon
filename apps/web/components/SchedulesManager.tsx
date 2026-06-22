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
}

function isWindow(r: ScheduleRule): r is Extract<ScheduleRule, { fromHour: number }> {
  return "fromHour" in r;
}

function ruleChip(r: ScheduleRule): string {
  if (isWindow(r)) return `${r.fromHour}:00–${r.toHour}:00 → ${r.interval}m`;
  return `default → ${r.defaultInterval}m`;
}

const blankRow = (): WindowRow => ({ from: "9", to: "18", interval: "5" });

export function SchedulesManager({ initial }: { initial: ScheduleEntry[] }) {
  const [pending, start] = useTransition();
  const [id, setId] = useState("");
  const [label, setLabel] = useState("");
  const [windows, setWindows] = useState<WindowRow[]>([blankRow()]);
  const [def, setDef] = useState("60");

  const loadForEdit = (e: ScheduleEntry) => {
    setId(e.id);
    setLabel(e.label);
    const wins = e.rules.filter(isWindow).map((r) => ({ from: String(r.fromHour), to: String(r.toHour), interval: String(r.interval) }));
    setWindows(wins.length ? wins : [blankRow()]);
    const d = e.rules.find((r) => !isWindow(r)) as { defaultInterval: number } | undefined;
    setDef(d ? String(d.defaultInterval) : "60");
  };

  const reset = () => {
    setId("");
    setLabel("");
    setWindows([blankRow()]);
    setDef("60");
  };

  const save = () => {
    const rules: ScheduleRule[] = [];
    for (const w of windows) {
      const fromHour = parseInt(w.from, 10);
      const toHour = parseInt(w.to, 10);
      const interval = parseInt(w.interval, 10);
      if ([fromHour, toHour, interval].some(Number.isNaN)) continue;
      rules.push({ fromHour, toHour, interval });
    }
    const d = parseInt(def, 10);
    if (!Number.isNaN(d)) rules.push({ defaultInterval: d });
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
          Time windows (ET, 24h — supports overnight like 22→9):
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
