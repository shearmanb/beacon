import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_THEME, THEME_IDS, resolveTheme } from "./themes";

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../app/globals.css"), "utf8");

describe("themes", () => {
  it("every listed theme has a palette block in globals.css, and vice versa", () => {
    const blocks = [...css.matchAll(/:root\[data-theme="([a-z0-9-]+)"\]/g)].map((m) => m[1]);
    expect(new Set(blocks)).toEqual(new Set(THEME_IDS));
  });
  it("ids are unique and the default is one of them", () => {
    expect(new Set(THEME_IDS).size).toBe(THEME_IDS.length);
    expect(THEME_IDS).toContain(DEFAULT_THEME);
  });
  it("a saved id that names no palette falls back to the default", () => {
    expect(resolveTheme("old-fitz")).toBe("old-fitz");
    expect(resolveTheme("bogus")).toBe(DEFAULT_THEME);
    expect(resolveTheme(null)).toBe(DEFAULT_THEME);
    expect(resolveTheme("")).toBe(DEFAULT_THEME);
  });
  it("every palette sets --accent (--accent-dim derives from it)", () => {
    for (const id of THEME_IDS) {
      const block = css.slice(css.indexOf(`:root[data-theme="${id}"]`));
      const body = block.slice(0, block.indexOf("}"));
      expect(body, id).toMatch(/--accent:\s*#[0-9a-fA-F]{6}/);
      expect(body, id).toMatch(/--bg:\s*#/);
    }
  });
});
