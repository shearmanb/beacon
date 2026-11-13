// One site on the Sites page (server component). Extracted from page.tsx in the
// 2026-10-30 simplification. The face answers three questions and nothing else:
//   1. are checks OK?  → health dot + ONE status line (lib/tile-status.ts) +
//      the last-60-min PulseStrip
//   2. how often is it checked?  → the 🕒 schedule line (+ "change ›")
//   3. what came up here lately, and is it buyable now?  → RecentActivity (5 rows)
//   4. go imminent, how often, for how long?  → ImminentControl in the header
// Everything that edits the site is inside the collapsed ⚙ panel (SiteControls).

import type { SiteRow } from "@beacon/db";
import type { SiteDefinition, SiteState } from "@beacon/core";
import type { Schedules } from "@beacon/shared";
import { imminentDurationMin, imminentInterval, type CadenceSignals } from "@beacon/shared";
import { nowInterval } from "../lib/cadence";
import { predictedNextCheckAt, formatEta } from "../lib/nextcheck";
import { scheduleLine, tileStatus } from "../lib/tile-status";
import { rosterIsLive } from "../lib/live";
import { parseWindowRules } from "../lib/site-forms";
import type { Health } from "../lib/health";
import { nowStatus, type ActivityRow, type NowStatus } from "../lib/activity";
import { NextCheckIn } from "./NextCheckIn";
import { PulseStrip } from "./PulseStrip";
import { ImminentControl } from "./ImminentControl";
import { RecentActivity } from "./RecentActivity";
import { SiteControls, type ScheduleOption } from "./SiteControls";

// Public URL a site links to — mirrors the worker's siteUrl() across source kinds.
function siteUrl(def: SiteDefinition): string {
  const s = def.source as Record<string, unknown>;
  if (typeof s["url"] === "string") return s["url"];
  if (typeof s["baseUrl"] === "string") return s["baseUrl"];
  if (typeof s["productUrl"] === "string") return s["productUrl"];
  if (typeof s["domain"] === "string") return `https://${s["domain"]}`;
  return "";
}

// ISO instant imminent mode auto-reverts (worker default via
// DEFAULT_IMMINENT_DURATION_MIN; per-site override imminentDurationMinutes).
// null when not in imminent mode / start not stamped.
function imminentUntil(def: SiteDefinition): string | null {
  if (!def.imminent || !def.imminentSince) return null;
  const durMs = imminentDurationMin(def) * 60_000;
  const until = Date.parse(def.imminentSince) + durMs;
  return Number.isFinite(until) ? new Date(until).toISOString() : null;
}

