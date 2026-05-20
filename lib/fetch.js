import { request } from "node:https";
import { URL } from "node:url";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
];

const ACCEPT_LANGUAGES = [
  "en-US,en;q=0.9",
  "en-US,en;q=0.8",
  "en-US,en;q=0.9,es;q=0.8",
  "en-GB,en;q=0.9,en-US;q=0.8",
  "en-US,en;q=0.7",
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function https(url, options = {}, _visited = new Set()) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": randomFrom(USER_AGENTS),
        Accept: "application/json, text/html;q=0.9, */*;q=0.8",
        "Accept-Language": randomFrom(ACCEPT_LANGUAGES),
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        ...options.headers,
      },
    };

    const req = request(reqOptions, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location;
        if (_visited.has(next)) { reject(new Error(`Redirect loop detected at ${next}`)); return; }
        _visited.add(url);
        resolve(https(next, options, _visited));
        return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }

      const encoding = res.headers["content-encoding"];
      let stream = res;
      if (encoding === "gzip") stream = res.pipe(createGunzip());
      else if (encoding === "deflate") stream = res.pipe(createInflate());
      else if (encoding === "br") stream = res.pipe(createBrotliDecompress());

      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      stream.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error(`Timeout fetching ${url}`));
    });
    req.end();
  });
}
