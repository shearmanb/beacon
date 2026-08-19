"use client";

// Target-bottle list: the organizing layer above keywords. A bottle carries the
// research (why it fits), the price discipline (sensible all-in target + the
// max hammer to walk away at), free-form notes, and reference links. Keywords
// point at a bottle, so a matched lot inherits "which bottle is this, and what
// am I willing to pay".

import { useState, useTransition } from "react";
import { estimateAllInDollars, type AuctionFees } from "@beacon/shared";
import { updateUnicornBottles, updateUnicornConfig } from "../app/actions";
import { STARTER_BOTTLES, STARTER_NOTES } from "../lib/unicorn-starter";

export interface BottleRow {
  id: string;
  rank: string;
  name: string;
  why: string;
  targetLowDollars: number | null;
  targetHighDollars: number | null;
  maxHammerDollars: number | null;
  notes: string;
  links: Array<{ label: string; url: string }>;
}

// Shared with the worker + the lots table — see @beacon/shared/auction.
export type FeeModel = AuctionFees;

const money = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;

const allIn = estimateAllInDollars;

const num = (v: string): number | null => {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};

export function UnicornBottles({
  bottles,
  fees,
  termCountByBottle,
}: {
  bottles: BottleRow[];
  fees: FeeModel;
  termCountByBottle: Record<string, number>;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<BottleRow | null>(null);

  const save = (next: BottleRow[]) =>
    start(async () => {
      setError(null);
      const res = await updateUnicornBottles(next);
      if (!res.ok) setError(res.error ?? "Save failed");
      else {
        setEditing(null);
        setDraft(null);
      }
    });

  const blank = (): BottleRow => ({
    id: `b_${Date.now()}`,
    rank: "",
    name: "",
    why: "",
    targetLowDollars: null,
    targetHighDollars: null,
    maxHammerDollars: null,
    notes: "",
    links: [],
  });

  const loadStarter = () =>
    start(async () => {
      setError(null);
      const res = await updateUnicornBottles(STARTER_BOTTLES);
      if (!res.ok) {
        setError(res.error ?? "Could not load the starter list");
        return;
      }
      await updateUnicornConfig({ notes: STARTER_NOTES });
    });

  const editor = (b: BottleRow, isNew: boolean) => (
    <div className="card" style={{ marginTop: 8 }}>
      <div className="form-cols">
        <div className="field">
          <label>Rank</label>
          <input className="in" value={b.rank} placeholder="A1" onChange={(e) => setDraft({ ...b, rank: e.target.value })} />
        </div>
        <div className="field" style={{ flex: 3 }}>
          <label>Bottle</label>
          <input
            className="in"
            value={b.name}
            placeholder="Early Baker's 7 Year, 107 proof…"
            onChange={(e) => setDraft({ ...b, name: e.target.value })}
          />
        </div>
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label>Why it fits</label>
        <textarea
          className="in"
          style={{ width: "100%", minHeight: 60 }}
          value={b.why}
          onChange={(e) => setDraft({ ...b, why: e.target.value })}
        />
      </div>
      <div className="form-cols" style={{ marginTop: 8 }}>
        <div className="field">
          <label>Target all-in low $</label>
          <input
            className="in"
            inputMode="numeric"
            value={b.targetLowDollars ?? ""}
            onChange={(e) => setDraft({ ...b, targetLowDollars: num(e.target.value) })}
          />
        </div>
        <div className="field">
          <label>Target all-in high $</label>
          <input
            className="in"
            inputMode="numeric"
            value={b.targetHighDollars ?? ""}
            onChange={(e) => setDraft({ ...b, targetHighDollars: num(e.target.value) })}
          />
        </div>
        <div className="field">
          <label>Max hammer $</label>
          <input
            className="in"
            inputMode="numeric"
            value={b.maxHammerDollars ?? ""}
            onChange={(e) => setDraft({ ...b, maxHammerDollars: num(e.target.value) })}
          />
          <span className="hint">
            {b.maxHammerDollars != null ? `≈ ${money(allIn(b.maxHammerDollars, fees))} delivered` : "the walk-away price"}
          </span>
        </div>
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label>Notes</label>
        <textarea
          className="in"
          style={{ width: "100%", minHeight: 50 }}
          placeholder="Condition requirements, what to verify, what to avoid…"
          value={b.notes}
          onChange={(e) => setDraft({ ...b, notes: e.target.value })}
        />
      </div>
      <div className="field" style={{ marginTop: 8 }}>
        <label>Links</label>
        {b.links.map((ln, i) => (
          <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
            <input
              className="in"
              style={{ maxWidth: 160 }}
              placeholder="label"
              value={ln.label}
              onChange={(e) =>
                setDraft({ ...b, links: b.links.map((x, j) => (i === j ? { ...x, label: e.target.value } : x)) })
              }
            />
            <input
              className="in"
              style={{ flex: 1 }}
              placeholder="https://…"
              value={ln.url}
              onChange={(e) =>
                setDraft({ ...b, links: b.links.map((x, j) => (i === j ? { ...x, url: e.target.value } : x)) })
              }
            />
            <button className="btn" onClick={() => setDraft({ ...b, links: b.links.filter((_, j) => j !== i) })}>
              ✕
            </button>
          </div>
        ))}
        <button className="btn" onClick={() => setDraft({ ...b, links: [...b.links, { label: "", url: "" }] })}>
          + link
        </button>
      </div>
      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
        <button
          className="btn on"
          disabled={pending || !b.name.trim()}
          onClick={() => save(isNew ? [...bottles, b] : bottles.map((x) => (x.id === b.id ? b : x)))}
        >
          {pending ? "…" : "Save bottle"}
        </button>
        <button
          className="btn"
          disabled={pending}
          onClick={() => {
            setEditing(null);
            setDraft(null);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <div className="card">
      {error && <div className="preview-note err" style={{ marginBottom: 8 }}>{error}</div>}

      {bottles.length === 0 && editing !== "new" && (
        <div style={{ marginBottom: 10 }}>
          <p className="muted" style={{ marginBottom: 8 }}>
            No target bottles yet. Bottles are the organizing layer: each one holds the research, your price
            ceiling, and notes — then you point keywords at it.
          </p>
          <button className="btn on" disabled={pending} onClick={loadStarter}>
            {pending ? "…" : `Load starter list (${STARTER_BOTTLES.length} bottles, A1–A10)`}
          </button>
        </div>
      )}

      {bottles.map((b) =>
        editing === b.id && draft ? (
          <div key={b.id}>{editor(draft, false)}</div>
        ) : (
          // Fixed grid tracks (see .bottle-row) so every bottle's price block,
          // keyword count and actions line up in the same columns regardless of
          // how long its name or research note runs.
          <div key={b.id} className="bottle-row">
            <div>
              <div className="bottle-name">
                {b.rank && <span className="kind-chip" style={{ marginRight: 6 }}>{b.rank}</span>}
                {b.name}
              </div>
              <div className="bottle-meta" style={{ marginTop: 4 }}>
                {b.maxHammerDollars != null ? (
                  <>
                    max hammer <strong>{money(b.maxHammerDollars)}</strong> → {money(allIn(b.maxHammerDollars, fees))}{" "}
                    all-in
                  </>
                ) : (
                  <span className="faint">no max hammer set</span>
                )}
              </div>
            </div>

            <div>
              <div className="bottle-meta">
                {b.targetLowDollars != null && b.targetHighDollars != null ? (
                  <>
                    target {money(b.targetLowDollars)}–{money(b.targetHighDollars)}
                  </>
                ) : (
                  <span className="faint">no target set</span>
                )}
              </div>
              <span
                className={`pill ${termCountByBottle[b.id] ? "yes" : "no"}`}
                style={{ marginTop: 6, display: "inline-block" }}
                title={
                  termCountByBottle[b.id]
                    ? "Keywords are hunting for this bottle"
                    : "No keyword points at this bottle yet — nothing will ever match it"
                }
              >
                {termCountByBottle[b.id] ?? 0} keyword{(termCountByBottle[b.id] ?? 0) === 1 ? "" : "s"}
              </span>
            </div>

            <div>
              {b.why && <p className="hint" style={{ margin: 0 }}>{b.why}</p>}
              {b.notes && (
                <p className="hint" style={{ margin: "6px 0 0", color: "var(--warn)" }}>
                  📝 {b.notes}
                </p>
              )}
              {b.links.length > 0 && (
                <div style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {b.links.map((ln, i) => (
                    <a key={i} href={ln.url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                      {ln.label || ln.url}
                    </a>
                  ))}
                </div>
              )}
            </div>

            <div className="bottle-actions">
              <button
                className="btn"
                disabled={pending}
                onClick={() => {
                  setEditing(b.id);
                  setDraft(b);
                }}
              >
                edit
              </button>
              <button
                className="btn"
                disabled={pending}
                onClick={() => save(bottles.filter((x) => x.id !== b.id))}
                title="Remove this bottle; any keywords pointing at it become unlinked"
              >
                ✕
              </button>
            </div>
          </div>
        ),
      )}

      {editing === "new" && draft ? (
        editor(draft, true)
      ) : (
        <button
          className="btn"
          style={{ marginTop: 10 }}
          disabled={pending}
          onClick={() => {
            setEditing("new");
            setDraft(blank());
          }}
        >
          + Add bottle
        </button>
      )}
    </div>
  );
}
