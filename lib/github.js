import { request } from "node:https";

const GH_TOKEN = process.env.GH_TOKEN;
const GH_REPO = process.env.GH_REPO;

function apiRequest(method, filePath, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.github.com",
      path: `/repos/${GH_REPO}/contents/${filePath}`,
      method,
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "beacon-worker/1.0",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(bodyStr
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(bodyStr) }
          : {}),
      },
    };

    const req = request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode === 404) { resolve(null); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub API ${res.statusCode} on ${filePath}: ${text.slice(0, 200)}`));
          return;
        }
        try { resolve(JSON.parse(text)); } catch { resolve(text); }
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error(`GitHub API timeout on ${filePath}`)));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

export async function readFile(filePath) {
  const data = await apiRequest("GET", filePath);
  if (!data) return { content: null, sha: null };
  const content = Buffer.from(data.content, "base64").toString("utf8");
  return { content, sha: data.sha };
}

// Returns the new blob SHA so callers can track it without a follow-up GET.
export async function writeFile(filePath, content, sha, message) {
  const data = await apiRequest("PUT", filePath, {
    message,
    content: Buffer.from(content).toString("base64"),
    sha,
  });
  return data?.content?.sha ?? null;
}
