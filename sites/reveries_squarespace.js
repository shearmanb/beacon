import { https } from "../lib/fetch.js";

const SKIP_STRINGS = [
  "subscribe",
  "newsletter",
  "contact",
  "follow",
  "instagram",
  "shipping",
  "returns",
  "privacy",
  "terms",
  "about",
  "home",
  "abv:",
  "age:",
  "cooperage:",
  "tasting notes:",
  "distilled in",
  "bottled at",
  "matured in",
  "cask strength",
  "no coloring",
  "no filtering",
];

export async function checkSite(site, previousState) {
  const html = await https(site.url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  const titles = parseH4Titles(html);
  const productMap = buildProductMap(titles);
  const alerts = diff(previousState?.products ?? {}, productMap, site);

  return {
    state: {
      lastChecked: new Date().toISOString(),
      productCount: Object.keys(productMap).length,
      products: productMap,
    },
    alerts,
  };
}

function parseH4Titles(html) {
  const matches = html.matchAll(/<h4[^>]*>([\s\S]*?)<\/h4>/gi);
  const seen = new Set();
  const titles = [];

  for (const match of matches) {
    const raw = match[1].replace(/<[^>]+>/g, "").trim();
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (SKIP_STRINGS.some((s) => lower.includes(s))) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    titles.push(raw);
  }

  return titles;
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildProductMap(titles) {
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
      available: true,
      image: null,
      url: "https://www.thereveries.co/shop",
    };
  }
  return map;
}

function diff(previous, current, site) {
  const alerts = [];

  for (const [handle, product] of Object.entries(current)) {
    if (!previous[handle] && site.alertOnNewProduct) {
      alerts.push({ type: "new_product", product });
    }
  }

  return alerts;
}
