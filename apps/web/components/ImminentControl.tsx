"use client";

// ⚡ split control in the tile header: "Go imminent · every 2m · for 45m" in
// one motion. Off: button + two selects; the click starts imminent with the
// selected cadence and duration (one server write — setImminent persists both
// as the site's tuning, so the worker, its auto-off and the badge agree, and
// the next "Go imminent" on this tile starts from the same picks).
// On: the pulsing ImminentBadge (every Xm · Nm left) + "stop". To change the
// cadence mid-imminent: stop, pick, go.
//
// Plain async busy-state, not useTransition — React 18 async transitions
// swallow rejections silently (see DiagnoseButton).

import { useState } from "react";
import { setImminent } from "../app/actions";
import { DEFAULT_IMMINENT_DURATION_MIN } from "@beacon/shared";
import { DURATION_OPTS, INTERVAL_OPTS } from "./ImminentTuning";
import { ImminentBadge } from "./ImminentBadge";

export function ImminentControl({
  siteId,
  imminent,
  everyMin,
  durationMin,
  untilIso,
  initialNow,
  auto = false,
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
  /** This run was started by the worker's auto-imminent rule, not a click. */
  auto?: boolean;
}) {
  const cur = durationMin ?? DEFAULT_IMMINENT_DURATION_MIN;
  const opts = DURATION_OPTS.includes(cur) ? DURATION_OPTS : [cur, ...DURATION_OPTS];
  const everyOpts = INTERVAL_OPTS.includes(everyMin) ? INTERVAL_OPTS : [everyMin, ...INTERVAL_OPTS];
  const [dur, setDur] = useState(cur);
  const [every, setEvery] = useState(everyMin);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function toggle(on: boolean): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await setImminent(siteId, on, on ? { durationMinutes: dur, intervalMinutes: every } : {});
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
        {auto && (
          <span className="mono" style={{ fontSize: 10 }} title="Started automatically: a related shop just showed a new bottle, a restock or a lifted wall. Reverts by itself.">
            auto
          </span>
        )}
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
        title={`Check every ${every}m for ${dur}m, ignoring rate-limit cooldowns, then revert to the schedule. First fast check runs on the worker's next loop (≤60s).`}
        onClick={() => void toggle(true)}
      >
        {busy ? "⚡ starting…" : "⚡ Go imminent"}
      </button>
      <select className="in" value={String(every)} disabled={busy} title="How often to check while imminent (1m is the floor — tighter trips anti-bot)" onChange={(e) => setEvery(Number(e.target.value))}>
        {everyOpts.map((m) => (
          <option key={m} value={m}>
            every {m}m
          </option>
        ))}
      </select>
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
