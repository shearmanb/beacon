// Purchasable-state monitor for server-rendered brand product pages (the
// Campari "campari-wdf" WordPress theme — Wild Turkey, Russell's Reserve, etc.).
//
// These pages list products as cards whose call-to-action is the availability
// signal: an info label ("See details" on Wild Turkey, "Discover more" on
// Russell's Reserve) means *not buyable*; "Add to cart" / "Buy now" means the
// release has gone on sale. We map buyable → available:true and reuse the shared
// diff(), so a card flipping info → buyable surfaces as a `restock` and a newly
// listed card as a `new_product`.
//
// The two sites use DIFFERENT card templates (el_box/el-title vs
// bb_posts_grid__item), so the parser anchors on the CTA anchor — any
// <a class="…sn_btn…"> whose href is a product-detail URL
// (/products/<slug>/ or /our-products/<slug>/) — and reads the nearest preceding
// <h3> as the title. That's template-agnostic and structurally excludes the
// page's non-product sn_btns (nav, cocktails CTA, age-gate buttons, cart
// checkout, global "Buy now" with href="javascript:;").
//
// HTTP errors (incl. 401/403 from an Incapsula/age wall) are left to throw so
// the worker's normal error path handles them (consecutiveErrors → site_error,
// plus the 429/403 circuit breaker). site.requestHeaders, if present, is merged
// into the request — a future escape hatch for an age/Incapsula cookie.

import { https, conditionalHeaders, extractValidators } from "../lib/fetch.js";
import { diff } from "../lib/diff.js";
import { emptyFetchGuard } from "../lib/empty_guard.js";

// Buyable iff a purchase phrase is present and no info/unavailable phrase is.
const PURCHASE_SIGNALS = /\b(?:add to (?:cart|bag)|buy now|buy online|shop now|order now|pre-?order)\b/i;
const INFO_SIGNALS = /\b(?:see details|discover more|where to buy|learn more|notify me|coming soon|sold out|out of stock|read more)\b/i;

