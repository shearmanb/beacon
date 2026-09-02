"use client";

// Live "next check in ~Xm" ticker. `predictedAt` is a fixed ISO timestamp
// computed server-side (see lib/nextcheck.ts) — this component only turns it
// into a live-updating label, independent of AutoRefresh's 2-min server
// resync, so the countdown visibly moves between page refreshes.

import { useEffect, useState } from "react";
import { formatEta } from "../lib/nextcheck";

const TICK_MS = 15_000;

export function NextCheckIn({
  predictedAt,
  initialLabel,
}: {
  predictedAt: string | null;
  initialLabel: string;
}) {
  // `mounted` gates the Date.now()-driven label so SSR and the first client
  // render agree (both show the server-computed initialLabel) — same
  // hydration-safety pattern as PulseStrip/ReveriesPanel. After mount the
  // label re-derives from the real clock on its own short timer.
  const [mounted, setMounted] = useState(false);
  const [label, setLabel] = useState(initialLabel);

  useEffect(() => {
    setMounted(true);
    const tick = () => setLabel(formatEta(predictedAt));
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [predictedAt]);

  return (
    <span
      className="val"
      title="Predicted — actual timing depends on the worker's ~60s loop, per-cycle jitter, and current site conditions (cooldowns, imminent mode)."
    >
      {mounted ? label : initialLabel}
    </span>
  );
}
