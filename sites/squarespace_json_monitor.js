import { https } from "../lib/fetch.js";
import { createHash } from "node:crypto";

// Strings that indicate the shop has been replaced with a holding page
const RESET_SIGNALS = [
  "coming soon",
  "enter password",
  "password protected",
  "this store is unavailable",
  "sqs-pw-form",
];

// Blunt change-detection strategy for Squarespace shops.
// Fetches ?format=json, fingerprints product titles + variant data, and fires
// a site_changed alert on any change — regardless of what changed.
// Complementary to reveries_squarespace which does structured per-product diffs.

export async function checkSite(site, previousState) {
  const alreadyInReset = previousState?.pageReset === true;
  const jsonUrl = site.url.includes("?")
    ? `${site.url}&format=json`
    : `${site.url}?format=json`;

  let text;
  try {
    text = await https(jsonUrl, {});
  } catch (err) {
    if (/^HTTP \d/.test(err.message)) {
      return handleReset(previousState, alreadyInReset, site, err.message);
    }
    throw err;
  }

  // Check for reset signals embedded in the JSON response body
  const lowerText = text.toLowerCase();
  const signal = RESET_SIGNALS.find((s) => lowerText.includes(s));
  if (signal) {
    return handleReset(previousState, alreadyInReset, site, `Reset signal: "${signal}"`);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Failed to parse Squarespace JSON response");
  }

  const items = (data?.collection?.items ?? data?.items ?? []).filter((i) => i.title);
  const currentTitles = items.map((i) => i.title).sort();

  // Stable fingerprint: sorted product titles + variant sold/stock/unlimited
  const fingerprint = items
    .map((item) => {
      const variants = (item.structuredContent?.variants ?? item.variants ?? [])
        .map((v) => ({ sold: v.sold, stock: v.stock, unlimited: v.unlimited }))
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return { title: item.title, variants };
    })
    .sort((a, b) => a.title.localeCompare(b.title));

  const hash = createHash("sha256")
    .update(JSON.stringify(fingerprint))
    .digest("hex")
    .slice(0, 16);

  const prevHash = previousState?.contentHash ?? null;
  const prevTitles = previousState?.titles ?? [];
  const alerts = [];

  if (prevHash !== null && hash !== prevHash) {
    const prevSet = new Set(prevTitles);
    const curSet = new Set(currentTitles);
    const added = currentTitles.filter((t) => !prevSet.has(t));
    const removed = prevTitles.filter((t) => !curSet.has(t));

    let note;
    if (added.length > 0 || removed.length > 0) {
      note = [
        ...added.map((t) => `Added: **${t}**`),
        ...removed.map((t) => `Removed: **${t}**`),
      ].join("\n");
    } else {
      note = `Content changed (${prevTitles.length}→${currentTitles.length} products, data updated)`;
    }

    console.log(`[${site.name}] Change detected (${prevHash} → ${hash}): ${note.replace(/\*\*/g, "")}`);

    alerts.push({
      type: "site_changed",
      product: {
        handle: site.id,
        title: site.name,
        url: site.url,
        available: true,
        vendor: null,
        minPrice: null,
        image: null,
        note,
      },
    });
  }

  return {
    state: {
      lastChecked: new Date().toISOString(),
      contentHash: hash,
      titles: currentTitles,
      productCount: currentTitles.length,
      pageReset: false,
      products: {},
    },
    alerts,
  };
}

function handleReset(previousState, alreadyInReset, site, reason) {
  console.log(`[${site.name}] Page reset detected: ${reason}`);
  return {
    state: {
      ...previousState,
      lastChecked: new Date().toISOString(),
      pageReset: true,
      resetReason: reason,
    },
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
              note: `Coming Soon page detected.\n_Detected: ${reason}_`,
            },
          },
        ],
  };
}
