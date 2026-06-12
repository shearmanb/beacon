import { request } from "node:https";
import { URL } from "node:url";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { randomFrom, jitter } from "./utils.js";

// Hard ceiling on total request time (headers + body + decompression). Guards
// against servers that send headers quickly then trickle or stall the body —
// the socket idle timeout resets on every byte received, so without a
// wall-clock deadline a slow body could hang indefinitely.
const REQUEST_DEADLINE_MS = 30_000;

// Bundled profiles keep UA and matching Sec-CH-UA headers consistent.
// Firefox and Safari don't send Sec-CH-UA, so those profiles omit those fields.
const BROWSER_PROFILES = [
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Sec-CH-UA": '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="99"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Sec-CH-UA": '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="99"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"macOS"',
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0",
  },
  {
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15",
  },
  {
    ua: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    "Sec-CH-UA": '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="99"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Linux"',
  },
  {
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0",
    "Sec-CH-UA": '"Chromium";v="136", "Microsoft Edge";v="136", "Not-A.Brand";v="99"',
    "Sec-CH-UA-Mobile": "?0",
    "Sec-CH-UA-Platform": '"Windows"',
  },
];

const ACCEPT_LANGUAGES = [
  "en-US,en;q=0.9",
  "en-US,en;q=0.8",
  "en-US,en;q=0.9,es;q=0.8",
  "en-GB,en;q=0.9,en-US;q=0.8",
  "en-US,en;q=0.7",
];

// One browser identity per hostname, held for 6–24 h. Re-rolling the profile
// on every request would mean the same IP presents a different browser every
// minute — itself a bot signature. A stable identity looks like a repeat
// visitor.
const hostIdentities = new Map();

function identityForHost(hostname) {
  const existing = hostIdentities.get(hostname);
  if (existing && Date.now() < existing.expiresAt) return existing;
  const identity = {
    profile: randomFrom(BROWSER_PROFILES),
    acceptLanguage: randomFrom(ACCEPT_LANGUAGES),
    expiresAt: Date.now() + jitter(15 * 3_600_000, 9 * 3_600_000), // 6–24 h
  };
  hostIdentities.set(hostname, identity);
  return identity;
}

// options:
//   headers      — extra/override request headers
//   withResponse — resolve { status, headers, body } instead of the body
//                  string; also makes 304 Not Modified a valid (non-error)
//                  outcome so callers can send If-None-Match/If-Modified-Since
export function https(url, options = {}, _visited = new Set(), _retries = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const identity = identityForHost(parsed.hostname);
    const { ua, ...chHeaders } = identity.profile;

    let req;
    let settled = false;
    const finish = (fn) => (val) => { if (settled) return; settled = true; fn(val); };
    const ok = finish(resolve);
    const fail = finish(reject);

    const deadline = setTimeout(() => {
      if (req) req.destroy(new Error(`Deadline exceeded fetching ${url}`));
      fail(new Error(`Deadline exceeded fetching ${url}`));
    }, REQUEST_DEADLINE_MS);
    const clearDeadline = () => clearTimeout(deadline);

    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": ua,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": identity.acceptLanguage,
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        ...chHeaders,
        ...options.headers,
      },
    };

    req = request(reqOptions, (res) => {
      if (res.statusCode === 304 && options.withResponse) {
        res.resume();
        clearDeadline();
        ok({ status: 304, headers: res.headers, body: "" });
        return;
      }

      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location;
        if (_visited.has(next)) { clearDeadline(); fail(new Error(`Redirect loop detected at ${next}`)); return; }
        _visited.add(url);
        res.resume();
        clearDeadline();
        https(next, options, _visited, _retries).then(ok, fail);
        return;
      }

      // Retry on rate-limit or temporary unavailability
      if ((res.statusCode === 429 || res.statusCode === 503) && _retries < 3) {
        let delay = Math.pow(2, _retries) * 1000; // 1s, 2s, 4s
        if (res.statusCode === 429) {
          const retryAfter = res.headers["retry-after"];
          if (retryAfter) {
            const secs = parseFloat(retryAfter);
            if (!isNaN(secs)) delay = secs * 1000;
          }
        }
        res.resume(); // drain to free the socket
        clearDeadline();
        setTimeout(() => https(url, options, _visited, _retries + 1).then(ok, fail), delay);
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        clearDeadline();
        res.resume();
        const err = new Error(`HTTP ${res.statusCode} for ${url}`);
        err.statusCode = res.statusCode; // worker uses this for 429/403 cooldowns
        fail(err);
        return;
      }

      const encoding = res.headers["content-encoding"];
      let stream = res;
      if (encoding === "gzip") stream = res.pipe(createGunzip());
      else if (encoding === "deflate") stream = res.pipe(createInflate());
      else if (encoding === "br") stream = res.pipe(createBrotliDecompress());

      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        clearDeadline();
        const body = Buffer.concat(chunks).toString("utf8");
        ok(options.withResponse ? { status: res.statusCode, headers: res.headers, body } : body);
      });
      stream.on("error", (err) => { clearDeadline(); fail(err); });
    });

    req.on("error", (err) => { clearDeadline(); fail(err); });
    req.setTimeout(15000, () => {
      req.destroy(new Error(`Socket idle timeout fetching ${url}`));
    });
    req.end();
  });
}

// ── Conditional request helpers ───────────────────────────────────────────────
// Strategies store { etag, lastModified } per site (httpValidators in state)
// and send them back so unchanged pages answer 304 with no body — less load
// on the store, and polite low-volume traffic is what doesn't get flagged.

export function conditionalHeaders(validators) {
  const headers = {};
  if (validators?.etag) headers["If-None-Match"] = validators.etag;
  if (validators?.lastModified) headers["If-Modified-Since"] = validators.lastModified;
  return headers;
}

export function extractValidators(headers) {
  const etag = headers?.etag ?? null;
  const lastModified = headers?.["last-modified"] ?? null;
  return etag || lastModified ? { etag, lastModified } : null;
}
