// Conditional-request helpers. Strategies store { etag, lastModified } per site
// (httpValidators in state) and send them back so unchanged pages answer 304
// with no body — less load on the store, and polite low-volume traffic is what
// doesn't get flagged.

import type { IncomingHttpHeaders } from "node:http";

export interface HttpValidators {
  etag: string | null;
  lastModified: string | null;
}

export function conditionalHeaders(validators: HttpValidators | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (validators?.etag) headers["If-None-Match"] = validators.etag;
  if (validators?.lastModified) headers["If-Modified-Since"] = validators.lastModified;
  return headers;
}

export function extractValidators(headers: IncomingHttpHeaders | undefined): HttpValidators | null {
  const etag = headers?.etag ?? null;
  const lastModified = headers?.["last-modified"] ?? null;
  return etag || lastModified ? { etag, lastModified } : null;
}
