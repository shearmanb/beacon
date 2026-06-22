import { getStore } from "../../lib/store";
import { SchedulesManager, type ScheduleEntry } from "../../components/SchedulesManager";

export const dynamic = "force-dynamic";

export default async function SchedulesPage() {
  const store = await getStore();
  const schedules = await store.schedules.all();
  const list: ScheduleEntry[] = Object.entries(schedules).map(([id, d]) => ({
    id,
    label: d.label ?? id,
    rules: d.rules,
    builtin: d.builtin === true,
  }));

  return (
    <>
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
