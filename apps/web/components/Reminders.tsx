"use client";

import { useState, useTransition } from "react";
import { addReminder, removeReminder, setReminderDone } from "../app/actions";

export function AddReminderForm() {
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [text, setText] = useState("");
  const [priority, setPriority] = useState(false);
  const [pending, start] = useTransition();

  const submit = () => {
    if (!date || !text.trim()) return;
    start(async () => {
      await addReminder({ date, time, text, priority });
      setText("");
      setTime("");
      setPriority(false);
    });
  };

  return (
    <div className="card" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
      <input className="in" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      <input className="in" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      <input
        className="in"
        style={{ flex: 1, minWidth: 180 }}
        placeholder="Drop reminder…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      <label className="mono" style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
        <input type="checkbox" checked={priority} onChange={(e) => setPriority(e.target.checked)} /> ★
      </label>
      <button className="btn" disabled={pending} onClick={submit}>
        Add
      </button>
    </div>
  );
}

export function ReminderControls({ id, done }: { id: string; done: boolean }) {
  const [pending, start] = useTransition();
  return (
    <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
      <button className="btn" disabled={pending} onClick={() => start(() => setReminderDone(id, !done))}>
        {done ? "undone" : "done"}
      </button>
      <button className="btn" disabled={pending} onClick={() => start(() => removeReminder(id))}>
        delete
      </button>
    </span>
  );
}
