import { describe, it, expect } from "vitest";
import { mkdtemp, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureEvidence, pruneEvidence } from "./evidence.js";

const fakePage = {
  screenshot: async () => Buffer.from("png-bytes"),
  content: async () => "<html>walled</html>",
};

describe("captureEvidence", () => {
  it("writes a screenshot + html pair and returns their paths", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beacon-ev-"));
    const refs = await captureEvidence("site_a", fakePage, dir);
    expect(refs.screenshotPath).toMatch(/site_a.*\.png$/);
    expect(refs.htmlPath).toMatch(/site_a.*\.html$/);
    const files = await readdir(join(dir, "site_a"));
    expect(files).toHaveLength(2);
  });

  it("never throws when the page capture fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beacon-ev-"));
    const broken = {
      screenshot: async () => {
        throw new Error("target closed");
      },
      content: async () => {
        throw new Error("target closed");
      },
    };
    const refs = await captureEvidence("site_b", broken, dir);
    expect(refs.screenshotPath).toBeUndefined();
    expect(refs.htmlPath).toBeUndefined();
  });
});

describe("pruneEvidence", () => {
  it("keeps only the newest N capture pairs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beacon-ev-"));
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < 6; i++) {
      await writeFile(join(dir, `2026-07-2${i}T00-00-00-000Z.png`), "x");
      await writeFile(join(dir, `2026-07-2${i}T00-00-00-000Z.html`), "x");
    }
    await pruneEvidence(dir, 2);
    const left = (await readdir(dir)).sort();
    expect(left).toEqual([
      "2026-07-24T00-00-00-000Z.html",
      "2026-07-24T00-00-00-000Z.png",
      "2026-07-25T00-00-00-000Z.html",
      "2026-07-25T00-00-00-000Z.png",
    ]);
  });
});
