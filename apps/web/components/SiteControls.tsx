"use client";

import { useTransition } from "react";
import { runNow, setImminent, setMonitoring } from "../app/actions";

export function SiteControls({
  siteId,
  enabled,
  imminent,
}: {
  siteId: string;
  enabled: boolean;
  imminent: boolean;
}) {
  const [pending, start] = useTransition();
  return (
    <div className="row">
      <button
        className={`btn ${enabled ? "on" : ""}`}
        disabled={pending}
        onClick={() => start(() => setMonitoring(siteId, !enabled))}
      >
        {enabled ? "● Monitoring" : "○ Off"}
      </button>
      <button
        className={`btn bolt ${imminent ? "on" : ""}`}
        disabled={pending}
        onClick={() => start(() => setImminent(siteId, !imminent))}
      >
        {imminent ? "⚡ Imminent" : "⚡ Imminent off"}
      </button>
      <button className="btn" disabled={pending} onClick={() => start(() => runNow(siteId))}>
        ▶ Run now
      </button>
    </div>
  );
}
