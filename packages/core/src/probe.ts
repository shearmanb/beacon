// URL probe for the dashboard's "add a site" flow: fetch a URL and guess which
// source recipe fits (Shopify REST, a Squarespace / password-wall status
// monitor, or unknown), returning a prefilled source spec + a human-readable
// explanation. Lives in core (not the web app) so it reuses the same anti-bot
// fetch layer the adapters use and stays testable alongside the engine.

import { httpGet, HttpError } from "@beacon/fetch";
import type { SourceKind, SourceSpec } from "./schema.js";

export interface ProbeResult {
  /** Suggested source kind, or null when nothing matched confidently. */
  kind: SourceKind | null;
  /** Human-readable explanation of what was detected. */
  detail: string;
  /** A prefilled source spec to seed the form (best guess). */
  source?: SourceSpec;
  /** Suggested display name (from <title> or hostname). */
  name?: string;
  /** Set when the URL was unusable / unreachable. */
  error?: string;
}

const WALL_SIGNALS = ["sqs-pw-form", "coming soon", "enter password", "password-protected"];

function suggestName(url: URL, html?: string): string {
  if (html) {
    const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (m && m[1]!.trim()) return m[1]!.trim().slice(0, 80);
  }
  const host = url.hostname.replace(/^www\./, "");
  const seg = url.pathname.split("/").filter(Boolean).pop();
  return seg ? `${host} — ${seg}` : host;
}

export async function probeSite(rawUrl: string): Promise<ProbeResult> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error("not http(s)");
  } catch {
    return { kind: null, detail: "", error: "Enter a full URL including https://" };
  }
  const origin = url.origin;
  const collectionMatch = url.pathname.match(/\/collections\/[^/]+/);
  const collectionPath = collectionMatch ? collectionMatch[0]!.replace(/^\//, "") : undefined;

  // 1) Shopify? products.json is the definitive tell.
  const probeUrl = `${origin}${collectionMatch ? collectionMatch[0] : ""}/products.json?limit=1`;
  try {
    const res = await httpGet(probeUrl, { withResponse: true });
    const json = JSON.parse(res.body) as { products?: unknown };
    if (Array.isArray(json.products)) {
      const n = json.products.length;
      return {
        kind: "shopify_rest",
        name: suggestName(url),
        detail:
          `Shopify store detected${collectionPath ? ` (collection “${collectionPath}”)` : ""}. ` +
          (n
            ? "Products are reachable via the public products.json API."
            : "The products.json API is reachable but currently returns 0 products."),
        source: {
          kind: "shopify_rest",
          baseUrl: origin,
          ...(collectionPath ? { collectionPath } : {}),
          conditionalGet: true,
        },
      };
    }
  } catch {
    // Not Shopify (or products.json blocked) — fall through to the HTML probe.
  }

  // 2) Fetch the page itself: Squarespace / password-wall → status monitor.
  try {
    const res = await httpGet(url.toString(), { withResponse: true });
    const html = res.body;
    const lower = html.toLowerCase();
    const isSquarespace = lower.includes("squarespace") || lower.includes("static1.squarespace.com");
    const wall = WALL_SIGNALS.find((s) => lower.includes(s));
    if (isSquarespace || wall) {
      return {
        kind: "http_status",
        name: suggestName(url, html),
        detail:
          `${isSquarespace ? "Squarespace site" : "Page"} detected` +
          (wall ? ` with a likely password / coming-soon wall (matched “${wall}”).` : ".") +
          " A status monitor fires site_reset once when the wall drops.",
        source: {
          kind: "http_status",
          url: url.toString(),
          blockedWhen: { bodyMatchesAny: ["sqs-pw-form", "coming soon", "enter password"], httpStatusIn: [401, 403] },
        },
      };
    }
    return {
      kind: null,
      name: suggestName(url, html),
      detail:
        `Page is reachable (HTTP ${res.status}) but isn’t recognizably Shopify or Squarespace. ` +
        "Pick a source kind manually — a 'custom' extractor (e.g. campari_v1) or a status monitor may fit.",
      source: {
        kind: "http_status",
        url: url.toString(),
        blockedWhen: { bodyMatchesAny: [], httpStatusIn: [401, 403] },
      },
    };
  } catch (err) {
    const code = err instanceof HttpError ? err.statusCode : undefined;
    if (code === 401 || code === 403) {
      return {
        kind: "http_status",
        name: suggestName(url),
        detail: `Page returned HTTP ${code} — likely an age / password wall. A status monitor fires when it opens.`,
        source: {
          kind: "http_status",
          url: url.toString(),
          blockedWhen: { bodyMatchesAny: [], httpStatusIn: [401, 403] },
        },
      };
    }
    return { kind: null, detail: "", error: `Couldn’t fetch that URL: ${(err as Error).message}` };
  }
}
