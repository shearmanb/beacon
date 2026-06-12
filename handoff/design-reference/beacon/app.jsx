// Beacon app shell — header, layout, tweaks
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "reveries",
  "density": "regular",
  "ekgLive": true
}/*EDITMODE-END*/;

const THEMES = [
  ["reveries", "Reveries / T8KE — raven black & gold"],
  ["wildturkey", "Wild Turkey — 101 red & gold foil"],
  ["jackdaniels", "Jack Daniel's — aged series leather"],
  ["heavenhill", "Heaven Hill — heritage navy"],
  ["willett", "Willett — purple top / green top"],
  ["weller", "Weller — the rainbow"],
  ["makersmark", "Maker's Mark — red wax"],
  ["michters", "Michter's — US★1"],
  ["flightdeck", "Flightdeck — mission control"],
  ["flightpath", "Flightpath — purple ops"]
];
const THEME_LABELS = Object.fromEntries(THEMES);

function GlanceStrip() {
  const sites = window.BEACON_DATA.sites;
  const healthy = sites.filter(s => s.health === "ok").length;
  const inStock = window.BEACON_DATA.products.filter(p => p.stock).length;
  return (
    <div className="glance" data-screen-label="Mobile glance">
      <span><span className={"dot " + (healthy === sites.length ? "ok" : "warn")}></span> <b>{healthy}/{sites.length}</b> sites</span>
      <span className="gsep">·</span>
      <span style={{ color: inStock ? "var(--ok)" : undefined }}><b>{inStock}</b> in stock</span>
      <span className="gsep">·</span>
      <span style={{ color: "var(--muted)" }}>synced 6:50 PM</span>
    </div>
  );
}

function Header({ theme, onTheme }) {
  const sites = window.BEACON_DATA.sites;
  const inStock = window.BEACON_DATA.products.filter(p => p.stock).length;
  const total = sites.reduce((a, s) => a + s.products, 0);
  return (
    <header className="hdr" data-screen-label="Header">
      <div className="hdr-strip"></div>
      <div className="wordmark"><b><span className="beak">▲</span> BEACON</b><span className="label">v0.7</span></div>
      <div className="hdr-stats">
        <div className="hdr-stat"><span className="label">sites</span><span className="v">{sites.filter(s => s.health === "ok").length}<span className="dim">/{sites.length}</span></span></div>
        <div className="hdr-stat"><span className="label">tracked</span><span className="v">{total}</span></div>
        <div className="hdr-stat"><span className="label">in stock</span><span className="v" style={{ color: inStock ? "var(--ok)" : undefined }}>{inStock}</span></div>
        <div className="hdr-stat"><span className="label">last sync</span><span className="v">6:50<span className="dim"> PM</span></span></div>
      </div>
      <div className="hdr-actions">
        <button className="btn primary">▶ Run now</button>
        <button className="btn">Schedules</button>
        <button className="btn ghost">Token</button>
        <button className="btn ghost">Webhook</button>
        <select className="in" style={{ width: "auto", padding: "6px 8px", fontSize: "11px" }} value={theme}
          onChange={(e) => onTheme(e.target.value)} title="Color scheme">
          {THEMES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>
    </header>
  );
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  React.useEffect(() => {
    const root = document.documentElement;
    const theme = THEME_LABELS[t.theme] ? t.theme : "reveries";
    root.classList.add("theme-swap");
    root.dataset.theme = theme;
    root.dataset.density = t.density;
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-swap")));
  }, [t.theme, t.density]);
  return (
    <div className="app">
      <GlanceStrip />
      <LeftRail />
      <main className="main">
        <Header theme={THEME_LABELS[t.theme] ? t.theme : "reveries"} onTheme={(v) => setTweak("theme", v)} />
        <SitesSection ekgOn={t.ekgLive} />
        <ReveriesSection />
        <ProductsSection />
      </main>
      <RightRail />
      <TweaksPanel>
        <TweakSection label="Brand color scheme" />
        <TweakSelect label="Theme" value={THEME_LABELS[t.theme] || THEME_LABELS.reveries}
          options={Object.values(THEME_LABELS)}
          onChange={(v) => setTweak("theme", (THEMES.find(p => p[1] === v) || THEMES[0])[0])} />
        <TweakSection label="Layout" />
        <TweakRadio label="Density" value={t.density} options={["regular", "compact"]}
          onChange={(v) => setTweak("density", v)} />
        <TweakToggle label="Live check simulation" value={t.ekgLive}
          onChange={(v) => setTweak("ekgLive", v)} />
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
