// Per-site "Recent" list for the Sites tile: the newest alert-history rows for
// each site, so a tile answers "what came up here lately?" without a trip to
// /history. Pure grouping over rows the page already fetches in one query
// (store.history.recentByTypes) — no new DB method. Product sites show
// new / restock / sold-out; signal sites (http_status) show wall up / lifted.
// Reads HISTORY, not state.products, so it is never a stock claim (standing
// rule 1 does not apply) — it is a log of what the checker saw and when.

export const PRODUCT_EVENT_TYPES = ["new_product", "restock", "sold_out"] as const;
export const SIGNAL_EVENT_TYPES = ["site_reset", "site_changed"] as const;
export const RECENT_EVENT_TYPES: string[] = [...PRODUCT_EVENT_TYPES, ...SIGNAL_EVENT_TYPES];

export interface HistoryRowLike {
  id: number;
  ts: string;
  siteId: string | null;
  type: string;
  title: string | null;
  url: string | null;
  payload?: unknown;
}

export interface ActivityRow {
  id: number;
  ts: string;
  type: string;
  /** Glyph + short label for the row's event kind. */
  glyph: string;
  label: string;
  title: string;
  url: string | null;
  price: number | null;
}

const KIND: Record<string, { glyph: string; label: string }> = {
  new_product: { glyph: "▲", label: "new" },
  restock: { glyph: "↻", label: "restock" },
  sold_out: { glyph: "▼", label: "sold out" },
  site_reset: { glyph: "🌊", label: "wall up" },
  site_changed: { glyph: "◇", label: "changed" },
};

function priceOf(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const p = (payload as { minPrice?: unknown }).minPrice;
  return typeof p === "number" && Number.isFinite(p) ? p : null;
}

function noteOf(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const n = (payload as { note?: unknown }).note;
  return typeof n === "string" && n.trim() ? n.trim() : null;
}

export function toActivityRow(r: HistoryRowLike): ActivityRow {
  const k = KIND[r.type] ?? { glyph: "•", label: r.type.replace(/_/g, " ") };
  // Signal rows carry the SITE name as their title (there is no product), which
  // reads as nothing on the tile — show the event's note instead ("🟢 Wall
  // lifted — …"), falling back to the short label.
  const signal = (SIGNAL_EVENT_TYPES as readonly string[]).includes(r.type);
  const title = signal ? (noteOf(r.payload) ?? k.label) : (r.title ?? "—");
  return {
    id: r.id,
    ts: r.ts,
    type: r.type,
    glyph: k.glyph,
    label: k.label,
    title,
    url: r.url && r.url !== "#" ? r.url : null,
    price: priceOf(r.payload),
  };
}

/**
 * Group history rows (any order) into per-site lists, newest first, capped at
 * `perSite`. `kinds` maps siteId → source kind so a signal-only site keeps its
 * wall events and a product site keeps its product events. Sites absent from
 * `kinds` are ignored (e.g. unicorn_auctions, which has its own page).
 */
export function recentBySite(
  rows: HistoryRowLike[],
  kinds: Record<string, string>,
  perSite = 3,
): Map<string, ActivityRow[]> {
  const out = new Map<string, ActivityRow[]>();
  const sorted = [...rows].sort((a, b) => b.id - a.id);
  for (const r of sorted) {
    if (!r.siteId || !(r.siteId in kinds)) continue;
    const signal = kinds[r.siteId] === "http_status";
    const wanted = signal ? (SIGNAL_EVENT_TYPES as readonly string[]) : (PRODUCT_EVENT_TYPES as readonly string[]);
    if (!wanted.includes(r.type)) continue;
    const list = out.get(r.siteId) ?? [];
    if (list.length >= perSite) continue;
    list.push(toActivityRow(r));
    out.set(r.siteId, list);
  }
  return out;
}
