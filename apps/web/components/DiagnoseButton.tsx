"use client";

// 🩺 One-click block diagnosis on a site tile. Runs the channels step-by-step on
// the SERVER (same Railway egress IP as the worker) and renders each step plus a
// plain-English verdict — so "is our IP blocked or is the site down?" never
// needs log-spelunking. Results render INLINE below the button (no Discord ping
// — this is an on-demand probe, not an alert). Every run is also logged
// server-side, so the Railway deploy logs keep a record.
//
// Plain busy-state async (not useTransition): with React 18 an async transition
// drops isPending at the first await and swallows rejections — which made a
// failed diagnosis end silently with no output. try/catch/finally guarantees
// the user ALWAYS sees an outcome.

import { useState } from "react";
import { diagnoseSite } from "../app/actions";
import type { DiagnoseReport } from "@beacon/core";

export function DiagnoseButton({ siteId }: { siteId: string }) {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<DiagnoseReport | { error: string } | null>(null);

  async function run(): Promise<void> {
    setBusy(true);
    setReport(null);
    try {
      const result = await diagnoseSite(siteId);
      setReport(result ?? { error: "No response from the server — check the Railway deploy logs for [diagnose] lines." });
    } catch (err) {
      setReport({ error: `Diagnosis failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 6 }}>
      <div className="row">
        <button
          className="btn"
          disabled={busy}
          title="Fetch this site from Beacon's server right now (the same IP the worker uses) and report whether it's being blocked. Results appear below."
          onClick={() => void run()}
        >
          {busy ? "🩺 diagnosing… (can take ~1 min)" : "🩺 Diagnose"}
        </button>
        {report && !busy && (
          <button className="btn" onClick={() => setReport(null)}>
            ✕ clear
          </button>
        )}
      </div>
      {report && !busy && (
        <div className="mono" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
          {"error" in report ? (
            <span style={{ color: "var(--err)" }}>{report.error}</span>
          ) : (
            <>
              {report.steps.map((s, i) => (
                <div key={i}>
                  <span style={{ color: s.ok ? "var(--ok)" : "var(--err)" }}>{s.ok ? "✔" : "✘"}</span>{" "}
                  {s.label}: {s.detail}
                </div>
              ))}
              <div style={{ marginTop: 4, color: report.blocked ? "var(--warn)" : "var(--ok)" }}>
                {report.verdict}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
