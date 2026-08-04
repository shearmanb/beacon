import "./globals.css";
import type { ReactNode } from "react";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { AutoRefresh } from "../components/AutoRefresh";
import { DeployStamp } from "../components/DeployStamp";

export const metadata = {
  title: "Beacon",
  description: "Stock-monitoring dashboard",
};

// Shown in the header so it's obvious which build is live. The live "updated"
// time + Railway deploy ID render below via <DeployStamp /> (self-maintaining
// from Railway env), so no hardcoded date to go stale here anymore.
const APP_VERSION = "v2";

// Set the saved theme before paint to avoid a flash of the default theme.
const themeInit = `try{var t=localStorage.getItem('beacon_theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="flightdeck">
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
              <a href="/">Sites</a>
              <a href="/add">Add site</a>
              <a href="/products">Products</a>
              <a href="/errors">Errors</a>
              <a href="/history">History</a>
              <a href="/unicorn" title="Unicorn Auctions watcher — isolated from site tracking">Unicorn</a>
              <a href="/api/export/history" title="Download the full alert history as JSONL — feed it to Claude to mine drop-timing patterns">Export</a>
              <a href="/schedules">Schedules</a>
              <a href="/reminders">Reminders</a>
            </nav>
            <div className="spacer" />
            <span className="ver mono">{APP_VERSION}</span>
            <ThemeSwitcher />
          </header>
          <DeployStamp />
          {children}
        </div>
      </body>
    </html>
  );
}
