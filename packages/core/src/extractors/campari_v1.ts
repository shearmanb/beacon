// campari_v1 — faithful port of sites/purchasable_state_monitor.js's
// parseProductCards. Server-rendered Campari "campari-wdf" WordPress pages (Wild
// Turkey, Russell's Reserve) list products as cards whose CTA text is the
// availability signal: "Add to cart"/"Buy now" => buyable (available:true);
// "See details"/"Discover more" => info-only (available:false).
//
// This lives behind the `custom` escape hatch (not the declarative html adapter)
// because it needs imperative logic: "nearest preceding <h3>" by document index,
// entity + curly-apostrophe normalization, and a JSON-LD overlay merged UNDER
// grid availability. Title filtering is intentionally NOT done here — the shared
// pipeline applies site.filters after extraction.

import type { NormalizedProduct } from "@beacon/shared";
import type { CustomExtractor, ExtractorContext, ExtractorOutput } from "./types.js";

// Buyable iff a purchase phrase is present and no info/unavailable phrase is.
// Kept deliberately broad on the purchase side (limited drops route to varied
// CTAs — "Buy", "Purchase", "Add to basket", an off-site "Buy on …") and gated
// by INFO_SIGNALS, which always wins, so "Where to buy" can't read as buyable.
const PURCHASE_SIGNALS =
  /\b(?:add to (?:cart|bag|basket)|buy(?: now| online| it(?: now)?)?|purchase|shop now|order now|pre-?order|get yours)\b/i;
const INFO_SIGNALS =
  /\b(?:see details|discover more|where to (?:buy|find)|learn more|notify me|coming soon|sold out|out of stock|read more|wait\s?list|join the list|raffle|enter to win|store locator|find a store|back (?:soon|in stock)|register)\b/i;

