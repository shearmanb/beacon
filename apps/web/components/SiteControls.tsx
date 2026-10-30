"use client";

// ⚙ settings panel on the Sites tile (collapsed by default). Everything that
// EDITS a site lives here — on/off, schedule, run, deprecate, imminent cadence,
// keywords, 🕒 window, ⚙ source JSON, 🩺 Diagnose — so the tile face stays a
// read-only glance (2026-10-30 simplification). The collapsed summary shows the
// keywords as read-only chips; the input inside commits only on an explicit
// Save (it used to save on blur and clear the site's state, one stray click
// from a re-baseline). The ⚡ go-imminent control lives in the tile header
// (ImminentControl); the "every Xm" cadence select stays here.

import { useState, useTransition } from "react";
import { runNow, setDeprecated, setMonitoring, setSchedule, setSiteFilters, updateSiteSource } from "../app/actions";
import { splitList, type WindowSpec } from "../lib/site-forms";
import { ImminentTuning } from "./ImminentTuning";
import { WindowEditor } from "./WindowEditor";
import { DiagnoseButton } from "./DiagnoseButton";

export interface ScheduleOption {
  value: string;
  label: string;
}

export function SiteControls({
  siteId,
  siteName,
  enabled,
  deprecated,
  schedule,
  scheduleOptions,
  imminentInterval,
  imminentDuration,
  titleContains,
  sourceJson,
  currentWindow,
}: {
  siteId: string;
  siteName: string;
  enabled: boolean;
  deprecated: boolean;
  schedule: string;
  scheduleOptions: ScheduleOption[];
  imminentInterval: number | null;
  imminentDuration: number | null;
  titleContains: string[];
  sourceJson: string;
  /** This site's own quick-window schedule (`${siteId}_window`), parsed back
   *  into the editor's four fields — null if it doesn't have one yet. */
  currentWindow: WindowSpec | null;
}) {
  const [pending, start] = useTransition();
  const [kw, setKw] = useState(titleContains.join(", "));
  const kwChanged = JSON.stringify(splitList(kw)) !== JSON.stringify(titleContains);
  // Source JSON editor (4c): plain async busy-state (NOT useTransition — see
  // DiagnoseButton: React 18 async transitions swallow rejections silently).
  const [srcText, setSrcText] = useState(sourceJson);
  const [srcBusy, setSrcBusy] = useState(false);
  const [srcMsg, setSrcMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function saveSource(): Promise<void> {
    setSrcBusy(true);
    setSrcMsg(null);
    try {
      const res = await updateSiteSource(siteId, srcText);
      setSrcMsg(res.ok ? { ok: true, text: "✓ saved — site re-baselines on its next check" } : { ok: false, text: res.error ?? "save failed" });
    } catch (err) {
      setSrcMsg({ ok: false, text: `save failed: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setSrcBusy(false);
    }
  }

  // Explicit Save only. Changing the keywords re-baselines the site server-side
  // so existing matches don't flood as new — which is exactly why it must never
  // happen by accident.
  function commitKeywords(): void {
    if (!kwChanged) return;
    start(() => setSiteFilters(siteId, { titleContains: splitList(kw) }));
  }
  const opts = scheduleOptions.some((o) => o.value === schedule)
    ? scheduleOptions
    : [{ value: schedule, label: schedule || "(default)" }, ...scheduleOptions];

  return (
    <details className="site-settings">
      <summary title="Everything that edits this site: monitoring, schedule, keywords, window, source, diagnose.">
        <span className="gear">⚙ settings</span>
        <span className="kw-chips">
          <span className="faint">keywords:</span>
          {titleContains.length === 0 ? (
            <span className="faint">any title</span>
          ) : (
            titleContains.map((k) => (
              <span key={k} className="pill">
                {k}
              </span>
            ))
          )}
        </span>
      </summary>
      <div className="row">
        <button
          className={`btn ${enabled ? "on" : ""}`}
          disabled={pending}
          title={enabled ? "Monitoring is on — click to stop checking this site" : "Monitoring is off — click to resume (resets its failure streak)"}
          onClick={() => start(() => setMonitoring(siteId, !enabled))}
        >
          {enabled ? "● Monitoring" : "○ Off"}
        </button>
        <select
          className="in sched"
          value={schedule}
          disabled={pending}
          onChange={(e) => start(() => setSchedule(siteId, e.target.value))}
          title="Schedule — edit the named schedules and see every site's cadence on the Cadence page"
        >
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button className="btn" disabled={pending} title="Check this site on the worker's next loop (≤60s)" onClick={() => start(() => runNow(siteId))}>
          ▶ Run
        </button>
        <button
          className="btn"
          disabled={pending}
          title={
            deprecated
              ? "Move back to the main Sites tab (its Discord alerts resume)"
              : "Move to the Deprecated tab. It keeps checking and recording history, but stops paging Discord as long as another active checker covers the same store — if it's the last one on its store, it still pages (labelled deprecated)."
          }
          onClick={() => start(() => setDeprecated(siteId, !deprecated))}
        >
          {deprecated ? "↩ Restore" : "🗄 Deprecate"}
        </button>
      </div>
      <ImminentTuning siteId={siteId} imminentInterval={imminentInterval} imminentDuration={imminentDuration} intervalOnly />
      <div className="row kw">
        <span
          className="tune-label"
          title={
            "Keep only products whose title contains one of these words (comma-separated, case-insensitive). " +
            "IMPORTANT: this filters what the source already FETCHES — for a collection source (e.g. /collections/t8ke) " +
            "it only narrows that collection, it does NOT search the whole store. A keyword for a bottle that lives " +
            "outside the fetched collection will match nothing (fix the source scope via ⚙ source, or add a separate site). " +
            "Leave blank to keep everything the source returns. Saving a change re-baselines the site so existing matches don't flood as new."
          }
        >
          🔎 keywords
        </span>
        <input
          className="in"
          style={{ flex: 1, minWidth: 120 }}
          value={kw}
          disabled={pending}
          placeholder="any title (e.g. Reveries, T8KE, Jay West)"
          onChange={(e) => setKw(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitKeywords();
          }}
          title="Title keywords (comma-separated) — Save to apply"
        />
        <button className="btn" disabled={pending || !kwChanged} title="Apply the keyword change (re-baselines the site)" onClick={commitKeywords}>
          Save
        </button>
      </div>
      <WindowEditor siteId={siteId} siteName={siteName} currentWindow={currentWindow} />
      <details style={{ marginTop: 4 }}>
        <summary
          className="tune-label"
          style={{ cursor: "pointer", fontSize: 11 }}
          title="Edit this site's source recipe (URL, collection path, storefront fallback, …) as JSON. Validated before saving; a change re-baselines the site silently."
        >
          ⚙ source
        </summary>
        <textarea
          className="in mono"
          style={{ width: "100%", marginTop: 4, fontSize: 11 }}
          rows={7}
          value={srcText}
          disabled={srcBusy}
          onChange={(e) => setSrcText(e.target.value)}
          spellCheck={false}
        />
        <div className="row" style={{ marginTop: 4, alignItems: "center" }}>
          <button className="btn" disabled={srcBusy || srcText === sourceJson} onClick={() => void saveSource()}>
            {srcBusy ? "saving…" : "Save source"}
          </button>
          <button className="btn" disabled={srcBusy || srcText === sourceJson} onClick={() => { setSrcText(sourceJson); setSrcMsg(null); }}>
            reset
          </button>
          {srcMsg && (
            <span className="mono" style={{ fontSize: 11, color: srcMsg.ok ? "var(--ok)" : "var(--err)" }}>
              {srcMsg.text}
            </span>
          )}
        </div>
      </details>
      <DiagnoseButton siteId={siteId} />
    </details>
  );
}
