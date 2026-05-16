import { request } from "node:https";
import { URL } from "node:url";

const COLORS = {
  new_product: 0x3498db, // blue
  restock: 0x2ecc71,     // green
  sold_out: 0xe74c3c,    // red
};

const LABELS = {
  new_product: "New Product",
  restock: "Back In Stock",
  sold_out: "Sold Out",
};

export async function sendAlert(webhookUrl, siteName, alert) {
  const { type, product } = alert;
  const color = COLORS[type] ?? 0x95a5a6;
  const label = LABELS[type] ?? type;

  const priceStr =
    product.minPrice != null ? `$${product.minPrice.toFixed(2)}` : "Price unknown";

  const embed = {
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
            label: "View Product",
            url: product.url,
          },
        ],
      },
    ],
  });

  return postWebhook(webhookUrl, payload);
}

function postWebhook(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
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
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Discord webhook returned ${res.statusCode}: ${Buffer.concat(chunks).toString()}`));
        }
      });
    });

    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
