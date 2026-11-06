"use client";

// Theme picker (footer). Grouped like drop-tracker's Settings → Appearance:
// Bottles · Light · Classic. The list and the fallback live in lib/themes.ts,
// shared with layout.tsx's no-flash init script.

import { useEffect, useState } from "react";
import { DEFAULT_THEME, THEMES, resolveTheme } from "../lib/themes";

const GROUPS = ["Bottles", "Light", "Classic"] as const;

export function ThemeSwitcher() {
  const [theme, setTheme] = useState(DEFAULT_THEME);

  useEffect(() => {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem("beacon_theme");
    } catch {
      /* storage blocked — keep the default */
    }
    const t = resolveTheme(saved);
    setTheme(t);
    document.documentElement.dataset["theme"] = t;
  }, []);

  const change = (t: string) => {
    setTheme(t);
    document.documentElement.dataset["theme"] = t;
    try {
      localStorage.setItem("beacon_theme", t);
    } catch {
      /* not remembered this time — still applied */
    }
  };

  return (
    <select className="in" value={theme} onChange={(e) => change(e.target.value)} title="Theme — bottle palettes match drop-tracker" aria-label="Theme">
      {GROUPS.map((g) => (
        <optgroup key={g} label={g}>
          {THEMES.filter((t) => t.group === g).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
