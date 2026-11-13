import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openStore, type BeaconStore } from "@beacon/db";
import { appendJsonl, maybeMirrorHistory } from "./mirror.js";

let store: BeaconStore;
beforeEach(async () => {
  store = await openStore({ url: ":memory:" });
});
afterEach(() => store.close());

const alert = (title: string) => ({
  type: "new_product" as const,
  product: { title, url: `https://x.com/products/${title}`, handle: title },
});

/** Stub fetch recording calls; `existing` simulates the file already on GitHub. */
function stubFetch(existing: string | null) {
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
    calls.push({ url: String(url), method, body });
    if (method === "GET") {
      if (existing == null) return new Response("{}", { status: 404 });
      return new Response(
        JSON.stringify({ sha: "sha-1", content: Buffer.from(existing, "utf8").toString("base64") }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ ok: true }), { status: 201 });
  }) as typeof fetch;
  return { impl, calls };
}

describe("appendJsonl", () => {
  it("appends rows to existing lines and stays JSONL-shaped", () => {
    const out = appendJsonl('{"a":1}\n', [{ b: 2 }]);
    expect(out).toBe('{"a":1}\n{"b":2}\n');
  });

  it("bounds the file to the newest lines", () => {
    const existing = Array.from({ length: 6_000 }, (_, i) => `{"i":${i}}`).join("\n") + "\n";
    const out = appendJsonl(existing, [{ i: "new" }]);
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(6_000);
    expect(lines[lines.length - 1]).toBe('{"i":"new"}');
    expect(lines[0]).toBe('{"i":1}'); // oldest line scrolled off
  });
});

describe("maybeMirrorHistory", () => {
  it("no-ops (no fetch) when GH env is absent", async () => {
    await store.history.append("s1", [alert("a")]);
    const { impl, calls } = stubFetch(null);
    await maybeMirrorHistory({ store, dryRun: false }, { fetchImpl: impl, token: "", repo: "" });
    expect(calls).toHaveLength(0);
  });

  it("creates the file on first run (PUT without sha) and records the last id", async () => {
    await store.history.append("s1", [alert("a"), alert("b")]);
    const { impl, calls } = stubFetch(null);
    await maybeMirrorHistory({ store, dryRun: false }, { fetchImpl: impl, token: "tok", repo: "o/r" });
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    const put = calls[1]!;
    expect(put.body!["sha"]).toBeUndefined();
    expect(put.body!["message"]).toContain("[skip ci]");
    const content = Buffer.from(put.body!["content"] as string, "base64").toString("utf8");
    expect(content.trim().split("\n")).toHaveLength(2);
    expect(content).toContain('"a"');
    const meta = JSON.parse((await store.meta.get("historyMirror"))!) as { lastId: number };
    expect(meta.lastId).toBeGreaterThan(0);
  });

  it("appends to an existing file (PUT carries the sha) and only pushes NEW rows", async () => {
    await store.history.append("s1", [alert("old")]);
    const { impl: first } = stubFetch(null);
    await maybeMirrorHistory({ store, dryRun: false }, { fetchImpl: first, token: "tok", repo: "o/r", intervalMs: 0 });

    await store.history.append("s1", [alert("fresh")]);
    const { impl, calls } = stubFetch('{"seen":"before"}\n');
    await maybeMirrorHistory({ store, dryRun: false }, { fetchImpl: impl, token: "tok", repo: "o/r", intervalMs: 0 });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body!["sha"]).toBe("sha-1");
    const content = Buffer.from(put.body!["content"] as string, "base64").toString("utf8");
    expect(content).toContain('"seen":"before"'); // existing lines preserved
    expect(content).toContain('"fresh"');
    expect(content).not.toContain('"old"'); // already mirrored — not re-pushed
  });

  it("respects the daily gate (second run inside the interval does nothing)", async () => {
    await store.history.append("s1", [alert("a")]);
    const { impl: first } = stubFetch(null);
    await maybeMirrorHistory({ store, dryRun: false }, { fetchImpl: first, token: "tok", repo: "o/r" });

    await store.history.append("s1", [alert("b")]);
    const { impl, calls } = stubFetch(null);
    await maybeMirrorHistory({ store, dryRun: false }, { fetchImpl: impl, token: "tok", repo: "o/r" });
    expect(calls).toHaveLength(0); // gated for ~24h
  });

  it("never pushes in dry-run", async () => {
    await store.history.append("s1", [alert("a")]);
    const { impl, calls } = stubFetch(null);
    await maybeMirrorHistory({ store, dryRun: true }, { fetchImpl: impl, token: "tok", repo: "o/r" });
    expect(calls).toHaveLength(0);
  });
  it("over 1 MB GitHub returns empty content: reads the raw file instead of overwriting the history", async () => {
    await store.history.append("s1", [alert("new-row")]);
    const calls: Array<{ method: string; accept: string; body?: Record<string, unknown> }> = [];
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const accept = (init?.headers as Record<string, string>)["Accept"] ?? "";
      calls.push({ method, accept, body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined });
      if (method !== "GET") return new Response("{}", { status: 200 });
      if (accept.includes("raw")) return new Response('{"old":1}\n{"old":2}\n', { status: 200 });
      return new Response(JSON.stringify({ sha: "big", size: 1_073_043, content: "" }), { status: 200 });
    }) as typeof fetch;
    await maybeMirrorHistory({ store, dryRun: false }, { fetchImpl: impl, token: "tok", repo: "o/r" });
    const put = calls.find((c) => c.method === "PUT")!;
    const lines = Buffer.from(put.body!["content"] as string, "base64").toString("utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('{"old":1}');
    expect(put.body!["sha"]).toBe("big");
  });

  it("refuses to write when a non-empty file cannot be read back", async () => {
    await store.history.append("s1", [alert("new-row")]);
    let puts = 0;
    const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET") {
        puts += 1;
        return new Response("{}", { status: 200 });
      }
      const accept = (init?.headers as Record<string, string>)["Accept"] ?? "";
      if (accept.includes("raw")) return new Response("", { status: 200 });
      return new Response(JSON.stringify({ sha: "big", size: 2_000_000, content: "" }), { status: 200 });
    }) as typeof fetch;
    await expect(maybeMirrorHistory({ store, dryRun: false }, { fetchImpl: impl, token: "tok", repo: "o/r" })).rejects.toThrow(/not overwriting/);
    expect(puts).toBe(0);
  });
});
