// Full alert-history export as JSONL — the "hand the data to an analyst"
// button. The alert_history table (capped 5,000 rows ≈ years at current
// volume) is the ground truth behind every Discord ping AND the quiet/
// suppressed events Discord never saw, so this beats any chat export for
// mining drop-timing patterns. Auth: the site-wide middleware cookie gate
// already covers /api/*, so a logged-in browser can just download it.
//
// First line is a meta record ({kind:"meta", ...}); every following line is
// one history row, oldest-first (natural for append-style analysis).

import { NextResponse } from "next/server";
import { getStore } from "../../../../lib/store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const store = await getStore();
  const rows = (await store.history.recent(100_000)).reverse(); // oldest-first
  const meta = {
    kind: "meta",
    exportedAt: new Date().toISOString(),
    rowCount: rows.length,
    source: "beacon v2 alert_history",
  };
  const body = [meta, ...rows].map((r) => JSON.stringify(r)).join("\n") + "\n";
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="beacon_alert_history_${new Date().toISOString().slice(0, 10)}.jsonl"`,
      "Cache-Control": "no-store",
    },
  });
}
