import { describe, it, expect } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "./store.js";
import { snapshot, restoreLatest, listBackups, dbPathFromUrl } from "./backup.js";

const SITE = {
  id: "s1",
  name: "Shop",
  source: { kind: "shopify_rest", baseUrl: "https://x.com" },
};

describe("backup (1b)", () => {
  it("is a no-op for non-file URLs", async () => {
    const store = await openStore({ url: ":memory:" });
    expect(await snapshot(store.client, ":memory:")).toBeNull();
    expect(dbPathFromUrl(":memory:")).toBeNull();
    store.close();
  });

  it("snapshots a file DB and restores it after a simulated volume loss", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beacon-bk-"));
    const dbUrl = `file:${join(dir, "t.db")}`;
    const backupsDir = join(dir, "backups");

    const store = await openStore({ url: dbUrl });
    await store.sites.upsert(SITE);
    const snap = await snapshot(store.client, dbUrl, { dir: backupsDir, keep: 5 });
    expect(snap).toBeTruthy();
    expect((await stat(snap!)).size).toBeGreaterThan(0);
    expect((await listBackups(backupsDir)).length).toBe(1);
    store.close();

    // Simulate a lost DB file (the backups dir survives).
    const dbPath = dbPathFromUrl(dbUrl)!;
    await rm(dbPath, { force: true });
    await rm(`${dbPath}-wal`, { force: true });
    await rm(`${dbPath}-shm`, { force: true });

    const restored = await restoreLatest(dbUrl, backupsDir);
    expect(restored).toBeTruthy();

    const reopened = await openStore({ url: dbUrl });
    expect((await reopened.sites.list()).length).toBe(1);
    reopened.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("returns null when there is no backup to restore", async () => {
    const dir = await mkdtemp(join(tmpdir(), "beacon-bk-"));
    expect(await restoreLatest(`file:${join(dir, "none.db")}`, join(dir, "backups"))).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});
