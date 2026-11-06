// The theme list — ONE copy, read by the picker (ThemeSwitcher) and by the
// no-flash init script in layout.tsx, so a saved id can only ever resolve to a
// palette that exists. Bottle and light palettes mirror drop-tracker's
// THEME_DEFS (names, order, values in globals.css); add a theme in both repos.

export interface ThemeDef {
  id: string;
  name: string;
  group: "Bottles" | "Light" | "Classic";
}

export const DEFAULT_THEME = "rr-hh";

export const THEMES: ThemeDef[] = [
  { group: "Bottles", id: "rr-hh", name: "Russell’s 13 · HH 22" },
  { group: "Bottles", id: "old-fitz", name: "Old Fitz" },
  { group: "Bottles", id: "reveries", name: "The Reveries" },
  { group: "Bottles", id: "makers-mark", name: "Maker’s Mark" },
  { group: "Bottles", id: "stagg", name: "Stagg" },
  { group: "Bottles", id: "willett-purple", name: "Willett Purple" },
  { group: "Bottles", id: "old-grand-dad", name: "Old Grand-Dad" },
  { group: "Bottles", id: "jd-14", name: "JD 14 Year" },
  { group: "Bottles", id: "jd-no7", name: "Old No. 7" },
  { group: "Light", id: "russells-13-light", name: "Russell’s 13 Light" },
  { group: "Light", id: "willett-purple-light", name: "Willett Purple Light" },
  { group: "Classic", id: "flightdeck", name: "Flightdeck" },
  { group: "Classic", id: "flightpath", name: "Flightpath" },
  { group: "Classic", id: "wildturkey", name: "Wild Turkey" },
];

export const THEME_IDS: string[] = THEMES.map((t) => t.id);

/** A saved id that names no palette (a typo, a removed theme) falls back to the
 *  default rather than leaving the page on the bare :root tokens. */
export function resolveTheme(saved: string | null | undefined): string {
  return saved && THEME_IDS.includes(saved) ? saved : DEFAULT_THEME;
}
