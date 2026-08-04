"use client";

// Paste-payload sandbox for the Unicorn listing parser (CampariSandbox
// pattern): unicornauctions.com may block datacenter IPs and dev sandboxes
// can't reach it, so the parser + matcher are validated offline against a
// payload copied from browser DevTools. Runs the exact code the worker job uses.

import { useState, useTransition } from "react";
import { previewUnicornListing } from "../app/actions";
import type { UnicornPreviewResult } from "../lib/unicorn-forms";
import type { UnicornTermInput } from "./UnicornTerms";

type Format = "json_api" | "next_data" | "html";

export function UnicornSandbox({
  defaults,
}: {
  defaults: { format: Format; baseUrl: string; terms: UnicornTermInput[] };
}) {
  const [body, setBody] = useState("");
  const [format, setFormat] = useState<Format>(defaults.format);
  const [baseUrl, setBaseUrl] = useState(defaults.baseUrl);
  const [result, setResult] = useState<UnicornPreviewResult | null>(null);
  const [pending, start] = useTransition();

  const run = () => {
    setResult(null);
    start(async () => setResult(await previewUnicornListing(body, format, baseUrl, defaults.terms)));
  };

  return (
    <details className="card wizard-step">
      <summary>
        <h3 style={{ display: "inline" }}>Listing payload sandbox</h3>
      </summary>
      <p className="hint" style={{ marginTop: 8 }}>
        Open the Unicorn lots page in your browser → DevTools → Network → copy the listing response
        (JSON XHR body, the page HTML, or the <span className="mono">__NEXT_DATA__</span> blob) and
        paste it here. Confirms the parser reads it and shows what your current terms would match —
        then save the matching format/path in the ⚙ fetch recipe above.
      </p>
      <div className="form-cols">
        <div className="field">
          <label>Format</label>
          <select className="in" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
            <option value="json_api">json_api — a JSON XHR response</option>
            <option value="next_data">next_data — page HTML with __NEXT_DATA__</option>
            <option value="html">html — server-rendered lot cards</option>
          </select>
        </div>
        <div className="field">
          <label>Base URL</label>
          <input className="in" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <span className="hint">resolves relative lot links</span>
        </div>
      </div>
      <textarea
        className="in"
        style={{ width: "100%", minHeight: 130, marginTop: 8, fontFamily: "var(--mono)", fontSize: 11 }}
        placeholder="Paste the listing payload…"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div style={{ marginTop: 8 }}>
        <button className="btn on" disabled={pending || !body.trim()} onClick={run}>
          {pending ? "…" : "Parse payload"}
        </button>
      </div>
      {result && !result.ok && (
        <div className="preview-note err" style={{ marginTop: 10 }}>
          {result.error}
        </div>
      )}
      {result && result.ok && (
        <div style={{ marginTop: 10 }}>
          <div className={`preview-note ${result.rawCount === 0 ? "err" : "ok"}`}>
            Parsed {result.rawCount} lot{result.rawCount === 1 ? "" : "s"} · {result.matchedCount} matched by your
            terms · {result.descCoveragePct}% carry descriptions
            {result.hasMore ? " · more pages detected" : ""}
            {result.rawCount === 0 ? " — wrong format branch, or the payload isn't the lot listing." : ""}
          </div>
          {(result.sample?.length ?? 0) > 0 && (
            <table className="ptable" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>{(result.matchedCount ?? 0) > 0 ? "Matched lot" : "Lot (first 25 — no term matches)"}</th>
                  <th>Current bid</th>
                  <th>Terms</th>
                </tr>
              </thead>
              <tbody>
                {result.sample!.map((l, i) => (
                  <tr key={`${l.url}:${i}`}>
                    <td>
                      <a href={l.url} target="_blank" rel="noreferrer">
                        {l.title}
                      </a>
                    </td>
                    <td className="mono">{l.currentBidDollars != null ? `$${l.currentBidDollars.toLocaleString("en-US")}` : "—"}</td>
                    <td>
                      {l.matchedTerms.map((t) => (
                        <span key={t} className="pill yes" style={{ marginRight: 4 }}>
                          {t}
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </details>
  );
}