export function SiteTile({
  row,
  state,
  health,
  schedules,
  scheduleOptions,
  recent,
  walls,
  now,
}: {
  row: SiteRow;
  state: SiteState | undefined;
  health: Health;
  schedules: Schedules;
  scheduleOptions: ScheduleOption[];
  recent: ActivityRow[];
  /** Storefronts currently behind a password wall (lib/live walledHosts). */
  walls: Set<string>;
  now: number;
}) {
  const def = row.definition;
  const url = siteUrl(def);
  // Predicted next-check instant, through the exact formula the worker uses
  // (lib/nextcheck.ts) — a read-only prediction, not a scheduling decision.
  const nextCheckAtIso = predictedNextCheckAt(
    row.enabled,
    def,
    state?.lastChecked,
    state?.["cooldownUntil"] as string | null | undefined,
    schedules,
    now,
    state as CadenceSignals | undefined,
  );
  const nextLabel = formatEta(nextCheckAtIso, now);
  const status = tileStatus({ enabled: row.enabled, def, state: state as Record<string, unknown> | undefined, schedules, health, nextLabel, now });
  // The "next …" part ticks live on the client; find it so the ticker can
  // replace that one part and the rest stays server text (no hydration drift).
  const nextIdx = status.parts.findIndex((p) => p.startsWith("next "));

  // PulseStrip overlays. `stalled` reuses siteHealth's staleness formula
  // (interval × 2.5 + grace) so a red strip lines up with a non-ok dot;
  // `degraded` flags a recent failure even if not yet stale.
  const checkHist = (state?.["checkHistory"] as { ts: string; ok: boolean }[] | undefined) ?? [];
  const cadenceMins = nowInterval(def, schedules);
  const overdueMs = state?.lastChecked ? now - new Date(state.lastChecked).getTime() : Infinity;
  const stalled = row.enabled && overdueMs > (cadenceMins * 2.5 + 8) * 60_000;
  const degraded = checkHist.slice(-4).some((h) => !h.ok);
  const imminentOn = !!def.imminent && row.enabled;

  // 🕒 line: the schedule's name + what it resolves to now, with a jump to this
  // site's row in the Cadence control panel (/schedules) where every window is
  // laid out. The ⚙ panel's schedule dropdown changes it in place.
  const schedVal = String(def.schedule ?? def.intervalMinutes ?? "");
  const schedLabel = scheduleOptions.find((o) => o.value === schedVal)?.label ?? (schedVal ? `${schedVal} min` : "default");

  // What each Recent row's bottle is doing NOW (gated like every stock surface).
  const live = rosterIsLive(row.enabled, state?.lastChecked);
  const products = state?.products as Record<string, { available?: boolean; url?: string }> | undefined;
  const recentStatus = new Map<number, NowStatus>(recent.map((r) => [r.id, nowStatus(r.handle, products, live, walls)]));

  return (
    <div className={`site-card ${row.enabled ? "" : "disabled"} ${imminentOn ? "imminent" : ""}`}>
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
        {row.enabled && (
          <ImminentControl
            siteId={row.id}
            imminent={!!def.imminent}
            everyMin={imminentInterval(def)}
            durationMin={def.imminentDurationMinutes ?? null}
            untilIso={imminentUntil(def)}
            auto={def.imminentAutoMinutes != null}
            initialNow={now}
          />
        )}
      </div>

      <div className={`site-status ${status.tone}`} title="Health · last check · next check (predicted) · cadence in effect now, per the schedule">
        {status.parts.map((p, i) => (
          <span key={i} className="part">
            {i > 0 && <span className="sep"> · </span>}
            {i === nextIdx ? (
              <>
                next <NextCheckIn predictedAt={nextCheckAtIso} initialLabel={nextLabel} />
              </>
            ) : (
              p
            )}
          </span>
        ))}
      </div>
      {row.enabled && (
        <div className={`site-sched ${imminentOn ? "imm" : ""}`}>
          <span className="txt">🕒 {scheduleLine(def, schedules, schedLabel, now)}</span>
          <a href={`/schedules#cad-${row.id}`} title="See this site's check windows for the whole day and change its schedule (also in ⚙ settings below)">
            change ›
          </a>
        </div>
      )}
      {status.secondary.length > 0 && (
        <div className="site-secondary">
          {status.secondary.map((n) => (
            <span key={n.text} className={`note ${n.tone ?? ""}`} title={n.title}>
              {n.text}
            </span>
          ))}
        </div>
      )}
      {status.lastError && (
        <div className="site-err mono" title={status.lastError + (status.errorHint ? ` — ${status.errorHint}` : "")}>
          {status.lastError}
          {status.errorHint && <span style={{ color: "var(--warn)" }}> — {status.errorHint}</span>}
        </div>
      )}

      {checkHist.length > 0 && <PulseStrip history={checkHist} stalled={stalled} degraded={degraded} />}

      <RecentActivity rows={recent} now={now} status={recentStatus} />

      <SiteControls
        siteId={row.id}
        siteName={row.name}
        enabled={row.enabled}
        deprecated={!!def.deprecated}
        schedule={String(def.schedule ?? def.intervalMinutes ?? "")}
        scheduleOptions={scheduleOptions}
        titleContains={def.filters?.titleContains ?? []}
        sourceJson={JSON.stringify(def.source, null, 2)}
        currentWindow={parseWindowRules(schedules[`${row.id}_window`]?.rules)}
      />
    </div>
  );
}
