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

  // ── 2. Always fetch HTML when JSON API gave us products ──────────────────────
  // The Squarespace JSON API variant data is unreliable for this shop — it can
  // return wrong stock status even when products are purchasable on the page.
  // Squarespace reliably marks sold-out products with ProductItem--sold-out on the
  // <article> element, so we always parse HTML to override availability.
  // This also handles reset detection and transient-empty checks in one fetch.
  if (productMap !== null) {
    let html = null;
    try {
      html = await https(site.url, {});
    } catch (htmlErr) {
      console.log(`[${site.name}] HTML fetch failed (${htmlErr.message})`);
    }

    if (html !== null) {
      const lower = html.toLowerCase();
      const signal = RESET_SIGNALS.find((s) => lower.includes(s));

      if (signal) {
        resetReason = `Reset signal in HTML: "${signal}"`;
        productMap = null;
      } else if (Object.keys(productMap).length === 0 && Object.keys(prevProducts).length > 0) {
        console.log(`[${site.name}] JSON API returned 0 products but HTML looks normal — preserving previous state`);
        productMap = prevProducts;
      } else {
        // Override availability (and fill in images/URLs) from HTML
        applyHtmlAvailability(html, productMap, site.url, site.name);
      }
    } else if (Object.keys(productMap).length === 0 && Object.keys(prevProducts).length > 0) {
      console.log(`[${site.name}] JSON API empty + HTML fetch failed — preserving previous state`);
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
      // Only alert once — not every 5-min check while it stays in reset
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

    // Variants carry stock info; fall back gracefully if absent.
    // NOTE: availability from variants is unreliable for some shops and will be
    // overridden by applyHtmlAvailability() after this fetch.
    const variants = item.structuredContent?.variants ?? item.variants ?? [];
    let available;
    if (variants.length === 0) {
      available = true; // unknown — assume available; HTML will correct if wrong
    } else {
      // sold===false is authoritative: Squarespace explicitly marks it as not sold out,
      // regardless of stock count (stock:0 + sold:false = still purchasable)
      available = variants.some(
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
    const fullUrl = item.fullUrl ? `${baseOrigin}${item.fullUrl}` : url;

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

// ── HTML availability override ────────────────────────────────────────────────
// Squarespace renders sold-out products with `ProductItem--sold-out` on the
// <article> element. We parse each product article block, match it to a known
// product by title keywords, and set availability accordingly.
// Also fills in image and product URL when the JSON API didn't provide them.
function applyHtmlAvailability(html, productMap, siteUrl, siteName) {
  // Strip scripts/styles so we don't match class names inside JS strings
  const cleanHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "");

  const baseOrigin = new URL(siteUrl).origin;
  let applied = 0;

  for (const match of cleanHtml.matchAll(/<article([^>]*)>([\s\S]*?)<\/article>/gi)) {
    const [, attrs, content] = match;
    if (!/productitem/i.test(attrs)) continue;

    const soldOut = /productitem--sold-out/i.test(attrs);

    // Plain text of this article (for title matching)
    const text = content
      .replace(/<[^>]+>/g, " ")
      .replace(/&quot;/g, '"')
      .replace(/&#8220;/g, "“")
      .replace(/&#8221;/g, "”")
      .replace(/&amp;/g, "&")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/\s+/g, " ")
      .toLowerCase()
      .trim();

    // Image: prefer data-src (lazy-load) then src
    const imgMatch =
      content.match(/<img[^>]+data-src="([^"]+)"/i) ??
      content.match(/<img[^>]+src="(https?[^"]+)"/i);
    const imageUrl = imgMatch?.[1] ?? null;

    // Product page link (relative path under /shop or /products)
    const linkMatch =
      content.match(/href="(\/shop\/[^"?#]+)"/i) ??
      content.match(/href="(\/products\/[^"?#]+)"/i);
    const productPath = linkMatch?.[1] ?? null;

    // Match article to a product by scoring title-word overlap.
    // Using best-match (highest score) avoids false matches when common words
    // like "REVERIES" or "YEAR" appear in every product title.
    let bestProduct = null;
    let bestScore = 0;

    for (const product of Object.values(productMap)) {
      const words = product.title
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 4)
        .map((w) => w.toLowerCase());

      const score = words.filter((w) => text.includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        bestProduct = product;
      }
    }

    if (bestProduct && bestScore >= 1) {
      bestProduct.available = !soldOut;
      if (imageUrl && !bestProduct.image) bestProduct.image = imageUrl;
      if (productPath && bestProduct.url === siteUrl) {
        bestProduct.url = `${baseOrigin}${productPath}`;
      }
      applied++;
    }
  }

  if (applied > 0) {
    console.log(`  [${siteName}] HTML availability applied to ${applied} product(s)`);
  } else {
    // No <article class="ProductItem"> found — HTML structure may differ.
    // JSON API availability is kept as-is.
    console.log(`  [${siteName}] No ProductItem article blocks found in HTML — keeping JSON API availability`);
  }
}

// ── HTML fallback (when JSON API is completely unavailable) ───────────────────
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
      available: true, // HTML h4 fallback can't determine stock; assume listed = available
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
