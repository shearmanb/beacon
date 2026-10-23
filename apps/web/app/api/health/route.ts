// Public liveness probe for the external dead-man (.github/workflows/deadman.yml,
// or any uptime pinger). Deliberately unauthenticated and deliberately thin:
// it answers "is the worker loop alive?" and nothing else — no site names, no
// products, no errors. 200 while the worker heartbeat is fresh, 503 otherwise
// (including when the DB can't be read: a dashboard that can't reach its
// datastore is not healthy).
//
// Why a separate route from /api/ops/status: that one needs a bearer token,
// and a dead-man that needs a secret in the prober is one more thing to lose.
// This probe can live in a public GitHub Actions workflow with zero secrets.

import { NextResponse } from "next/server";
import { getStore } from "../../../lib/store";

export const dynamic = "force-dynamic";

// Mirrors WORKER_STALE_MS in app/page.tsx — the loop runs ~60s; 15 min of
// silence means the loop itself is wedged or the process is gone. The wedge
// watchdog exits the process at 15 min too, so a 503 here means Railway's
// restart did NOT bring the worker back — exactly the case the dead-man exists for.
const STALE_MS = 15 * 60_000;

export async function GET(): Promise<NextResponse> {
  try {
    const store = await getStore();
    const heartbeat = await store.meta.get("worker_heartbeat");
    const ageSec = heartbeat ? Math.round((Date.now() - Date.parse(heartbeat)) / 1000) : null;
    const ok = ageSec !== null && Number.isFinite(ageSec) && ageSec * 1000 <= STALE_MS;
    return NextResponse.json(
      { ok, workerHeartbeatAgeSec: ageSec },
      { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ ok: false, workerHeartbeatAgeSec: null }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