function decodeEntities(s: string): string {
  return s
    .replace(/&#0*38;|&amp;/gi, "&")
    .replace(/&#0*39;|&apos;|&rsquo;|&#8217;/gi, "'")
    .replace(/&quot;|&#0*34;/gi, '"')
    .replace(/&nbsp;|&#0*160;/gi, " ")
    .replace(/&#8211;|&ndash;/gi, "–")
    .replace(/&#8212;|&mdash;/gi, "—");
}

// Strip inner tags, decode entities, normalize curly apostrophes to straight (so
// titleContains:["Master's"] matches whether the page used ' or ’), collapse ws.
function cleanText(s: string): string {
  return decodeEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Returns { slug, url } when href is a product-detail page, else null. The slug
// must be the final path segment so the bare listing (/our-products/) and the
// cocktails page (/bourbon-cocktails/) don't match.
function productSlug(href: string | undefined, baseUrl: string): { slug: string; url: string } | null {
  if (!href) return null;
  let u: URL;
  try {
    u = new URL(href, baseUrl || "https://example.com");
  } catch {
    return null;
  }
  const m = u.pathname.match(/\/(?:our-products|products)\/([^/?#]+)\/?$/i);
  if (!m) return null;
  const slug = m[1];
  if (!slug || slug.toLowerCase() === "products" || slug.toLowerCase() === "our-products") return null;
  return { slug, url: u.href };
}

// Pulls product names+urls from a JSON-LD CollectionPage->ItemList, if present.
// Catches staged pages (e.g. a password-"Protected:" entry) that exist in the
// schema before they appear in the visible grid.
function collectionSchemaItems(html: string): Array<{ url: string; name: string }> {
  const out: Array<{ url: string; name: string }> = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let data: unknown;
    try {
      data = JSON.parse(m[1]!.trim());
    } catch {
      continue;
    }
    const nodes = Array.isArray(data)
      ? data
      : Array.isArray((data as Record<string, unknown>)?.["@graph"])
        ? ((data as Record<string, unknown>)["@graph"] as unknown[])
        : [data];
    for (const node of nodes as Array<Record<string, unknown>>) {
      if (!node || node["@type"] !== "CollectionPage") continue;
      const els = (node["mainEntity"] as Record<string, unknown> | undefined)?.["itemListElement"];
      if (!Array.isArray(els)) continue;
      for (const el of els as Array<Record<string, unknown>>) {
        if (el?.["url"] && el?.["name"]) out.push({ url: String(el["url"]), name: String(el["name"]) });
      }
    }
  }
  return out;
}

export interface CampariOptions {
  useCollectionSchema?: boolean;
}

/** Pure HTML -> NormalizedProduct[]. The shared pipeline filters afterward. */
export function parseCampariCards(
  html: string,
  opts: { baseUrl: string; vendorName?: string | null; useCollectionSchema?: boolean },
): NormalizedProduct[] {
  const { baseUrl, vendorName = null, useCollectionSchema = false } = opts;

  // The JSON-LD overlay reads <script> from the RAW html. For the visual-card
  // scan, strip comments/scripts/styles first so a stray <a>/<h3> inside a
  // comment or inline script can't masquerade as — or swallow — a product card.
  const schemaItems = useCollectionSchema ? collectionSchemaItems(html) : [];
  const dom = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ");

  // Index every <h3> so each CTA can resolve its nearest preceding title.
  const h3s: Array<{ index: number; text: string }> = [];
  const h3re = /<h3\b[^>]*>([\s\S]*?)<\/h3>/gi;
  let hm: RegExpExecArray | null;
  while ((hm = h3re.exec(dom)) !== null) {
    h3s.push({ index: hm.index, text: cleanText(hm[1]!) });
  }
  const titleBefore = (pos: number): string | null => {
    let best: string | null = null;
    for (const h of h3s) {
      if (h.index >= pos) break; // h3s are in document order
      if (h.text) best = h.text; // nearest non-empty <h3> before the CTA
    }
    return best;
  };

  const map = new Map<string, NormalizedProduct>();

  // Scan sn_btn anchors that point at a product-detail URL.
  const are = /<a\b([^>]*?)>([\s\S]*?)<\/a>/gi;
  let am: RegExpExecArray | null;
  while ((am = are.exec(dom)) !== null) {
    const attrs = am[1]!;
    const cls = attrs.match(/class\s*=\s*["']([^"']*)["']/i);
    if (!cls || !/\bsn_btn\b/.test(cls[1]!)) continue;
    const hrefM = attrs.match(/href\s*=\s*["']([^"']*)["']/i);
    if (!hrefM) continue;
    const slugInfo = productSlug(hrefM[1], baseUrl);
    if (!slugInfo || map.has(slugInfo.slug)) continue; // de-dup; listing wins over carousel
    const cta = cleanText(am[2]!);
    map.set(slugInfo.slug, {
      handle: slugInfo.slug,
      title: titleBefore(am.index) ?? slugInfo.slug,
      vendor: vendorName,
      productType: null,
      tags: [],
      minPrice: null,
      available: PURCHASE_SIGNALS.test(cta) && !INFO_SIGNALS.test(cta),
      image: null,
      url: slugInfo.url,
      // Carry the raw button text so diff() can fire site_changed if the wording
      // changes to something our word-list doesn't recognize as buyable.
      cta,
    });
  }

  // Optional roster overlay: add schema items not already in the grid as
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
        productType: null,
        tags: [],
        minPrice: null,
        available: false,
        image: null,
        url: slugInfo.url,
      });
    }
  }

  return [...map.values()];
}

export const campariV1: CustomExtractor = (html: string, ctx: ExtractorContext): ExtractorOutput => {
  const useCollectionSchema = (ctx.options as CampariOptions | undefined)?.useCollectionSchema === true;
  return {
    products: parseCampariCards(html, {
      baseUrl: ctx.baseUrl,
      vendorName: ctx.vendorName,
      useCollectionSchema,
    }),
  };
};
