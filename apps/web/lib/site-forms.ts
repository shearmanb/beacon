// Shared types + pure helpers for the add-site wizard. Deliberately NOT a
// "use server" module (that file may only export async actions) and free of
// server imports, so the client wizard and the server actions can both use it.

export interface PreviewSample {
  title: string;
  available: boolean;
  minPrice: number | null;
  url: string;
  vendor: string | null;
}

export type PreviewResult =
  | { ok: false; error: string }
  | { ok: true; mode: "products"; rawCount: number; filteredCount: number; sample: PreviewSample[]; detail?: string }
  | { ok: true; mode: "signal"; blocked: boolean; detail: string };

export interface AddResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/** "a, b ,, c" → ["a","b","c"] */
export function splitList(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

export function splitNums(s: string): number[] {
  return splitList(s)
    .map(Number)
    .filter((n) => !Number.isNaN(n));
}

export function numOrNull(s: string): number | null {
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

/** Turn a display name into a safe snake_case site id. */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "site"
  );
}
