// Seeded randomness for the stage. Effects look random but are reproducible: tests pass a seed,
// and StageServices.random() (types.ts) promises "deterministic in tests".

export type Random = () => number;

/** mulberry32: a tiny, fast 32-bit generator. Plenty for sparkle; not for anything secret. */
export function createRandom(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number in [min, max). */
export function between(rand: Random, min: number, max: number): number {
  return min + (max - min) * rand();
}

/** Picks one element; undefined for an empty list. */
export function pick<T>(rand: Random, list: readonly T[]): T | undefined {
  return list.length ? list[Math.min(list.length - 1, Math.floor(rand() * list.length))] : undefined;
}
