"use client";

// Section head for the Sites grid: title + "▶ Run all". The full/compact/micro
// density switch that used to live here was removed in the 2026-10-30 tile
// simplification — the tile is compact by design now, with a ⚙ panel for the
// rest, so there is one layout to keep right instead of three.

import { useTransition, type ReactNode } from "react";
import { runNow } from "../app/actions";

export function SitesView({ children }: { children: ReactNode }) {
  const [pending, start] = useTransition();
  return (
    <>
      <div className="sect-hd">
        <h2>Sites</h2>
        <span className="rule" />
        <button className="btn" disabled={pending} title="Check every enabled site on the worker's next loop (≤60s)" onClick={() => start(() => runNow())}>
          ▶ Run all
        </button>
      </div>
      <div className="sites-grid">{children}</div>
    </>
  );
}
