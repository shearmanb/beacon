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

import { useEffect, useMemo, useState, useTransition } from "react";
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

// Sort choices for the lots table. A dropdown, not clickable column heads,
// because the mobile card layout hides <thead> (same call as /products).
const SORTS = {
  newest: "Newest first",
  oldest: "Oldest first",
  "bid-asc": "Bid: low → high",
  "bid-desc": "Bid: high → low",
  headroom: "Most room under max",
  bottle: "Target bottle (rank)",
  title: "Lot name A–Z",
} as const;
type SortKey = keyof typeof SORTS;
const SORT_KEY = "beacon.unicorn.lotSort";
const rankCmp = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

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
  const [sort, setSort] = useState<SortKey>("newest");
  // Remember the sort per browser (guarded; restored after mount so SSR and the
  // first client render agree).
  useEffect(() => {
    try {
      const v = localStorage.getItem(SORT_KEY);
      if (v && v in SORTS) setSort(v as SortKey);
    } catch {
      /* storage blocked */
    }
  }, []);
  const chooseSort = (v: SortKey) => {
    setSort(v);
    try {
      localStorage.setItem(SORT_KEY, v);
    } catch {
      /* storage blocked */
    }
  };
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

  // Room under the most permissive linked max hammer (bid-less or untargeted
  // lots have none and sort after every lot that does).
  const headroom = (lot: UnicornLotRow): number | null => {
    if (lot.currentBidDollars == null) return null;
    const maxes = lot.bottleIds.map((id) => bottleById.get(id)?.maxHammerDollars).filter((m): m is number => m != null);
    return maxes.length ? Math.max(...maxes) - lot.currentBidDollars : null;
  };
  const bestRank = (lot: UnicornLotRow): string | null => {
    const ranks = lot.bottleIds.map((id) => bottleById.get(id)?.rank).filter((r): r is string => !!r);
    return ranks.length ? ranks.sort(rankCmp)[0]! : null;
  };
  // Missing values (no bid, no target) always go last, whichever direction.
  const nullsLast = <T,>(a: T | null, b: T | null, cmp: (x: T, y: T) => number): number =>
    a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : cmp(a, b);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const lo = minBid.trim() === "" ? null : Number(minBid);
    const hi = maxBid.trim() === "" ? null : Number(maxBid);
    const rows = lots.filter((l) => {
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
    const byNum = (x: number, y: number) => x - y;
    const cmp: Record<SortKey, (a: UnicornLotRow, b: UnicornLotRow) => number> = {
      newest: (a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt),
      oldest: (a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt),
      "bid-asc": (a, b) => nullsLast(a.currentBidDollars, b.currentBidDollars, byNum),
      "bid-desc": (a, b) => nullsLast(a.currentBidDollars, b.currentBidDollars, (x, y) => y - x),
      headroom: (a, b) => nullsLast(headroom(a), headroom(b), (x, y) => y - x),
      bottle: (a, b) => nullsLast(bestRank(a), bestRank(b), rankCmp),
      title: (a, b) => a.title.localeCompare(b.title),
    };
    // Ties fall back to newest first so the order is stable and predictable.
    return [...rows].sort((a, b) => cmp[sort](a, b) || cmp.newest(a, b));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lots, q, term, bottleId, minBid, maxBid, underMaxOnly, bottleById, sort]);

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
        <select className="in" value={sort} onChange={(e) => chooseSort(e.target.value as SortKey)} title="Sort the matched lots">
          {(Object.keys(SORTS) as SortKey[]).map((k) => (
            <option key={k} value={k}>
              Sort: {SORTS[k]}
            </option>
          ))}
        </select>
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
