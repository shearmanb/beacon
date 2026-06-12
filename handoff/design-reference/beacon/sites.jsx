// Sites section — flat compact cards
function SiteCard({ s, view, checking }) {
  const [mon, setMon] = React.useState(s.monitoring);
  const [imm, setImm] = React.useState(s.imminent);
  const [open, setOpen] = React.useState(false);
  const [quick, setQuick] = React.useState("");
  const [quickCad, setQuickCad] = React.useState(null); // active quick-cadence override (minutes)
  const showSettings = view === "detailed" || open;
  const zero = s.inStock === 0;
  const cadence = quickCad ? quickCad + "m" : s.interval;
  const applyQuick = () => { const n = parseInt(quick, 10); if (n > 0) { setQuickCad(n); setQuick(""); } };
  return (
    <div className={"site-card" + (checking ? " checking" : "")} data-screen-label={"Site: " + s.name}>
      {/* header row: dot · name · labeled stats · badges */}
      <div className="site-hd">
        <Dot s={checking ? "warn" : s.health} />
        <span className="name">{s.name}</span>
        <span className={"sc-stat" + (zero ? " zero" : "")} title="In stock / tracked">
          <span className="sc-lbl">stock</span><b>{s.inStock}</b><span className="sc-dim">/{s.products}</span>
        </span>
        <span className="sc-stat" title="Next check">
          <span className="sc-lbl">next</span>
          <span style={{ color: checking ? "var(--accent)" : undefined }}>{checking ? "now" : (s.nextIn < 1 ? "<1m" : s.nextIn + "m")}</span>
        </span>
        {!showSettings && <span className={"sicon" + (mon ? " on" : "")} title="Monitoring">MON</span>}
        {!showSettings && imm && <span className="sicon bolt">IMM</span>}
      </div>

      {/* timeline + single meta line */}
      <CheckTimeline s={s} checking={checking} cadence={cadence} quick={!!quickCad} />

      {/* settings — one wrapping row */}
      {showSettings && (
        <div className="site-cfg">
          <select className="in" style={{ flex: "1 1 110px" }} defaultValue={s.schedule} title="Check schedule">
            {window.BEACON_DATA.scheduleOptions.map(o => <option key={o}>{o}</option>)}
          </select>
          <span className="cfg-sep">MON</span>
          <Switch on={mon} onClick={() => setMon(!mon)} />
          <span className="cfg-sep">IMM</span>
          <Switch on={imm} onClick={() => setImm(!imm)} />
          <span className="cfg-sep" title="Imminent mode turns itself off after this many minutes">AUTO-OFF</span>
          <input className="in" style={{ width: "38px", textAlign: "center" }} defaultValue={s.autoOff} title="auto-off minutes" />
          {quickCad ? (
            <button className="btn ghost sm" style={{ color: "var(--warn)" }} onClick={() => setQuickCad(null)} title="Quick cadence active — click to revert to schedule">⚡{quickCad}m ✕</button>
          ) : (
            <span className="qk-wrap" title="Quick cadence: temporarily check every N minutes (Enter to apply)">
              <span className="cfg-sep">⚡QUICK</span>
              <input className="in" style={{ width: "34px", textAlign: "center" }} placeholder="m" value={quick}
                onChange={e => setQuick(e.target.value.replace(/[^0-9]/g, ""))}
                onKeyDown={e => e.key === "Enter" && applyQuick()} onBlur={() => quick && applyQuick()} />
            </span>
          )}
        </div>
      )}
      {view === "compact" && (
        <button className="btn ghost sm" style={{ marginTop: "5px", width: "100%", padding: "2px 0" }}
          onClick={() => setOpen(!open)}>{open ? "▴" : "▾"}</button>
      )}
    </div>
  );
}

