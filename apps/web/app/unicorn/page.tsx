// Unicorn Auctions watcher — the module's ONLY surface. Reads the two meta
// blobs the worker job writes; deliberately shares nothing with site tracking
// (no tile, no PulseStrip, no site health) so problems here stay here.

import { getStore } from "../../lib/store";
import { ago } from "../../lib/health";
import {
  parseUnicornScanState,
  validateUnicornConfig,
  UNICORN_CONFIG_META_KEY,
  UNICORN_STATE_META_KEY,
  type UnicornConfig,
} from "@beacon/core";
import { UnicornControls } from "../../components/UnicornControls";
import { UnicornTerms } from "../../components/UnicornTerms";
import { UnicornLots } from "../../components/UnicornLots";
import { UnicornBottles } from "../../components/UnicornBottles";
import { UnicornSandbox } from "../../components/UnicornSandbox";

export const dynamic = "force-dynamic";

/** "· next in ~19h" — the cadence is daily but jittered (22–26 h) so requests
 *  never land on an exact metronome, so show the real due time. */
function nextScanLabel(nextDueAt: string | null | undefined, enabled: boolean): string {
  if (!enabled) return " · paused";
  if (!nextDueAt) return "";
  const ms = Date.parse(nextDueAt) - Date.now();
  if (Number.isNaN(ms)) return "";
  if (ms <= 0) return " · next scan due now";
  const h = Math.round(ms / 3_600_000);
  return h < 1 ? " · next in <1h" : ` · next in ~${h}h`;
}

