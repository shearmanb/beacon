// Shared scheduling logic used by worker.js.

export function getEtHour() {
  return parseInt(
    new Date().toLocaleString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      hour12: false,
    }),
    10
  );
}

// Handles midnight-crossing windows: fromHour=22 toHour=9 means 10pm–9am.
function windowMatches(fromHour, toHour, hour) {
  if (fromHour <= toHour) return hour >= fromHour && hour < toHour;
  return hour >= fromHour || hour < toHour;
}

export function resolveNamedSchedule(scheduleName, schedules) {
  const def = schedules[scheduleName];
  if (!def?.rules) return null;
  const hour = getEtHour();
  for (const rule of def.rules) {
    if (rule.defaultInterval != null) return rule.defaultInterval;
    if (rule.fromHour != null && windowMatches(rule.fromHour, rule.toHour, hour)) {
      return rule.interval;
    }
  }
  return null;
}

export function getEffectiveInterval(site, schedules) {
  const { schedule } = site;
  let interval = site.intervalMinutes;
  if (schedule) {
    const fixed = parseInt(schedule, 10);
    interval = !isNaN(fixed) ? fixed : resolveNamedSchedule(schedule, schedules) ?? site.intervalMinutes;
  }
  if (!Number.isFinite(interval)) {
    // Misconfigured site (unresolvable schedule + missing intervalMinutes):
    // a non-numeric interval makes `elapsed >= interval` permanently false,
    // silently disabling checks. Fall back to a safe 60m instead.
    console.warn(`[schedule] ${site.id ?? site.name}: no resolvable interval — defaulting to 60m`);
    return 60;
  }
  return interval;
}

// Deterministic per-cycle jitter factor in [0.9, 1.15). Seeded from the site
// and its lastChecked so the factor is stable across loops within one wait
// cycle (a fresh random draw every loop would bias checks early), but changes
// every cycle so checks never land on an exact metronome.
function cycleJitterFactor(siteId, lastChecked) {
  const seed = `${siteId}|${lastChecked}`;
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return 0.9 + (h % 1000) / 1000 * 0.25;
}

export function shouldCheck(site, siteState, schedules) {
  if (!siteState?.lastChecked) return true;
  const elapsed = (Date.now() - new Date(siteState.lastChecked).getTime()) / 1000 / 60;
  // Imminent mode uses imminentIntervalMinutes; fall back to the effective
  // interval if that field is absent so the site never silently stops checking.
  // Imminent checks skip the jitter — drop windows want the floor, not variance.
  if (site.imminent && site.imminentIntervalMinutes != null) {
    return elapsed >= site.imminentIntervalMinutes;
  }
  const interval = getEffectiveInterval(site, schedules);
  return elapsed >= interval * cycleJitterFactor(site.id, siteState.lastChecked);
}
