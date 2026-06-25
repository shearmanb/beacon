import { getStore } from "../lib/store";
import { ago, siteHealth, type Health } from "../lib/health";
import { SiteControls } from "../components/SiteControls";
import { PulseStrip } from "../components/PulseStrip";
import { ReveriesPanel } from "../components/ReveriesPanel";
import { isReveries } from "../lib/reveries";
import { runNow } from "./actions";
import { getEffectiveInterval } from "@beacon/shared";
import type { SiteDefinition } from "@beacon/core";

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
  const [rows, schedules, recentAlerts] = await Promise.all([
    store.sites.list(),
    store.schedules.all(),
    store.history.recent(100),
  ]);
  const states = await Promise.all(rows.map((r) => store.state.load(r.id)));

  const cards = rows.map((row, i) => ({ row, state: states[i] }));
  const healths = cards.map(({ row, state }) => siteHealth(row.definition, state, schedules));

  const monitored = rows.filter((r) => r.enabled).length;
  const healthy = healths.filter((h) => h === "ok").length;
  const errCount = healths.filter((h) => h === "err").length;
  const warnCount = healths.filter((h) => h === "warn").length;

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

  // Worker liveness: max lastChecked across all sites vs. a single global
  // threshold. Older than that → the worker likely isn't running at all.
  const lastCheckMs = lastCheck ? Date.now() - new Date(lastCheck).getTime() : null;
  const workerStale = lastCheckMs === null || lastCheckMs > WORKER_STALE_MS;

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
  const lastReveriesLabel =
    lastReveries?.title && lastReveries.title.length > 26
      ? lastReveries.title.slice(0, 25) + "…"
      : (lastReveries?.title ?? null);

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
          <span className="v" title="Most recent Reveries bottle to list or restock">
            {lastReveries ? ago(lastReveries.ts) : "none yet"}
          </span>
          {lastReveriesLabel && (
            <span className="faint mono" style={{ fontSize: 9 }}>
              {lastReveriesLabel}
            </span>
          )}
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
          ⚠ Worker may be down — last ran {lastCheckMs === null ? "never" : minsAgo(lastCheckMs)}
        </div>
      ) : (
        <div className="worker-banner ok">
          ● Worker active · last ran {minsAgo(lastCheckMs!)}
        </div>
      )}

      {reveriesProducts.length > 0 && <ReveriesPanel products={reveriesProducts} />}

      <div className="sect-hd">
        <h2>Sites</h2>
        <span className="rule" />
        <form
          action={async () => {
            "use server";
            await runNow();
          }}
        >
          <button className="btn" type="submit">
            ▶ Run all
          </button>
        </form>
      </div>

      <div className="sites-grid">
        {cards.map(({ row, state }, i) => {
          const health: Health = healths[i]!;
          const def = row.definition;
          const url = siteUrl(def);
          const productCount = Object.keys((state?.products as object | undefined) ?? {}).length;
          const errors = (state?.consecutiveErrors as number | undefined) ?? 0;
          const immLeft = imminentLeft(def);
          // PulseStrip health overlays. `stalled` reuses siteHealth's staleness
          // formula (interval × 2.5 + grace) so a red strip lines up with a
          // non-ok dot; `degraded` flags a recent failure even if not yet stale.
          const checkHist = (state?.checkHistory as { ts: string; ok: boolean }[] | undefined) ?? [];
          const lastCheckedStr = state?.lastChecked as string | undefined;
          const overdueMs = lastCheckedStr ? Date.now() - new Date(lastCheckedStr).getTime() : Infinity;
          const stalled = row.enabled && overdueMs > (getEffectiveInterval(def, schedules) * 2.5 + 8) * 60_000;
          const degraded = checkHist.slice(-4).some((h) => !h.ok);
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
                <div className="site-stat">
                  <span className="k">Products</span>
                  <span className="val">{productCount}</span>
                </div>
                <div className="site-stat">
                  <span className="k">Last check</span>
                  <span className="val">{ago(state?.lastChecked)}</span>
                </div>
                {def.imminent && (
                  <div className="site-stat">
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
                  <div className="site-stat">
                    <span className="k">Errors</span>
                    <span className="val" style={{ color: "var(--err)" }}>
                      {errors}
                    </span>
                  </div>
                )}
              </div>
              {(state?.lastError as string | undefined) && errors > 0 && (
                <div className="faint mono" style={{ fontSize: 11, marginBottom: 6 }}>
                  {String(state?.lastError)}
                </div>
              )}
              <SiteControls
                siteId={row.id}
                enabled={row.enabled}
                imminent={def.imminent}
                schedule={String(def.schedule ?? def.intervalMinutes ?? "")}
                scheduleOptions={scheduleOptions}
                imminentInterval={def.imminentIntervalMinutes ?? null}
                imminentDuration={def.imminentDurationMinutes ?? null}
              />
              {Array.isArray(state?.checkHistory) && (state!.checkHistory as unknown[]).length > 0 && (
                <PulseStrip
                  history={state!.checkHistory as { ts: string; ok: boolean }[]}
                  siteId={row.id}
                  stalled={stalled}
                  degraded={degraded}
                />
              )}
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="muted">No sites configured yet. Run the migration importer to seed the database.</p>
        )}
      </div>
    </>
  );
}
