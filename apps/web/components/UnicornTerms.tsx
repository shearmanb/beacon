"use client";

// Watchlist editor for the Unicorn module: each term matches lot names and/or
// descriptions (all words present, any order, case-insensitive). Saves replace
// the whole terms array via updateUnicornConfig — write-confirmed, same
// discipline as every other dashboard edit.

import { useState, useTransition } from "react";
import { updateUnicornConfig } from "../app/actions";

export interface UnicornTermInput {
  term: string;
  inName: boolean;
  inDesc: boolean;
  bottleId?: string | undefined;
}

export interface TermBottleRef {
  id: string;
  rank: string;
  name: string;
}

export function UnicornTerms({
  terms,
  bottles,
}: {
  terms: UnicornTermInput[];
  bottles: TermBottleRef[];
}) {
  const [draft, setDraft] = useState("");
  const [draftName, setDraftName] = useState(true);
  const [draftDesc, setDraftDesc] = useState(false);
  const [draftBottle, setDraftBottle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const save = (next: UnicornTermInput[]) =>
    start(async () => {
      setError(null);
      const res = await updateUnicornConfig({ terms: next });
      if (!res.ok) setError(res.error ?? "Save failed");
    });

  const add = () => {
    const term = draft.trim();
    if (!term) return;
    if (terms.some((t) => t.term.toLowerCase() === term.toLowerCase())) {
      setError(`"${term}" is already on the list.`);
      return;
    }
    save([...terms, { term, inName: draftName || !draftDesc, inDesc: draftDesc, bottleId: draftBottle || undefined }]);
    setDraft("");
  };

  const toggle = (i: number, field: "inName" | "inDesc") => {
    const next = terms.map((t, idx) => (idx === i ? { ...t, [field]: !t[field] } : t));
    const edited = next[i]!;
    if (!edited.inName && !edited.inDesc) return; // at least one field must stay on
    save(next);
  };

  return (
    <div className="card">
      {terms.length === 0 && (
        <p className="muted" style={{ marginBottom: 8 }}>
          No terms yet — nothing will match until you add some (e.g. &ldquo;weller 12&rdquo;,
          &ldquo;stitzel&rdquo;, &ldquo;michter&apos;s 20&rdquo;).
        </p>
      )}
      {terms.map((t, i) => (
        <div key={t.term} className="row" style={{ display: "flex", gap: 12, alignItems: "center", padding: "6px 0" }}>
          <span className="mono" style={{ minWidth: 180 }}>
            {t.term}
          </span>
          <label className="check">
            <input type="checkbox" checked={t.inName} disabled={pending} onChange={() => toggle(i, "inName")} /> name
          </label>
          <label className="check">
            <input type="checkbox" checked={t.inDesc} disabled={pending} onChange={() => toggle(i, "inDesc")} /> description
          </label>
          <select
            className="in"
            style={{ maxWidth: 200, fontSize: 12 }}
            value={t.bottleId ?? ""}
            disabled={pending || bottles.length === 0}
            title="Which target bottle is this keyword hunting for?"
            onChange={(e) =>
              save(terms.map((x, idx) => (idx === i ? { ...x, bottleId: e.target.value || undefined } : x)))
            }
          >
            <option value="">— no bottle —</option>
            {bottles.map((b) => (
              <option key={b.id} value={b.id}>
                {[b.rank, b.name].filter(Boolean).join(" · ").slice(0, 48)}
              </option>
            ))}
          </select>
          <span className="spacer" />
          <button className="btn" disabled={pending} onClick={() => save(terms.filter((_, idx) => idx !== i))}>
            ✕
          </button>
        </div>
      ))}

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 10 }}>
        <input
          className="in"
          style={{ minWidth: 220 }}
          placeholder="add a term, e.g. weller 12"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <label className="check">
          <input type="checkbox" checked={draftName} onChange={(e) => setDraftName(e.target.checked)} /> name
        </label>
        <label className="check">
          <input type="checkbox" checked={draftDesc} onChange={(e) => setDraftDesc(e.target.checked)} /> description
        </label>
        <select
          className="in"
          style={{ maxWidth: 200, fontSize: 12 }}
          value={draftBottle}
          disabled={bottles.length === 0}
          onChange={(e) => setDraftBottle(e.target.value)}
        >
          <option value="">— no bottle —</option>
          {bottles.map((b) => (
            <option key={b.id} value={b.id}>
              {[b.rank, b.name].filter(Boolean).join(" · ").slice(0, 48)}
            </option>
          ))}
        </select>
        <button className="btn on" disabled={pending || !draft.trim()} onClick={add}>
          {pending ? "…" : "Add term"}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 6 }}>
        All words must appear (any order): &ldquo;weller 12&rdquo; matches &ldquo;1— Weller 12 Year&rdquo;.
        Adding a term surfaces its existing matches as alerts on the next scan.
      </p>
      {error && <div className="preview-note err" style={{ marginTop: 8 }}>{error}</div>}
    </div>
  );
}
