import { describe, expect, it } from 'vitest';
import type { Point } from '../../../contracts';
import { bbox, centroid, resample, rotate } from '../../../kernel/geometry';
import {
  FLICK_ANGLES, POINTS, SCORE_DISTANCE, angleDiff, bestAlignment, directionDeg, flickScore, meanDistance, normalizePath,
  normalizeSampled, rotateShape, rotationAngles, scoreOf, shapeFromPoints, shapeToPoints, strokeRotations,
} from './match';

// An asymmetric open shape (Accio's "C" from Appendix B), so rotations and directions are visible.
const ACCIO: Point[] = [[0.75, 0.14], [0.68, 0.1], [0.61, 0.09], [0.54, 0.08], [0.46, 0.09], [0.39, 0.11], [0.33, 0.15], [0.27, 0.2], [0.23, 0.26], [0.19, 0.32], [0.16, 0.39], [0.15, 0.46], [0.15, 0.54], [0.16, 0.61], [0.19, 0.68], [0.23, 0.74], [0.27, 0.8], [0.33, 0.85], [0.39, 0.89], [0.46, 0.91], [0.54, 0.92], [0.61, 0.91], [0.68, 0.9], [0.75, 0.86]];

describe('normalizePath (Section 7.5 steps 1 to 3)', () => {
  it('resamples to 64 points, centres the centroid on the origin and scales the longer side to 1', () => {
    const n = normalizePath(ACCIO);
    expect(n.shape.xs).toHaveLength(POINTS);
    const pts = shapeToPoints(n.shape);
    const c = centroid(pts);
    expect(c[0]).toBeCloseTo(0, 9);
    expect(c[1]).toBeCloseTo(0, 9);
    const b = bbox(pts);
    expect(Math.max(b.w, b.h)).toBeCloseTo(1, 9);
  });

  it('scales uniformly, so a tall shape stays tall', () => {
    const tall = normalizePath([[0, 0], [0.1, 0.5], [0, 1]]);
    const b = bbox(shapeToPoints(tall.shape));
    expect(b.h).toBeCloseTo(1, 9);
    expect(b.w).toBeLessThan(0.2);
  });

  it('keeps the frame, so a normalized point maps back exactly onto the resampled path', () => {
    const n = normalizePath(ACCIO);
    const r = resample(ACCIO, POINTS);
    for (let i = 0; i < POINTS; i += 9) {
      expect(n.shape.xs[i] / n.frame.scale + n.frame.cx).toBeCloseTo(r[i][0], 12);
      expect(n.shape.ys[i] / n.frame.scale + n.frame.cy).toBeCloseTo(r[i][1], 12);
    }
  });

  it('leaves a path of no size at the origin with scale 1', () => {
    const n = normalizePath([[0.3, 0.3], [0.3, 0.3]]);
    expect(n.frame.scale).toBe(1);
    expect(Math.max(...[...n.shape.xs].map(Math.abs))).toBeLessThan(1e-12);
  });

  it('refuses to normalize a window with no extent', () => {
    expect(normalizeSampled(new Float64Array(POINTS).fill(2), new Float64Array(POINTS).fill(3))).toBeNull();
  });
});