function decodeEntities(s) {
  return s
    .replace(/&#0*38;|&amp;/gi, "&")
    .replace(/&#0*39;|&apos;|&rsquo;|&#8217;/gi, "'")
    .replace(/&quot;|&#0*34;/gi, '"')
    .replace(/&nbsp;|&#0*160;/gi, " ")
    .replace(/&#8211;|&ndash;/gi, "–")
    .replace(/&#8212;|&mdash;/gi, "—");
}

// Strip inner tags, decode the handful of entities these pages use, normalize
// curly apostrophes to straight (so titleContains:["Master's"] matches whether
// the page used ' or ’), and collapse whitespace.
function cleanText(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns { slug, url } when href is a product-detail page, else null. The slug
// must be the final path segment so the bare listing (/our-products/) and the
// cocktails page (/bourbon-cocktails/) don't match.
function productSlug(href, baseUrl) {
  if (!href) return null;
  let u;
  try { u = new URL(href, baseUrl || "https://example.com"); } catch { return null; }
  const m = u.pathname.match(/\/(?:our-products|products)\/([^/?#]+)\/?$/i);
  if (!m) return null;
  const slug = m[1];
  if (!slug || slug.toLowerCase() === "products" || slug.toLowerCase() === "our-products") return null;
  return { slug, url: u.href };
}

// Pulls product names+urls from a JSON-LD CollectionPage→ItemList, if present.
// Catches staged pages (e.g. a password-"Protected:" entry) that exist in the
// schema before they appear in the visible grid.
function collectionSchemaItems(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const nodes = Array.isArray(data) ? data : (Array.isArray(data["@graph"]) ? data["@graph"] : [data]);
    for (const node of nodes) {
      if (!node || node["@type"] !== "CollectionPage") continue;
      const els = node.mainEntity?.itemListElement;
      if (!Array.isArray(els)) continue;
      for (const el of els) {
        if (el?.url && el?.name) out.push({ url: el.url, name: String(el.name) });
      }
    }
  }
  return out;
}

// Pure HTML → product map. Exported so the dashboard Sandbox can port it and the
// worker path stays the single source of truth for the parsing rules.
export function parseProductCards(html, opts = {}) {
  const {
    baseUrl,
    vendorName = null,
    titleContains = [],
    titleExcludes = [],
    useCollectionSchema = false,
  } = opts;

  // The JSON-LD overlay reads <script> from the RAW html (below). For the
  // visual-card scan, strip comments/scripts/styles first so a stray <a>/<h3>
  // inside an HTML comment or an inline script (WordPress pages are full of
  // both) can't masquerade as — or swallow — a real product card.
  const schemaItems = useCollectionSchema ? collectionSchemaItems(html) : [];
  const dom = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");

  // Index every <h3> so each CTA can resolve its nearest preceding title.
  const h3s = [];
  const h3re = /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi;
  let hm;
  while ((hm = h3re.exec(dom)) !== null) {
    h3s.push({ index: hm.index, text: cleanText(hm[1]) });
  }
  const titleBefore = (pos) => {
    let best = null;
    for (const h of h3s) {
      if (h.index >= pos) break;     // h3s are in document order
      if (h.text) best = h.text;     // nearest non-empty <h3> before the CTA
    }
    return best;
  };

  const map = new Map();

  // Scan sn_btn anchors that point at a product-detail URL.
  const are = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  let am;
  while ((am = are.exec(dom)) !== null) {
    const attrs = am[1];
    const cls = attrs.match(/class\s*=\s*["']([^"']*)["']/i);
    if (!cls || !/\bsn_btn\b/.test(cls[1])) continue;
    const hrefM = attrs.match(/href\s*=\s*["']([^"']*)["']/i);
    if (!hrefM) continue;
    const slugInfo = productSlug(hrefM[1], baseUrl);
    if (!slugInfo || map.has(slugInfo.slug)) continue; // de-dup; first (listing) wins over carousel
    const cta = cleanText(am[2]);
    map.set(slugInfo.slug, {
      handle: slugInfo.slug,
      title: titleBefore(am.index) ?? slugInfo.slug,
      vendor: vendorName,
      minPrice: null,
      available: PURCHASE_SIGNALS.test(cta) && !INFO_SIGNALS.test(cta),
      image: null,
      url: slugInfo.url,
    });
  }

  // Optional roster overlay: add schema items not already seen in the grid as
  // not-yet-buyable (available:false). A grid CTA always wins on availability.
  if (useCollectionSchema) {
    for (const item of schemaItems) {
      const slugInfo = productSlug(item.url, baseUrl);
      if (!slugInfo || map.has(slugInfo.slug)) continue;
      const title = decodeEntities(item.name).replace(/^\s*Protected:\s*/i, "").trim();
      map.set(slugInfo.slug, {
        handle: slugInfo.slug,
        title: title || slugInfo.slug,
        vendor: vendorName,
        minPrice: null,
        available: false,
        image: null,
        url: slugInfo.url,
      });
    }
  }

  // Title filters (case-insensitive), mirroring shopify_collection.applyFilters.
  let list = [...map.values()];
  if (titleContains.length) {
    list = list.filter((p) => titleContains.some((t) => p.title.toLowerCase().includes(t.toLowerCase())));
  }
  if (titleExcludes.length) {
    list = list.filter((p) => !titleExcludes.some((t) => p.title.toLowerCase().includes(t.toLowerCase())));
  }

  const out = {};
  for (const p of list) out[p.handle] = p;
  return out;
}

export async function checkSite(site, previousState) {
  const validators = previousState?.httpValidators ?? null;
  const res = await https(site.url, {
    withResponse: true,
    headers: { ...conditionalHeaders(validators), ...(site.requestHeaders || {}) },
  });

  // 304: page byte-identical to last check — previous state stands.
  if (res.status === 304) {
    return {
      state: { ...previousState, lastChecked: new Date().toISOString() },
      alerts: [],
    };
  }

  const prevProducts = previousState?.products ?? {};
  const productMap = parseProductCards(res.body, {
    baseUrl: site.url,
    vendorName: site.name,
    titleContains: site.filters?.titleContains ?? [],
    titleExcludes: site.filters?.titleExcludes ?? [],
    useCollectionSchema: site.useCollectionSchema === true,
  });

  // Parsed nothing while state holds products → preserve state and, after 3
  // consecutive empties, fire one site_reset (template changed / page blocked).
  if (Object.keys(productMap).length === 0) {
    const guarded = emptyFetchGuard({
      site,
      previousState,
      prevProducts,
      threshold: 3,
      note:
        `Parsed 0 product cards on 3 consecutive checks. Previous products are ` +
        `preserved. The page template may have changed, or the site may be ` +
        `blocking the fetch (e.g. Incapsula / age wall).`,
    });
    if (guarded) return guarded;
  }

  const alerts = diff(prevProducts, productMap, site);

  return {
    state: {
      lastChecked: new Date().toISOString(),
      productCount: Object.keys(productMap).length,
      products: productMap,
      httpValidators: extractValidators(res.headers),
    },
    alerts,
  };
}
