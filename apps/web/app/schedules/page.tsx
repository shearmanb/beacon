import { getStore } from "../../lib/store";
import { SchedulesManager, type ScheduleEntry } from "../../components/SchedulesManager";
import { CadenceTable, type CadenceSite } from "../../components/CadenceTable";

export const dynamic = "force-dynamic";

export default async function SchedulesPage() {
  const store = await getStore();
  const [schedules, siteRows] = await Promise.all([store.schedules.all(), store.sites.list()]);
  const list: ScheduleEntry[] = Object.entries(schedules).map(([id, d]) => ({
    id,
    label: d.label ?? id,
    rules: d.rules,
    builtin: d.builtin === true,
  }));
  const sites: CadenceSite[] = siteRows.map((r) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled,
    definition: r.definition,
  }));

  return (
    <>
      <div className="sect-hd">
        <h2>Site cadence</h2>
        <span className="rule" />
        <span className="muted mono" style={{ fontSize: 12 }}>
          {sites.filter((s) => s.enabled).length} monitored
        </span>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        How often each site is checked, resolved for today (ET) by the same engine the worker runs.
        Real spacing adds ±10–15% jitter, and failure cooldowns can stretch it (clamped to ≤15 min
        inside tight windows). ⚡ = imminent override.
      </p>
      <CadenceTable sites={sites} schedules={schedules} />

      <div className="sect-hd">
        <h2>Schedules</h2>
        <span className="rule" />
        <span className="muted mono" style={{ fontSize: 12 }}>
          {list.length} defined
        </span>
      </div>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        Named schedules vary the check interval by time of day (Eastern). Sites pick one from the
        Schedule dropdown on their card.
      </p>
      <SchedulesManager initial={list} />
    </>
  );
}
