// Seeded random numbers, so every lab run and every fixture is reproducible.

/** mulberry32: small, fast and good enough for synthetic strokes. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed from text (FNV-1a), so each spell gets its own stream whatever order it runs in. */
export function seedFrom(...parts: (string | number)[]): number {
  const text = parts.join('|');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export class Rng {
  private next: () => number;
  private spare: number | null = null;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** Uniform in [0, 1). */
  float(): number {
    return this.next();
  }
  uniform(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }
  /** Integer in [lo, hi], both included. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** Normal with mean 0 and standard deviation sd (Box-Muller). */
  normal(sd = 1): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s * sd;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v) * sd;
  }
  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }
}
