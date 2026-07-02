"use client";

// 🩺 One-click block diagnosis on a site tile. Runs the channels step-by-step on
// the SERVER (same Railway egress IP as the worker) and renders each step plus a
// plain-English verdict — so "is our IP blocked or is the site down?" never
// needs log-spelunking.

import { useState, useTransition } from "react";
import { diagnoseSite } from "../app/actions";
import type { DiagnoseReport } from "@beacon/core";

export function DiagnoseButton({ siteId }: { siteId: string }) {
  const [pending, start] = useTransition();
  const [report, setReport] = useState<DiagnoseReport | { error: string } | null>(null);

  function run(): void {
    start(async () => {
      setReport(await diagnoseSite(siteId));
    });
  }

  return (
    <div style={{ marginTop: 6 }}>
      <div className="row">
        <button
          className="btn"
          disabled={pending}
          title="Fetch this site from Beacon's server right now (the same IP the worker uses) and report whether it's being blocked."
          onClick={run}
        >
          {pending ? "🩺 diagnosing…" : "🩺 Diagnose"}
        </button>
        {report && !pending && (
          <button className="btn" onClick={() => setReport(null)}>
            ✕ clear
          </button>
        )}
      </div>
      {report && !pending && (
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
