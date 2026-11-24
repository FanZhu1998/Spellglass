import { describe, expect, it } from 'vitest';
import type { Point } from '../contracts';
import { bbox, centroid, flickPath, linearity, normalize, pathLength, pointAt, resample, rotate, toIsotropic } from './geometry';
import { asFlick, gestureKey, gesturePaceMs, strokeToUnitPath } from './gestures';

const square: Point[] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];

describe('geometry', () => {
  it('resamples to evenly spaced points that keep both ends', () => {
    const r = resample(square, 9);
    expect(r).toHaveLength(9);
    expect(r[0]).toEqual([0, 0]);
    expect(r[8]).toEqual([0, 0]);
    expect(r[2][0]).toBeCloseTo(1);
    expect(r[2][1]).toBeCloseTo(0);
    const gaps = r.slice(1).map((p, i) => Math.hypot(p[0] - r[i][0], p[1] - r[i][1]));
    for (const g of gaps) expect(g).toBeCloseTo(0.5, 5);
  });

  it('handles degenerate input', () => {
    expect(resample([], 4)).toEqual([]);
    expect(resample([[0.3, 0.3]], 3)).toEqual([[0.3, 0.3], [0.3, 0.3], [0.3, 0.3]]);
    expect(resample([[0.3, 0.3], [0.3, 0.3]], 2)).toEqual([[0.3, 0.3], [0.3, 0.3]]);
  });

  it('normalizes: centroid at the origin, longer side 1', () => {
    const n = normalize([[0.2, 0.2], [0.6, 0.2], [0.6, 0.4]], 64);
    const c = centroid(n);
    expect(c[0]).toBeCloseTo(0, 6);
    expect(c[1]).toBeCloseTo(0, 6);
    const b = bbox(n);
    expect(Math.max(b.w, b.h)).toBeCloseTo(1, 6);
  });

  it('measures linearity: 0 for a line, near 1 for a circle', () => {
    const line = resample([[0, 0], [1, 1]], 64);
    expect(linearity(line)).toBeLessThan(1e-6);
    const circle = Array.from({ length: 64 }, (_, i) => [Math.cos((i / 64) * Math.PI * 2), Math.sin((i / 64) * Math.PI * 2)] as Point);
    expect(linearity(circle)).toBeCloseTo(1, 2);
  });

  it('rotates clockwise on screen for positive angles (y points down)', () => {
    const [p] = rotate([[1, 0]], Math.PI / 2);
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(1);
  });

  it('finds points along a path by arc fraction', () => {
    expect(pointAt([[0, 0], [2, 0]], 0.25)).toEqual([0.5, 0]);
    expect(pathLength(square)).toBeCloseTo(4);
  });

  it('makes caster-space circles round', () => {
    const ellipse = toIsotropic([[0.5 + 0.1 / (16 / 9), 0.5]], 16 / 9);
    expect(ellipse[0][0]).toBeCloseTo((0.5 + 0.1 / (16 / 9)) * (16 / 9));
  });
});

describe('gestures', () => {
  it('derives the pace from path length, and flicks are quick', () => {
    expect(gesturePaceMs({ flick: 'up' })).toBe(350);
    expect(gesturePaceMs({ path: [[0, 0], [1, 0]] })).toBe(700);
    expect(gesturePaceMs({ path: [[0, 0], [1, 0]], pace_ms: 1234 })).toBe(1234);
  });

  it('changes the gesture key with the shape but not with hint text', () => {
    const a = gestureKey({ path: [[0, 0], [1, 1]], parts: [{ until: 1, name: 'the line' }] });
    const b = gestureKey({ path: [[0, 0], [1, 1]], parts: [{ until: 1, name: 'the stroke' }] });
    const c = gestureKey({ path: [[1, 0], [0, 1]] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('turns a captured stroke into a centred unit-square path', () => {
    const p = strokeToUnitPath([[0.3, 0.3], [0.5, 0.3], [0.5, 0.5]], 16 / 9, 16);
    const b = bbox(p);
    expect(Math.max(b.w, b.h)).toBeCloseTo(0.9, 2);
    expect((b.minX + b.maxX) / 2).toBeCloseTo(0.5, 2);
  });

  it('recognizes nearly straight drawings as flicks', () => {
    expect(asFlick(flickPath('up'), 0.2, 35)).toBe('up');
    expect(asFlick(flickPath('left'), 0.2, 35)).toBe('left');
    expect(asFlick([[0, 0], [1, 1]], 0.2, 35)).toBeNull();
    expect(asFlick([[0, 0], [1, 0], [1, 1]], 0.2, 35)).toBeNull();
  });
});
