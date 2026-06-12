// Lightweight page-status monitor for Squarespace storefronts that may show a
// password / "coming soon" wall between product waves.
//
// This is intentionally separate from the shopify_storefront strategy so that
// the two concerns stay decoupled: shopify_storefront tracks inventory, this
// tracks frontend accessibility. Both run on their own schedule.
//
// Alert lifecycle:
//   open → blocked  : fires site_reset once (sets resetAlertSent = true)
//   blocked → open  : clears resetAlertSent; no alert fired — product alerts
//                     from shopify_storefront will announce the new wave
//   blocked → blocked: suppressed (resetAlertSent flag)
//
// HTTP 401 / 403 are treated as blocked (password wall). Anything else
// (network error, 5xx, timeout) is re-thrown so the worker increments
// consecutiveErrors and fires a site_error alert after the threshold.

import { https, conditionalHeaders, extractValidators } from "../lib/fetch.js";

const RESET_SIGNALS = [
  "sqs-pw-form",
  "coming soon",
  "enter password",
  "password protected",
  "this store is unavailable",
];

export async function checkSite(site, previousState) {
  let html = "";
  let validators = previousState?.httpValidators ?? null;

  try {
    const res = await https(site.url, {
      withResponse: true,
      headers: conditionalHeaders(validators),
    });

    // 304: page is byte-identical to last time — previous status stands.
    if (res.status === 304) {
      return {
        state: { ...previousState, lastChecked: new Date().toISOString() },
        alerts: [],
      };
    }

    html = res.body;
    validators = extractValidators(res.headers);
  } catch (err) {
    if (err.statusCode === 401 || err.statusCode === 403) {
      // Hard password wall — treat identically to an HTML reset signal.
      html = "";
      validators = null;
    } else {
      throw err; // real error; worker handles consecutiveErrors + site_error alert
    }
  }

  const lower = html.toLowerCase();
  const matchedSignal = RESET_SIGNALS.find((s) => lower.includes(s));
  const isBlocked = matchedSignal !== undefined || html === "";

  const alreadyAlerted = previousState?.resetAlertSent === true;
  const alerts = [];

  if (isBlocked && !alreadyAlerted) {
    alerts.push({
      type: "site_reset",
      product: {
        title: site.name,
        url: site.url,
        note: `Coming Soon / password wall detected at ${site.url}` +
          (matchedSignal ? ` (signal: "${matchedSignal}")` : " (HTTP 401/403)") +
          "\nNew wave likely 2–14 days away.",
      },
    });
  }

  return {
    state: {
      lastChecked: new Date().toISOString(),
      products: {},
      pageReset: isBlocked,
      resetAlertSent: isBlocked ? (alreadyAlerted || alerts.length > 0) : false,
      resetReason: isBlocked
        ? (matchedSignal ?? "HTTP 401/403")
        : null,
      httpValidators: validators,
    },
    alerts,
  };
}
