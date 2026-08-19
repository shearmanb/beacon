"use client";

// Matched-lots table for the Unicorn watcher: client-side filtering (text,
// matched term, bottle, price range) plus per-lot dismiss. Everything is handed
// in by the server component and filtered in memory, no extra queries.
//
// The ALL-IN column is the point of the table. Unicorn's hammer price is not
// what you pay — a buyer's premium, then tax/card fee on the total, then
// shipping — so a bid that looks under budget often isn't. When a lot's
// keywords are linked to a target bottle, the row is also judged against that
// bottle's max hammer, which is the actual buy/walk-away decision.

import { useMemo, useState, useTransition } from "react";
import { estimateAllInDollars, type AuctionFees } from "@beacon/shared";
import { ignoreUnicornLot } from "../app/actions";

export interface UnicornLotRow {
  id: string;
  title: string;
  url: string;
  currentBidDollars: number | null;
  matchedTerms: string[];
  bottleIds: string[];
  firstSeenAt: string;
}

export interface IgnoredLotRow {
  id: string;
  title: string;
  at: string;
}

export interface BottleRef {
  id: string;
  rank: string;
  name: string;
  maxHammerDollars: number | null;
}

// The fee model + math live in @beacon/shared (pure, browser-safe) so the
// dashboard and the worker's Discord alerts can never disagree about what a
// bid actually costs delivered.
export type FeeModel = AuctionFees;
const allInDollars = estimateAllInDollars;

const money = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;

function seenLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : `${days}d ago`;
}

export function UnicornLots({
  lots,
  ignoredLots,
  bottles,
  fees,
}: {
  lots: UnicornLotRow[];
  ignoredLots: IgnoredLotRow[];
  bottles: BottleRef[];
  fees: FeeModel;
}) {
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [bottleId, setBottleId] = useState("");
  const [minBid, setMinBid] = useState("");
  const [maxBid, setMaxBid] = useState("");
  const [underMaxOnly, setUnderMaxOnly] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const bottleById = useMemo(() => new Map(bottles.map((b) => [b.id, b])), [bottles]);
  const terms = useMemo(() => Array.from(new Set(lots.flatMap((l) => l.matchedTerms))).sort(), [lots]);

  /** The buy/walk verdict for a row: under, over, or no target set. */
  const verdict = (lot: UnicornLotRow): { state: "under" | "over" | "none"; detail: string } => {
    if (lot.currentBidDollars == null) return { state: "none", detail: "" };
    const targets = lot.bottleIds.map((id) => bottleById.get(id)).filter((b): b is BottleRef => !!b);
    const withMax = targets.filter((b) => b.maxHammerDollars != null);
    if (withMax.length === 0) return { state: "none", detail: "" };
    // Multiple linked bottles: the most permissive ceiling wins — being over
    // one target but under another is still worth a look.
    const best = Math.max(...withMax.map((b) => b.maxHammerDollars!));
    return lot.currentBidDollars > best
      ? { state: "over", detail: `over max (${money(best)})` }
      : { state: "under", detail: `${money(best - lot.currentBidDollars)} to max` };
  };

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const lo = minBid.trim() === "" ? null : Number(minBid);
    const hi = maxBid.trim() === "" ? null : Number(maxBid);
    return lots.filter((l) => {
      if (needle && !l.title.toLowerCase().includes(needle)) return false;
      if (term && !l.matchedTerms.includes(term)) return false;
      if (bottleId && !l.bottleIds.includes(bottleId)) return false;
      // A lot with no bid yet has no price to compare — exclude it only when a
      // bound is actually set, so "min 100" doesn't silently hide un-bid lots.
      if (lo !== null && Number.isFinite(lo) && (l.currentBidDollars ?? -1) < lo) return false;
      if (hi !== null && Number.isFinite(hi) && (l.currentBidDollars ?? Infinity) > hi) return false;
      if (underMaxOnly && verdict(l).state === "over") return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lots, q, term, bottleId, minBid, maxBid, underMaxOnly, bottleById]);

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, fallback: string) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (!res.ok) setError(res.error ?? fallback);
    });

  return (
    <>
      <div className="filters">
        <input className="in" placeholder="Search lot title…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="in" value={bottleId} onChange={(e) => setBottleId(e.target.value)}>
          <option value="">All bottles</option>
          {bottles.map((b) => (
            <option key={b.id} value={b.id}>
              {[b.rank, b.name].filter(Boolean).join(" · ").slice(0, 60)}
            </option>
          ))}
        </select>
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
        <label className="check">
          <input type="checkbox" checked={underMaxOnly} onChange={(e) => setUnderMaxOnly(e.target.checked)} /> under max
          hammer
        </label>
        <span className="muted mono" style={{ fontSize: 12 }}>
          {filtered.length}/{lots.length}
        </span>
      </div>

      <p className="hint" style={{ marginTop: -4, marginBottom: 10 }}>
        All-in = hammer + {fees.buyerPremiumPct}% buyer&apos;s premium + {fees.salesTaxPct}% tax/CC fee +{" "}
        {money(fees.shippingDollars)} shipping. Filters and &ldquo;max hammer&rdquo; use the hammer price.
      </p>

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
                <th>All-in</th>
                <th>Target bottle</th>
                <th>Matched keyword</th>
                <th>First seen</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((lot) => {
                const v = verdict(lot);
                const targets = lot.bottleIds.map((id) => bottleById.get(id)).filter((b): b is BottleRef => !!b);
                return (
                  <tr key={lot.id}>
                    {/* data-label carries the column head into the mobile
                        stacked-card layout, where <thead> is hidden. */}
                    <td data-label="Lot">
                      <a href={lot.url} target="_blank" rel="noreferrer">
                        {lot.title}
                      </a>
                    </td>
                    <td className="mono" data-label="Bid">
                      {lot.currentBidDollars != null ? money(lot.currentBidDollars) : "—"}
                    </td>
                    <td className="mono" data-label="All-in">
                      {lot.currentBidDollars != null ? (
                        <>
                          <strong>{money(allInDollars(lot.currentBidDollars, fees))}</strong>
                          {v.state !== "none" && (
                            <span
                              className={`pill ${v.state === "over" ? "no" : "yes"}`}
                              style={{ marginLeft: 6 }}
                              title={
                                v.state === "over"
                                  ? "Current bid is already above your max hammer for this bottle"
                                  : "Current bid is still under your max hammer for this bottle"
                              }
                            >
                              {v.detail}
                            </span>
                          )}
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td data-label="Bottle">
                      {targets.length > 0 ? (
                        targets.map((b) => (
                          <span key={b.id} className="kind-chip" style={{ marginRight: 4 }}>
                            {b.rank || b.name.slice(0, 18)}
                          </span>
                        ))
                      ) : (
                        <span className="faint">unlinked</span>
                      )}
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
                        onClick={() => act(() => ignoreUnicornLot(lot.id, lot.title, true), "Could not dismiss that lot.")}
                      >
                        ignore
                      </button>
                    </td>
                  </tr>
                );
              })}
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
              <button
                className="btn"
                disabled={pending}
                onClick={() => act(() => ignoreUnicornLot(row.id, row.title, false), "Could not restore that lot.")}
              >
                restore
              </button>
            </div>
          ))}
        </details>
      )}
    </>
  );
}
