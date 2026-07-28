// Headless prod status for Claude Code sessions (and curl): worker heartbeat +
// a per-site health summary. Auth: middleware — dashboard cookie OR
// `Authorization: Bearer <BEACON_OPS_TOKEN>`. Summary fields only — the product
// map never leaves the box through this route.

import { NextResponse } from "next/server";
import { getStore } from "../../../../lib/store";

export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const store = await getStore();
  const heartbeat = await store.meta.get("worker_heartbeat");
  const rows = await store.sites.list();
  const sites = [];
  for (const row of rows) {
    const state = await store.state.load(row.id);
    // Pass/fail timeline (the one record that survives a recovery) — the raw
    // material for judging an intermittently-blocked checker. Failures only:
    // compact, and the timestamps are what reveal the pattern (e.g. clustering
    // in drop windows).
    const history = (state?.checkHistory as Array<{ ts: string; ok: boolean }> | undefined) ?? [];
    const failedAt = history.filter((h) => !h.ok).map((h) => h.ts);
    sites.push({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      sourceKind: row.sourceKind,
      lastChecked: (state?.lastChecked as string | undefined) ?? null,
      productCount: (state?.productCount as number | undefined) ?? null,
      consecutiveErrors: (state?.consecutiveErrors as number | undefined) ?? 0,
      lastError: (state?.lastError as string | undefined) ?? null,
      cooldownUntil: (state?.cooldownUntil as string | undefined) ?? null,
      fetchVia: (state?.fetchVia as string | undefined) ?? null,
      preferFallback: state?.preferFallback === true,
      lastBrowserCheckAt: (state?.lastBrowserCheckAt as string | undefined) ?? null,
      checks: {
        recorded: history.length,
        failed: failedAt.length,
        since: history[0]?.ts ?? null,
        failedAt: failedAt.slice(-25),
      },
    });
  }
  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    workerHeartbeat: heartbeat ?? null,
    workerHeartbeatAgeSec: heartbeat ? Math.round((Date.now() - Date.parse(heartbeat)) / 1000) : null,
    sites,
  });
}
