// Recent failures per site — the errorLog tail (which carries evidence paths
// for browser checks) plus current error bookkeeping. Sites with no recorded
// errors are omitted. Auth: middleware (cookie or ops bearer token).

import { NextResponse } from "next/server";
import { getStore } from "../../../../lib/store";

export const dynamic = "force-dynamic";

const ERROR_TAIL = 8;

export async function GET(): Promise<NextResponse> {
  const store = await getStore();
  const rows = await store.sites.list();
  const sites = [];
  for (const row of rows) {
    const state = await store.state.load(row.id);
    const errorLog = (state?.errorLog as Array<Record<string, unknown>> | undefined) ?? [];
    const lastError = (state?.lastError as string | undefined) ?? null;
    if (!lastError && errorLog.length === 0) continue;
    sites.push({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      sourceKind: row.sourceKind,
      consecutiveErrors: (state?.consecutiveErrors as number | undefined) ?? 0,
      lastError,
      lastErrorAt: (state?.lastErrorAt as string | undefined) ?? null,
      cooldownUntil: (state?.cooldownUntil as string | undefined) ?? null,
      errorLog: errorLog.slice(-ERROR_TAIL),
    });
  }
  return NextResponse.json({ generatedAt: new Date().toISOString(), sites });
}
