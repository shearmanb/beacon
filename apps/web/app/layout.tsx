import "./globals.css";
import type { ReactNode } from "react";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { AutoRefresh } from "../components/AutoRefresh";

export const metadata = {
  title: "Beacon",
  description: "Stock-monitoring dashboard",
};

// Shown in the header so it's obvious which build is live. Bump on a notable
// release (mirrors the v1 dashboard's "v0.4 · App update" stamp).
const APP_VERSION = "v2";
const APP_UPDATED = "2026-06-24";

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
              <a href="/history">History</a>
              <a href="/schedules">Schedules</a>
              <a href="/reminders">Reminders</a>
            </nav>
            <div className="spacer" />
            <span className="ver mono" title={`Last app update: ${APP_UPDATED} ET`}>
              {APP_VERSION} · {APP_UPDATED}
            </span>
            <ThemeSwitcher />
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
