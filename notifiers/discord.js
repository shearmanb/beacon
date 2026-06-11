import { request } from "node:https";
import { URL } from "node:url";
import { sleep } from "../lib/utils.js";

const COLORS = {
  new_product: 0x3498db,    // blue
  restock: 0x2ecc71,        // green
  sold_out: 0xe74c3c,       // red
  site_reset: 0xf39c12,     // orange
  site_changed: 0x9b59b6,   // purple
  site_error: 0xe67e22,     // dark orange
  site_recovered: 0x16a085, // teal
  imminent_timeout: 0xf1c40f, // yellow
};

const LABELS = {
  new_product: "New Product",
  restock: "Back In Stock",
  sold_out: "Sold Out",
  site_reset: "🌊 Wave Reset",
  site_changed: "🔔 Store Changed",
  site_error: "🚨 Site Down",
  site_recovered: "✅ Site Recovered",
  imminent_timeout: "⏱ Imminent Timed Out",
};

export async function sendAlert(webhookUrl, siteName, alert) {
  const { type, product } = alert;
  const color = COLORS[type] ?? 0x95a5a6;
  const label = LABELS[type] ?? type;

  let embed;

  const SITE_LEVEL = new Set(["site_reset", "site_changed", "site_error", "site_recovered", "imminent_timeout"]);
  if (SITE_LEVEL.has(type)) {
    const defaults = {
      site_reset: "Coming Soon page detected — shop has reset between waves.",
      site_changed: "Something changed on the store page.",
      site_error: "Repeated check failures — investigate.",
      site_recovered: "Checks are succeeding again.",
      imminent_timeout: "Imminent mode auto-disabled after timeout.",
    };
    const extraFields =
      type === "site_reset"
        ? [{ name: "Expected", value: "New bottles in 2–14 days", inline: true }]
        : [];
    embed = {
      title: `${label} — ${siteName}`,
      color,
      description: product.note ?? defaults[type] ?? "",
      fields: extraFields,
      url: product.url,
      timestamp: new Date().toISOString(),
    };
  } else {
    const priceStr =
      product.minPrice != null ? `$${product.minPrice.toFixed(2)}` : "Price unknown";

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

    if (product.vendor) {
      embed.fields.push({ name: "Vendor", value: product.vendor, inline: true });
    }

    if (product.image) {
      embed.thumbnail = { url: product.image };
    }
  }

  const payload = JSON.stringify({
    username: "Beacon",
    embeds: [embed],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: SITE_LEVEL.has(type) ? "View Site" : "View Product",
            url: product.url,
          },
        ],
      },
    ],
  });

  return postWebhook(webhookUrl, payload);
}

async function postWebhook(webhookUrl, payload, attempt = 0) {
  const body = await new Promise((resolve, reject) => {
    const parsed = new URL(webhookUrl);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    };

    const req = request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(deadline);
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
      });
      res.on("error", (err) => {
        clearTimeout(deadline);
        reject(err);
      });
    });

    // Wall-clock deadline: the idle timeout below resets on every byte, so a
    // trickling response could hang past it indefinitely (same gap lib/fetch.js
    // guards with its deadline timer).
    const deadline = setTimeout(
      () => req.destroy(new Error("Discord webhook deadline exceeded")),
      15000
    );

    req.on("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
    req.setTimeout(10000, () => req.destroy(new Error("Discord webhook timeout")));
    req.write(payload);
    req.end();
  });

  if (body.status === 429 && attempt < 4) {
    let retryAfter = 1;
    try { retryAfter = JSON.parse(body.body)?.retry_after ?? 1; } catch { /* use default */ }
    await sleep(retryAfter * 1000 + 200);
    return postWebhook(webhookUrl, payload, attempt + 1);
  }

  if (body.status < 200 || body.status >= 300) {
    throw new Error(`Discord webhook returned ${body.status}: ${body.body}`);
  }
}
