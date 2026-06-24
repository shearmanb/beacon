import "./globals.css";
import type { ReactNode } from "react";
import { ThemeSwitcher } from "../components/ThemeSwitcher";
import { AutoRefresh } from "../components/AutoRefresh";

export const metadata = {
  title: "Beacon",
  description: "Stock-monitoring dashboard",
};

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
            <ThemeSwitcher />
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
