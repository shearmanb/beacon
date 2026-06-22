"use client";

import { useEffect, useState } from "react";

const THEMES = [
  { v: "flightdeck", l: "Flightdeck" },
  { v: "flightpath", l: "Flightpath" },
  { v: "reveries", l: "Reveries" },
  { v: "wildturkey", l: "Wild Turkey" },
];

export function ThemeSwitcher() {
  const [theme, setTheme] = useState("flightdeck");

  useEffect(() => {
    const t = localStorage.getItem("beacon_theme") || "flightdeck";
    setTheme(t);
    document.documentElement.dataset["theme"] = t;
  }, []);

  const change = (t: string) => {
    setTheme(t);
    localStorage.setItem("beacon_theme", t);
    document.documentElement.dataset["theme"] = t;
  };

  return (
    <select className="in" value={theme} onChange={(e) => change(e.target.value)} title="Theme" aria-label="Theme">
      {THEMES.map((t) => (
        <option key={t.v} value={t.v}>
          {t.l}
        </option>
      ))}
    </select>
  );
}
