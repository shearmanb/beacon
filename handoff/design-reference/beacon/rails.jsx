// Left rail (reminders) + right rail (pending / collection tabs)
function LeftRail() {
  const [items, setItems] = React.useState(window.BEACON_DATA.reminders);
  const [txt, setTxt] = React.useState("");
  const [date, setDate] = React.useState("2026-06-12");
  const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  const add = () => {
    if (!txt.trim()) return;
    const dt = new Date(date + "T12:00:00");
    const lbl = isNaN(dt) ? "—" : MONTHS[dt.getMonth()] + " " + String(dt.getDate()).padStart(2, "0");
    const days = isNaN(dt) ? 0 : Math.max(0, Math.round((dt - new Date()) / 86400000));
    setItems([{ date: lbl, d: days, label: txt.trim(), priority: false, done: false }, ...items]);
    setTxt("");
  };
  const toggle = (it) => setItems(items.map((x) => x === it ? { ...x, done: !x.done } : x));
  const jumpToSites = (e) => {
    e.stopPropagation();
    const el = document.querySelector('section[data-screen-label="Sites"]');
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 70, behavior: "smooth" });
  };
  const sorted = [...items].sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || a.d - b.d);
  const upcoming = items.filter(i => !i.done).length;
  return (
    <aside className="rail" data-screen-label="Reminders rail">
      <div className="rail-hd"><h3>Drop Reminders</h3><span className="cnt">{upcoming}</span></div>
      <div className="rail-form">
        <div className="row2">
          <input className="in" type="date" value={date} onChange={e => setDate(e.target.value)} />
          <input className="in" type="time" />
        </div>
        <input className="in" placeholder="What to remember…" value={txt}
          onChange={e => setTxt(e.target.value)} onKeyDown={e => e.key === "Enter" && add()} />
        <button className="btn primary sm" onClick={add}>+ Add reminder</button>
      </div>
      {sorted.map((r, i) => {
        const soon = !r.done && r.d <= 2;
        return (
          <div key={r.label} className={"rem-item" + (r.priority ? " pri" : "") + (r.done ? " done" : "")} onClick={() => toggle(r)} style={{ cursor: "pointer" }}>
            <span className="rem-date">{r.date}</span>
            <span className="rem-label">{r.label}
              {r.link && !r.done && <button className="rem-link" onClick={jumpToSites} title={"Jump to " + r.link.name}>↗ {r.link.name}</button>}
            </span>
            <span className={"rem-t" + (soon ? " soon" : "")}>{r.done ? "done" : "T-" + r.d + "d"}</span>
          </div>
        );
      })}
    </aside>
  );
}

function RightRail() {
  const [tab, setTab] = React.useState("pending");
  const [pending, setPending] = React.useState(window.BEACON_DATA.pending);
  const [collection, setCollection] = React.useState(window.BEACON_DATA.collection);
  const STEPS = ["ordered", "shipped", "delivered"];
  const setStatus = (item, st) => setPending(pending.map(p => p === item ? { ...p, status: st } : p));
  const moveToCollection = (item) => {
    setPending(pending.filter(p => p !== item));
    setCollection([{ name: item.name, proof: "—", acquired: "2026", paid: item.cost }, ...collection]);
  };
  const collValue = collection.reduce((a, c) => a + c.paid, 0);
  return (
    <aside className="rail right" data-screen-label="Pending / Collection rail">
      <div className="rtabs">
        <button className={tab === "pending" ? "act" : ""} onClick={() => setTab("pending")}>PENDING · {pending.length}</button>
        <button className={tab === "coll" ? "act" : ""} onClick={() => setTab("coll")}>COLLECTION · {collection.length}</button>
      </div>

      {tab === "pending" && (
        <div>
          <div className="rail-form">
            <input className="in" placeholder="Bottle *" />
            <div className="row2">
              <input className="in" placeholder="Cost $" />
              <input className="in" placeholder="Retailer" />
            </div>
            <div className="row2">
              <input className="in" type="date" />
              <input className="in" placeholder="ETA note" />
            </div>
            <button className="btn primary sm">+ Add to pending</button>
          </div>
          {pending.length === 0 && <div className="empty">No pending bottles.</div>}
          {pending.map((p, i) => {
            const idx = STEPS.indexOf(p.status);
            return (
              <div key={i} className="pend-item">
                <div className="nm">{p.name}</div>
                <div className="pend-meta"><span>{p.retailer}</span><span className="num">{fmt$(p.cost)}</span></div>
                <div className="pend-meta"><span>ordered {p.ordered}</span></div>
                <div className="steps">
                  {STEPS.map((st, j) => (
                    <button key={st} className={"step" + (j <= idx ? " on" : "") + (j === idx ? " cur" : "")}
                      onClick={() => setStatus(p, st)} title={"Mark " + st}>{st}</button>
                  ))}
                </div>
                {p.status !== "delivered" && <div className={"pend-eta" + (p.status === "shipped" ? " shipped" : "")}>{p.status === "shipped" ? "▸ " : "◌ "}{p.eta}</div>}
                {p.status === "delivered" && (
                  <button className="btn primary sm" style={{ width: "100%", marginTop: "7px" }} onClick={() => moveToCollection(p)}>✓ Add to collection</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === "coll" && (
        <div>
          <div className="coll-total"><span>est. invested</span><b className="num">{fmt$(collValue)}</b></div>
          {collection.map((c, i) => (
            <div key={i} className="coll-item">
              <span className="nm">{c.name}</span>
              <span className="pf">{c.proof}pf · {c.acquired}</span>
            </div>
          ))}
          <button className="btn ghost sm" style={{ width: "100%", marginTop: "10px" }}>+ Add bottle</button>
        </div>
      )}
    </aside>
  );
}

Object.assign(window, { LeftRail, RightRail });
