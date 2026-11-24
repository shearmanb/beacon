// vABC limited-availability list watcher: the module's only surface. Reads
// the one meta blob the worker job writes. Read-only apart from "Check now".

import { getStore } from "../../lib/store";
import { ago } from "../../lib/health";
import { parseVabcState, VABC_STATE_META_KEY, VABC_URL, type VabcItem } from "@beacon/core";
import { requestVabcCheck } from "../actions";

export const dynamic = "force-dynamic";

function nextLabel(nextDueAt: string | null): string {
  if (!nextDueAt) return " · first check due now";
  const ms = Date.parse(nextDueAt) - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return " · next check due now";
  const h = Math.round(ms / 3_600_000);
  return h < 1 ? " · next in <1h" : ` · next in ~${h}h`;
}

function Bottle({ item }: { item: VabcItem }) {
  return item.url ? (
    <a href={item.url} target="_blank" rel="noreferrer">
      {item.name}
    </a>
  ) : (
    <>{item.name}</>
  );
}

function ChangeList({ label, items }: { label: string; items: VabcItem[] }) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginTop: 6 }}>
      <strong>{label}</strong>
      <ul style={{ margin: "4px 0 0 18px" }}>
        {items.map((i) => (
          <li key={`${i.section}:${i.code}`}>
            <Bottle item={i} /> <span className="mono faint">· {i.code}</span>
            {i.section === "onShelf" && <span className="faint"> (on-shelf list)</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default async function VabcPage() {
  const store = await getStore();
  const state = parseVabcState(await store.meta.get(VABC_STATE_META_KEY));
  const limited = state.items.filter((i) => i.section === "limited");
  const onShelf = state.items.filter((i) => i.section === "onShelf");
  const rows = [...limited, ...onShelf];

  return (
    <>
      <div className="sect-hd">
        <h2>🥃 vABC limited list</h2>
        <span className="rule" />
        <span className="muted mono" style={{ fontSize: 12 }}>
          last good read {ago(state.lastSuccessAt)}
          {nextLabel(state.nextDueAt)} · {limited.length} limited · {onShelf.length} on-shelf
          {state.updatedLabel ? ` · vABC stamp ${state.updatedLabel}` : ""}
        </span>
      </div>

      <p className="hint" style={{ marginBottom: 12 }}>
        Reads the <a href={VABC_URL} target="_blank" rel="noreferrer">vABC limited availability page</a> once
        a day and posts additions and removals to Discord as one message. A read that is blocked or looks wrong
        never counts as a change: Beacon retries every ~3 h and warns on Discord after 3 failures in a row.
      </p>

      {state.lastError && (
        <div className="banner" style={{ marginBottom: 12 }}>
          ⚠ Last check failed ({state.consecutiveFailures} in a row, last attempt {ago(state.lastAttemptAt)}):{" "}
          <span className="mono">{state.lastError}</span>
          {" — "}changes are not being tracked until a read succeeds. Site tracking is unaffected.
        </div>
      )}

      <form action={requestVabcCheck} style={{ marginBottom: 14 }}>
        <button className="btn" disabled={state.forceCheckRequested} title="The worker picks this up on its next ~60s loop">
          {state.forceCheckRequested ? "Check queued…" : "▶ Check now"}
        </button>
      </form>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Recent changes</h3>
        {state.changes.length === 0 ? (
          <p className="hint">
            {state.lastSuccessAt ? "No additions or removals since the first read." : "No successful read yet."}
          </p>
        ) : (
          state.changes.map((c) => (
            <div key={c.at} style={{ marginTop: 10 }}>
              <span className="mono muted" style={{ fontSize: 12 }}>
                {new Date(c.at).toLocaleString("en-US", { timeZone: "America/New_York" })} ET
                {c.updatedLabel ? ` · vABC stamp ${c.updatedLabel}` : ""}
              </span>
              <ChangeList label={`➕ Added (${c.added.length})`} items={c.added} />
              <ChangeList label={`➖ Removed (${c.removed.length})`} items={c.removed} />
            </div>
          ))
        )}
      </div>

      {rows.length > 0 && (
        <table className="ptable">
          <thead>
            <tr>
              <th>Bottle</th>
              <th>Code</th>
              <th>List</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((i) => (
              <tr key={`${i.section}:${i.code}`}>
                <td data-label="Bottle">
                  <Bottle item={i} />
                </td>
                <td className="mono" data-label="Code">
                  {i.code}
                </td>
                <td data-label="List">{i.section === "onShelf" ? "On-shelf" : "Limited"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
