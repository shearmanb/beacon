import { getStore } from "../../lib/store";
import { ago, siteHealth, type Health } from "../../lib/health";
import { DiagnoseButton } from "../../components/DiagnoseButton";

export const dynamic = "force-dynamic";

// The operational/health event types — everything that isn't a routine product
// alert (new_product/restock/sold_out) or a silent baseline. This is the
// "errors, recovery, diagnostics" timeline the Error log is for; product alerts
// live on the History tab.
const OPERATIONAL_TYPES = [
  "site_error",
  "site_recovered",
  "self_healed",
  "site_reset",
  "site_changed",
  "system_degraded",
  "imminent_timeout",
] as const;

const TYPE_COLOR: Record<string, string> = {
  site_error: "#e67e22",
  site_recovered: "#16a085",
  self_healed: "#00bcd4",
  site_reset: "#f39c12",
  site_changed: "#9b59b6",
  system_degraded: "#c0392b",
  imminent_timeout: "var(--warn)",
};

// Status-less stall ("Aborted fetching…") — the host hangs the connection
// instead of answering (tar-pit bot mitigation). Mirrors the Sites-tile logic.
const STALL_RE = /aborted (fetch|post)ing|deadline exceeded|socket idle timeout/i;

interface ErrLogEntry {
  ts?: string;
  message?: string;
  statusCode?: number | null;
}

