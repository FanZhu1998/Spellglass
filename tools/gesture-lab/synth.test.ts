import { describe, expect, it } from 'vitest';
import type { Point } from '../../src/contracts';
import { bbox, dist, linearity, resample } from '../../src/kernel/geometry';
import { Rng, mulberry32, seedFrom } from './random';
import { NOISE, distortGesture, paceWarp, startAnywhere, toCaster } from './synth';

const CIRCLE: Point[] = Array.from({ length: 33 }, (_, i) => [0.5 + 0.45 * Math.sin((2 * Math.PI * i) / 32), 0.5 - 0.45 * Math.cos((2 * Math.PI * i) / 32)]);

describe('seeded random numbers', () => {
  it('repeats exactly for a seed', () => {
    const a = mulberry32(42), b = mulberry32(42);
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
    expect(seedFrom('a', 1)).toBe(seedFrom('a', 1));
    expect(seedFrom('a', 1)).not.toBe(seedFrom('a', 2));
  });

  it('draws normals with about the right spread', () => {
    const r = new Rng(3);
    const xs = Array.from({ length: 4000 }, () => r.normal(2));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.1);
    expect(sd).toBeGreaterThan(1.9);
    expect(sd).toBeLessThan(2.1);
  });
});

describe('the noise model', () => {
  it('gives 30 to 70 samples a cast, and the same cast for the same seed', () => {
    const counts = new Set<number>();
    for (let i = 0; i < 200; i++) counts.add(distortGesture({ path: CIRCLE }, new Rng(i)).length);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(NOISE.minSamples);
    expect(Math.max(...counts)).toBeLessThanOrEqual(NOISE.maxSamples);
    expect(distortGesture({ path: CIRCLE }, new Rng(5))).toEqual(distortGesture({ path: CIRCLE }, new Rng(5)));
  });

  it('distorts but keeps the shape recognizable, more so at noise × 1.5', () => {
    const spread = (noise: number) => {
      let total = 0;
      for (let i = 0; i < 100; i++) {
        const d = resample(distortGesture({ path: CIRCLE }, new Rng(i), noise), 32);
        const b = bbox(d);
        total += Math.abs(b.w / b.h - 1);
      }
      return total / 100;
    };
    expect(spread(0)).toBeLessThan(0.02);
    expect(spread(1)).toBeGreaterThan(0.05);
    expect(spread(1.5)).toBeGreaterThan(spread(1));
  });

  it('draws flicks as nearly straight strokes in their direction', () => {
    for (let i = 0; i < 50; i++) {
      const pts = distortGesture({ flick: 'left' }, new Rng(i));
      expect(linearity(resample(pts, 64))).toBeLessThan(0.2);
      expect(pts[pts.length - 1][0]).toBeLessThan(pts[0][0]);
    }
  });

  it('starts closed shapes at a stored start point or anywhere, as asked', () => {
    /** Angle of each cast's first point around the middle of its bounding box, degrees from the top. */
    const starts = (mode: 'stored' | 'anywhere') => {
      const out: number[] = [];
      for (let i = 0; i < 40; i++) {
        const pts = distortGesture({ path: CIRCLE, any_start: true, start_points: 4 }, new Rng(i), 0, NOISE, 64, mode);
        const b = bbox(pts);
        const [x, y] = [pts[0][0] - (b.minX + b.maxX) / 2, pts[0][1] - (b.minY + b.maxY) / 2];
        out.push(((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360);
      }
      return out;
    };
    const offQuarter = (deg: number) => Math.min(deg % 90, 90 - (deg % 90));
    expect(starts('stored').every((a) => offQuarter(a) < 3)).toBe(true);
    expect(starts('anywhere').some((a) => offQuarter(a) > 20)).toBe(true);
    expect(dist(startAnywhere(CIRCLE, 0.5)[0], [0.5, 0.95])).toBeLessThan(0.01);
  });

  it('warps the pace without reversing it', () => {
    const r = new Rng(9);
    for (let k = 0; k < 20; k++) {
      const w = paceWarp(r);
      expect(w(0)).toBeCloseTo(0, 12);
      expect(w(1)).toBeCloseTo(1, 12);
      for (let i = 1; i <= 100; i++) expect(w(i / 100)).toBeGreaterThanOrEqual(w((i - 1) / 100));
    }
  });

  it('places strokes in caster space at the asked size', () => {
    const c = toCaster(CIRCLE, 16 / 9, 0.4, 0.5, 0.5);
    const b = bbox(c);
    expect(b.h).toBeCloseTo(0.4, 6);
    expect(b.w * (16 / 9)).toBeCloseTo(0.4, 6);
  });
});
