// Discord webhook channel — ported from notifiers/discord.js. Rich embeds,
// color/label per alert type, site-level vs product-level formatting, and 429
// retry_after handling. Reuses @beacon/fetch's httpPost (shared deadline +
// socket timeout) instead of a hand-rolled https client.

import { httpPost } from "@beacon/fetch";
import { sleep, type Alert, type AlertType } from "@beacon/shared";
import type { NotificationChannel } from "./types.js";

// site_changed (purple) fires when a tracked product stays not-buyable but its
// CTA/button text changes (see @beacon/shared diff.ts); color + label below.
const COLORS: Record<string, number> = {
  new_product: 0x3498db, // blue
  restock: 0x2ecc71, // green
  sold_out: 0xe74c3c, // red
  site_reset: 0xf39c12, // orange (password / coming-soon wall)
  site_changed: 0x9b59b6, // purple (reserved)
  site_error: 0xe67e22, // dark orange
  site_recovered: 0x16a085, // teal
  imminent_timeout: 0xf1c40f, // yellow
  system_degraded: 0xc0392b, // crimson (all sites failing at once — likely IP block / network)
  self_healed: 0x00bcd4, // cyan (fallback channel engaged/disengaged — informational)
};

const LABELS: Record<string, string> = {
  new_product: "New Product",
  restock: "Back In Stock",
  sold_out: "Sold Out",
  site_reset: "🌊 Wave Reset",
  site_changed: "🔔 Store Changed",
  site_error: "🚨 Site Down",
  site_recovered: "✅ Site Recovered",
  imminent_timeout: "⏱ Imminent Timed Out",
  system_degraded: "🛑 Systemic Failure",
  self_healed: "⛑ Self-Healed",
};

const SITE_LEVEL = new Set<AlertType>([
  "site_reset",
  "site_changed",
  "site_error",
  "site_recovered",
  "imminent_timeout",
  "system_degraded",
  "self_healed",
]);

const SITE_DEFAULTS: Record<string, string> = {
  site_reset: "Coming Soon page detected — shop has reset between waves.",
  site_changed: "Something changed on the store page.",
  site_error: "Repeated check failures — investigate.",
  site_recovered: "Checks are succeeding again.",
  imminent_timeout: "Imminent mode auto-disabled after timeout.",
  system_degraded: "Every site failed this pass — likely a network outage or the egress IP being blocked.",
  self_healed: "A primary channel was blocked; checks continue via a fallback channel.",
};

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}
interface Embed {
  title: string;
  color: number;
  description: string;
  fields: EmbedField[];
  url?: string;
  timestamp: string;
  thumbnail?: { url: string };
}

/** Pure: build the Discord webhook JSON payload for an alert. */
export function buildDiscordPayload(siteName: string, alert: Alert): string {
  const { type, product } = alert;
  const color = COLORS[type] ?? 0x95a5a6;
  const label = LABELS[type] ?? type;
  const siteLevel = SITE_LEVEL.has(type);

  const hasUrl = typeof product.url === "string" && product.url.length > 0;

  let embed: Embed;
  if (siteLevel) {
    embed = {
      title: `${label} — ${siteName}`,
      color,
      description: product.note ?? SITE_DEFAULTS[type] ?? "",
      fields: type === "site_reset" ? [{ name: "Expected", value: "New bottles in 2–14 days", inline: true }] : [],
      ...(hasUrl ? { url: product.url } : {}),
      timestamp: new Date().toISOString(),
    };
  } else {
    const priceStr = product.minPrice != null ? `$${product.minPrice.toFixed(2)}` : "Price unknown";
    embed = {
      title: `${label}: ${product.title}`,
      color,
      description: `**${siteName}**`,
      fields: [
        { name: "Price", value: priceStr, inline: true },
        { name: "Status", value: product.available ? "✅ Available" : "❌ Sold Out", inline: true },
      ],
      url: product.url,
      timestamp: new Date().toISOString(),
    };
    if (product.vendor) embed.fields.push({ name: "Vendor", value: product.vendor, inline: true });
    if (product.image) embed.thumbnail = { url: product.image };
  }

  return JSON.stringify({
    username: "Beacon",
    embeds: [embed],
    // A Discord link button requires a valid URL; system-level alerts (DB down,
    // systemic failure) carry none, so omit the button entirely in that case.
    ...(hasUrl
      ? {
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 5, label: siteLevel ? "View Site" : "View Product", url: product.url },
              ],
            },
          ],
        }
      : {}),
  });
}

const MAX_RETRIES = 4;

export class DiscordChannel implements NotificationChannel {
  readonly name = "discord";
  constructor(private readonly webhookUrl: string) {}

  async send(siteName: string, alert: Alert): Promise<void> {
    await this.post(buildDiscordPayload(siteName, alert), 0);
  }

  private async post(payload: string, attempt: number): Promise<void> {
    const res = await httpPost(this.webhookUrl, payload, { throwOnHttpError: false });

    if (res.status === 429 && attempt < MAX_RETRIES) {
      let retryAfter = 1;
      try {
        retryAfter = (JSON.parse(res.body) as { retry_after?: number })?.retry_after ?? 1;
      } catch {
        /* use default */
      }
      await sleep(retryAfter * 1000 + 200);
      return this.post(payload, attempt + 1);
    }

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Discord webhook returned ${res.status}: ${res.body}`);
    }
  }
}
