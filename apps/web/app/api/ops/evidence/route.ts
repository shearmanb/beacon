// Browser-check evidence access: list captured screenshot/HTML files, or fetch
// one. What the browser actually SAW when a check failed — retrievable
// headlessly (Claude sessions) or from a logged-in browser.
//
//   GET /api/ops/evidence                     → { sites: { siteId: [files…] } }
//   GET /api/ops/evidence?site=X&file=Y.png   → the file itself
//
// Filesystem reads only, strictly inside the evidence dir: site + file are
// sanitized to single path segments (no separators, no dotfiles) so the route
// cannot traverse. Auth: middleware (cookie or ops bearer token).

import { NextResponse, type NextRequest } from "next/server";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const dynamic = "force-dynamic";

function evidenceDir(): string {
  return process.env["BEACON_EVIDENCE_DIR"] ?? "/data/evidence";
}

// One safe path segment: no separators, no leading dot, nothing outside the
// filename alphabet the writer (packages/browser/evidence.ts) produces.
const SAFE_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const site = req.nextUrl.searchParams.get("site");
  const file = req.nextUrl.searchParams.get("file");
  const base = evidenceDir();

  if (site && file) {
    if (!SAFE_SEGMENT.test(site) || !SAFE_SEGMENT.test(file) || file.includes("..")) {
      return NextResponse.json({ error: "bad path" }, { status: 400 });
    }
    try {
      const body = await readFile(join(base, site, file));
      const type = file.endsWith(".png") ? "image/png" : "text/html; charset=utf-8";
      return new NextResponse(new Uint8Array(body), {
        headers: { "Content-Type": type, "Cache-Control": "no-store" },
      });
    } catch {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  }

  try {
    const sites: Record<string, string[]> = {};
    for (const dir of await readdir(base)) {
      if (!SAFE_SEGMENT.test(dir)) continue;
      try {
        sites[dir] = (await readdir(join(base, dir))).sort().reverse(); // newest first
      } catch {
        /* not a dir — skip */
      }
    }
    return NextResponse.json({ generatedAt: new Date().toISOString(), sites });
  } catch {
    // Evidence dir doesn't exist yet (no failures captured) — empty, not an error.
    return NextResponse.json({ generatedAt: new Date().toISOString(), sites: {} });
  }
}
