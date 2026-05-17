import { request } from "node:https";
import { URL } from "node:url";

export function https(url, options = {}, _visited = new Set()) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "GET",
      headers: {
        "User-Agent": "Beacon/1.0 (+https://github.com/shearmanb/beacon)",
        Accept: "application/json, text/html",
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

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error(`Timeout fetching ${url}`));
    });
    req.end();
  });
}
