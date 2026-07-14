import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { type AddressInfo } from "node:net";
import { httpGet, HttpError, type HttpResponse } from "./http.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let handler: Handler;
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("httpGet", () => {
  it("returns a plain body string", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello world");
    };
    expect(await httpGet(`${base}/`)).toBe("hello world");
  });

  it("decompresses a gzip body transparently", async () => {
    const payload = JSON.stringify({ products: [{ handle: "x" }] });
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Encoding": "gzip", "Content-Type": "application/json" });
      res.end(gzipSync(Buffer.from(payload)));
    };
    expect(await httpGet(`${base}/json`)).toBe(payload);
  });

  it("sends browser-like headers (User-Agent, Accept-Language)", async () => {
    let seen: IncomingMessage["headers"] | undefined;
    handler = (req, res) => {
      seen = req.headers;
      res.end("ok");
    };
    await httpGet(`${base}/`);
    expect(seen?.["user-agent"]).toMatch(/Mozilla\/5\.0/);
    expect(seen?.["accept-language"]).toBeTruthy();
  });

  it("follows redirects to the final 200", async () => {
    handler = (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "/final" });
        res.end();
      } else {
        res.writeHead(200);
        res.end("arrived");
      }
    };
    expect(await httpGet(`${base}/start`)).toBe("arrived");
  });

  it("treats 304 as success when withResponse is set", async () => {
    handler = (_req, res) => {
      res.writeHead(304);
      res.end();
    };
    const r: HttpResponse = await httpGet(`${base}/cond`, { withResponse: true });
    expect(r.status).toBe(304);
    expect(r.body).toBe("");
  });

  it("retries on 429 honoring a short Retry-After, then succeeds", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { "Retry-After": "0" });
        res.end("slow down");
      } else {
        res.writeHead(200);
        res.end("recovered");
      }
    };
    expect(await httpGet(`${base}/rl`)).toBe("recovered");
    expect(calls).toBe(2);
  });

  it("fails fast with the status when Retry-After exceeds the inline cap (no long sleep)", async () => {
    // A long Retry-After must NOT be waited out inline — that would burn the
    // caller's per-site budget and starve the fallback. It surfaces as HttpError
    // so the circuit breaker / fallback channel handle it upstream.
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      res.writeHead(429, { "Retry-After": "60" });
      res.end("come back later");
    };
    const start = Date.now();
    await expect(httpGet(`${base}/rl-long`)).rejects.toMatchObject({ name: "HttpError", statusCode: 429 });
    expect(Date.now() - start).toBeLessThan(1000); // did not sleep anywhere near 60s
    expect(calls).toBe(1); // no inline retry
  });

  it("honors an abort fired during the retry backoff (does not wait it out)", async () => {
    // The backoff sleep must be cancelable — the old code removed the abort
    // listener before sleeping, so a stall guard / per-site budget was ignored
    // until the full delay elapsed. Retry-After 3s is under the inline cap, so it
    // sleeps; aborting at 50ms must reject promptly, not after 3s.
    handler = (_req, res) => {
      res.writeHead(429, { "Retry-After": "3" });
      res.end("slow");
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const start = Date.now();
    await expect(httpGet(`${base}/rl-abort`, { signal: controller.signal })).rejects.toThrow(/Aborted/);
    expect(Date.now() - start).toBeLessThan(1500); // cancelled the sleep, didn't wait 3s
  });

  it("rejects with HttpError carrying the status code on 4xx", async () => {
    handler = (_req, res) => {
      res.writeHead(404);
      res.end("nope");
    };
    await expect(httpGet(`${base}/missing`)).rejects.toMatchObject({
      name: "HttpError",
      statusCode: 404,
    });
    await expect(httpGet(`${base}/missing`)).rejects.toBeInstanceOf(HttpError);
  });

  it("sends API-shaped headers for kind:'api' (no navigation headers)", async () => {
    let seen: IncomingMessage["headers"] | undefined;
    handler = (req, res) => {
      seen = req.headers;
      res.end("ok");
    };
    await httpGet(`${base}/products.json`, { kind: "api" });
    expect(seen?.["accept"]).toMatch(/application\/json/);
    expect(seen?.["sec-fetch-dest"]).toBe("empty");
    expect(seen?.["sec-fetch-mode"]).toBe("cors");
    expect(seen?.["upgrade-insecure-requests"]).toBeUndefined();
  });

  it("sends navigation headers for a deep document path (same-origin + Referer)", async () => {
    let seen: IncomingMessage["headers"] | undefined;
    handler = (req, res) => {
      seen = req.headers;
      res.end("ok");
    };
    await httpGet(`${base}/shop/page`);
    expect(seen?.["sec-fetch-dest"]).toBe("document");
    expect(seen?.["sec-fetch-site"]).toBe("same-origin");
    expect(seen?.["referer"]).toBeTruthy();
  });

  it("aborts an in-flight request when its signal fires", async () => {
    handler = () => {
      /* never responds → only the abort can settle it */
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    await expect(httpGet(`${base}/hang`, { signal: controller.signal })).rejects.toThrow(/Aborted/);
  });

  it("exposes status + headers + body with withResponse on 200", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { ETag: '"v1"' });
      res.end("body-here");
    };
    const r: HttpResponse = await httpGet(`${base}/ok`, { withResponse: true });
    expect(r.status).toBe(200);
    expect(r.body).toBe("body-here");
    expect(r.headers.etag).toBe('"v1"');
  });
});