function SitesSection({ ekgOn }) {
  const [view, setView] = React.useState(() => localStorage.getItem("beacon.sitesView") || "detailed");
  const [collapsed, setCollapsed] = React.useState(() => localStorage.getItem("beacon.sitesCollapsed") === "1");
  const [showLegend, setShowLegend] = React.useState(false);
  const setViewP = (v) => { setView(v); localStorage.setItem("beacon.sitesView", v); };
  const toggleCollapsed = () => { const c = !collapsed; setCollapsed(c); localStorage.setItem("beacon.sitesCollapsed", c ? "1" : "0"); };
  const [checkingId, setCheckingId] = React.useState(null);
  const sites = window.BEACON_DATA.sites;
  // simulate a live check sweeping a random site every ~8s
  React.useEffect(() => {
    if (!ekgOn) { setCheckingId(null); return; }
    let alive = true;
    const tick = () => {
      if (!alive) return;
      const s = sites[Math.floor(Math.random() * sites.length)];
      setCheckingId(s.id);
      setTimeout(() => { if (alive) setCheckingId(null); }, 3000);
    };
    tick();
    const iv = setInterval(tick, 8000);
    return () => { alive = false; clearInterval(iv); };
  }, [ekgOn]);
  const healthy = sites.filter(s => s.health === "ok").length;
  return (
    <section className="sect" data-screen-label="Sites">
      <SectionHead title="Sites" right={
        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <span className="label" style={{ color: healthy === sites.length ? "var(--ok)" : "var(--warn)" }}>{healthy}/{sites.length} healthy</span>
          {!collapsed && (
            <div className="seg">
              <button className={view === "mini" ? "act" : ""} onClick={() => setViewP("mini")}>mini</button>
              <button className={view === "compact" ? "act" : ""} onClick={() => setViewP("compact")}>compact</button>
              <button className={view === "detailed" ? "act" : ""} onClick={() => setViewP("detailed")}>detailed</button>
            </div>
          )}
          <button className="btn ghost sm" onClick={toggleCollapsed} title={collapsed ? "Expand sites" : "Collapse sites"}>{collapsed ? "▾ expand" : "▴ collapse"}</button>
          <button className="btn ghost sm" onClick={() => setShowLegend(true)} title="What does everything on a site tile mean?">? guide</button>
        </div>
      } />
      {showLegend && <TileLegend onClose={() => setShowLegend(false)} />}
      {collapsed ? (
        <div className="sites-mini">
          {sites.map(s => <SitePill key={s.id} s={s} checking={checkingId === s.id} />)}
        </div>
      ) : view === "mini" ? (
        <div className="sites-mini">
          {sites.map(s => <SitePill key={s.id} s={s} checking={checkingId === s.id} />)}
        </div>
      ) : (
        <div className={"sites-grid " + view}>
          {sites.map(s => <SiteCard key={s.id} s={s} view={view} checking={checkingId === s.id} />)}
        </div>
      )}
    </section>
  );
}

function SitePill({ s, checking }) {
  const zero = s.inStock === 0;
  return (
    <div className={"site-pill" + (checking ? " checking" : "")} title={s.name + " — " + s.inStock + "/" + s.products + " in stock · " + s.revStock + " Reveries · checks every " + s.interval + " · " + s.schedule}>
      <Dot s={checking ? "warn" : s.health} />
      <span className="pname">{s.name}</span>
      <span className={"stock-frac" + (zero ? " zero" : "")}><b>{s.inStock}</b><span style={{ color: "var(--faint)" }}>/{s.products}</span></span>
      {s.revStock > 0 && <span className="pill-rev" title="Reveries in stock">R·{s.revStock}</span>}
      {s.imminent && <span className="sicon bolt">IMM</span>}
      <span className="pnext" title="Current check cadence">{checking ? "…" : "↻ " + s.interval}</span>
    </div>
  );
}

Object.assign(window, { SiteCard, SitesSection, SitePill });

