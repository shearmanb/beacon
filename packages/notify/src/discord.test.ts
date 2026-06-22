import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";
import { buildDiscordPayload, DiscordChannel } from "./discord.js";
import type { Alert } from "@beacon/shared";

describe("buildDiscordPayload", () => {
  it("formats a product alert with price/status/vendor and a button", () => {
    const alert: Alert = {
      type: "restock",
      product: { handle: "a", title: "Reveries B1", url: "https://x/a", minPrice: 129.99, available: true, vendor: "The Reveries", image: "https://img/a.jpg" },
    };
    const payload = JSON.parse(buildDiscordPayload("SharedPour", alert));
    const embed = payload.embeds[0];
    expect(embed.title).toBe("Back In Stock: Reveries B1");
    expect(embed.color).toBe(0x2ecc71);
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        { name: "Price", value: "$129.99", inline: true },
        { name: "Status", value: "✅ Available", inline: true },
        { name: "Vendor", value: "The Reveries", inline: true },
      ]),
    );
    expect(embed.thumbnail.url).toBe("https://img/a.jpg");
    expect(payload.components[0].components[0].label).toBe("View Product");
  });

  it("formats a site-level alert (site_reset) with the wave-reset label", () => {
    const alert: Alert = { type: "site_reset", product: { title: "Reveries", url: "https://x", note: "password wall" } };
    const embed = JSON.parse(buildDiscordPayload("Reveries", alert)).embeds[0];
    expect(embed.title).toBe("🌊 Wave Reset — Reveries");
    expect(embed.description).toBe("password wall");
    expect(embed.color).toBe(0xf39c12);
  });

  it("handles a missing price gracefully", () => {
    const embed = JSON.parse(
      buildDiscordPayload("S", { type: "new_product", product: { title: "X", url: "https://x", available: false } }),
    ).embeds[0];
    expect(embed.fields).toContainEqual({ name: "Price", value: "Price unknown", inline: true });
  });
});

describe("DiscordChannel.send", () => {
  let server: Server;
  let base: string;
  let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const alert: Alert = { type: "new_product", product: { handle: "a", title: "A", url: "https://x/a", available: true } };

  it("posts the payload and resolves on 204", async () => {
    let received: unknown;
    handler = (_req, res, body) => {
      received = JSON.parse(body);
      res.writeHead(204);
      res.end();
    };
    await new DiscordChannel(`${base}/webhook`).send("Site", alert);
    expect((received as { username: string }).username).toBe("Beacon");
  });

  it("retries on 429 honoring retry_after, then succeeds", async () => {
    let calls = 0;
    handler = (_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ retry_after: 0 }));
      } else {
        res.writeHead(204);
        res.end();
      }
    };
    await new DiscordChannel(`${base}/webhook`).send("Site", alert);
    expect(calls).toBe(2);
  });

  it("throws on a non-2xx, non-429 response", async () => {
    handler = (_req, res) => {
      res.writeHead(400);
      res.end("bad request");
    };
    await expect(new DiscordChannel(`${base}/webhook`).send("Site", alert)).rejects.toThrow(/returned 400/);
  });
});
