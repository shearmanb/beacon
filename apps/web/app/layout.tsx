import "./globals.css";
import type { ReactNode } from "react";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { AutoRefresh } from "../components/AutoRefresh";
import { DeployStamp } from "../components/DeployStamp";
import { DEFAULT_THEME, THEME_IDS } from "../lib/themes";

export const metadata = {
  title: "Beacon",
  description: "Stock-monitoring dashboard",
};

// Explicit rather than relying on the framework default — the dashboard is read
// on a phone as often as a laptop, and losing this silently reverts every
// mobile layout rule to a 980px-wide zoomed-out render.
export const viewport = {
  width: "device-width",
  initialScale: 1,
};

// Shown in the footer so it's obvious which build is live. The live "updated"
// time + Railway deploy ID render beside it via <DeployStamp /> (self-maintaining
// from Railway env), so no hardcoded date to go stale here anymore.
const APP_VERSION = "v2";

// Set the saved theme before paint to avoid a flash of the default theme. Only
// ids in lib/themes.ts are honoured; anything else keeps the default.
const themeInit = `try{var k=${JSON.stringify(THEME_IDS)},t=localStorage.getItem('beacon_theme');if(t&&k.indexOf(t)>=0)document.documentElement.dataset.theme=t;}catch(e){}`;

// Header = the four pages used every day; the rest sit under "More". A <details>
// needs no client JS, and a navigation replaces the page, which closes it.
const MAIN_LINKS = [
  { href: "/", label: "Sites" },
  { href: "/products", label: "Products" },
  { href: "/history", label: "History" },
  { href: "/schedules", label: "Cadence", title: "Cadence control panel — every site's check windows, cadence and controls, plus the named schedules" },
];
const MORE_LINKS = [
  { href: "/add", label: "Add site" },
  { href: "/errors", label: "Errors" },
  { href: "/unicorn", label: "Unicorn", title: "Unicorn Auctions watcher — isolated from site tracking" },
  { href: "/api/export/history", label: "Export", title: "Download the full alert history as JSONL — feed it to Claude to mine drop-timing patterns" },
  { href: "/reminders", label: "Reminders" },
  { href: "https://reveriesregistry.com/", label: "Reveries Registry ↗", title: "The Reveries Registry — fan-made archive of every Reveries release (opens in a new tab)", external: true },
];

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: themeInit rewrites data-theme on <html> before
    // React hydrates (that's the point: no flash), so the attribute differs from
    // the server's default by design. It covers this element's attributes only.
    <html lang="en" data-theme={DEFAULT_THEME} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        <AutoRefresh />
        <div className="app">
          <header className="hdr">
            <div className="wordmark">
              <span className="beak">◆</span> BEACON
            </div>
            <nav className="nav">
              {MAIN_LINKS.map((l) => (
                <a key={l.href} href={l.href} title={l.title}>
                  {l.label}
                </a>
              ))}
              <details className="nav-more">
                <summary>More ▾</summary>
                <div className="nav-menu">
                  {MORE_LINKS.map((l) => (
                    <a
                      key={l.href}
                      href={l.href}
                      title={l.title}
                      {...("external" in l && l.external ? { target: "_blank", rel: "noreferrer" } : {})}
                    >
                      {l.label}
                    </a>
                  ))}
                </div>
              </details>
            </nav>
          </header>
          {children}
          <footer className="ftr">
            <DeployStamp />
            <span className="ftr-right">
              <span className="ver mono">{APP_VERSION}</span>
              <ThemeSwitcher />
            </span>
          </footer>
        </div>
      </body>
    </html>
  );
}
