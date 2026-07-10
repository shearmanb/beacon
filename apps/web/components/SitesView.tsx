"use client";

// Density switcher for the Sites grid — mirrors the ✨ Reveries panel's
// full/compact/micro levels (same localStorage-pref + mounted-gate pattern, so
// SSR and first client render agree on "full" and settle to the saved pref).
//
//   full    — every tile detail (default; how it has always looked).
//   compact — products · last checked · schedule · heartbeat (PulseStrip).
//   micro   — stoplight · name · last checked · cadence, one short row.
//
// The tiles stay server-rendered (passed as children); the chosen level is a
// class on the grid and CSS reveals the right subset per mode — so the cards
// aren't re-plumbed and the interactive controls keep working in full view.

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { runNow } from "../app/actions";

type Level = "full" | "compact" | "micro";
const LEVELS: Level[] = ["full", "compact", "micro"];
const STORE_KEY = "beacon_sites_level";

export function SitesView({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  const [level, setLevel] = useState<Level>("full");
  const [pending, start] = useTransition();

  useEffect(() => {
    setMounted(true);
    try {
      const v = localStorage.getItem(STORE_KEY);
      if (v === "full" || v === "compact" || v === "micro") setLevel(v);
    } catch {
      /* ignore malformed pref */
    }
  }, []);

  const choose = (next: Level) => {
    setLevel(next);
    try {
      localStorage.setItem(STORE_KEY, next);
    } catch {
      /* ignore quota errors */
    }
  };

  const view: Level = mounted ? level : "full";

  return (
    <>
      <div className="sect-hd">
        <h2>Sites</h2>
        <span className="rule" />
        <div className="rev-modes" role="group" aria-label="Site tile density">
          {LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              className={`rev-mode ${view === l ? "on" : ""}`}
              aria-pressed={view === l}
              onClick={() => choose(l)}
            >
              {l}
            </button>
          ))}
        </div>
        <button className="btn" disabled={pending} onClick={() => start(() => runNow())}>
          ▶ Run all
        </button>
      </div>
      <div className={`sites-grid mode-${view}`}>{children}</div>
    </>
  );
}
