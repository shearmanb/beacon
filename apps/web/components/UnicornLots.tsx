"use client";

// Matched-lots table for the Unicorn watcher: client-side filtering (text,
// matched term, price range) plus per-lot dismiss. Mirrors ProductsTable —
// everything is handed in by the server component and filtered in memory, no
// extra queries. Kept separate from ProductsTable because a lot is not a
// product (bids, not prices; matched terms, not vendors) and because the
// Unicorn module stays isolated from site tracking.

import { useMemo, useState, useTransition } from "react";
import { ignoreUnicornLot } from "../app/actions";

export interface UnicornLotRow {
  id: string;
  title: string;
  url: string;
  currentBidDollars: number | null;
  matchedTerms: string[];
  firstSeenAt: string;
}

export interface IgnoredLotRow {
  id: string;
  title: string;
  at: string;
}

function seenLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;
}

export function UnicornLots({ lots, ignoredLots }: { lots: UnicornLotRow[]; ignoredLots: IgnoredLotRow[] }) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [minBid, setMinBid] = useState("");
  const [maxBid, setMaxBid] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const terms = useMemo(
    () => Array.from(new Set(lots.flatMap((l) => l.matchedTerms))).sort(),
    [lots],
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const lo = minBid.trim() === "" ? null : Number(minBid);
    const hi = maxBid.trim() === "" ? null : Number(maxBid);
    return lots.filter((l) => {
      if (needle && !l.title.toLowerCase().includes(needle)) return false;
      if (term && !l.matchedTerms.includes(term)) return false;
      // A lot with no bid yet has no price to compare — exclude it only when a
      // bound is actually set, so "min 100" doesn't silently hide un-bid lots
      // without explanation.
      if (lo !== null && Number.isFinite(lo) && (l.currentBidDollars ?? -1) < lo) return false;
      if (hi !== null && Number.isFinite(hi) && (l.currentBidDollars ?? Infinity) > hi) return false;
      return true;
    });
  }, [lots, q, term, minBid, maxBid]);

  const dismiss = (lot: UnicornLotRow) =>
    start(async () => {
      setError(null);
      const res = await ignoreUnicornLot(lot.id, lot.title, true);
      if (!res.ok) setError(res.error ?? "Could not dismiss that lot.");
    });

  const restore = (row: IgnoredLotRow) =>
    start(async () => {
      setError(null);
      const res = await ignoreUnicornLot(row.id, row.title, false);
      if (!res.ok) setError(res.error ?? "Could not restore that lot.");
    });

  return (
    <>
      <div className="filters">
        <input className="in" placeholder="Search lot title…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="in" value={term} onChange={(e) => setTerm(e.target.value)}>
          <option value="">All terms</option>
          {terms.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          className="in"
          style={{ maxWidth: 110 }}
          inputMode="numeric"
          placeholder="min bid $"
          value={minBid}
          onChange={(e) => setMinBid(e.target.value)}
        />
        <input
          className="in"
          style={{ maxWidth: 110 }}
          inputMode="numeric"
          placeholder="max bid $"
          value={maxBid}
          onChange={(e) => setMaxBid(e.target.value)}
        />
        <span className="muted mono" style={{ fontSize: 12 }}>
          {filtered.length}/{lots.length}
        </span>
      </div>

      {error && <div className="preview-note err" style={{ marginBottom: 8 }}>{error}</div>}

      <div className="card" style={{ padding: 0 }}>
        {filtered.length === 0 && (
          <p className="muted" style={{ padding: 14 }}>
            {lots.length === 0 ? "No matched lots in the current auction." : "No lots match these filters."}
          </p>
        )}
        {filtered.length > 0 && (
          <table className="ptable">
            <thead>
              <tr>
                <th>Lot</th>
                <th>Current bid</th>
                <th>Matched keyword</th>
                <th>First seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((lot) => (
                <tr key={lot.id}>
                  {/* data-label carries the column head into the mobile
                      stacked-card layout, where <thead> is hidden. */}
                  <td data-label="Lot">
                    <a href={lot.url} target="_blank" rel="noreferrer">
                      {lot.title}
                    </a>
                  </td>
                  <td className="mono" data-label="Bid">
                    {lot.currentBidDollars != null ? `$${lot.currentBidDollars.toLocaleString("en-US")}` : "—"}
                  </td>
                  <td data-label="Keyword">
                    {lot.matchedTerms.map((t) => (
                      <span key={t} className="pill yes" style={{ marginRight: 4 }}>
                        {t}
                      </span>
                    ))}
                  </td>
                  <td className="when" data-label="Seen">
                    {seenLabel(lot.firstSeenAt)}
                  </td>
                  <td>
                    <button
                      className="btn"
                      disabled={pending}
                      title="Not what you're looking for — hide it and never alert on it again"
                      onClick={() => dismiss(lot)}
                    >
                      ignore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {ignoredLots.length > 0 && (
        <details className="card" style={{ marginTop: 10 }}>
          <summary className="hint" style={{ cursor: "pointer" }}>
            Ignored lots ({ignoredLots.length}) — dismissed as false hits
          </summary>
          <p className="hint" style={{ marginTop: 6 }}>
            These never match, never alert, and never appear above. Restoring one makes it eligible again on the
            next scan.
          </p>
          {ignoredLots.map((row) => (
            <div key={row.id} className="row" style={{ display: "flex", gap: 10, alignItems: "center", padding: "4px 0" }}>
              <span style={{ flex: 1 }}>{row.title || row.id}</span>
              <button className="btn" disabled={pending} onClick={() => restore(row)}>
                restore
              </button>
            </div>
          ))}
        </details>
      )}
    </>
  );
}
