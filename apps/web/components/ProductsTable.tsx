"use client";

// Client-side filtered products table. The server component (products/page.tsx)
// loads every tracked product + the ignored set and hands them in; all filtering
// is in-memory here (search / site / availability / show-ignored) — no extra
// queries, no API routes. Restores the v1 dashboard's product filters.

import { useEffect, useMemo, useState } from "react";
import { IgnoreButton } from "./IgnoreButton";
import { parseAge, parseProof } from "../lib/bottle";

export interface ProductRow {
  site: string;
  handle: string;
  title: string;
  available: boolean;
  /** Roster frozen (checker disabled / silent >24h): last-known values, not
   *  current stock. Forced false on `available` upstream, flagged here so the
   *  row says so instead of quietly reading "sold out". */
  stale?: boolean;
  /** Storefront behind its password / coming-soon wall: loaded in the shop
   *  backend, not buyable. Forced false on `available` upstream. */
  walled?: boolean;
  minPrice: number | null;
  vendor: string | null;
  url: string;
  /** The product's own page when `url` is a shared shop page. */
  pageUrl?: string | null;
  /** Cleaned description / tasting notes. */
  details?: string | null;
  reveries: boolean;
  firstSeen: string | null;
}

type Avail = "all" | "in" | "wall" | "out";
type SortKey = "status" | "new" | "price_asc" | "price_desc" | "age" | "proof" | "name";

// Per-viewer view settings (sort + filters, not the search box) survive reloads.
const VIEW_KEY = "beacon.products.view";
interface View {
  site: string;
  avail: Avail;
  revOnly: boolean;
  showIgnored: boolean;
  sort: SortKey;
  minAge: number;
  minProof: number;
  maxPrice: string;
  notesOnly: boolean;
}
const DEFAULT_VIEW: View = {
  site: "",
  avail: "all",
  revOnly: false,
  showIgnored: false,
  sort: "status",
  minAge: 0,
  minProof: 0,
  maxPrice: "",
  notesOnly: false,
};

