/**
 * Small seeded PRNG (mulberry32). The planner uses it so that the client-side
 * preview and the server-side plan are built from the same seed and therefore
 * describe exactly the same schedule.
 */
export interface Rng {
  /** Uniform float in [0, 1) */
  next(): number;
  /** Uniform integer in [min, max] (inclusive) */
  int(min: number, max: number): number;
  /** Uniform float in [min, max) */
  float(min: number, max: number): number;
  /** Pick one element */
  pick<T>(items: readonly T[]): T;
  /** In-place Fisher–Yates shuffle, returns the same array */
  shuffle<T>(items: T[]): T[];
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    float: (min, max) => min + next() * (max - min),
    pick: (items) => items[Math.floor(next() * items.length)],
    shuffle: (items) => {
      for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
      }
      return items;
    },
  };
}

export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0;
}
