import { getStore } from "../lib/store";
import { ago, siteHealth, type Health } from "../lib/health";
import { SiteControls } from "../components/SiteControls";
import { runNow } from "./actions";

export const dynamic = "force-dynamic";

export default async function SitesPage() {
  const store = await getStore();
  const [rows, schedules] = await Promise.all([store.sites.list(), store.schedules.all()]);
  const states = await Promise.all(rows.map((r) => store.state.load(r.id)));

  const cards = rows.map((row, i) => ({ row, state: states[i] }));
  const healths = cards.map(({ row, state }) => siteHealth(row.definition, state, schedules));

  const monitored = rows.filter((r) => r.enabled).length;
  const healthy = healths.filter((h) => h === "ok").length;
  const trackedProducts = states.reduce(
    (n, s) => n + Object.keys((s?.products as object | undefined) ?? {}).length,
    0,
  );

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
      <div className="glance">
        <div className="stat">
          <span className="k">Sites OK</span>
          <span className="v">
            {healthy}/{monitored}
          </span>
        </div>
        <div className="stat">
          <span className="k">Monitored</span>
          <span className="v">{monitored}</span>
        </div>
        <div className="stat">
          <span className="k">Tracked products</span>
          <span className="v">{trackedProducts}</span>
        </div>
      </div>

      <div className="sect-hd">
        <h2>Sites</h2>
        <span className="rule" />
        <form action={async () => {
          "use server";
          await runNow();
        }}>
          <button className="btn" type="submit">
            ▶ Run all
          </button>
        </form>
      </div>

      <div className="sites-grid">
        {cards.map(({ row, state }, i) => {
          const health: Health = healths[i]!;
          const def = row.definition;
          const productCount = Object.keys((state?.products as object | undefined) ?? {}).length;
          const errors = (state?.consecutiveErrors as number | undefined) ?? 0;
          return (
            <div key={row.id} className={`site-card ${row.enabled ? "" : "disabled"}`}>
              <div className="site-hd">
                <span className={`dot ${health}`} />
                <span className="name">{row.name}</span>
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
                    <span className="val" style={{ color: "var(--warn)" }}>
                      ⚡ imminent
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
              />
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
