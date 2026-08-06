"use client";

// Paste-HTML sandbox for the Campari card parser (Wild Turkey / Russell's
// Reserve). Those sites 403 datacenter IPs, so the wizard's live URL preview
// can't reach them — paste the page source here to validate parsing offline.
// Runs the same pure parseCampariCards the worker's custom extractor uses.

import { useState, useTransition } from "react";
import { previewCampariHtml } from "../app/actions";
import type { PreviewResult } from "../lib/site-forms";

export function CampariSandbox() {
  const [html, setHtml] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [useSchema, setUseSchema] = useState(false);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [pending, start] = useTransition();

  const run = () => {
    setResult(null);
    start(async () => setResult(await previewCampariHtml(html, baseUrl, useSchema)));
  };

  return (
    <details className="card wizard-step">
      <summary>
        <h3 style={{ display: "inline" }}>Campari HTML sandbox (Wild Turkey / Russell&apos;s Reserve)</h3>
      </summary>
      <p className="hint" style={{ marginTop: 8 }}>
        These sites block datacenter IPs, so the live Preview above can&apos;t reach them. Paste the
        product-page HTML here to test the card parser offline — buyable comes from the CTA text
        (&ldquo;Add to cart&rdquo; → in stock, &ldquo;See details&rdquo; → info only).
      </p>
      <div className="form-cols">
        <div className="field">
          <label>Base URL</label>
          <input
            className="in"
            value={baseUrl}
            placeholder="https://russellsreserve.com"
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <span className="hint">resolves relative product links</span>
        </div>
      </div>
      <label className="check" style={{ marginTop: 4 }}>
        <input type="checkbox" checked={useSchema} onChange={(e) => setUseSchema(e.target.checked)} /> also read the
        JSON-LD collection roster (catches staged/Protected pages)
      </label>
      <textarea
        className="in"
        style={{ width: "100%", minHeight: 130, marginTop: 8, fontFamily: "var(--mono)", fontSize: 11 }}
        placeholder="Paste the product-page HTML…"
        value={html}
        onChange={(e) => setHtml(e.target.value)}
      />
      <div style={{ marginTop: 8 }}>
        <button className="btn on" disabled={pending || !html.trim()} onClick={run}>
          {pending ? "…" : "Parse HTML"}
        </button>
      </div>
      {result && !result.ok && (
        <div className="preview-note err" style={{ marginTop: 10 }}>
          {result.error}
        </div>
      )}
      {result && result.ok && result.mode === "products" && (
        <div style={{ marginTop: 10 }}>
          <div className={`preview-note ${result.rawCount === 0 ? "err" : "ok"}`}>{result.detail}</div>
          {result.sample.length > 0 && (
            <table className="ptable" style={{ marginTop: 8 }}>
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {result.sample.map((p, i) => (
                  <tr key={`${p.url}:${i}`}>
                    <td data-label="Product">
                      <a href={p.url} target="_blank" rel="noreferrer">
                        {p.title}
                      </a>
                    </td>
                    <td data-label="Status">
                      <span className={`pill ${p.available ? "yes" : "no"}`}>{p.available ? "buyable" : "info only"}</span>
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