// ---- Tile guide: annotated map of every element on a site tile ----
function TileLegend({ onClose }) {
  React.useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const G = ({ title, children }) => (
    <div className="lg-group"><div className="lg-title">{title}</div>{children}</div>
  );
  const R = ({ sym, name, desc }) => (
    <div className="lg-row"><span className="lg-sym">{sym}</span><span className="lg-name">{name}</span><span className="lg-desc">{desc}</span></div>
  );
  return (
    <div className="lg-overlay" onClick={onClose}>
      <div className="lg-panel" onClick={e => e.stopPropagation()} data-screen-label="Tile guide">
        <div className="lg-hd">
          <span>Site tile — element guide</span>
          <button className="btn ghost sm" onClick={onClose}>✕ close</button>
        </div>
        <G title="Header row">
          <R sym={<span className="dot ok"></span>} name="Health dot" desc="Green = site healthy · amber = degraded or being checked right now · red = down" />
          <R sym={<b style={{fontSize:"11px"}}>Name</b>} name="Site" desc="The monitored store / page" />
          <R sym={<span className="mono" style={{fontSize:"10px"}}>STOCK 1/3</span>} name="Stock" desc="Bottles in stock / total bottles tracked on this site (green when any in stock)" />
          <R sym={<span className="mono" style={{fontSize:"10px"}}>NEXT 8m</span>} name="Next check" desc="Minutes until the next scheduled check (‘now’ while one is running)" />
          <R sym={<span className="sicon on">MON</span>} name="Monitoring" desc="Green = monitoring on · gray = paused" />
          <R sym={<span className="sicon bolt">IMM</span>} name="Imminent" desc="Imminent-drop mode — checking at max speed; auto-disables after the AUTO-OFF time" />
        </G>
        <G title="Timeline (last 60 minutes)">
          <R sym={<span style={{display:"inline-block",width:"2px",height:"10px",background:"var(--muted)"}}></span>} name="Tick" desc="One check ran at this moment" />
          <R sym={<span style={{display:"inline-block",width:"8px",height:"8px",background:"var(--ok)",transform:"rotate(45deg)"}}></span>} name="Find" desc="A new bottle came in stock on this check" />
          <R sym={<span style={{display:"inline-block",width:"8px",height:"8px",borderRadius:"50%",border:"2px solid var(--err)"}}></span>} name="Fail" desc="This check errored (site down, blocked, timeout)" />
          <R sym={<span style={{display:"inline-block",width:"6px",height:"6px",borderRadius:"50%",background:"var(--accent)"}}></span>} name="Now" desc="Right edge = now; pulses while a check is in flight" />
          <R sym={<span className="mono" style={{fontSize:"9px"}}>4✓ 1◆ 0✗</span>} name="Tally" desc="Checks · finds · fails in the last hour (left side of the line under the track)" />
        </G>
        <G title="Meta line (right side)">
          <R sym={<span className="mono" style={{fontSize:"9px"}}>every 20m</span>} name="Cadence" desc="How often this site is being checked right now (amber + ⚡ = quick override active)" />
          <R sym={<span className="mono" style={{fontSize:"9px"}}>6:39 PM</span>} name="Last check" desc="Clock time of the most recent check" />
          <R sym={<span className="mono" style={{fontSize:"9px"}}>find 2h</span>} name="Last find" desc="How long since stock last changed here" />
        </G>
        <G title="Settings (detailed view, or ▾ on compact)">
          <R sym={<span className="mono" style={{fontSize:"9px"}}>Schedule ▾</span>} name="Schedule" desc="Named check plan, e.g. Working Hours Heavy = 5m 9–6, 20m 6–10, 2h overnight" />
          <R sym={<span className="mono" style={{fontSize:"9px"}}>MON ⭘</span>} name="Monitoring" desc="Master on/off for this site" />
          <R sym={<span className="mono" style={{fontSize:"9px"}}>IMM ⭘</span>} name="Imminent" desc="Max-speed checking for a drop you expect any minute" />
          <R sym={<span className="mono" style={{fontSize:"9px"}}>AUTO-OFF 20m</span>} name="Auto-off" desc="Imminent mode turns itself off after this many minutes" />
          <R sym={<span className="mono" style={{fontSize:"9px"}}>⚡ [min]</span>} name="Quick cadence" desc="Type minutes and press Enter = temporary flat interval that overrides the schedule; ⚡Nm ✕ reverts" />
        </G>
        <G title="Compact / mini">
          <R sym={<span className="sicon on">MON</span>} name="Badges" desc="When settings are hidden, MON/IMM state shows as badges in the header instead" />
          <R sym={<span className="pill-rev">R·1</span>} name="Reveries" desc="Number of Reveries bottles in stock at this site" />
          <R sym={<span className="mono" style={{fontSize:"9px"}}>↻ 20m</span>} name="Cadence" desc="Far-right timer = current check cadence" />
        </G>
      </div>
    </div>
  );
}
window.TileLegend = TileLegend;
