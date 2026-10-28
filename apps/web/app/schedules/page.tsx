import { DEFAULT_IMMINENT_DURATION_MIN } from "@beacon/shared";
import { getStore } from "../../lib/store";
import { SchedulesManager, type ScheduleEntry } from "../../components/SchedulesManager";
import { CadenceTable, type CadenceSite } from "../../components/CadenceTable";

export const dynamic = "force-dynamic";

export default async function SchedulesPage() {
  const store = await getStore();
  const [schedules, siteRows] = await Promise.all([store.schedules.all(), store.sites.list()]);
  // Per-site stored state (lastChecked / cooldownUntil) feeds the last/next
  // check readouts — read-only, same formula the worker uses (lib/nextcheck).
  const states = await Promise.all(siteRows.map((r) => store.state.load(r.id)));
  const list: ScheduleEntry[] = Object.entries(schedules).map(([id, d]) => ({
    id,
    label: d.label ?? id,
    rules: d.rules,
    builtin: d.builtin === true,
  }));
  const sites: CadenceSite[] = siteRows.map((r, i) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    deprecated: r.definition.deprecated === true,
    definition: r.definition,
    lastChecked: (states[i]?.lastChecked as string | null | undefined) ?? null,
    cooldownUntil: (states[i]?.cooldownUntil as string | null | undefined) ?? null,
  }));
  const enabled = sites.filter((s) => s.enabled);
  const imminentCount = enabled.filter((s) => s.definition.imminent === true).length;

  return (
    <>
      <div className="sect-hd">
        <h2>Cadence control panel</h2>
        <span className="rule" />
        <span className="muted mono" style={{ fontSize: 12 }}>
          {enabled.length} monitored · {sites.length - enabled.length} off
          {imminentCount > 0 ? ` · ⚡ ${imminentCount} imminent` : ""}
        </span>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Every site, its check windows and cadence as resolved for today (ET) by the same engine the
        worker runs — plus the controls to change them. Strip colour = intensity (≤5m · ≤15m · ≤60m ·
        slower); the outlined cell is the current hour. Real spacing adds ±10–15% jitter, and failure
        cooldowns can stretch it (clamped to ≤15 min inside tight windows). ⚡ = imminent override.
      </p>
      <CadenceTable sites={sites} schedules={schedules} defaultImminentDuration={DEFAULT_IMMINENT_DURATION_MIN} />

      <div className="sect-hd">
        <h2>Schedules</h2>
        <span className="rule" />
        <span className="muted mono" style={{ fontSize: 12 }}>
          {list.length} defined
        </span>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Named schedules vary the check interval by time of day (Eastern). Sites pick one from the
        Schedule dropdown on their card or in the panel above; a 🕒 window saves as{" "}
        <span className="mono">&lt;site&gt;_window</span>.
      </p>
      <SchedulesManager initial={list} />
    </>
  );
}