export default async function ErrorsPage() {
  const store = await getStore();
  const [rows, schedules, events] = await Promise.all([
    store.sites.list(),
    store.schedules.all(),
    store.history.recentByTypes([...OPERATIONAL_TYPES], 200),
  ]);
  const states = await Promise.all(rows.map((r) => store.state.load(r.id)));

  // Build the "currently unhealthy" list: any site with active errors, an active
  // cooldown, or running on the Storefront fallback (a self-heal in effect).
  const now = Date.now();
  const problems = rows
    .map((row, i) => {
      const state = states[i];
      const health: Health = siteHealth(row.definition, state, schedules);
      const consecutiveErrors = (state?.consecutiveErrors as number | undefined) ?? 0;
      const cooldownMsLeft = state?.cooldownUntil
        ? new Date(state.cooldownUntil as string).getTime() - now
        : 0;
      const onFallback = state?.fetchVia === "storefront_fallback";
      const errorLog = (state?.errorLog as ErrLogEntry[] | undefined) ?? [];
      const lastStatus = consecutiveErrors > 0 ? errorLog[errorLog.length - 1]?.statusCode ?? null : null;
      const lastError = state?.lastError as string | undefined;
      const looksBlocked = lastStatus === 401 || lastStatus === 403 || lastStatus === 430;
      const looksStalled = consecutiveErrors > 0 && lastStatus == null && STALL_RE.test(String(lastError ?? ""));
      return {
        id: row.id,
        name: row.name,
        sourceKind: row.sourceKind,
        enabled: row.enabled,
        health,
        consecutiveErrors,
        cooldownMsLeft: cooldownMsLeft > 0 ? cooldownMsLeft : 0,
        onFallback,
        preferFallback: state?.preferFallback === true,
        fetchViaReason: state?.fetchViaReason as string | undefined,
        lastStatus,
        lastError,
        lastErrorAt: state?.lastErrorAt as string | undefined,
        looksBlocked,
        looksStalled,
        errorLog,
      };
    })
    .filter((p) => p.consecutiveErrors > 0 || p.cooldownMsLeft > 0 || p.onFallback)
    // Worst first: hard errors, then cooldowns, then quiet fallbacks.
    .sort((a, b) => b.consecutiveErrors - a.consecutiveErrors || b.cooldownMsLeft - a.cooldownMsLeft);

  // Summary reflects LIVE monitoring, so count only enabled sites. Disabled
  // sites can still carry stale error state (e.g. a paused, broken checker) —
  // surface those separately rather than as a red "erroring" alarm.
  const active = problems.filter((p) => p.enabled);
  const disabledProblems = problems.length - active.length;
  const erroring = active.filter((p) => p.consecutiveErrors > 0).length;
  const onFallback = active.filter((p) => p.onFallback).length;
  const inCooldown = active.filter((p) => p.cooldownMsLeft > 0).length;

  const disabledNote = disabledProblems
    ? `${disabledProblems} disabled site${disabledProblems === 1 ? "" : "s"} with stale errors shown below`
    : "";
  const summary =
    active.length === 0
      ? ["✓ All monitored sites healthy — no active errors, cooldowns, or fallbacks.", disabledNote]
          .filter(Boolean)
          .join(" · ")
      : [
          erroring ? `${erroring} erroring` : "",
          inCooldown ? `${inCooldown} in cooldown` : "",
          onFallback ? `${onFallback} on Storefront fallback` : "",
          disabledNote,
        ]
          .filter(Boolean)
          .join(" · ");

  return (
    <>
      <div className="sect-hd">
        <h2>Error log</h2>
        <span className="rule" />
        <span className="muted mono" style={{ fontSize: 12 }}>
          {problems.length} active
        </span>
      </div>

      <div className={`worker-banner ${active.length === 0 ? "ok" : "stale"}`}>{summary}</div>

      {problems.length > 0 && (
        <div className="sites-grid" style={{ marginTop: 12 }}>
          {problems.map((p) => (
            <div key={p.id} className={`site-card ${p.enabled ? "" : "disabled"}`}>
              <div className="site-hd">
                <span className={`dot ${p.health}`} />
                <span className="name">{p.name}</span>
                {!p.enabled && (
                  <span className="kind-chip" title="Monitoring is off — this is the last-known error state, not a live failure.">
                    monitoring off
                  </span>
                )}
                <span className="kind-chip">{p.sourceKind}</span>
              </div>
              <div className="site-stats">
                {p.consecutiveErrors > 0 && (
                  <div className="site-stat">
                    <span className="k">Errors</span>
                    <span className="val" style={{ color: "var(--err)" }}>
                      {p.consecutiveErrors}
                      {p.lastStatus != null ? ` · HTTP ${p.lastStatus}` : ""}
                    </span>
                  </div>
                )}
                {p.cooldownMsLeft > 0 && (
                  <div className="site-stat">
                    <span className="k">Cooldown</span>
                    <span
                      className="val"
                      style={{ color: "var(--warn)" }}
                      title="Circuit breaker: after a 403/429/430/stall the site rests 5→15→60→180 min before retrying."
                    >
                      ⏸ {Math.ceil(p.cooldownMsLeft / 60_000)}m
                    </span>
                  </div>
                )}
                {p.onFallback && (
                  <div className="site-stat">
                    <span className="k">Channel</span>
                    <span
                      className="val"
                      style={{ color: "var(--warn)" }}
                      title={`${p.fetchViaReason ?? "products.json blocked"} — running via the Storefront GraphQL API fallback.`}
                    >
                      ⛑ storefront {p.preferFallback ? "(preferred)" : "fallback"}
                    </span>
                  </div>
                )}
                <div className="site-stat">
                  <span className="k">Last fail</span>
                  <span className="val">{ago(p.lastErrorAt)}</span>
                </div>
              </div>

              {p.lastError && p.consecutiveErrors > 0 && (
                <div className="faint mono" style={{ fontSize: 11, marginBottom: 6 }}>
                  {p.lastError}
                  {p.looksBlocked && (
                    <span style={{ color: "var(--warn)" }}>
                      {" "}
                      — looks like bot protection blocking Beacon&apos;s server IP; the page can still load fine in your own browser.
                    </span>
                  )}
                  {p.looksStalled && (
                    <span style={{ color: "var(--warn)" }}>
                      {" "}
                      — the site is leaving Beacon&apos;s connections hanging (tar-pit bot mitigation aimed at server IPs); the page can still load fine in your own browser.
                    </span>
                  )}
                </div>
              )}

              {p.errorLog.length > 0 && (
                <details className="errlog">
                  <summary className="tune-label" style={{ cursor: "pointer", fontSize: 10 }}>
                    recent failures ({p.errorLog.length})
                  </summary>
                  <div className="errlog-body">
                    {[...p.errorLog]
                      .slice(-8)
                      .reverse()
                      .map((e, i) => (
                        <div key={i} className="errlog-line mono">
                          <span className="when">{ago(e.ts)}</span>
                          {e.statusCode != null && <span className="stat-code">HTTP {e.statusCode}</span>}
                          <span className="msg">{e.message ?? "—"}</span>
                        </div>
                      ))}
                  </div>
                </details>
              )}

              <DiagnoseButton siteId={p.id} />
            </div>
          ))}
        </div>
      )}

      <div className="sect-hd">
        <h2>Event timeline</h2>
        <span className="rule" />
        <span className="muted mono" style={{ fontSize: 12 }}>
          last {events.length}
        </span>
      </div>
      <p className="hint" style={{ margin: "0 0 8px" }}>
        Errors, recoveries, self-heals and site resets — product alerts live on the History tab.
      </p>
      <div className="card" style={{ padding: 0 }}>
        {events.map((e) => {
          const note = (e.payload as { note?: string } | null)?.note;
          return (
            <div className="evt evt-stack" key={e.id}>
              <div className="evt-top">
                <span
                  className="type"
                  style={{ color: TYPE_COLOR[e.type] ?? "var(--text)", borderColor: TYPE_COLOR[e.type] ?? "var(--line2)" }}
                >
                  {e.type.replace(/_/g, " ")}
                </span>
                <span>
                  {e.url ? (
                    <a href={e.url} target="_blank" rel="noreferrer">
                      {e.title ?? e.handle ?? "—"}
                    </a>
                  ) : (
                    e.title ?? e.handle ?? "—"
                  )}
                  {e.siteId && <span className="faint"> · {e.siteId}</span>}
                </span>
                <span className="when">{ago(e.ts)}</span>
              </div>
              {note && <div className="evt-note faint mono">{note}</div>}
            </div>
          );
        })}
        {events.length === 0 && (
          <p className="muted" style={{ padding: 14 }}>
            No errors or recoveries recorded yet — a clean history.
          </p>
        )}
      </div>
    </>
  );
}