export default async function UnicornPage() {
  const store = await getStore();
  const rawConfig = await store.meta.get(UNICORN_CONFIG_META_KEY);
  const state = parseUnicornScanState(await store.meta.get(UNICORN_STATE_META_KEY));

  let config: UnicornConfig | null = null;
  let configError: string | null = null;
  if (rawConfig) {
    try {
      const validated = validateUnicornConfig(JSON.parse(rawConfig));
      if (validated.ok) config = validated.config!;
      else configError = validated.error ?? "invalid";
    } catch {
      configError = "stored config is not valid JSON";
    }
  }

  const lots = Object.entries(state.lots)
    .map(([id, lot]) => ({ ...lot, id, bottleIds: lot.bottleIds ?? [] }))
    .sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? 1 : -1));
  const bottles = config?.bottles ?? [];
  const fees = config?.fees ?? { buyerPremiumPct: 15, salesTaxPct: 10.25, shippingDollars: 25 };
  // How many keywords point at each bottle — surfaces a bottle nobody is
  // actually hunting for, which is the failure mode of this whole linkage.
  const termCountByBottle: Record<string, number> = {};
  for (const t of config?.terms ?? []) {
    if (t.bottleId) termCountByBottle[t.bottleId] = (termCountByBottle[t.bottleId] ?? 0) + 1;
  }
  const unlinkedTerms = (config?.terms ?? []).filter((t) => !t.bottleId).length;
  const anyDescTerms = (config?.terms ?? []).some((t) => t.inDesc);
  const descBlind = anyDescTerms && state.rawLotCount > 0 && state.descCoverage === 0;

  return (
    <>
      <div className="sect-hd">
        <h2>🦄 Unicorn Auctions</h2>
        <span className="rule" />
        <span className="muted mono" style={{ fontSize: 12 }}>
          {config
            ? `last scan ${ago(state.lastScanAt)}${nextScanLabel(state.nextDueAt, config.enabled)} · ${state.rawLotCount} lots scanned · ${lots.length} matched`
            : "not configured"}
        </span>
      </div>

      <p className="hint" style={{ marginBottom: 12 }}>
        Isolated auction watcher — scans the weekly Unicorn lot listing once a day against your term
        watchlist. Runs beside site tracking, not inside it: its errors never page as site errors and
        site problems never touch it.
      </p>

      {!config && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Not set up yet</h3>
          <p className="hint">
            {configError
              ? `The stored config is broken (${configError}) — saving below replaces it.`
              : "Enable the watcher to start daily scans. Then add terms, and use the sandbox + advanced settings to point the parser at the real listing feed (browser DevTools → Network on the lots page)."}
          </p>
          <UnicornControls config={null} forceScanPending={false} />
        </div>
      )}

      {config && (
        <>
          {state.lastError && (
            <div className="banner" style={{ marginBottom: 12 }}>
              ⚠ Last scan failed ({state.consecutiveFailures} in a row): <span className="mono">{state.lastError}</span>
              {" — "}site tracking is unaffected. If this persists, the listing path/format may have changed
              (fix in advanced settings below) or the site is blocking this server&apos;s IP.
            </div>
          )}
          {descBlind && (
            <div className="banner" style={{ marginBottom: 12 }}>
              ℹ Some terms are set to match descriptions, but the listing feed carried no description
              text on the last scan — those terms are matching lot names only.
            </div>
          )}

          <UnicornControls
            config={{
              enabled: config.enabled,
              baseUrl: config.baseUrl,
              listingPath: config.listingPath,
              format: config.format,
              maxPages: config.maxPages,
              pageDelayMs: config.pageDelayMs,
              cookieRef: config.cookieRef ?? null,
              requestHeaders: config.requestHeaders ?? null,
              lotUrlTemplate: config.lotUrlTemplate ?? null,
              graphql: (config.graphql as Record<string, unknown> | undefined) ?? null,
            }}
            forceScanPending={state.forceScanRequested === true}
          />

          <div className="sect-hd" style={{ marginTop: 18 }}>
            <h2>Target bottles</h2>
            <span className="rule" />
            <span className="muted mono" style={{ fontSize: 12 }}>
              {bottles.length}
            </span>
          </div>
          <UnicornBottles bottles={bottles} fees={fees} termCountByBottle={termCountByBottle} />

          {config.notes.trim() && (
            <details className="card" style={{ marginTop: 10 }}>
              <summary className="hint" style={{ cursor: "pointer" }}>
                Buying rules
              </summary>
              <pre
                className="hint"
                style={{ marginTop: 8, whiteSpace: "pre-wrap", fontFamily: "inherit" }}
              >
                {config.notes}
              </pre>
            </details>
          )}

          {/* Collapsed once terms exist — day to day this page is for reading
              matches, not editing the watchlist. Open by default while empty so
              first-time setup is obvious. */}
          <details className="card" style={{ marginTop: 18 }} open={config.terms.length === 0}>
            <summary>
              <h3 style={{ display: "inline" }}>
                Watch terms{" "}
                <span className="muted mono" style={{ fontSize: 12, fontWeight: "normal" }}>
                  ({config.terms.length}
                  {unlinkedTerms > 0 && bottles.length > 0 ? `, ${unlinkedTerms} unlinked` : ""})
                </span>
              </h3>
            </summary>
            <div style={{ marginTop: 8 }}>
              <UnicornTerms terms={config.terms} bottles={bottles} />
            </div>
          </details>

          <div className="sect-hd" style={{ marginTop: 18 }}>
            <h2>Matched lots</h2>
            <span className="rule" />
            <span className="muted mono" style={{ fontSize: 12 }}>
              {state.lastScanAt ? `${lots.length} live` : "waiting on the first scan"}
            </span>
          </div>
          <UnicornLots lots={lots} ignoredLots={config.ignoredLots} bottles={bottles} fees={fees} />
        </>
      )}

      <div className="sect-hd" style={{ marginTop: 18 }}>
        <h2>Sandbox</h2>
        <span className="rule" />
      </div>
      <UnicornSandbox
        defaults={{
          format: config?.format ?? "next_data",
          baseUrl: config?.baseUrl ?? "https://www.unicornauctions.com",
          terms: config?.terms ?? [],
        }}
      />
    </>
  );
}
