// Minimal POST companion to httpGet, for JSON APIs (Shopify Storefront GraphQL,
// Discord webhooks). Unlike httpGet it sends no browser identity and no
// Accept-Encoding (API responses are small JSON), keeping it simple. Shares the
// wall-clock deadline + socket-idle-timeout discipline and the HttpError type.

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { URL } from "node:url";
import { HttpError, type HttpResponse } from "./http.js";

const REQUEST_DEADLINE_MS = 30_000;
const SOCKET_IDLE_TIMEOUT_MS = 15_000;

export interface PostOptions {
  headers?: Record<string, string>;
  /** When true (default), reject non-2xx with HttpError; otherwise resolve it. */
  throwOnHttpError?: boolean;
  /** Cancel the request when this aborts (shared per-site budget, 2c). */
  signal?: AbortSignal;
}

export function httpPost(url: string, body: string, options: PostOptions = {}): Promise<HttpResponse> {
  const throwOnHttpError = options.throwOnHttpError ?? true;
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) {
      reject(new Error(`Aborted posting ${url}`));
      return;
    }
    const parsed = new URL(url);

    let settled = false;
    let onAbort: (() => void) | undefined;
    const cleanup = (): void => {
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
    };
    const finish =
      <T>(fn: (val: T) => void) =>
      (val: T): void => {
        if (settled) return;
        settled = true;
        cleanup();
        fn(val);
      };
    const ok = finish(resolve);
    const fail = finish(reject);

    const deadline = setTimeout(() => {
      req.destroy(new Error(`Deadline exceeded posting ${url}`));
      fail(new Error(`Deadline exceeded posting ${url}`));
    }, REQUEST_DEADLINE_MS);
    const clearDeadline = (): void => clearTimeout(deadline);

    const requestFn = parsed.protocol === "http:" ? httpRequest : httpsRequest;
    const req = requestFn(
      {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Accept: "application/json",
          ...options.headers,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          clearDeadline();
          const text = Buffer.concat(chunks).toString("utf8");
          if (throwOnHttpError && (status < 200 || status >= 300)) {
            fail(new HttpError(status, url));
            return;
          }
          ok({ status, headers: res.headers, body: text });
        });
        res.on("error", (err: Error) => {
          clearDeadline();
          fail(err);
        });
      },
    );

    req.on("error", (err) => {
      clearDeadline();
      fail(err);
    });
    req.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`Socket idle timeout posting ${url}`));
    });
    if (signal) {
      onAbort = () => {
        clearDeadline();
        req.destroy(new Error(`Aborted posting ${url}`));
        fail(new Error(`Aborted posting ${url}`));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    req.write(body);
    req.end();
  });
}
