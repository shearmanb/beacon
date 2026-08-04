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
import { UnicornSandbox } from "../../components/UnicornSandbox";

export const dynamic = "force-dynamic";

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
    .map(([id, lot]) => ({ id, ...lot }))
    .sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? 1 : -1));
  const anyDescTerms = (config?.terms ?? []).some((t) => t.inDesc);
  const descBlind = anyDescTerms && state.rawLotCount > 0 && state.descCoverage === 0;

  return (
    <>
      <div className="sect-hd">
        <h2>🦄 Unicorn Auctions</h2>
        <span className="rule" />
        <span className="muted mono" style={{ fontSize: 12 }}>
          {config
            ? `last scan ${ago(state.lastScanAt)} · ${state.rawLotCount} lots scanned · ${lots.length} matched`
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
            }}
            forceScanPending={state.forceScanRequested === true}
          />

          <div className="sect-hd" style={{ marginTop: 18 }}>
            <h2>Watch terms</h2>
            <span className="rule" />
          </div>
          <UnicornTerms terms={config.terms} />

          <div className="sect-hd" style={{ marginTop: 18 }}>
            <h2>Matched lots</h2>
            <span className="rule" />
            <span className="muted mono" style={{ fontSize: 12 }}>
              {lots.length} live
            </span>
          </div>
          <div className="card" style={{ padding: 0 }}>
            {lots.length === 0 && (
              <p className="muted" style={{ padding: 14 }}>
                No matched lots{state.lastScanAt ? " in the current auction" : " yet — waiting on the first scan"}.
              </p>
            )}
            {lots.length > 0 && (
              <table className="ptable">
                <thead>
                  <tr>
                    <th>Lot</th>
                    <th>Current bid</th>
                    <th>Matched</th>
                    <th>First seen</th>
                  </tr>
                </thead>
                <tbody>
                  {lots.map((lot) => (
                    <tr key={lot.id}>
                      <td>
                        <a href={lot.url} target="_blank" rel="noreferrer">
                          {lot.title}
                        </a>
                      </td>
                      <td className="mono">
                        {lot.currentBidDollars != null ? `$${lot.currentBidDollars.toLocaleString("en-US")}` : "—"}
                      </td>
                      <td>
                        {lot.matchedTerms.map((t) => (
                          <span key={t} className="pill yes" style={{ marginRight: 4 }}>
                            {t}
                          </span>
                        ))}
                      </td>
                      <td className="when">{ago(lot.firstSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
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
