"use client";

// The ✨ Reveries section, made collapsible. Expanded = the full product grid
// (unchanged). Collapsed = a compact bar — like the "7/7 sites ok" header —
// keeping the "N in stock · M tracked" count and showing the first few in-stock
// bottles as small links so the headline stays visible without the full grid.
//
// Open/closed is remembered per-browser in localStorage (`beacon_reveries_open`),
// the same pattern PulseStrip uses for its per-tile toggle. Defaults to open.

import { useEffect, useState } from "react";

export interface RevProduct {
  key: string;
  site: string;
  title: string;
  available: boolean;
  minPrice: number | null;
  vendor: string | null;
  url: string;
}

const STORE_KEY = "beacon_reveries_open";
// How many in-stock bottles to list in the collapsed bar before "+N more" — keeps
// the bar to roughly one line so it doesn't sprawl across the width.
const COLLAPSED_CHIPS = 4;

export function ReveriesPanel({ products }: { products: RevProduct[] }) {
  // `mounted` gates the localStorage-driven state so SSR and the first client
  // render agree (both open) — no hydration mismatch; settles to the pref after.
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setMounted(true);
    try {
      const v = localStorage.getItem(STORE_KEY);
      if (v !== null) setOpen(v !== "false");
    } catch {
      /* ignore malformed pref */
    }
  }, []);

  const toggle = () => {
    setOpen((v) => {
      const next = !v;
      try {
        localStorage.setItem(STORE_KEY, String(next));
      } catch {
        /* ignore quota errors */
      }
      return next;
    });
  };

  const inStock = products.filter((p) => p.available);
  const chips = inStock.slice(0, COLLAPSED_CHIPS);
  const overflow = inStock.length - chips.length;
  const showOpen = !mounted || open;

  return (
    <section className="reveries-panel">
      <div className="sect-hd rev-hd">
        <button type="button" className="rev-toggle" onClick={toggle} aria-expanded={showOpen}>
          {showOpen ? "▾" : "▸"} ✨ Reveries
        </button>
        <span className="rule" />
        <span className="muted mono rev-count">
          <b style={{ color: inStock.length > 0 ? "var(--ok)" : undefined }}>{inStock.length}</b> in stock ·{" "}
          {products.length} tracked
        </span>
      </div>

      {showOpen ? (
        <div className="reveries-grid">
          {products.map((p) => (
            <div key={p.key} className={`rev-card ${p.available ? "in" : ""}`}>
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
          ))}
        </div>
      ) : (
        <div className="rev-collapsed">
          {inStock.length === 0 ? (
            <span className="faint mono">none in stock right now</span>
          ) : (
            <>
              {chips.map((p) =>
                p.url && p.url !== "#" ? (
                  <a
                    key={p.key}
                    className="rev-chip"
                    href={p.url}
                    target="_blank"
                    rel="noreferrer"
                    title={`${p.title}${p.minPrice != null ? ` · $${p.minPrice.toFixed(2)}` : ""} · ${p.site}`}
                  >
                    {p.title}
                  </a>
                ) : (
                  <span key={p.key} className="rev-chip">
                    {p.title}
                  </span>
                ),
              )}
              {overflow > 0 && <span className="rev-more">+{overflow} more</span>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
