import { describe, expect, it } from "vitest";
import type { Schedules } from "@beacon/shared";
import { getEtHour } from "@beacon/shared";
import { cadenceLines, tileStatus } from "./tile-status";

// 2026-10-30T16:00Z = 12:00 ET (EDT). Pin `now` so the phrase is deterministic.
const NOW = Date.parse("2026-10-30T16:00:00.000Z");
const MIN = 60_000;
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

const schedules: Schedules = {
  fast_hours: {
    label: "fast",
    rules: [
      { fromHour: 8, toHour: 15, interval: 5 },
      { fromHour: 17, toHour: 20, interval: 5 },
      { fromHour: 6, toHour: 8, interval: 8 },
      { fromHour: 15, toHour: 17, interval: 8 },
      { fromHour: 20, toHour: 22, interval: 8 },
      { fromHour: 22, toHour: 6, interval: 60 },
      { defaultInterval: 60 },
    ],
  },
};

describe("cadenceLines", () => {
  const fh = { id: "a", schedule: "fast_hours" };
  it("names the cadence now and when it next changes", () => {
    expect(getEtHour(new Date(NOW))).toBe(12); // fixture sanity
    const c = cadenceLines(fh, schedules, undefined, "⚡ Fast Hours (5m peak · 8m shoulders)", NOW);
    expect(c).toEqual({ now: "every 5 min now", next: "→ every 8 min from 3 PM ET", label: "⚡ Fast Hours" });
  });
  it("early morning shoulder: 8 now, 5 from 8 AM", () => {
    const early = Date.parse("2026-10-30T10:50:00.000Z"); // 06:50 ET
    const c = cadenceLines(fh, schedules, undefined, "fast", early);
    expect([c.now, c.next]).toEqual(["every 8 min now", "→ every 5 min from 8 AM ET"]);
  });
  it("names the day when the change lands after midnight", () => {
    const lateNight = Date.parse("2026-10-31T01:30:00.000Z"); // Fri 21:30 ET
    expect(cadenceLines(fh, schedules, undefined, "fast", lateNight).next).toBe("→ every 60 min from 10 PM ET");
    const overnight = Date.parse("2026-10-31T03:30:00.000Z"); // Fri 23:30 ET
    expect(cadenceLines(fh, schedules, undefined, "fast", overnight).next).toBe("→ every 8 min from Sat 6 AM ET");
  });
  it("a flat interval never changes", () => {
    const c = cadenceLines({ id: "a", intervalMinutes: 20 }, {}, undefined, "fixed 20 min", NOW);
    expect([c.now, c.next]).toEqual(["every 20 min now", "→ no change: same cadence all day"]);
  });
  it("shows the eased-off interval after a block", () => {
    const state = { errorLog: [{ ts: new Date(NOW - MIN).toISOString(), statusCode: 429 }] };
    const c = cadenceLines(fh, schedules, state, "fast", NOW);
    expect(c.now).toBe("every 7.5 min now (schedule says 5, eased off)");
    expect(c.next).toBe("→ every 12 min from 3 PM ET");
  });
  it("imminent: the imminent cadence, then when it hands back", () => {
    const until = new Date(NOW + 20 * MIN).toISOString(); // 12:20 ET
    const c = cadenceLines({ ...fh, imminent: true }, schedules, undefined, "fast", NOW, until);
    expect([c.now, c.next]).toEqual(["every 2 min now (imminent)", "→ back to every 5 min at 12:20 PM ET"]);
  });
});

describe("tileStatus", () => {
  const def = { id: "a", schedule: "fast_hours" };
  const base = { enabled: true, def, schedules, nextLabel: "~2m", now: NOW };

  it("healthy: green, with last check, next check and the cadence phrase", () => {
    const s = tileStatus({ ...base, health: "ok", state: { lastChecked: iso(-3 * MIN) } });
    expect(s.tone).toBe("ok");
    expect(s.parts).toEqual(["✓ checking", "3m ago", "next ~2m"]);
    expect(s.secondary).toEqual([]);
    expect(s.lastError).toBeNull();
  });

  it("a few failures: amber with the HTTP status, cooldown countdown and the back-off note", () => {
    const state = {
      lastChecked: iso(-1 * MIN),
      consecutiveErrors: 2,
      errorLog: [{ ts: iso(-1 * MIN), statusCode: 429, message: "HTTP 429" }],
      cooldownUntil: iso(4 * MIN + 1),
      lastError: "HTTP 429 fetching https://x/products.json",
    };
    const s = tileStatus({ ...base, health: "warn", state });
    expect(s.tone).toBe("warn");
    expect(s.parts[0]).toBe("⚠ 2 failures · HTTP 429");
    expect(s.parts).toContain("⏸ cooldown 5m");
    expect(s.secondary.map((n) => n.text)).toEqual(["⏳ backing off ×1.5 (HTTP 429 1m ago)"]);
    expect(s.lastError).toBe(state.lastError);
    expect(s.errorHint).toBeNull();
  });

  it("down: red, 403 gets the bot-protection hint; a stall gets the tar-pit hint", () => {
    const blocked = tileStatus({
      ...base,
      health: "err",
      state: { lastChecked: iso(0), consecutiveErrors: 7, errorLog: [{ ts: iso(0), statusCode: 403 }], lastError: "HTTP 403" },
    });
    expect(blocked.tone).toBe("err");
    expect(blocked.parts[0]).toBe("✕ down · 7 failures · HTTP 403");
    expect(blocked.errorHint).toMatch(/bot protection/);
    const stalled = tileStatus({
      ...base,
      health: "err",
      state: { lastChecked: iso(0), consecutiveErrors: 5, errorLog: [{ ts: iso(0), statusCode: null, message: "Aborted fetching x" }], lastError: "Aborted fetching x (socket idle timeout)" },
    });
    expect(stalled.errorHint).toMatch(/tar-pit/);
  });

  it("imminent: no cooldown part, no back-off note, imminent cadence phrase", () => {
    const state = { lastChecked: iso(0), cooldownUntil: iso(10 * MIN), errorLog: [{ ts: iso(-MIN), statusCode: 429 }] };
    const s = tileStatus({ ...base, def: { ...def, imminent: true }, health: "ok", state });
    expect(s.parts.some((p) => p.startsWith("⏸"))).toBe(false);
    expect(s.secondary).toEqual([]);
    expect(s.parts.some((p) => p.startsWith("every"))).toBe(false); // cadence lives on the 🕒 line
  });

  it("fallback channel, truncated roster and quiet canary become secondary notes", () => {
    const state = {
      lastChecked: iso(0),
      fetchVia: "storefront_fallback",
      preferFallback: true,
      fallbackTruncated: true,
      checkHistory: new Array(60).fill({ ts: iso(0), ok: true }),
    };
    const s = tileStatus({ ...base, health: "ok", state });
    expect(s.secondary.map((n) => n.text)).toEqual(["⛑ via storefront (preferred)", "⚠ roster truncated", "💤 no alerts yet"]);
  });

  it("disabled: off tone, no error text", () => {
    const s = tileStatus({ ...base, enabled: false, health: "off", state: { lastChecked: iso(-3 * 86_400_000), consecutiveErrors: 9, lastError: "x" } });
    expect(s.tone).toBe("off");
    expect(s.parts).toEqual(["○ off", "last check 3d ago"]);
    expect(s.lastError).toBeNull();
  });

  it("never checked: amber 'not checked yet'", () => {
    const s = tileStatus({ ...base, health: "warn", state: undefined, nextLabel: "—" });
    expect(s.parts.slice(0, 2)).toEqual(["⚠ not checked yet", "never"]);
  });
});