describe('rotation band (Section 7.5 step 4)', () => {
  it('tries 0 first, then ±3° steps out to ±15°', () => {
    expect(rotationAngles(15, 3)).toEqual([0, 3, -3, 6, -6, 9, -9, 12, -12, 15, -15]);
    expect(rotationAngles(0, 3)).toEqual([0]);
  });

  it('survives nonsense settings', () => {
    expect(rotationAngles(15, 0)).toEqual([0, 15, -15]);
    expect(rotationAngles(Number.NaN, 3)).toEqual([0]);
    expect(rotationAngles(90, 0.01).length).toBeLessThanOrEqual(121);
  });

  it('rotates clockwise on screen for positive angles, like geometry.rotate', () => {
    const r = rotateShape(shapeFromPoints([[1, 0]]), 90);
    expect(r.xs[0]).toBeCloseTo(0, 12);
    expect(r.ys[0]).toBeCloseTo(1, 12);
    const g = rotate([[0.3, -0.2]], (25 * Math.PI) / 180)[0];
    const s = rotateShape(shapeFromPoints([[0.3, -0.2]]), 25);
    expect(s.xs[0]).toBeCloseTo(g[0], 12);
    expect(s.ys[0]).toBeCloseTo(g[1], 12);
  });

  it('finds the tilt of a stroke relative to its template, clockwise positive', () => {
    const template = normalizePath(ACCIO).shape;
    const stroke = rotateShape(template, 12);
    const al = bestAlignment(strokeRotations(stroke, rotationAngles(15, 3)), template);
    expect(al.angle).toBe(12);
    expect(al.distance).toBeLessThan(1e-9);
    const left = bestAlignment(strokeRotations(rotateShape(template, -9), rotationAngles(15, 3)), template);
    expect(left.angle).toBe(-9);
  });

  it('cannot undo a tilt beyond the band', () => {
    const template = normalizePath(ACCIO).shape;
    const inBand = bestAlignment(strokeRotations(rotateShape(template, 15), rotationAngles(15, 3)), template);
    const beyond = bestAlignment(strokeRotations(rotateShape(template, 40), rotationAngles(15, 3)), template);
    expect(inBand.distance).toBeLessThan(1e-9);
    expect(beyond.angle).toBe(15);
    expect(beyond.distance).toBeGreaterThan(0.1);
  });

  it('gives up early on a comparison that cannot win, and says so', () => {
    const a = normalizePath(ACCIO).shape;
    const b = rotateShape(a, 90);
    expect(meanDistance(a, b)).toBeGreaterThan(0.1);
    expect(meanDistance(a, b, 0.01)).toBe(Infinity);
    expect(bestAlignment(strokeRotations(b, [0]), a, undefined, 0.01).distance).toBe(Infinity);
  });
});

describe('score (Section 7.5 step 5)', () => {
  it('is 1 − distance ÷ 0.707, clamped to 0..1', () => {
    expect(SCORE_DISTANCE).toBe(0.707);
    expect(scoreOf(0)).toBe(1);
    expect(scoreOf(0.0707)).toBeCloseTo(0.9, 12);
    expect(scoreOf(0.707)).toBe(0);
    expect(scoreOf(2)).toBe(0);
    expect(scoreOf(Infinity)).toBe(0);
  });
});

describe('stage 1 helpers', () => {
  it('wraps angle differences into (−180, 180]', () => {
    expect(angleDiff(170, -170)).toBe(-20);
    expect(angleDiff(-170, 170)).toBe(20);
    expect(angleDiff(-90, 180)).toBe(90);
    expect(angleDiff(180, -180)).toBe(0);
  });

  it('measures the start-to-end direction in screen degrees', () => {
    expect(directionDeg([[0, 0], [1, 0]])).toBe(0);
    expect(directionDeg([[0, 0], [0, 1]])).toBe(90);
    expect(directionDeg([[0, 0], [0, -1]])).toBe(-90);
    expect(directionDeg([[0, 0], [-1, 0]])).toBe(180);
    expect(directionDeg([[0, 0], [1, 1], [0, 0]])).toBeNull();
    expect(FLICK_ANGLES).toEqual({ right: 0, down: 90, left: 180, up: -90 });
  });

  it('scores a perfect flick 1, a clean one about 0.95, one edge 0.86 and both edges 0.72', () => {
    expect(flickScore(0, 0, 0.2, 35)).toBe(1);
    expect(flickScore(0.05, 5, 0.2, 35)).toBeCloseTo(0.945, 3);
    expect(flickScore(0.2, 0, 0.2, 35)).toBeCloseTo(0.86, 12);
    expect(flickScore(0, 35, 0.2, 35)).toBeCloseTo(0.86, 12);
    expect(flickScore(0.2, 35, 0.2, 35)).toBeCloseTo(0.72, 12);
    expect(flickScore(0.1, -17.5, 0.2, 35)).toBeCloseTo(0.86, 12);
  });
});
