// One site on the Sites page (server component). Extracted from page.tsx in the
// 2026-10-30 simplification. The face answers three questions and nothing else:
//   1. are checks OK?  → health dot + ONE status line (lib/tile-status.ts) +
//      the last-60-min PulseStrip
//   2. what came up here lately?  → RecentActivity (alert history, 3 rows)
//   3. go imminent, for how long?  → ImminentControl in the header
// Everything that edits the site is inside the collapsed ⚙ panel (SiteControls).

import type { SiteRow } from "@beacon/db";
import type { SiteDefinition, SiteState } from "@beacon/core";
import type { Schedules } from "@beacon/shared";
import { DEFAULT_IMMINENT_DURATION_MIN, imminentInterval, type ErrorLogEntry } from "@beacon/shared";
import { nowInterval } from "../lib/cadence";
import { predictedNextCheckAt, formatEta } from "../lib/nextcheck";
import { tileStatus } from "../lib/tile-status";
import { parseWindowRules } from "../lib/site-forms";
import type { Health } from "../lib/health";
import type { ActivityRow } from "../lib/activity";
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
  const durMs = (def.imminentDurationMinutes ?? DEFAULT_IMMINENT_DURATION_MIN) * 60_000;
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
  now,
}: {
  row: SiteRow;
  state: SiteState | undefined;
  health: Health;
  schedules: Schedules;
  scheduleOptions: ScheduleOption[];
  recent: ActivityRow[];
  now: number;
}) {
  const def = row.definition;
  const url = siteUrl(def);
  const errorLog = state?.["errorLog"] as ErrorLogEntry[] | undefined;
  // Predicted next-check instant, through the exact formula the worker uses
  // (lib/nextcheck.ts) — a read-only prediction, not a scheduling decision.
  const nextCheckAtIso = predictedNextCheckAt(
    row.enabled,
    def,
    state?.lastChecked,
    state?.["cooldownUntil"] as string | null | undefined,
    schedules,
    now,
    errorLog,
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

      <RecentActivity rows={recent} now={now} />

      <SiteControls
        siteId={row.id}
        siteName={row.name}
        enabled={row.enabled}
        deprecated={!!def.deprecated}
        schedule={String(def.schedule ?? def.intervalMinutes ?? "")}
        scheduleOptions={scheduleOptions}
        imminentInterval={def.imminentIntervalMinutes ?? null}
        imminentDuration={def.imminentDurationMinutes ?? null}
        titleContains={def.filters?.titleContains ?? []}
        sourceJson={JSON.stringify(def.source, null, 2)}
        currentWindow={parseWindowRules(schedules[`${row.id}_window`]?.rules)}
      />
    </div>
  );
}
