// Shared small components
const { useState, useEffect, useMemo } = React;
const fmt$ = (n) => "$" + n.toFixed(2).replace(/\.00$/, "");

function Dot({ s }) { return <span className={"dot " + s}></span>; }

function CheckTimeline({ s, checking, cadence, quick }) {
  // last 60 minutes; positions = (60 - minutesAgo) / 60
  const pos = (m) => Math.max(0, Math.min(100, ((60 - m) / 60) * 100));
  const checks = s.checks || [];
  const found = s.found || [];
  const fails = s.fails || [];
  return (
    <div className={"tl" + (checking ? " live" : "")}>
      <div className="track">
        <div className="rail-line"></div>
        {checks.map((m, i) => <div key={"c" + i} className="tick" style={{ left: pos(m) + "%" }} title={m + "m ago — checked"}></div>)}
        {found.map((m, i) => <div key={"f" + i} className="ev-found" style={{ left: pos(m) + "%" }} title={m + "m ago — new bottle found"}></div>)}
        {fails.map((m, i) => <div key={"x" + i} className="ev-fail" style={{ left: pos(m) + "%" }} title={m + "m ago — check failed"}></div>)}
        <div className="now-dot"></div>
      </div>
      <div className="tl-line">
        <span className="tl-tally" title="Last hour: checks · finds · fails">
          <span>{checks.length}✓</span>
          <span className={found.length ? "f" : ""}>{found.length}◆</span>
          <span className={fails.length ? "x" : ""}>{fails.length}✗</span>
        </span>
        <span className="tl-cad" title="Cadence · last check · last find">
          every <b className={quick ? "qk" : ""}>{cadence || s.interval}</b>{quick ? "⚡" : ""} · {checking ? "checking…" : s.lastChecked} · find {s.lastChange}
        </span>
      </div>
    </div>
  );
}

function Chip({ kind, children }) { return <span className={"chip " + kind}>{children}</span>; }

function Switch({ on, onClick }) {
  return <button className={"sw" + (on ? " on" : "")} onClick={onClick} aria-pressed={on}></button>;
}

function SectionHead({ title, rev, right }) {
  return (
    <div className={"sect-hd" + (rev ? " rev" : "")}>
      <span className="tick"></span>
      <h2><span className="h2-star">★ </span>{title}</h2>
      <span className="rule"></span>
      {right}
    </div>
  );
}

function BottlePh({ label }) {
  return <div className="rev-img"><span>{label || "BOTTLE IMG"}</span></div>;
}

// ---- Reveries hero grid ----
function ReveriesSection() {
  const [showAll, setShowAll] = useState(false);
  const all = [...window.BEACON_DATA.reveries].sort((a, b) => (b.stock ? 1 : 0) - (a.stock ? 1 : 0));
  const liveCount = all.filter(i => i.stock).length;
  const CAP = 6; // sold-out tiles shown when collapsed (~one row)
  const soldOut = all.filter(i => !i.stock);
  const items = showAll ? all : all.filter(i => i.stock).concat(soldOut.slice(0, CAP));
  const hidden = soldOut.length - CAP;
  return (
    <section className="sect" data-screen-label="Reveries">
      <SectionHead title="Reveries · Jay West" rev
        right={<span className="label" style={{ color: liveCount ? "var(--ok)" : "var(--faint)" }}>{liveCount} live / {all.length} tracked</span>} />
      <div className="rev-strip">
        {items.map((p, i) => (
          <div key={i} className={"rev-card" + (p.stock ? " live big" : " dimmed")}>
            <BottlePh label={p.stock ? "BOTTLE IMG" : "IMG"} />
            <div className="rev-body">
              <div style={{ display: "flex", justifyContent: "space-between", gap: "8px" }}>
                {p.stock ? <Chip kind="stock"><span className="dot ok"></span>In stock</Chip> : <Chip kind="out">Sold out</Chip>}
              </div>
              <div className="nm">{p.name}</div>
              <div className="rev-foot">
                <span className="site">{p.site}</span>
                <span className="pr num">{fmt$(p.price)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
      {hidden > 0 && (
        <button className="btn ghost sm" style={{ width: "100%", marginTop: "10px" }} onClick={() => setShowAll(!showAll)}>
          {showAll ? "▴ show less" : "▾ show all " + soldOut.length + " sold out"}
        </button>
      )}
    </section>
  );
}

// ---- Products table ----
function ProductsSection() {
  const [q, setQ] = useState("");
  const [site, setSite] = useState("All sites");
  const [avail, setAvail] = useState("All availability");
  const data = window.BEACON_DATA.products;
  const sites = ["All sites", ...new Set(data.map(p => p.site))];
  const [sort, setSort] = useState({ key: null, dir: 1 });
  const rows = data.filter(p =>
    (site === "All sites" || p.site === site) &&
    (avail === "All availability" || (avail === "In stock" ? p.stock : !p.stock)) &&
    p.name.toLowerCase().includes(q.toLowerCase())
  );
  if (sort.key) {
    rows.sort((a, b) => {
      const va = sort.key === "status" ? (a.stock ? 0 : 1) : a[sort.key];
      const vb = sort.key === "status" ? (b.stock ? 0 : 1) : b[sort.key];
      return (typeof va === "string" ? va.localeCompare(vb) : va - vb) * sort.dir;
    });
  }
  const th = (key, lbl, right) => (
    <th className="sortable" style={right ? { textAlign: "right" } : undefined}
      onClick={() => setSort(s => ({ key, dir: s.key === key ? -s.dir : 1 }))}>
      {lbl}<span className="arr">{sort.key === key ? (sort.dir === 1 ? " ▴" : " ▾") : ""}</span>
    </th>
  );
  return (
    <section className="sect" data-screen-label="Products">
      <SectionHead title="All Products" right={<span className="label">{rows.length} shown</span>} />
      <div className="filters">
        <input className="in search" placeholder="Search products…" value={q} onChange={e => setQ(e.target.value)} />
        <select className="in" value={site} onChange={e => setSite(e.target.value)}>{sites.map(s => <option key={s}>{s}</option>)}</select>
        <select className="in" value={avail} onChange={e => setAvail(e.target.value)}>
          <option>All availability</option><option>In stock</option><option>Sold out</option>
        </select>
      </div>
      <table className="ptable">
        <thead><tr><th></th>{th("name", "Product")}{th("site", "Site")}{th("price", "Price", true)}{th("status", "Status")}<th></th></tr></thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={i}>
              <td><div className="pthumb"></div></td>
              <td className="pname">{p.name} {p.rev && <Chip kind="rev">Reveries</Chip>} {p.isNew && <Chip kind="new">New</Chip>}</td>
              <td className="psite">{p.site}</td>
              <td className="pprice">{fmt$(p.price)}{p.delta ? <span className={"delta " + (p.delta > 0 ? "up" : "down")}>{p.delta > 0 ? " ↑" : " ↓"}{fmt$(Math.abs(p.delta))}</span> : null}</td>
              <td>{p.stock ? <Chip kind="stock"><span className="dot ok"></span>In stock</Chip> : <Chip kind="out">Sold out</Chip>}</td>
              <td><button className="btn ghost sm ignore">Ignore</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

Object.assign(window, { Dot, CheckTimeline, Chip, Switch, SectionHead, BottlePh, ReveriesSection, ProductsSection, fmt$ });
