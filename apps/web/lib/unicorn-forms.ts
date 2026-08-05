// Shared result types for the /unicorn server actions ("use server" modules may
// only export async functions, so types live here).

export interface UnicornActionResult {
  ok: boolean;
  error?: string;
}

export interface UnicornPreviewResult {
  ok: boolean;
  error?: string;
  rawCount?: number;
  matchedCount?: number;
  /** 0..100 — share of parsed lots carrying description text. */
  descCoveragePct?: number;
  hasMore?: boolean;
  /** Roster size the API itself reports, when it says — lets you confirm the
   *  scan will see the whole auction, not just page one. */
  total?: number | null;
  sample?: Array<{
    title: string;
    url: string;
    currentBidDollars: number | null;
    matchedTerms: string[];
  }>;
}
