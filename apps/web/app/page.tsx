import { getStore } from "../lib/store";
import { ago, siteHealth, type Health } from "../lib/health";
import { SiteControls } from "../components/SiteControls";
import { PulseStrip } from "../components/PulseStrip";
import { DiagnoseButton } from "../components/DiagnoseButton";
import { ReveriesPanel } from "../components/ReveriesPanel";
import { SitesView } from "../components/SitesView";
import { isReveries } from "../lib/reveries";
import { getEffectiveInterval } from "@beacon/shared";
import type { SiteDefinition } from "@beacon/core";

export const dynamic = "force-dynamic";

// Worker is considered down if no site has been checked within this window — it
// loops ~60s, so 15 min of total silence means the worker itself is stalled
// (the R3 dead-worker signal). Schedule-agnostic: a single global threshold.
const WORKER_STALE_MS = 15 * 60_000;
// Quiet-site canary (3d): a healthy site that hasn't produced any activity in
// this long (or has never alerted despite many checks) is worth a glance — often
// a too-narrow filter or a quietly-broken source.
const QUIET_MS = 21 * 86_400_000;
function minsAgo(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

// Public URL a site links to — mirrors the worker's siteUrl() across source kinds.
function siteUrl(def: SiteDefinition): string {
  const s = def.source as Record<string, unknown>;
  if (typeof s["url"] === "string") return s["url"];
  if (typeof s["baseUrl"] === "string") return s["baseUrl"];
  if (typeof s["productUrl"] === "string") return s["productUrl"];
  if (typeof s["domain"] === "string") return `https://${s["domain"]}`;
  return "";
}

// Minutes until imminent mode auto-reverts (worker default 20m; per-site override
// via imminentDurationMinutes). null when not in imminent mode / not yet started.
function imminentLeft(def: SiteDefinition): number | null {
  if (!def.imminent || !def.imminentSince) return null;
  const durMs = (def.imminentDurationMinutes ?? 20) * 60_000;
  const leftMs = Date.parse(def.imminentSince) + durMs - Date.now();
  if (Number.isNaN(leftMs)) return null;
  return leftMs > 0 ? Math.ceil(leftMs / 60_000) : 0;
}

export default async function SitesPage() {
  const store = await getStore();
  const [rows, schedules, recentAlerts, heartbeat] = await Promise.all([
    store.sites.list(),
    store.schedules.all(),
    store.history.recent(100),
    // Per-loop worker heartbeat (2e) — written every ~60s regardless of whether
    // any site was due, so it's a tighter liveness signal than max(lastChecked).
    store.meta.get("worker_heartbeat"),
  ]);
  const states = await Promise.all(rows.map((r) => store.state.load(r.id)));

  const cards = rows.map((row, i) => ({
    row,
    state: states[i],
    health: siteHealth(row.definition, states[i], schedules),
  }));

  const monitored = rows.filter((r) => r.enabled).length;
  const healthy = cards.filter((c) => c.health === "ok").length;
  const errCount = cards.filter((c) => c.health === "err").length;
  const warnCount = cards.filter((c) => c.health === "warn").length;
  // Density-mode requirement: "off" (disabled) sites sink to the bottom of the
  // grid regardless of DB order. Stable sort keeps the enabled sites' order.
  cards.sort((a, b) => Number(b.row.enabled) - Number(a.row.enabled));

  const trackedProducts = states.reduce(
    (n, s) => n + Object.keys((s?.products as object | undefined) ?? {}).length,
    0,
  );

  // Reveries in stock across every site — the headline goal.
  let reveriesInStock = 0;
  cards.forEach(({ row, state }) => {
    const products = (state?.products as Record<string, Record<string, unknown>> | undefined) ?? {};
    for (const p of Object.values(products)) {
      if (p["available"] === true && isReveries(row.id, String(p["title"] ?? ""))) reveriesInStock += 1;
    }
  });

  // Most recent failed check across all sites, from the per-site checkHistory
  // already loaded for the PulseStrip (no extra query).
  let lastErrTs: string | null = null;
  let lastErrSite = "";
  cards.forEach(({ row, state }) => {
    const hist = (state?.checkHistory as { ts: string; ok: boolean }[] | undefined) ?? [];
    for (const h of hist) {
      if (!h.ok && (lastErrTs === null || h.ts > lastErrTs)) {
        lastErrTs = h.ts;
        lastErrSite = row.name;
      }
    }
  });

  const lastCheck = states.reduce<string | null>((acc, s) => {
    const lc = (s?.lastChecked as string | null | undefined) ?? null;
    return lc && (!acc || lc > acc) ? lc : acc;
  }, null);

  // Worker liveness: prefer the explicit heartbeat (2e); fall back to
  // max(lastChecked) for pre-heartbeat state. Older than the threshold → the
  // worker likely isn't running at all.
  const lastCheckMs = lastCheck ? Date.now() - new Date(lastCheck).getTime() : null;
  const heartbeatMs = heartbeat ? Date.now() - Date.parse(heartbeat) : null;
  const liveMs = heartbeatMs ?? lastCheckMs;
  const workerStale = liveMs === null || liveMs > WORKER_STALE_MS;

  // Reveries products in stock across every site, for the ✨ Reveries section.
  // Built from the products already loaded for the page (no extra query).
  const reveriesProducts = cards
    .flatMap(({ row, state }) => {
      const products =
        (state?.products as Record<string, Record<string, unknown>> | undefined) ?? {};
      return Object.values(products)
        .filter((p) => isReveries(row.id, String(p["title"] ?? "")))
        .map((p) => ({
          key: `${row.id}:${String(p["handle"])}`,
          handle: String(p["handle"]),
          site: row.name,
          title: String(p["title"] ?? p["handle"]),
          available: p["available"] === true,
          minPrice: typeof p["minPrice"] === "number" ? (p["minPrice"] as number) : null,
          vendor: (p["vendor"] as string | null) ?? null,
          url: String(p["url"] ?? "#"),
        }));
    })
    .sort((a, b) => Number(b.available) - Number(a.available) || a.title.localeCompare(b.title));

  const dayAgo = Date.now() - 86_400_000;
  const alerts24h = recentAlerts.filter(
    (e) => e.type !== "baseline" && Date.parse(e.ts) >= dayAgo,
  ).length;

  // Most recent time a Reveries bottle went up for sale (newly listed) or came
  // back in stock — the headline header stat. recentAlerts is newest-first, so
  // the first match is the latest. Replaces the redundant global "Last check"
  // (which just duplicated the worker banner directly below it).
  const lastReveries =
    recentAlerts.find(
      (e) =>
        (e.type === "new_product" || e.type === "restock") &&
        isReveries(e.siteId ?? "", e.title ?? ""),
    ) ?? null;
  // Most recent Reveries bottle to sell out (products carry no sold-out
  // timestamp, so this comes from history). Lets the compact panel show the
  // freshest sold-out tile right after the in-stock ones.
  const recentSoldOutHandle =
    recentAlerts.find((e) => e.type === "sold_out" && isReveries(e.siteId ?? "", e.title ?? ""))
      ?.handle ?? null;

  // Live state of the Reveries storefront's password / coming-soon wall, from the
  // reveries_site_status monitor (pageReset = wall up). The leading indicator of
  // a drop, surfaced in the header at a glance.
  const revStatusState = cards.find((c) => c.row.id === "reveries_site_status")?.state;
  const reveriesSite: "open" | "blocked" | "unknown" = !revStatusState?.lastChecked
    ? "unknown"
    : revStatusState.pageReset === true
      ? "blocked"
      : "open";
  const reveriesSiteView = {
    open: { label: "open", color: "var(--ok)", title: "thereveries.co is open — no password / coming-soon wall" },
    blocked: { label: "🌊 wall up", color: "#f39c12", title: "thereveries.co is behind its coming-soon / password wall — a drop is likely being prepped" },
    unknown: { label: "—", color: "var(--faint)", title: "Reveries site status unknown — the monitor hasn't checked yet" },
  }[reveriesSite];

  const imminentCount = rows.filter((r) => r.enabled && r.definition.imminent).length;

  const banner: Health = errCount > 0 ? "err" : warnCount > 0 ? "warn" : "ok";
  const bannerText =
    errCount > 0
      ? `${errCount} erroring`
      : warnCount > 0
        ? `${warnCount} need attention`
        : "all systems nominal";

  const scheduleOptions = [
    { value: "5", label: "5 min" },
    { value: "15", label: "15 min" },
    { value: "20", label: "20 min" },
    { value: "30", label: "30 min" },
    { value: "60", label: "60 min" },
    ...Object.entries(schedules).map(([k, d]) => ({ value: k, label: d.label ?? k })),
  ];

  return (
    <>
      <div className={`glance ${banner}`}>
        <div className="banner">
          <span className="bdot" />
          <div className="btext">
            <span className="bnum">
              {healthy}/{monitored}
            </span>
            <span className="blabel">sites ok · {bannerText}</span>
          </div>
        </div>
        <div className="stat">
          <span className="k">Reveries in stock</span>
          <span className="v" style={{ color: reveriesInStock > 0 ? "var(--ok)" : undefined }}>
            {reveriesInStock}
          </span>
        </div>
        <div className="stat">
          <span className="k">Reveries site</span>
          <span className="v" style={{ color: reveriesSiteView.color }} title={reveriesSiteView.title}>
            {reveriesSiteView.label}
          </span>
        </div>
        <div className="stat">
          <span className="k">Tracked products</span>
          <span className="v">{trackedProducts}</span>
        </div>
        <div className="stat">
          <span className="k">Alerts (24h)</span>
          <span className="v">{alerts24h}</span>
        </div>
        {imminentCount > 0 && (
          <div className="stat">
            <span className="k">Imminent</span>
            <span className="v" style={{ color: "var(--warn)" }}>
              ⚡ {imminentCount}
            </span>
          </div>
        )}
        <div className="stat">
          <span className="k">Last Reveries drop</span>
          <span className="v" title="Most recent Reveries bottle to list or restock — name shown on the ✨ Reveries panel">
            {lastReveries ? ago(lastReveries.ts) : "none yet"}
          </span>
        </div>
        <div className="stat">
          <span className="k">Last error</span>
          <span className="v" style={{ color: lastErrTs ? "var(--err)" : undefined }}>
            {lastErrTs ? ago(lastErrTs) : "none"}
          </span>
          {lastErrTs && (
            <span className="faint mono" style={{ fontSize: 9 }}>
              {lastErrSite}
            </span>
          )}
        </div>
      </div>

      {workerStale ? (
        <div className="worker-banner stale">
          ⚠ Worker may be down — last ran {liveMs === null ? "never" : minsAgo(liveMs)}
        </div>
      ) : (
        <div className="worker-banner ok">
          ● Worker active · last ran {minsAgo(liveMs!)}
        </div>
      )}
      {!process.env["HEALTHCHECK_URL"] && (
        <div className="faint" style={{ fontSize: 11, margin: "4px 0 10px", color: "var(--warn)" }}>
          ⚠ Dead-man switch not configured: if the whole worker dies, nothing will tell you — Beacon can&apos;t
          report its own death. Fix (free, ~5 min): create a check at healthchecks.io (period ~2 min, grace ~10 min)
          and set its ping URL as <span className="mono">HEALTHCHECK_URL</span> in the Railway service variables.
        </div>
      )}

      {reveriesProducts.length > 0 && (
        <ReveriesPanel
          products={reveriesProducts}
          lastDrop={lastReveries?.title ? { title: lastReveries.title, when: ago(lastReveries.ts) } : null}
          recentSoldOutHandle={recentSoldOutHandle}
        />
      )}

      <SitesView>
        {cards.map(({ row, state, health }) => {
          const def = row.definition;
          const url = siteUrl(def);
          // Density-mode readouts: effective cadence in minutes (micro) + the
          // human schedule label (compact).
          const cadenceMins = getEffectiveInterval(def, schedules);
          const schedVal = String(def.schedule ?? def.intervalMinutes ?? "");
          const schedLabel =
            scheduleOptions.find((o) => o.value === schedVal)?.label ?? (schedVal || "—");
          const productCount = Object.keys((state?.products as object | undefined) ?? {}).length;
          const errors = (state?.consecutiveErrors as number | undefined) ?? 0;
          const immLeft = imminentLeft(def);
          // Failure diagnostics: cooldown countdown, HTTP status of the latest
          // failure, and a "blocked" read when the status is a bot-protection
          // tell (401/403/430) — so a dead checker explains itself on the tile.
          const cooldownMsLeft = state?.cooldownUntil
            ? new Date(state.cooldownUntil as string).getTime() - Date.now()
            : 0;
          const errLog = (state?.errorLog as { statusCode?: number | null }[] | undefined) ?? [];
          const lastStatus = errors > 0 ? errLog[errLog.length - 1]?.statusCode ?? null : null;
          const looksBlocked = lastStatus === 401 || lastStatus === 403 || lastStatus === 430;
          // Status-less stall ("Aborted fetching…"): the host hangs the
          // connection instead of answering — tar-pit bot mitigation.
          const looksStalled =
            errors > 0 &&
            lastStatus == null &&
            /aborted (fetch|post)ing|deadline exceeded|socket idle timeout/i.test(String(state?.lastError ?? ""));
          const viaFallback = state?.fetchVia === "storefront_fallback";
          // PulseStrip health overlays. `stalled` reuses siteHealth's staleness
          // formula (interval × 2.5 + grace) so a red strip lines up with a
          // non-ok dot; `degraded` flags a recent failure even if not yet stale.
          const checkHist = (state?.checkHistory as { ts: string; ok: boolean }[] | undefined) ?? [];
          const lastCheckedStr = state?.lastChecked as string | undefined;
          const overdueMs = lastCheckedStr ? Date.now() - new Date(lastCheckedStr).getTime() : Infinity;
          const stalled = row.enabled && overdueMs > (cadenceMins * 2.5 + 8) * 60_000;
          const degraded = checkHist.slice(-4).some((h) => !h.ok);
          // Quiet-site canary (3d): healthy + active for a while + never/long-ago alerted.
          const lastAlertAt = state?.lastAlertAt as string | undefined;
          const quiet =
            row.enabled &&
            health === "ok" &&
            (lastAlertAt
              ? Date.now() - Date.parse(lastAlertAt) > QUIET_MS
              : checkHist.length >= 50);
          return (
            <div key={row.id} className={`site-card ${row.enabled ? "" : "disabled"}`}>
              <div className="site-hd">
                <span className={`dot ${health}`} />
                <span className="name">
                  {url ? (
                    <a href={url} target="_blank" rel="noreferrer">
                      {row.name}
                    </a>
                  ) : (
                    row.name
                  )}
                </span>
                <span className="kind-chip">{row.sourceKind}</span>
              </div>
              <div className="site-stats">
                <div className="site-stat st-products">
                  <span className="k">Products</span>
                  <span className="val">{productCount}</span>
                </div>
                <div className="site-stat st-lastcheck">
                  <span className="k">Last check</span>
                  <span className="val">{ago(state?.lastChecked)}</span>
                </div>
                <div className="site-stat st-schedule">
                  <span className="k">Schedule</span>
                  <span className="val" style={{ fontSize: 12 }}>
                    {schedLabel}
                  </span>
                </div>
                <div className="site-stat st-cadence">
                  <span className="k">Cadence</span>
                  <span className="val" title="Effective check interval right now (schedule-resolved).">
                    {cadenceMins}m
                  </span>
                </div>
                {def.imminent && (
                  <div className="site-stat st-mode">
                    <span className="k">Mode</span>
                    <span
                      className="val"
                      style={{ color: "var(--warn)" }}
                      title="Imminent mode auto-reverts to your normal schedule when the timer runs out."
                    >
                      ⚡ imminent{immLeft != null ? ` · auto-off in ${immLeft}m` : ""}
                    </span>
                  </div>
                )}
                {errors > 0 && (
                  <div className="site-stat st-errors">
                    <span className="k">Errors</span>
                    <span className="val" style={{ color: "var(--err)" }}>
                      {errors}
                      {lastStatus != null ? ` · HTTP ${lastStatus}` : ""}
                    </span>
                  </div>
                )}
                {cooldownMsLeft > 0 && (
                  <div className="site-stat st-cooldown">
                    <span className="k">Cooldown</span>
                    <span
                      className="val"
                      style={{ color: "var(--warn)" }}
                      title="Circuit breaker: after a 403/429/430 the site is rested 5→15→60 min before retrying, so checks pause on purpose."
                    >
                      ⏸ {Math.ceil(cooldownMsLeft / 60_000)}m left
                    </span>
                  </div>
                )}
                {viaFallback && (
                  <div className="site-stat st-channel">
                    <span className="k">Channel</span>
                    <span
                      className="val"
                      style={{ color: "var(--warn)" }}
                      title={`${(state?.fetchViaReason as string | undefined) ?? "products.json is blocked"} — this roster came from the Storefront GraphQL API fallback. ${
                        state?.preferFallback === true
                          ? "After repeated blocks the Storefront API is now the PREFERRED channel; REST is re-probed twice a day and this flips back automatically when it recovers."
                          : "REST is retried first on every check and this clears when it recovers."
                      }`}
                    >
                      ⛑ storefront {state?.preferFallback === true ? "(preferred)" : "fallback"}
                    </span>
                  </div>
                )}
                {state?.fallbackTruncated === true && (
                  <div className="site-stat st-truncated">
                    <span className="k">Coverage</span>
                    <span
                      className="val"
                      style={{ color: "var(--warn)" }}
                      title="The Storefront fallback stopped at its pagination cap with catalog left over — products past the cap are invisible on this channel. Scope this source to a collectionPath (⚙ source) so a check isn't a full-catalog scan."
                    >
                      ⚠ roster truncated
                    </span>
                  </div>
                )}
                {quiet && (
                  <div className="site-stat st-activity">
                    <span className="k">Activity</span>
                    <span
                      className="val faint"
                      title="No alerts in a long time despite healthy checks — verify the filter/source isn't quietly broken."
                    >
                      💤 quiet
                    </span>
                  </div>
                )}
              </div>
              {(state?.lastError as string | undefined) && errors > 0 && (
                <div className="faint mono site-err" style={{ fontSize: 11, marginBottom: 6 }}>
                  {String(state?.lastError)}
                  {looksBlocked && (
                    <span style={{ color: "var(--warn)" }}>
                      {" "}
                      — looks like bot protection blocking Beacon&apos;s server IP; the page can still load fine in your own browser.
                    </span>
                  )}
                  {looksStalled && (
                    <span style={{ color: "var(--warn)" }}>
                      {" "}
                      — the site is leaving Beacon&apos;s connections hanging with no answer (tar-pit bot mitigation aimed at server IPs); the page can still load fine in your own browser.
                    </span>
                  )}
                </div>
              )}
              <div className="site-controls-wrap">
                <SiteControls
                  siteId={row.id}
                  enabled={row.enabled}
                  imminent={def.imminent}
                  schedule={String(def.schedule ?? def.intervalMinutes ?? "")}
                  scheduleOptions={scheduleOptions}
                  imminentInterval={def.imminentIntervalMinutes ?? null}
                  imminentDuration={def.imminentDurationMinutes ?? null}
                  titleContains={def.filters?.titleContains ?? []}
                  sourceJson={JSON.stringify(def.source, null, 2)}
                />
              </div>
              {Array.isArray(state?.checkHistory) && (state!.checkHistory as unknown[]).length > 0 && (
                <PulseStrip
                  history={state!.checkHistory as { ts: string; ok: boolean }[]}
                  siteId={row.id}
                  stalled={stalled}
                  degraded={degraded}
                />
              )}
              <div className="diag-wrap">
                <DiagnoseButton siteId={row.id} />
              </div>
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="muted">No sites configured yet. Run the migration importer to seed the database.</p>
        )}
      </SitesView>
    </>
  );
}
