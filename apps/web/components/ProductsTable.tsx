"use client";

// Client-side filtered products table. The server component (products/page.tsx)
// loads every tracked product + the ignored set and hands them in; all filtering
// is in-memory here (search / site / availability / show-ignored) — no extra
// queries, no API routes. Restores the v1 dashboard's product filters.

import { useMemo, useState } from "react";
import { IgnoreButton } from "./IgnoreButton";

export interface ProductRow {
  site: string;
  handle: string;
  title: string;
  available: boolean;
  /** Roster frozen (checker disabled / silent >24h): last-known values, not
   *  current stock. Forced false on `available` upstream, flagged here so the
   *  row says so instead of quietly reading "sold out". */
  stale?: boolean;
  minPrice: number | null;
  vendor: string | null;
  url: string;
  reveries: boolean;
  firstSeen: string | null;
}

type Avail = "all" | "in" | "out";

// Compact "when added" label. Short absolute date is the primary read (a stable
// value that doesn't need re-rendering), with a relative "ago" + exact time in
// the tooltip. Kept local so this client component doesn't import server helpers.
function addedLabel(iso: string | null): { short: string; full: string } {
  if (!iso) return { short: "—", full: "First-seen time not recorded for this product yet." };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { short: "—", full: iso };
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const rel = days <= 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;
  const short = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return { short, full: `Added ${rel} · ${d.toLocaleString()}` };
}

export function ProductsTable({ items, ignored }: { items: ProductRow[]; ignored: string[] }) {
  const ignoredSet = useMemo(() => new Set(ignored), [ignored]);
  const sites = useMemo(() => Array.from(new Set(items.map((i) => i.site))).sort(), [items]);
  const [q, setQ] = useState("");
  const [site, setSite] = useState("");
  const [avail, setAvail] = useState<Avail>("all");
  const [showIgnored, setShowIgnored] = useState(false);
  const [revOnly, setRevOnly] = useState(false);
  const reveriesCount = useMemo(() => items.filter((i) => i.reveries).length, [items]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((it) => {
      if (site && it.site !== site) return false;
      // A stale row is neither in stock nor sold out — it is unknown, so it
      // matches neither availability filter.
      if (avail === "in" && !it.available) return false;
      if (avail === "out" && (it.available || it.stale)) return false;
      if (revOnly && !it.reveries) return false;
      if (!showIgnored && ignoredSet.has(it.handle)) return false;
      if (
        needle &&
        !it.title.toLowerCase().includes(needle) &&
        !(it.vendor ?? "").toLowerCase().includes(needle)
      )
        return false;
      return true;
    });
  }, [items, q, site, avail, revOnly, showIgnored, ignoredSet]);

  return (
    <>
      <div className="filters">
        <input
          className="in"
          placeholder="Search product or vendor…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="in" value={site} onChange={(e) => setSite(e.target.value)}>
          <option value="">All sites</option>
          {sites.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select className="in" value={avail} onChange={(e) => setAvail(e.target.value as Avail)}>
          <option value="all">Any status</option>
          <option value="in">In stock</option>
          <option value="out">Sold out</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={revOnly} onChange={(e) => setRevOnly(e.target.checked)} />
          ✨ Reveries only{reveriesCount > 0 ? ` (${reveriesCount})` : ""}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={showIgnored}
            onChange={(e) => setShowIgnored(e.target.checked)}
          />
          Show ignored
        </label>
        <span className="muted mono" style={{ fontSize: 12, marginLeft: "auto" }}>
          {filtered.length} / {items.length}
        </span>
      </div>
      <table className="ptable">
        <thead>
          <tr>
            <th>Product</th>
            <th>Site</th>
            <th>Price</th>
            <th>Status</th>
            <th>Added</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((it) => {
            const isIgnored = ignoredSet.has(it.handle);
            return (
              <tr key={`${it.site}:${it.handle}`} style={isIgnored ? { opacity: 0.5 } : undefined}>
                {/* data-label carries the column head into the mobile
                    stacked-card layout, where <thead> is hidden. */}
                <td data-label="Product">
                  {it.reveries && (
                    <span className="rev-flag" title="Reveries">
                      ✨
                    </span>
                  )}
                  <a href={it.url} target="_blank" rel="noreferrer">
                    {it.title}
                  </a>
                  {it.vendor && <span className="faint"> · {it.vendor}</span>}
                </td>
                <td className="muted" data-label="Site">
                  {it.site}
                </td>
                <td className="mono" data-label="Price">
                  {it.minPrice != null ? `$${it.minPrice.toFixed(2)}` : "—"}
                </td>
                <td data-label="Status">
                  <span
                    className={`pill ${it.stale ? "stale" : it.available ? "yes" : "no"}`}
                    title={
                      it.stale
                        ? "This checker is disabled or has not run in over 24h — last-known state, not current stock."
                        : undefined
                    }
                  >
                    {it.stale ? "not checked" : it.available ? "in stock" : "sold out"}
                  </span>
                </td>
                <td className="mono muted" data-label="Added" style={{ whiteSpace: "nowrap" }} title={addedLabel(it.firstSeen).full}>
                  {addedLabel(it.firstSeen).short}
                </td>
                <td>
                  <IgnoreButton handle={it.handle} ignored={isIgnored} />
                </td>
              </tr>
            );
          })}
          {filtered.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                No products match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
