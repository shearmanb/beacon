// Shared scheduling logic used by both checker.js and worker.js.

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
  if (!schedule) return site.intervalMinutes;
  const fixed = parseInt(schedule, 10);
  if (!isNaN(fixed)) return fixed;
  const resolved = resolveNamedSchedule(schedule, schedules);
  if (resolved != null) return resolved;
  return site.intervalMinutes;
}

export function shouldCheck(site, siteState, schedules) {
  if (!siteState?.lastChecked) return true;
  const elapsed = (Date.now() - new Date(siteState.lastChecked).getTime()) / 1000 / 60;
  // Imminent mode uses imminentIntervalMinutes, but fall back to the effective
  // interval if that field is absent — otherwise `elapsed >= undefined` is NaN
  // (always false) and the site silently stops checking exactly when imminent
  // mode is meant to make it check more aggressively.
  const interval = site.imminent
    ? (site.imminentIntervalMinutes ?? getEffectiveInterval(site, schedules))
    : getEffectiveInterval(site, schedules);
  return elapsed >= interval;
}
