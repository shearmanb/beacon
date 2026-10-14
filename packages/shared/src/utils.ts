// Small shared utilities — one source of truth for sleep/jitter/random.

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Duration in ms: base ± up to spread ms, floored at 0. */
export function jitter(baseMs: number, spreadMs: number): number {
  return Math.max(0, baseMs + (Math.random() * 2 - 1) * spreadMs);
}

export function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

/** Decode the HTML entities shop/auction copy actually uses (named + numeric). */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#0*38;|&amp;/gi, "&")
    .replace(/&#0*39;|&apos;|&rsquo;|&#8217;/gi, "'")
    .replace(/&quot;|&#0*34;/gi, '"')
    .replace(/&nbsp;|&#0*160;/gi, " ")
    .replace(/&#8211;|&ndash;/gi, "–")
    .replace(/&#8212;|&mdash;/gi, "—")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)));
}

/** Cap for NormalizedProduct.details — enough for a full set of tasting notes,
 *  well inside Discord's 4096-char embed description. */
export const DETAILS_MAX_CHARS = 1000;

/**
 * Product description HTML → readable plain text: block tags become line
 * breaks, list items bullets, entities decoded, whitespace tidied, then capped
 * at `max` on a word boundary. Returns null when nothing meaningful is left.
 */
export function htmlToText(html: string | null | undefined, max = DETAILS_MAX_CHARS): string | null {
  if (!html) return null;
  const text = decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<li\b[^>]*>/gi, "\n• ")
      .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|tr|ul|ol)>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  )
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\n+•/g, "\n•")
    .trim();
  if (!text) return null;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}
