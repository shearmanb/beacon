// Shared small utilities. Imported by worker.js, notifiers, and site strategies
// so we have one source of truth for sleep/jitter/random helpers.

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Returns a duration in ms: base ± up to spread ms, floored at 0.
export function jitter(baseMs, spreadMs) {
  return Math.max(0, baseMs + (Math.random() * 2 - 1) * spreadMs);
}

export function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
