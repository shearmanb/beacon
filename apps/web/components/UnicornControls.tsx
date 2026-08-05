"use client";

// Controls for the Unicorn watcher: enable/disable, "Scan now", and an advanced
// JSON editor for the fetch recipe (listingPath/format/etc.) — the same
// config-over-deploy escape hatch as the site tiles' ⚙ source editor.

import { useState, useTransition } from "react";
import { requestUnicornScan, updateUnicornConfig } from "../app/actions";

export interface UnicornFetchConfig {
  enabled: boolean;
  baseUrl: string;
  listingPath: string;
  format: "json_api" | "next_data" | "html" | "graphql";
  maxPages: number;
  pageDelayMs: number;
  cookieRef: string | null;
  requestHeaders: Record<string, string> | null;
  lotUrlTemplate: string | null;
  /** The POST recipe when format is "graphql" (endpoint/query/variables). */
  graphql: Record<string, unknown> | null;
}

export function UnicornControls({
  config,
  forceScanPending,
}: {
  /** null = not configured yet (show the enable/setup button only). */
  config: UnicornFetchConfig | null;
  forceScanPending: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(() =>
    config
      ? JSON.stringify(
          {
            baseUrl: config.baseUrl,
            listingPath: config.listingPath,
            format: config.format,
            maxPages: config.maxPages,
            pageDelayMs: config.pageDelayMs,
            ...(config.lotUrlTemplate ? { lotUrlTemplate: config.lotUrlTemplate } : {}),
            ...(config.cookieRef ? { cookieRef: config.cookieRef } : {}),
            ...(config.requestHeaders ? { requestHeaders: config.requestHeaders } : {}),
            ...(config.graphql ? { graphql: config.graphql } : {}),
          },
          null,
          2,
        )
      : "",
  );

  const apply = (patch: Record<string, unknown>) =>
    start(async () => {
      setError(null);
      const res = await updateUnicornConfig(patch);
      if (!res.ok) setError(res.error ?? "Save failed");
    });

  if (!config) {
    return (
      <div>
        <button className="btn on" disabled={pending} onClick={() => apply({})}>
          {pending ? "…" : "Enable Unicorn watcher"}
        </button>
        {error && <div className="preview-note err" style={{ marginTop: 8 }}>{error}</div>}
      </div>
    );
  }

  return (
    <div className="card">
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          className={`btn ${config.enabled ? "on" : ""}`}
          disabled={pending}
          onClick={() => apply({ enabled: !config.enabled })}
        >
          {config.enabled ? "Monitoring: on" : "Monitoring: off"}
        </button>
        <button
          className="btn"
          disabled={pending || forceScanPending || !config.enabled}
          onClick={() => start(async () => requestUnicornScan())}
          title="The worker picks this up on its next ~60s loop"
        >
          {forceScanPending ? "Scan queued…" : "▶ Scan now"}
        </button>
        {!config.enabled && <span className="hint">disabled — daily scans are paused</span>}
      </div>
      {error && <div className="preview-note err" style={{ marginTop: 8 }}>{error}</div>}

      <details style={{ marginTop: 10 }}>
        <summary className="hint" style={{ cursor: "pointer" }}>
          ⚙ Advanced: fetch recipe (listing path, format, paging)
        </summary>
        <p className="hint" style={{ marginTop: 6 }}>
          How the job reaches the lot listing. Find the real values in browser DevTools (Network tab on
          the lots page): a GraphQL POST → <span className="mono">graphql</span> plus a{" "}
          <span className="mono">graphql</span> block holding the endpoint, the query text, and the
          variables copied from the Payload tab; a plain JSON XHR → <span className="mono">json_api</span>{" "}
          + its URL path; a Next.js page payload → <span className="mono">next_data</span>; otherwise{" "}
          <span className="mono">html</span>. Put <span className="mono">{"{page}"}</span>,{" "}
          <span className="mono">{"{offset}"}</span> or <span className="mono">{"{limit}"}</span> wherever
          the request paginates — in the path for GET formats, or inside{" "}
          <span className="mono">graphql.variables</span> for GraphQL. Validate with the sandbox below
          before saving.
        </p>
        <textarea
          className="in mono"
          style={{ width: "100%", minHeight: 140, marginTop: 6, fontSize: 11 }}
          value={advanced}
          onChange={(e) => setAdvanced(e.target.value)}
        />
        <div style={{ marginTop: 6 }}>
          <button
            className="btn on"
            disabled={pending}
            onClick={() => {
              try {
                apply(JSON.parse(advanced) as Record<string, unknown>);
              } catch (err) {
                setError(`Not valid JSON: ${(err as Error).message}`);
              }
            }}
          >
            {pending ? "…" : "Save fetch recipe"}
          </button>
        </div>
      </details>
    </div>
  );
}
