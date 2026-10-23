"use client";

// Header badge for a site in imminent mode — the loud version of the old
// "Mode: ⚡ imminent" stat, which sat in the stats grid in the same small type
// as "Products" and was hidden in the compact/micro density modes. This one is
// in the tile header, in every density mode, and its countdown ticks on the
// client (same mounted-gate + 15s timer pattern as NextCheckIn so SSR and the
// first client render agree).

import { useEffect, useState } from "react";

const TICK_MS = 15_000;

function leftLabel(untilIso: string | null, now: number): string {
  if (!untilIso) return "";
  const ms = Date.parse(untilIso) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "reverting…";
  const m = Math.ceil(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${m}m left`;
}

export function ImminentBadge({
  everyMin,
  untilIso,
  initialNow,
}: {
  /** Cadence while imminent (minutes). */
  everyMin: number;
  /** ISO instant imminent auto-reverts, or null if the start wasn't stamped. */
  untilIso: string | null;
  /** Server clock at render, so the SSR label matches the first client paint. */
  initialNow: number;
}) {
  const [now, setNow] = useState(initialNow);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, []);
  const left = leftLabel(untilIso, now);
  return (
    <span
      className="imm-badge"
      title="Imminent mode: fast checks that bypass rate-limit cooldowns, then auto-revert to the normal schedule. Change the cadence / duration in the ⚡ imminent row below."
    >
      ⚡ IMMINENT · every {everyMin}m{left ? ` · ${left}` : ""}
    </span>
  );
}
