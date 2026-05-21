import { https } from "../lib/fetch.js";

// Generic strategy for pages that aren't Shopify/Squarespace.
// Fetches raw HTML, searches for a watchText near an optional anchorText,
// and alerts when the extracted value changes.
//
// Site config fields (under `monitor: { ... }`):
//   anchorText   – narrow the search window to HTML near this string (e.g. "Gold Foil")
//   watchTexts   – ordered list; first match wins (e.g. ["ADD TO CART", "BUY", "SEE DETAILS"])
//   alertValues  – subset of watchTexts that count as "available / restock"
//   windowChars  – how many chars after the anchor to scan (default 3000)
//
// NOTE: Only works on server-side-rendered pages. JS-rendered SPAs will return
// a skeleton shell with no product content — use a dedicated API endpoint instead.

export async function checkSite(site, previousState) {
  const html = await https(site.url);
  const value = extractValue(html, site.monitor ?? {});
  const prevValue = previousState?.value ?? null;
  const alerts = [];

  if (prevValue !== null && value !== prevValue) {
    const { alertValues = [] } = site.monitor ?? {};
    const nowAvailable = alertValues.length
      ? alertValues.some(v => value?.toLowerCase().includes(v.toLowerCase()))
      : true;

    if (nowAvailable ? site.alertOnRestock : site.alertOnSoldOut) {
      alerts.push({
        type: nowAvailable ? "restock" : "sold_out",
        product: {
          title: `${site.name} — ${value ?? "unknown"}`,
          url: site.url,
          available: nowAvailable,
          vendor: null,
          minPrice: null,
          image: null,
          handle: site.id,
        },
      });
    }
  }

  return {
    state: {
      lastChecked: new Date().toISOString(),
      value,
      prevValue,
      products: {},
    },
    alerts,
  };
}

function extractValue(html, { anchorText, watchTexts = [], windowChars = 3000 }) {
  let slice = html;

  if (anchorText) {
    const idx = html.indexOf(anchorText);
    if (idx === -1) return null;
    // Scan starting slightly before the anchor to catch buttons that precede the title
    const start = Math.max(0, idx - 500);
    slice = html.slice(start, idx + windowChars);
  }

  // Strip tags so "ADD TO CART" isn't split by markup like ADD <span>TO</span> CART
  const text = slice.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

  for (const watch of watchTexts) {
    if (text.toLowerCase().includes(watch.toLowerCase())) return watch;
  }
  return null;
}
