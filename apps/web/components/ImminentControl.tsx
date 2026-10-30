"use client";

// ⚡ split control in the tile header: "Go imminent" + a duration picker in
// one motion. Off: button + select ("for 45m"); the click starts imminent for
// the selected duration (one server write — setImminent persists the chosen
// duration as the site's tuning, so the worker's auto-off and the badge agree).
// On: the pulsing ImminentBadge (every Xm · Nm left) + "stop". The cadence
// ("every Xm") is rarely changed and lives in the tile's ⚙ panel.
//
// Plain async busy-state, not useTransition — React 18 async transitions
// swallow rejections silently (see DiagnoseButton).

import { useState } from "react";
import { setImminent } from "../app/actions";
import { DEFAULT_IMMINENT_DURATION_MIN } from "@beacon/shared";
import { DURATION_OPTS } from "./ImminentTuning";
import { ImminentBadge } from "./ImminentBadge";

export function ImminentControl({
  siteId,
  imminent,
  everyMin,
  durationMin,
  untilIso,
  initialNow,
}: {
  siteId: string;
  imminent: boolean;
  /** Cadence while imminent (tuned value or the shared default). */
  everyMin: number;
  /** Stored imminentDurationMinutes, or null for the default. */
  durationMin: number | null;
  /** Auto-revert instant while imminent (null if the start wasn't stamped). */
  untilIso: string | null;
  initialNow: number;
}) {
  const cur = durationMin ?? DEFAULT_IMMINENT_DURATION_MIN;
  const opts = DURATION_OPTS.includes(cur) ? DURATION_OPTS : [cur, ...DURATION_OPTS];
  const [dur, setDur] = useState(cur);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function toggle(on: boolean): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await setImminent(siteId, on, on ? { durationMinutes: dur } : {});
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (imminent) {
    return (
      <div className="imm-ctl on">
        <ImminentBadge everyMin={everyMin} untilIso={untilIso} initialNow={initialNow} />
        <button className="btn sm" disabled={busy} title="Stop imminent mode now and go back to the schedule" onClick={() => void toggle(false)}>
          {busy ? "…" : "stop"}
        </button>
        {err && <span className="mono" style={{ fontSize: 10, color: "var(--err)" }}>{err}</span>}
      </div>
    );
  }
  return (
    <div className="imm-ctl">
      <button
        className="btn bolt"
        disabled={busy}
        title={`Check every ${everyMin}m for ${dur}m, ignoring rate-limit cooldowns, then revert to the schedule. First fast check runs on the worker's next loop (≤60s).`}
        onClick={() => void toggle(true)}
      >
        {busy ? "⚡ starting…" : "⚡ Go imminent"}
      </button>
      <select className="in" value={String(dur)} disabled={busy} title="How long imminent stays on before it auto-reverts" onChange={(e) => setDur(Number(e.target.value))}>
        {opts.map((m) => (
          <option key={m} value={m}>
            for {m >= 60 ? `${m / 60}h` : `${m}m`}
          </option>
        ))}
      </select>
      {err && <span className="mono" style={{ fontSize: 10, color: "var(--err)" }}>{err}</span>}
    </div>
  );
}
