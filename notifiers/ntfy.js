// ntfy.sh push notifications — disabled by default.
// To enable: set NTFY_TOPIC env var and set enabled = true below.

const enabled = false;

export async function sendAlert(topic, siteName, alert) {
  if (!enabled || !topic) return;

  const { type, product } = alert;
  const title = `${siteName}: ${product.title}`;
  const message = type === "restock" ? "Back in stock!" : type === "new_product" ? "New product listed" : "Sold out";

  const { request } = await import("node:https");
  const payload = message;

  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "ntfy.sh",
        path: `/${topic}`,
        method: "POST",
        headers: {
          Title: title,
          Priority: "high",
          "Content-Type": "text/plain",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
