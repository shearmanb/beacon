// Bottle specs parsed from product titles, for the Products table's sort and
// filters. Shops put age/proof only in the title, in a dozen spellings:
// "10YR", "10 Year", "8 Years Old" / "115.80 Proof", "124pf", "122.30° pf".
// Pure + client-safe (no server imports).

const AGE_RE = /\b(\d{1,2})\s*-?\s*(?:yrs?|years?)\b/i;
const PROOF_RE = /\b(\d{2,3}(?:\.\d+)?)\s*°?\s*(?:proof|pf)\b/i;

/** Age statement in years, or null (NAS / not in the title). */
export function parseAge(title: string): number | null {
  const m = title.match(AGE_RE);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 50 ? n : null;
}

/** Proof, or null. Bounded to plausible spirits proofs so "750ml"-style
 *  numbers or "Barrel Proof" (no number) never parse. */
export function parseProof(title: string): number | null {
  const m = title.match(PROOF_RE);
  const n = m ? Number(m[1]) : NaN;
  return n >= 60 && n <= 180 ? n : null;
}
