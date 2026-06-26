"use client";

// The ✨ Reveries section with three view levels:
//   full    — the complete product grid (default; how it has always looked).
//   compact — a single, non-wrapping row of tiles: in-stock first, then the most
//             recently sold-out one ahead of the rest, so it's what shows if the
//             row has room left (the row clips whatever doesn't fit).
//   micro   — header only, no tiles: in-stock count, tracked count, last drop name.
//
// The chosen level persists per-browser in localStorage (`beacon_reveries_level`),
// the same pattern PulseStrip uses for its toggle. Defaults to full.

import { useEffect, useState } from "react";

export interface RevProduct {
  key: string;
  handle: string;
  site: string;
  title: string;
  available: boolean;
  minPrice: number | null;
  vendor: string | null;
  url: string;
}

type Level = "full" | "compact" | "micro";
const LEVELS: Level[] = ["full", "compact", "micro"];
const STORE_KEY = "beacon_reveries_level";

function Tile({ p }: { p: RevProduct }) {
  return (
    <div className={`rev-card ${p.available ? "in" : ""}`}>
      <div className="rev-title">
        {p.url && p.url !== "#" ? (
          <a href={p.url} target="_blank" rel="noreferrer">
            {p.title}
          </a>
        ) : (
          p.title
        )}
      </div>
      <div className="rev-meta">
        <span className={`pill ${p.available ? "yes" : "no"}`}>
          {p.available ? "in stock" : "sold out"}
        </span>
        <span className="mono">{p.minPrice != null ? `$${p.minPrice.toFixed(2)}` : "—"}</span>
      </div>
      <div className="faint mono rev-sub">
        {p.vendor ? `${p.vendor} · ` : ""}
        {p.site}
      </div>
    </div>
  );
}

export function ReveriesPanel({
  products,
  lastDrop,
  recentSoldOutHandle,
}: {
  products: RevProduct[];
  lastDrop: { title: string; when: string } | null;
  recentSoldOutHandle: string | null;
}) {
  // `mounted` gates the localStorage-driven level so SSR and the first client
  // render agree (both "full") — no hydration mismatch; settles to the pref after.
  const [mounted, setMounted] = useState(false);
  const [level, setLevel] = useState<Level>("full");

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

  const inStock = products.filter((p) => p.available);
  const soldOut = products.filter((p) => !p.available);
  // Compact row order: in-stock first, then the freshest sold-out tile ahead of
  // the other sold-out ones (so it's the one that survives the single-row clip).
  const compactOrder = [
    ...inStock,
    ...soldOut.sort(
      (a, b) =>
        Number(b.handle === recentSoldOutHandle) - Number(a.handle === recentSoldOutHandle),
    ),
  ];

  const view: Level = mounted ? level : "full";

  return (
    <section className="reveries-panel">
      <div className="sect-hd rev-hd">
        <span className="rev-h">✨ Reveries</span>
        <span className="rule" />
        <div className="rev-modes" role="group" aria-label="Reveries view level">
          {LEVELS.map((l) => (
            <button
              key={l}
              type="button"
              className={`rev-mode ${view === l ? "on" : ""}`}
              onClick={() => choose(l)}
              aria-pressed={view === l}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      <div className="rev-meta-line">
        <span className="rev-count">
          <b style={{ color: inStock.length > 0 ? "var(--ok)" : undefined }}>{inStock.length}</b> in
          stock · {products.length} tracked
        </span>
        {lastDrop && (
          <span className="rev-last">
            · last drop: <span className="rev-last-name">{lastDrop.title}</span>
            <span className="faint"> · {lastDrop.when}</span>
          </span>
        )}
      </div>

      {view === "full" && (
        <div className="reveries-grid">
          {products.map((p) => (
            <Tile key={p.key} p={p} />
          ))}
        </div>
      )}
      {view === "compact" && (
        <div className="rev-compact">
          {compactOrder.map((p) => (
            <Tile key={p.key} p={p} />
          ))}
        </div>
      )}
      {/* micro = header + meta line only, no tiles */}
    </section>
  );
}
