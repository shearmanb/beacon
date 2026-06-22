// Small shared utilities — one source of truth for sleep/jitter/random.

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Duration in ms: base ± up to spread ms, floored at 0. */
export function jitter(baseMs: number, spreadMs: number): number {
  return Math.max(0, baseMs + (Math.random() * 2 - 1) * spreadMs);
}

export function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}
