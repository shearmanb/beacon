import { getStore } from "../../lib/store";
import { AddReminderForm, ReminderControls } from "../../components/Reminders";

export const dynamic = "force-dynamic";

export default async function RemindersPage() {
  const store = await getStore();
  const items = await store.reminders.list();

  return (
    <>
      <div className="sect-hd">
        <h2>Drop reminders</h2>
        <span className="rule" />
      </div>
      <AddReminderForm />
      <div className="card">
        {items.map((r) => (
          <div className={`list-item ${r.done ? "done" : ""}`} key={r.id}>
            {r.priority && <span className="star">★</span>}
            <span className="mono faint" style={{ fontSize: 12, minWidth: 120 }}>
              {r.date}
              {r.time ? ` ${r.time}` : ""}
            </span>
            <span>{r.text}</span>
            <ReminderControls id={r.id} done={r.done} />
          </div>
        ))}
        {items.length === 0 && <p className="muted">No reminders. Add one above.</p>}
      </div>
    </>
  );
}