/** Descending compare with nulls last (unknown age/proof/price sinks). */
function desc(a: number | null, b: number | null): number {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return b - a;
}

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
  const [view, setView] = useState<View>(DEFAULT_VIEW);
  const [loaded, setLoaded] = useState(false);
  const { site, avail, revOnly, showIgnored, sort, minAge, minProof, maxPrice, notesOnly } = view;
  const set = <K extends keyof View>(k: K, v: View[K]) => setView((cur) => ({ ...cur, [k]: v }));
  // Restore after mount (not in the initializer) so SSR and first client
  // render agree; storage can be blocked, so every access is guarded.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      if (saved) setView({ ...DEFAULT_VIEW, ...(JSON.parse(saved) as Partial<View>) });
    } catch {
      /* default view */
    }
    // The Reveries panel's "sort & filter" link lands here pre-filtered.
    if (new URLSearchParams(window.location.search).get("reveries") === "1") {
      setView((cur) => ({ ...cur, revOnly: true }));
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (!loaded) return;
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      /* not persisted */
    }
  }, [view, loaded]);
  const reveriesCount = useMemo(() => items.filter((i) => i.reveries).length, [items]);
  // Age/proof live only in titles; parse once per roster.
  const specs = useMemo(
    () => new Map(items.map((i) => [i, { age: parseAge(i.title), proof: parseProof(i.title) }])),
    [items],
  );
  const isFiltered = JSON.stringify(view) !== JSON.stringify(DEFAULT_VIEW);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const priceCap = maxPrice.trim() ? Number(maxPrice) : NaN;
    const rows = items.filter((it) => {
      const s = specs.get(it)!;
      if (minAge && (s.age ?? 0) < minAge) return false;
      if (minProof && (s.proof ?? 0) < minProof) return false;
      if (!Number.isNaN(priceCap) && (it.minPrice == null || it.minPrice > priceCap)) return false;
      if (notesOnly && !it.details) return false;
      if (site && it.site !== site) return false;
      // A stale row is neither in stock nor sold out — it is unknown, so it
      // matches neither availability filter. A walled row is its own bucket.
      if (avail === "in" && !it.available) return false;
      if (avail === "wall" && !it.walled) return false;
      if (avail === "out" && (it.available || it.stale || it.walled)) return false;
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
    // "status" keeps the server's order (in stock → behind wall → sold out → frozen).
    if (sort === "status") return rows;
    const by: Record<Exclude<SortKey, "status">, (a: ProductRow, b: ProductRow) => number> = {
      new: (a, b) => (b.firstSeen ?? "").localeCompare(a.firstSeen ?? ""),
      price_asc: (a, b) => (a.minPrice == null || b.minPrice == null ? desc(a.minPrice, b.minPrice) : a.minPrice - b.minPrice),
      price_desc: (a, b) => desc(a.minPrice, b.minPrice),
      age: (a, b) => desc(specs.get(a)!.age, specs.get(b)!.age),
      proof: (a, b) => desc(specs.get(a)!.proof, specs.get(b)!.proof),
      name: (a, b) => a.title.localeCompare(b.title),
    };
    return [...rows].sort((a, b) => by[sort](a, b) || a.title.localeCompare(b.title));
  }, [items, specs, q, site, avail, revOnly, showIgnored, ignoredSet, sort, minAge, minProof, maxPrice, notesOnly]);

  return (
    <>
      <div className="filters">
        <input
          className="in"
          placeholder="Search product or vendor…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="in" value={site} onChange={(e) => set("site", e.target.value)}>
          <option value="">All sites</option>
          {sites.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select className="in" value={avail} onChange={(e) => set("avail", e.target.value as Avail)}>
          <option value="all">Any status</option>
          <option value="in">In stock</option>
          <option value="wall">Behind wall</option>
          <option value="out">Sold out</option>
        </select>
        <label className="check">
          <input type="checkbox" checked={revOnly} onChange={(e) => set("revOnly", e.target.checked)} />
          ✨ Reveries only{reveriesCount > 0 ? ` (${reveriesCount})` : ""}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={showIgnored}
            onChange={(e) => set("showIgnored", e.target.checked)}
          />
          Show ignored
        </label>
      </div>
      <div className="filters">
        <select className="in" value={sort} onChange={(e) => set("sort", e.target.value as SortKey)} title="Sort">
          <option value="status">Sort: status</option>
          <option value="new">Sort: newest added</option>
          <option value="price_asc">Sort: price low → high</option>
          <option value="price_desc">Sort: price high → low</option>
          <option value="age">Sort: oldest age</option>
          <option value="proof">Sort: highest proof</option>
          <option value="name">Sort: name A → Z</option>
        </select>
        <select className="in" value={minAge} onChange={(e) => set("minAge", Number(e.target.value))} title="Minimum age">
          <option value={0}>Any age</option>
          {[8, 10, 12, 15].map((n) => (
            <option key={n} value={n}>
              {n}+ yr
            </option>
          ))}
        </select>
        <select className="in" value={minProof} onChange={(e) => set("minProof", Number(e.target.value))} title="Minimum proof">
          <option value={0}>Any proof</option>
          {[100, 110, 120, 130].map((n) => (
            <option key={n} value={n}>
              {n}+ proof
            </option>
          ))}
        </select>
        <input
          className="in"
          type="number"
          inputMode="decimal"
          min={0}
          placeholder="Max $"
          value={maxPrice}
          onChange={(e) => set("maxPrice", e.target.value)}
          style={{ width: 90 }}
        />
        <label className="check">
          <input type="checkbox" checked={notesOnly} onChange={(e) => set("notesOnly", e.target.checked)} />
          📝 has notes
        </label>
        {isFiltered && (
          <button className="btn" onClick={() => setView(DEFAULT_VIEW)}>
            Reset
          </button>
        )}
        <span className="muted mono" style={{ fontSize: 12, marginLeft: "auto" }}>
          {filtered.length} / {items.length}
        </span>
      </div>
      <table className="ptable">
        <thead>
          <tr>
            <th>Product</th>
            <th>Site</th>
            <th>Age</th>
            <th>Proof</th>
            <th>Price</th>
            <th>Status</th>
            <th>Added</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((it) => {
            const isIgnored = ignoredSet.has(it.handle);
            const spec = specs.get(it)!;
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
                  {it.pageUrl && (
                    <>
                      {" "}
                      <a className="faint" href={it.pageUrl} target="_blank" rel="noreferrer" title="The product's own page">
                        ↗ product page
                      </a>
                    </>
                  )}
                  {it.details && (
                    <details className="pnotes">
                      <summary>📝 notes</summary>
                      <div>{it.details}</div>
                    </details>
                  )}
                </td>
                <td className="muted" data-label="Site">
                  {it.site}
                </td>
                <td className="mono muted" data-label="Age">
                  {spec.age != null ? `${spec.age} yr` : "—"}
                </td>
                <td className="mono muted" data-label="Proof">
                  {spec.proof != null ? spec.proof : "—"}
                </td>
                <td className="mono" data-label="Price">
                  {it.minPrice != null ? `$${it.minPrice.toFixed(2)}` : "—"}
                </td>
                <td data-label="Status">
                  <span
                    className={`pill ${it.stale ? "stale" : it.walled ? "wall" : it.available ? "yes" : "no"}`}
                    title={
                      it.stale
                        ? "This checker is disabled or has not run in over 24h — last-known state, not current stock."
                        : it.walled
                          ? "The shop is behind its password / coming-soon wall right now — loaded in the store's backend, not buyable until it opens."
                          : undefined
                    }
                  >
                    {it.stale ? "not checked" : it.walled ? "🌊 behind wall" : it.available ? "in stock" : "sold out"}
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
              <td colSpan={8} className="muted">
                No products match.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
