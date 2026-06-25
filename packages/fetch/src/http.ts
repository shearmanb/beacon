// Browser-like GET with a wall-clock deadline, redirect handling, gzip/deflate/
// brotli decompression, and 429/503 retry with backoff. Ported from the
// original lib/fetch.js. The one deliberate change: the transport (node:http vs
// node:https) is chosen by URL protocol, so the same client serves http URLs
// (local tests, future proxy transports) instead of being hardwired to https.
//
// Headers are coherent with the REQUEST KIND (anti-bot polish, 2g/2h): a page
// navigation ("document") sends navigation Sec-Fetch-* + Upgrade-Insecure-
// Requests; a JSON/XHR call ("api", e.g. products.json) sends the fetch()-shaped
// Sec-Fetch-Dest: empty / Mode: cors set instead. Sending navigation headers on
// a JSON endpoint is itself a bot tell, so adapters pass kind: "api" for those.
//
// An optional AbortSignal lets a caller (the worker's per-site budget, 2c)
// cancel an in-flight request so one slow/blocked host can't starve the loop.

import { request as httpsRequest } from "node:https";
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type RequestOptions } from "node:http";
import { URL } from "node:url";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { identityForHost, type HostIdentity } from "./identity.js";

// Hard ceiling on total request time (headers + body + decompression). Guards
// against servers that send headers quickly then trickle or stall the body —
// the socket idle timeout resets on every byte received, so without a
// wall-clock deadline a slow body could hang indefinitely.
const REQUEST_DEADLINE_MS = 30_000;
const SOCKET_IDLE_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;

export type RequestKind = "document" | "api";

export interface HttpOptions {
  /** Extra/override request headers. */
  headers?: Record<string, string>;
  /**
   * When true, resolve { status, headers, body } instead of the body string,
   * and treat 304 Not Modified as a valid (non-error) outcome so callers can
   * send If-None-Match / If-Modified-Since.
   */
  withResponse?: boolean;
  /**
   * Shape the request headers like a page navigation ("document", default) or a
   * JSON/XHR fetch ("api"). Adapters hitting JSON endpoints (products.json) pass
   * "api" so the headers aren't incoherent with the request.
   */
  kind?: RequestKind;
  /** Cancel the request (and any in-flight redirect/retry) when this aborts. */
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, url: string) {
    super(`HTTP ${statusCode} for ${url}`);
    this.name = "HttpError";
    this.statusCode = statusCode; // callers use this for 429/403 cooldowns
  }
}

// Build a header set coherent with the request kind. A real browser sends a
// different Sec-Fetch-* / Accept profile for a top-level navigation vs a fetch()
// to a JSON API; mismatching them is a cheap bot signal. Sec-Fetch-Site is also
// context-aware: a root-path navigation is "none" (typed/bookmarked) with no
// Referer; a deeper page or any API call is "same-origin" with a Referer, i.e. a
// returning visitor clicking through the site (which is what polling looks like).
function buildHeaders(
  parsed: URL,
  identity: HostIdentity,
  kind: RequestKind,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const { ua, ...chHeaders } = identity.profile;
  const origin = parsed.origin;
  const common: Record<string, string> = {
    "User-Agent": ua,
    "Accept-Language": identity.acceptLanguage,
    "Accept-Encoding": "gzip, deflate, br",
    ...chHeaders,
  };

  if (kind === "api") {
    return {
      ...common,
      Accept: "application/json, text/plain, */*",
      Referer: `${origin}/`,
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      ...overrides,
    };
  }

  const isRoot = parsed.pathname === "/" || parsed.pathname === "";
  const navHeaders: Record<string, string> = {
    ...common,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": isRoot ? "none" : "same-origin",
    "Sec-Fetch-User": "?1",
  };
  if (!isRoot) navHeaders["Referer"] = `${origin}/`;
  return { ...navHeaders, ...overrides };
}

export function httpGet(url: string, options: HttpOptions & { withResponse: true }): Promise<HttpResponse>;
export function httpGet(url: string, options?: HttpOptions): Promise<string>;
export function httpGet(url: string, options: HttpOptions = {}): Promise<string | HttpResponse> {
  return _httpGet(url, options, new Set(), 0);
}

function _httpGet(
  url: string,
  options: HttpOptions,
  visited: Set<string>,
  retries: number,
): Promise<string | HttpResponse> {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) {
      reject(new Error(`Aborted fetching ${url}`));
      return;
    }

    const parsed = new URL(url);
    const identity = identityForHost(parsed.hostname);

    let req: ClientRequest | undefined;
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
      if (req) req.destroy(new Error(`Deadline exceeded fetching ${url}`));
      fail(new Error(`Deadline exceeded fetching ${url}`));
    }, REQUEST_DEADLINE_MS);
    const clearDeadline = (): void => clearTimeout(deadline);

    if (signal) {
      onAbort = () => {
        clearDeadline();
        if (req) req.destroy(new Error(`Aborted fetching ${url}`));
        fail(new Error(`Aborted fetching ${url}`));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const reqOptions: RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: buildHeaders(parsed, identity, options.kind ?? "document", options.headers),
    };

    const requestFn = parsed.protocol === "http:" ? httpRequest : httpsRequest;

    req = requestFn(reqOptions, (res) => {
      const status = res.statusCode ?? 0;

      if (status === 304 && options.withResponse) {
        res.resume();
        clearDeadline();
        ok({ status: 304, headers: res.headers, body: "" });
        return;
      }

      if (status >= 300 && status < 400 && res.headers.location) {
        const next = new URL(res.headers.location, url).toString();
        if (visited.has(next)) {
          clearDeadline();
          fail(new Error(`Redirect loop detected at ${next}`));
          return;
        }
        visited.add(url);
        res.resume();
        clearDeadline();
        cleanup(); // the recursive call re-registers its own abort listener
        _httpGet(next, options, visited, retries).then(ok, fail);
        return;
      }

      // Retry on rate-limit or temporary unavailability.
      if ((status === 429 || status === 503) && retries < MAX_RETRIES) {
        let delay = Math.pow(2, retries) * 1000; // 1s, 2s, 4s
        if (status === 429) {
          const retryAfter = res.headers["retry-after"];
          if (retryAfter) {
            const secs = parseFloat(Array.isArray(retryAfter) ? retryAfter[0]! : retryAfter);
            if (!Number.isNaN(secs)) delay = secs * 1000;
          }
        }
        res.resume(); // drain to free the socket
        clearDeadline();
        cleanup();
        setTimeout(() => _httpGet(url, options, visited, retries + 1).then(ok, fail), delay);
        return;
      }

      if (status < 200 || status >= 300) {
        clearDeadline();
        res.resume();
        fail(new HttpError(status, url));
        return;
      }

      const encoding = res.headers["content-encoding"];
      let stream: NodeJS.ReadableStream = res;
      if (encoding === "gzip") stream = res.pipe(createGunzip());
      else if (encoding === "deflate") stream = res.pipe(createInflate());
      else if (encoding === "br") stream = res.pipe(createBrotliDecompress());

      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        clearDeadline();
        const body = Buffer.concat(chunks).toString("utf8");
        ok(options.withResponse ? { status, headers: res.headers, body } : body);
      });
      stream.on("error", (err: Error) => {
        clearDeadline();
        fail(err);
      });
    });

    req.on("error", (err) => {
      clearDeadline();
      fail(err);
    });
    req.setTimeout(SOCKET_IDLE_TIMEOUT_MS, () => {
      req?.destroy(new Error(`Socket idle timeout fetching ${url}`));
    });
    req.end();
  });
}
