import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { httpStatusAdapter, pageFingerprint } from "./http_status.js";
import { siteDefinitionSchema, type SiteDefinition } from "../schema.js";
import type { PrevState } from "./types.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler;
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function makeSite(): SiteDefinition {
  return siteDefinitionSchema.parse({
    id: "reveries_site_status",
    name: "The Reveries Site Status",
    alerts: { onSiteReset: true },
    source: {
      kind: "http_status",
      url: `${base}/shop`,
      blockedWhen: { bodyMatchesAny: ["coming soon", "sqs-pw-form", "enter password"], httpStatusIn: [401, 403] },
    },
  });
}

describe("httpStatusAdapter", () => {
  it("reports open for a normal page", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><div class='shop'>Shop now</div></body></html>");
    };
    const result = await httpStatusAdapter.fetch(makeSite(), {});
    expect(result.kind).toBe("signal");
    if (result.kind === "signal") expect(result.signal.kind).toBe("open");
  });

  it("reports blocked when a body reset-signal is present", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>This store is COMING SOON</body></html>");
    };
    const result = await httpStatusAdapter.fetch(makeSite(), {});
    if (result.kind !== "signal") throw new Error("expected signal");
    expect(result.signal.kind).toBe("blocked");
    expect(result.signal.reason).toMatch(/coming soon/i);
  });

  it("reports blocked on a 403 wall", async () => {
    handler = (_req, res) => {
      res.writeHead(403);
      res.end("forbidden");
    };
    const result = await httpStatusAdapter.fetch(makeSite(), {});
    if (result.kind !== "signal") throw new Error("expected signal");
    expect(result.signal.kind).toBe("blocked");
    expect(result.signal.reason).toMatch(/401\/403/);
  });

  it("short-circuits on 304 with stored validators", async () => {
    handler = (req, res) => {
      if (req.headers["if-none-match"] === '"v1"') {
        res.writeHead(304);
        res.end();
      } else {
        res.writeHead(200, { ETag: '"v1"' });
        res.end("ok");
      }
    };
    const prev: PrevState = { httpValidators: { etag: '"v1"', lastModified: null } };
    const result = await httpStatusAdapter.fetch(makeSite(), prev);
    expect(result.kind).toBe("not_modified");
  });

  it("re-throws non-wall errors (e.g. 500) for the worker's error path", async () => {
    handler = (_req, res) => {
      res.writeHead(500);
      res.end("boom");
    };
    await expect(httpStatusAdapter.fetch(makeSite(), {})).rejects.toMatchObject({ statusCode: 500 });
  });

  it("emits a content fingerprint (hash + len) on a signal result", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body><div class='shop'>Shop now</div></body></html>");
    };
    const result = await httpStatusAdapter.fetch(makeSite(), {});
    if (result.kind !== "signal") throw new Error("expected signal");
    expect(result.contentHash).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof result.contentLen).toBe("number");
  });
});

describe("pageFingerprint", () => {
  it("is stable across <script>/comment churn", () => {
    const a = "<html><body><div>Shop now</div><script>var n='aaaa1111';</script><!-- x --></body></html>";
    const b = "<html><body><div>Shop now</div><script>var n='bbbb2222zzzz';</script><!-- y z --></body></html>";
    expect(pageFingerprint(a).hash).toBe(pageFingerprint(b).hash);
  });

  it("is stable across rotating nonces/timestamps/long ids", () => {
    const a = "<div data-ts=1717000000000 data-build=0123456789abcdef0123>Shop now</div>";
    const b = "<div data-ts=1888000000000 data-build=fedcba9876543210fedc>Shop now</div>";
    expect(pageFingerprint(a).hash).toBe(pageFingerprint(b).hash);
  });

  it("differs for a materially different page (wall vs store)", () => {
    const wall = "<html><body>This store is Coming Soon</body></html>";
    const store = "<html><body><div class='product'>Bottle A — $129</div></body></html>";
    expect(pageFingerprint(wall).hash).not.toBe(pageFingerprint(store).hash);
  });
});
