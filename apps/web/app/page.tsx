import { getStore } from "../lib/store";
import { ago, siteHealth, type Health } from "../lib/health";
import { ReveriesPanel } from "../components/ReveriesPanel";
import { SitesView } from "../components/SitesView";
import { SiteTile } from "../components/SiteTile";
import { isReveries } from "../lib/reveries";
import { rosterIsLive } from "../lib/live";
import { countAllProducts, countLiveProducts, loadReveriesStock } from "../lib/stock";
import { RECENT_EVENT_TYPES, recentBySite } from "../lib/activity";
import { scheduleOptionsFor } from "../components/CadenceTable";

export const dynamic = "force-dynamic";

// Worker is considered down if no site has been checked within this window — it
// loops ~60s, so 15 min of total silence means the worker itself is stalled
// (the R3 dead-worker signal). Schedule-agnostic: a single global threshold.
const WORKER_STALE_MS = 15 * 60_000;
function minsAgo(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

export default async function SitesPage({ searchParams }: { searchParams: { tab?: string } }) {
  const showDeprecated = searchParams.tab === "deprecated";
  const store = await getStore();
  const [rows, schedules, recentAlerts, heartbeat] = await Promise.all([
    store.sites.list(),
    store.schedules.all(),
    store.history.recent(100),
    // Per-loop worker heartbeat (2e) — written every ~60s regardless of whether
    // any site was due, so it's a tighter liveness signal than max(lastChecked).
    store.meta.get("worker_heartbeat"),
  ]);
  const now = Date.now();
  // Per-tile "Recent" rows: product/signal events for THESE sites only (so the
  // unicorn firehose can't crowd out a quiet shop), grouped per site below.
  const activityRows = await store.history.recentBySitesAndTypes(
    rows.map((r) => r.id),
    RECENT_EVENT_TYPES,
  );
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
  // Deprecated checkers live on their own tab so they're never mistaken for
  // the checker that replaced them. Header stats above still count every site.
  const deprecatedCount = cards.filter((c) => c.row.definition.deprecated).length;
  const shownCards = cards.filter((c) => !!c.row.definition.deprecated === showDeprecated);

  // Only rosters still being checked count as tracked inventory — a disabled or
  // long-silent site freezes its last product map forever (see lib/live.ts).
  const trackedProducts = countLiveProducts(cards);
  // How many products dashboard-wide are stuck on a frozen roster right now —
  // the gap between "all" and "live". Surfaced as a header warning below when
  // >0, so a retired/quarantined checker's stale inventory is visible instead
  // of silently vanishing from the count (which is how the 2026-08-31 bug hid
  // for days: the number just looked plausible).
  const frozenProductCount = countAllProducts(cards) - trackedProducts;

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

  // Reveries products in stock across every site, for the ✨ Reveries section —
  // deduped by bottle and gated by roster liveness (see lib/stock.ts).
  const reveriesProducts = loadReveriesStock(cards);
  // Reveries in stock across every site — the headline goal.
  const reveriesInStock = reveriesProducts.filter((p) => p.available).length;
  // Bottles loaded in the shop backend while the storefront is walled — the
  // 2026-09-08 phantom: Shopify said "available", the page said "Come Back
  // Later". Shown as its own stat, never counted as in stock.
  const reveriesBehindWall = reveriesProducts.filter((p) => p.walled).length;

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
  // a drop, surfaced in the header at a glance. Gated through rosterIsLive (same
  // enabled+fresh check the product surfaces use) so a disabled or long-silent
  // monitor reads "unknown" instead of confidently repeating its last answer
  // forever — this indicator had the exact bug lib/stock.ts fixes for stock.
  const revStatusCard = cards.find((c) => c.row.id === "reveries_site_status");
  const revStatusState = revStatusCard?.state;
  const revStatusLive = rosterIsLive(revStatusCard?.row.enabled ?? false, revStatusState?.lastChecked);
  const reveriesSite: "open" | "blocked" | "unknown" = !revStatusLive
    ? "unknown"
    : revStatusState?.pageReset === true
      ? "blocked"
      : "open";
  const revStatusUnknownWhy = !revStatusCard
    ? "Reveries site status unknown — the monitor doesn't exist."
    : !revStatusCard.row.enabled
      ? "Reveries site status monitor is disabled — status unknown, not necessarily open."
      : !revStatusState?.lastChecked
        ? "Reveries site status unknown — the monitor hasn't checked yet."
        : "Reveries site status monitor hasn't checked in over 24h — status unknown, not necessarily open.";
  const reveriesSiteView = {
    open: { label: "open", color: "var(--ok)", title: "thereveries.co is open — no password / coming-soon wall" },
    blocked: { label: "🌊 wall up", color: "#f39c12", title: "thereveries.co is behind its coming-soon / password wall — a drop is likely being prepped" },
    unknown: { label: "—", color: "var(--faint)", title: revStatusUnknownWhy },
  }[reveriesSite];

  const imminentCount = rows.filter((r) => r.enabled && r.definition.imminent).length;

  const banner: Health = errCount > 0 ? "err" : warnCount > 0 ? "warn" : "ok";
  const bannerText =
    errCount > 0
      ? `${errCount} erroring`
      : warnCount > 0
        ? `${warnCount} need attention`
        : "all systems nominal";

  const scheduleOptions = scheduleOptionsFor(schedules);
  const recentPerSite = recentBySite(
    activityRows,
    Object.fromEntries(rows.map((r) => [r.id, r.sourceKind])),
  );

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
        {reveriesBehindWall > 0 && (
          <div className="stat">
            <span className="k">Behind wall</span>
            <span
              className="v"
              style={{ color: "var(--warn)" }}
              title="Reveries bottles the shop's backend reports as available while the storefront is behind its password / coming-soon wall — loaded, not buyable. See the ✨ panel."
            >
              🌊 {reveriesBehindWall}
            </span>
          </div>
        )}
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
        {frozenProductCount > 0 && (
          <div className="stat">
            <span className="k">Frozen</span>
            <span
              className="v"
              style={{ color: "var(--warn)" }}
              title="Products from disabled or long-silent checkers — last-known state, not current stock (see the ✨ Reveries panel or the Products page for which ones, marked 'not checked')."
            >
              {frozenProductCount}
            </span>
          </div>
        )}
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
        <div className="faint" style={{ fontSize: 11, margin: "4px 0 10px" }}>
          🛡 Dead-man: a GitHub Actions probe asks <span className="mono">/api/health</span> every ~10 min and fails
          (email, plus Discord if the repo secret <span className="mono">DISCORD_WEBHOOK_URL</span> is set) when the
          worker heartbeat goes stale. For a tighter check, set <span className="mono">HEALTHCHECK_URL</span> (healthchecks.io
          ping URL) in the Railway service variables.
        </div>
      )}

      {reveriesProducts.length > 0 && (
        <ReveriesPanel
          products={reveriesProducts}
          lastDrop={lastReveries?.title ? { title: lastReveries.title, when: ago(lastReveries.ts) } : null}
          recentSoldOutHandle={recentSoldOutHandle}
        />
      )}

      {(deprecatedCount > 0 || showDeprecated) && (
        <nav className="site-tabs">
          <a href="/" className={showDeprecated ? "" : "active"}>
            Active
          </a>
          <a href="/?tab=deprecated" className={showDeprecated ? "active" : ""}>
            🗄 Deprecated ({deprecatedCount})
          </a>
        </nav>
      )}

      <SitesView>
        {shownCards.map(({ row, state, health }) => (
          <SiteTile
            key={row.id}
            row={row}
            state={state}
            health={health}
            schedules={schedules}
            scheduleOptions={scheduleOptions}
            recent={recentPerSite.get(row.id) ?? []}
            now={now}
          />
        ))}
        {showDeprecated && deprecatedCount === 0 && <p className="muted">No deprecated sites.</p>}
        {rows.length === 0 && (
          <p className="muted">No sites configured yet. Run the migration importer to seed the database.</p>
        )}
      </SitesView>
    </>
  );
}
