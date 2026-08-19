import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type BeaconStore } from "@beacon/db";
import { maybeBackupConfig, restoreFromGithub, buildBackupBundle } from "./backup-mirror.js";

let store: BeaconStore;

beforeEach(async () => {
  store = await openStore({ url: ":memory:" });
});
afterEach(() => store.close());

/** In-memory stand-in for the GitHub contents API. */
function fakeGithub() {
  const files = new Map<string, string>(); // path -> utf8 body
  const commits: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const path = u.split("/contents/")[1]!.split("?")[0]!;
    if (!init || init.method !== "PUT") {
      const body = files.get(path);
      if (body == null) return new Response("{}", { status: 404 });
      return new Response(
        JSON.stringify({ sha: "sha-1", content: Buffer.from(body, "utf8").toString("base64") }),
        { status: 200 },
      );
    }
    const payload = JSON.parse(String(init.body)) as { content: string; message: string };
    files.set(path, Buffer.from(payload.content, "base64").toString("utf8"));
    commits.push(payload.message);
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  return { files, commits, over: { fetchImpl, token: "tok", repo: "o/r", intervalMs: 0 } };
}

async function seedSomething(): Promise<void> {
  await store.sites.upsert({
    id: "s1",
    name: "Shop",
    intervalMinutes: 20,
    source: { kind: "shopify_rest", baseUrl: "https://shop.example.com" },
  });
  await store.state.save("s1", {
    lastChecked: "2026-08-14T00:00:00.000Z",
    productCount: 1,
    products: { bottle: { handle: "bottle", title: "A Bottle", url: "u", tags: [], available: true } },
    checkHistory: [{ ts: "2026-08-14T00:00:00.000Z", ok: true }],
  });
  await store.schedules.upsert("drop_windows", { label: "x", rules: [{ defaultInterval: 15 }] });
  await store.ignored.add("junk-handle");
  await store.meta.set("unicorn_config", JSON.stringify({ terms: [{ term: "weller" }] }));
  await store.secrets.set("storefront_token", "SECRET-DO-NOT-LEAK");
}

describe("off-box backup (2d)", () => {
  it("pushes a bundle and never includes the secrets table", async () => {
    await seedSomething();
    const gh = fakeGithub();
    expect(await maybeBackupConfig({ store, dryRun: false }, gh.over)).toBe(true);

    const body = gh.files.get("analytics/backup/beacon-restore.json")!;
    expect(body).not.toContain("SECRET-DO-NOT-LEAK");
    expect(gh.commits[0]).toContain("[skip ci]");
    const bundle = JSON.parse(body);
    expect(bundle.sites).toHaveLength(1);
    expect(bundle.meta.unicorn_config).toContain("weller");
    // Operational churn is trimmed; the product baseline is the point.
    expect(bundle.states.s1.checkHistory).toBeUndefined();
    expect(Object.keys(bundle.states.s1.products)).toEqual(["bottle"]);
  });

  it("refuses to overwrite a good backup with an empty datastore", async () => {
    const gh = fakeGithub();
    await seedSomething();
    await maybeBackupConfig({ store, dryRun: false }, gh.over);
    const good = gh.files.get("analytics/backup/beacon-restore.json")!;

    // Now simulate the volume-loss state: empty DB, backup job runs anyway.
    const empty = await openStore({ url: ":memory:" });
    expect(await maybeBackupConfig({ store: empty, dryRun: false }, gh.over)).toBe(false);
    expect(gh.files.get("analytics/backup/beacon-restore.json")).toBe(good);
    empty.close();
  });

  it("restores sites, schedules, ignores, curated meta and BASELINES into an empty store", async () => {
    await seedSomething();
    const gh = fakeGithub();
    await maybeBackupConfig({ store, dryRun: false }, gh.over);

    const fresh = await openStore({ url: ":memory:" });
    const result = await restoreFromGithub(fresh, gh.over);
    expect(result.restored).toBe(true);
    expect(result.sites).toBe(1);
    expect((await fresh.sites.get("s1"))?.name).toBe("Shop");
    expect(Object.keys((await fresh.schedules.all()))).toEqual(["drop_windows"]);
    expect([...(await fresh.ignored.set())]).toEqual(["junk-handle"]);
    expect(await fresh.meta.get("unicorn_config")).toContain("weller");
    // The baseline is what stops a restore from paging every bottle as new.
    const state = await fresh.state.load("s1");
    expect(Object.keys((state?.products as Record<string, unknown>) ?? {})).toEqual(["bottle"]);
    fresh.close();
  });

  it("never clobbers a datastore that still has sites", async () => {
    await seedSomething();
    const gh = fakeGithub();
    await maybeBackupConfig({ store, dryRun: false }, gh.over);
    const result = await restoreFromGithub(store, gh.over);
    expect(result.restored).toBe(false);
    expect(result.reason).toContain("not empty");
  });

  it("reports cleanly when no bundle exists yet", async () => {
    const fresh = await openStore({ url: ":memory:" });
    const gh = fakeGithub();
    const result = await restoreFromGithub(fresh, gh.over);
    expect(result.restored).toBe(false);
    expect(result.reason).toContain("no backup bundle");
    fresh.close();
  });

  it("is disarmed without GH_TOKEN/GH_REPO", async () => {
    await seedSomething();
    const bundle = await buildBackupBundle(store); // still buildable for tests/tools
    expect(bundle.sites).toHaveLength(1);
    expect(await maybeBackupConfig({ store, dryRun: false }, { token: "", repo: "", intervalMs: 0 })).toBe(false);
  });
});
