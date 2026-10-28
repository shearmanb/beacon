"use client";

import { useState, useTransition } from "react";
import { runNow, setDeprecated, setImminent, setMonitoring, setSchedule, setSiteFilters, updateSiteSource } from "../app/actions";
import { splitList, type WindowSpec } from "../lib/site-forms";
import { DEFAULT_IMMINENT_DURATION_MIN, DEFAULT_IMMINENT_INTERVAL_MIN } from "@beacon/shared";
import { ImminentTuning } from "./ImminentTuning";
import { WindowEditor } from "./WindowEditor";

export interface ScheduleOption {
  value: string;
  label: string;
}

export function SiteControls({
  siteId,
  siteName,
  enabled,
  deprecated,
  imminent,
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
  imminent: boolean;
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

  // Save the keyword filter only when it actually changed. Changing it
  // re-baselines the site server-side so existing matches don't flood as new.
  function commitKeywords(): void {
    const next = splitList(kw);
    if (JSON.stringify(next) === JSON.stringify(titleContains)) return;
    start(() => setSiteFilters(siteId, { titleContains: next }));
  }
  const opts = scheduleOptions.some((o) => o.value === schedule)
    ? scheduleOptions
    : [{ value: schedule, label: schedule || "(default)" }, ...scheduleOptions];

  // Effective imminent values for the ⚡ button's tooltip (the selects that
  // edit them live in ImminentTuning, which applies the same defaults).
  const curInterval = imminentInterval ?? DEFAULT_IMMINENT_INTERVAL_MIN;
  const curDuration = imminentDuration ?? DEFAULT_IMMINENT_DURATION_MIN;

  return (
    <>
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
          title={
            imminent
              ? `Imminent is ON: checking every ${curInterval}m and ignoring rate-limit cooldowns, auto-off after ${curDuration}m. Click to stop now.`
              : `Go imminent: check every ${curInterval}m for ${curDuration}m, ignoring rate-limit cooldowns, then revert to the schedule. First fast check runs on the worker's next loop (≤60s).`
          }
          onClick={() => start(() => setImminent(siteId, !imminent))}
        >
          {imminent ? "⚡ Imminent ON" : "⚡ Go imminent"}
        </button>
        <select
          className="in sched"
          value={schedule}
          disabled={pending}
          onChange={(e) => start(() => setSchedule(siteId, e.target.value))}
          title="Schedule"
        >
          {opts.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <button className="btn" disabled={pending} onClick={() => start(() => runNow(siteId))}>
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
      <ImminentTuning siteId={siteId} imminentInterval={imminentInterval} imminentDuration={imminentDuration} />
      <div className="row kw">
        <span
          className="tune-label"
          title={
            "Keep only products whose title contains one of these words (comma-separated, case-insensitive). " +
            "IMPORTANT: this filters what the source already FETCHES — for a collection source (e.g. /collections/t8ke) " +
            "it only narrows that collection, it does NOT search the whole store. A keyword for a bottle that lives " +
            "outside the fetched collection will match nothing (fix the source scope via ⚙ source, or add a separate site). " +
            "Leave blank to keep everything the source returns. Changing this re-baselines the site so existing matches don't flood as new."
          }
        >
          🔎 keywords
        </span>
        <input
          className="in"
          style={{ flex: 1 }}
          value={kw}
          disabled={pending}
          placeholder="any title (e.g. Reveries, T8KE, Jay West)"
          onChange={(e) => setKw(e.target.value)}
          onBlur={commitKeywords}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          title="Title keywords (comma-separated)"
        />
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
    </>
  );
}
