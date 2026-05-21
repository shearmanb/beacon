import { https } from "../lib/fetch.js";

// Strings that indicate the shop has been replaced with a holding page
const RESET_SIGNALS = [
  "coming soon",
  "enter password",
  "password protected",
  "this store is unavailable",
  "sqs-pw-form",            // Squarespace password-page CSS class
];

// Fallback HTML parser: skip lines that are product details, not titles
const SKIP_STRINGS = [
  "subscribe", "newsletter", "contact", "follow", "instagram",
  "shipping", "returns", "privacy", "terms", "about", "home",
  "abv:", "% abv", "age:", "years aged", "year aged",
  "cooperage:", "tasting notes:", "tasting note:",
  "distilled in", "bottled at", "matured in",
  "cask strength", "no coloring", "no filtering",
  "do you understand", "limit 1", "multiple or irregular",
];

export async function checkSite(site, previousState) {
  const prevProducts = previousState?.products ?? {};
  const alreadyInReset = previousState?.pageReset === true;

  // ── 1. Try Squarespace JSON API ──────────────────────────────────────────────
  let productMap = null;
  let resetReason = null;

  try {
    productMap = await fetchJsonProducts(site.url);
  } catch (err) {
    // Non-2xx (password wall, 401, etc.) → reset signal
    if (/^HTTP \d/.test(err.message)) {
      resetReason = err.message;
    } else {
      // JSON parse failed or network issue — try HTML fallback
      try {
        const html = await https(site.url, {});
        const lower = html.toLowerCase();
        const signal = RESET_SIGNALS.find((s) => lower.includes(s));
        if (signal) {
          resetReason = `Reset signal in HTML: "${signal}"`;
        } else {
          productMap = parseHtmlProducts(html);
        }
      } catch (htmlErr) {
        resetReason = htmlErr.message;
      }
    }
  }

  // ── 2. Empty result when we had products before → verify via HTML before declaring reset ──────
  // The JSON API can transiently return 0 items (rate limit, API hiccup) even when the shop is
  // live. Only treat as a real reset if the HTML also shows a reset signal; otherwise preserve
  // the previous product list and log a warning.
  if (
    productMap !== null &&
    Object.keys(productMap).length === 0 &&
    Object.keys(prevProducts).length > 0
  ) {
    try {
      const html = await https(site.url, {});
      const lower = html.toLowerCase();
      const signal = RESET_SIGNALS.find((s) => lower.includes(s));
      if (signal) {
        resetReason = `Reset signal in HTML: "${signal}"`;
        productMap = null;
      } else {
        // Site is live and shows no reset signals — likely a transient empty API response.
        // Preserve previous products so we don't lose state on a blip.
        console.log(`[${site.name}] JSON API returned 0 products but HTML looks normal — preserving previous state`);
        productMap = prevProducts;
      }
    } catch (htmlErr) {
      // Can't reach the site at all — treat conservatively: don't declare reset on a network error,
      // just preserve the previous state and wait for the next check.
      console.log(`[${site.name}] JSON API empty + HTML fetch failed (${htmlErr.message}) — preserving previous state`);
      productMap = prevProducts;
    }
  }

  // ── 3. Handle reset ──────────────────────────────────────────────────────────
  if (resetReason !== null) {
    console.log(`[${site.name}] Page reset detected: ${resetReason}`);
    return {
      state: {
        ...previousState,
        lastChecked: new Date().toISOString(),
        pageReset: true,
        resetReason,
      },
      // Only alert once — not every 30-min check while it stays in reset
      alerts: alreadyInReset
        ? []
        : [
            {
              type: "site_reset",
              product: {
                title: site.name,
                url: site.url,
                vendor: null,
                minPrice: null,
                available: false,
                image: null,
                note: `Coming Soon page detected — new bottles expected in 2–14 days.\n_Detected: ${resetReason}_`,
              },
            },
          ],
    };
  }

  // ── 4. Normal diff ───────────────────────────────────────────────────────────
  const alerts = diff(prevProducts, productMap, site);

  return {
    state: {
      lastChecked: new Date().toISOString(),
      productCount: Object.keys(productMap).length,
      products: productMap,
      pageReset: false,
    },
    alerts,
  };
}

// ── Squarespace JSON API ──────────────────────────────────────────────────────
async function fetchJsonProducts(url) {
  const jsonUrl = url.includes("?") ? `${url}&format=json` : `${url}?format=json`;
  const text = await https(jsonUrl, {});
  const data = JSON.parse(text);

  const items = data?.collection?.items ?? data?.items ?? [];
  if (!Array.isArray(items)) throw new Error("Unexpected JSON structure from Squarespace");

  const map = {};
  for (const item of items) {
    if (!item.title) continue;
    const handle = slugify(item.title);

    // Variants carry stock info; fall back gracefully if absent
    const variants =
      item.structuredContent?.variants ?? item.variants ?? [];

    let available;
    if (variants.length === 0) {
      available = true; // unknown — assume available
    } else {
      available = variants.some(
        // sold===false is authoritative: Squarespace explicitly marks it as not sold out,
        // regardless of stock count (stock:0 + sold:false = still purchasable in Squarespace)
        (v) => v.unlimited || v.sold === false || (v.sold == null && (v.stock == null || v.stock > 0))
      );
    }

    const cents = variants[0]?.price ?? null;
    const minPrice = cents != null ? Math.round(cents) / 100 : null;

    const image =
      item.assetUrl ??
      item.thumbnail?.imageUrl ??
      item.mainImage?.imageUrl ??
      null;

    const baseOrigin = new URL(url).origin;
    const fullUrl = item.fullUrl
      ? `${baseOrigin}${item.fullUrl}`
      : url;

    map[handle] = {
      handle,
      title: item.title,
      vendor: "The Reveries",
      productType: "Whiskey",
      tags: [],
      minPrice,
      available,
      image,
      url: fullUrl,
    };
  }

  return map;
}

// ── HTML fallback ─────────────────────────────────────────────────────────────
function parseHtmlProducts(html) {
  const matches = html.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/gi);
  const seen = new Set();
  const titles = [];

  for (const match of matches) {
    const raw = match[1].replace(/<[^>]+>/g, "").trim();
    if (!raw || raw.length < 10) continue;
    const lower = raw.toLowerCase();
    if (SKIP_STRINGS.some((s) => lower.includes(s))) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    titles.push(raw);
  }

  const map = {};
  for (const title of titles) {
    const handle = slugify(title);
    map[handle] = {
      handle,
      title,
      vendor: "The Reveries",
      productType: "Whiskey",
      tags: [],
      minPrice: null,
      available: true, // HTML can't determine stock; assume listed = available
      image: null,
      url: "https://www.thereveries.co/shop",
    };
  }
  return map;
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function diff(previous, current, site) {
  const alerts = [];

  for (const [handle, product] of Object.entries(current)) {
    if (!previous[handle]) {
      if (site.alertOnNewProduct) alerts.push({ type: "new_product", product });
    } else if (!previous[handle].available && product.available) {
      if (site.alertOnRestock) alerts.push({ type: "restock", product });
    } else if (previous[handle].available && !product.available) {
      if (site.alertOnSoldOut) alerts.push({ type: "sold_out", product });
    }
  }

  return alerts;
}
