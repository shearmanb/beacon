import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Beacon",
  description: "Stock-monitoring dashboard",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="flightdeck">
      <body>
        <div className="app">
          <header className="hdr">
            <div className="wordmark">
              <span className="beak">◆</span> BEACON
            </div>
            <nav className="nav">
              <a href="/">Sites</a>
              <a href="/products">Products</a>
              <a href="/history">History</a>
              <a href="/reminders">Reminders</a>
            </nav>
            <div className="spacer" />
          </header>
          {children}
        </div>
      </body>
    </html>
  );
}
