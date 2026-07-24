// Failure-evidence capture: when a browser check fails or looks walled, keep
// what the browser actually saw — screenshot + final HTML — so the operator
// (and Claude, via /api/ops/evidence) can diagnose without re-running. Bounded:
// newest EVIDENCE_KEEP snapshots per site; best-effort by design (evidence must
// never break the check path that produces it).

import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const EVIDENCE_KEEP = 10;

export function evidenceDir(): string {
  return process.env["BEACON_EVIDENCE_DIR"] ?? "/data/evidence";
}

export interface EvidenceRefs {
  screenshotPath?: string;
  htmlPath?: string;
}

interface PageLike {
  screenshot(opts: { fullPage?: boolean; timeout?: number }): Promise<Buffer | Uint8Array>;
  content(): Promise<string>;
}

/** Timestamped, filesystem-safe basename (one per capture, pair-matched). */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export async function captureEvidence(siteId: string, page: PageLike, baseDir = evidenceDir()): Promise<EvidenceRefs> {
  const refs: EvidenceRefs = {};
  const dir = join(baseDir, siteId.replace(/[^a-zA-Z0-9_-]/g, "_"));
  const base = stamp();
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return refs; // read-only/absent volume (local dev) — evidence is optional
  }
  try {
    const shot = await page.screenshot({ fullPage: false, timeout: 5_000 });
    const p = join(dir, `${base}.png`);
    await writeFile(p, Buffer.from(shot));
    refs.screenshotPath = p;
  } catch {
    /* best-effort */
  }
  try {
    const html = await page.content();
    const p = join(dir, `${base}.html`);
    await writeFile(p, html.slice(0, 512 * 1024), "utf8"); // cap 512 KB
    refs.htmlPath = p;
  } catch {
    /* best-effort */
  }
  await pruneEvidence(dir).catch(() => {});
  return refs;
}

/** Keep only the newest EVIDENCE_KEEP capture *pairs* (by name — names are
 *  ISO-stamped so lexical order == time order). */
export async function pruneEvidence(dir: string, keep = EVIDENCE_KEEP): Promise<void> {
  const files = (await readdir(dir)).sort(); // oldest first
  const bases = [...new Set(files.map((f) => f.replace(/\.(png|html)$/, "")))];
  const drop = new Set(bases.slice(0, Math.max(0, bases.length - keep)));
  await Promise.all(
    files.filter((f) => drop.has(f.replace(/\.(png|html)$/, ""))).map((f) => unlink(join(dir, f)).catch(() => {})),
  );
}
