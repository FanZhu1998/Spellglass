import { describe, expect, it } from 'vitest';
import type { Gesture, GestureSample, Point } from '../../../contracts';
import { DEFAULT_START_POINTS } from '../../../contracts';
import { dist, pathLength, pointAt } from '../../../kernel/geometry';
import { POINTS } from './match';
import { closeLoop, prepareGesture, prepareSample, sampleLoop, storedTemplates, toStoredFraction } from './templates';

// Protego from Appendix B: a clockwise circle from the top, stored once.
const PROTEGO: Point[] = [[0.5, 0.05], [0.62, 0.07], [0.73, 0.12], [0.83, 0.19], [0.9, 0.29], [0.94, 0.41], [0.95, 0.53], [0.92, 0.65], [0.87, 0.76], [0.78, 0.85], [0.68, 0.91], [0.56, 0.95], [0.44, 0.95], [0.32, 0.91], [0.22, 0.85], [0.13, 0.76], [0.08, 0.65], [0.05, 0.53], [0.06, 0.41], [0.1, 0.29], [0.17, 0.19], [0.27, 0.12], [0.38, 0.07], [0.5, 0.05]];
const LOCOMOTOR: Point[] = [[0.2, 0.05], [0.2, 0.5], [0.2, 0.9], [0.55, 0.9], [0.9, 0.9]];

describe('stored templates', () => {
  it('resamples every stored path to 64 points, as SpellbookEntry.templates holds them', () => {
    const t = storedTemplates({ paths: [LOCOMOTOR, PROTEGO] });
    expect(t).toHaveLength(2);
    expect(t.every((p) => p.length === POINTS)).toBe(true);
    expect(storedTemplates({ flick: 'up' })).toEqual([]);
  });

  it('turns a flick into one straight line template', () => {
    const g = prepareGesture({ flick: 'up' });
    expect(g.flick).toBe('up');
    expect(g.seeds).toHaveLength(1);
    expect(g.seeds[0]).toMatchObject({ id: 'flick:up', kind: 'flick', pathIndex: 0 });
    expect(g.seeds[0].linearity).toBeLessThan(1e-9);
    // Drawn upwards: the first point is below the last (y points down).
    expect(g.seeds[0].path[0][1]).toBeGreaterThan(g.seeds[0].path[POINTS - 1][1]);
  });

  it('names stored paths seed:K and computes them from the gesture when the entry has none', () => {
    const g = prepareGesture({ paths: [LOCOMOTOR, LOCOMOTOR.map(([x, y]) => [y, x] as Point)] }, []);
    expect(g.seeds.map((t) => t.id)).toEqual(['seed:0', 'seed:1']);
    expect(g.seeds.map((t) => t.pathIndex)).toEqual([0, 1]);
  });
});

describe('several start points for closed shapes (Section 7.5, Appendix B)', () => {
  it('expands Protego into four start points by cyclic shift, keeping the direction', () => {
    const g = prepareGesture({ path: PROTEGO, any_start: true, start_points: 4 }, storedTemplates({ path: PROTEGO }));
    expect(g.anyStart).toBe(true);
    expect(g.seeds.map((t) => t.id)).toEqual(['seed:0', 'seed:0@start1', 'seed:0@start2', 'seed:0@start3']);
    const loop = storedTemplates({ path: PROTEGO })[0];
    g.seeds.forEach((t, s) => {
      expect(t.closed).toBe(true);
      expect(t.shift).toBeCloseTo(s / 4, 12);
      // Each variant starts a quarter further round and ends where it started.
      const expectedStart = pointAt(loop, s / 4);
      expect(dist(t.path[0], expectedStart)).toBeLessThan(0.01);
      expect(dist(t.path[0], t.path[POINTS - 1])).toBeLessThan(1e-9);
      // Same direction: a little way along the variant is a little further round the stored loop.
      expect(dist(t.path[2], pointAt(loop, s / 4 + 2 / 63))).toBeLessThan(0.01);
    });
    // The top, the right, the bottom and the left of the circle.
    expect(g.seeds[1].path[0][0]).toBeGreaterThan(0.9);
    expect(g.seeds[2].path[0][1]).toBeGreaterThan(0.9);
    expect(g.seeds[3].path[0][0]).toBeLessThan(0.1);
  });

  it('uses DEFAULT_START_POINTS when the gesture does not say', () => {
    expect(prepareGesture({ path: PROTEGO, any_start: true }).seeds).toHaveLength(DEFAULT_START_POINTS);
  });

  it('does not expand a path that is not a loop', () => {
    const g = prepareGesture({ path: LOCOMOTOR, any_start: true });
    expect(g.seeds.map((t) => t.id)).toEqual(['seed:0']);
    expect(g.seeds[0].closed).toBe(false);
    expect(closeLoop(LOCOMOTOR)).toBeNull();
  });

  it('closes a loop with a small gap and keeps fractions on the stored path', () => {
    // Without its last point the circle stops 0.12 short of where it began.
    const open = PROTEGO.slice(0, -1);
    expect(closeLoop(PROTEGO.slice(0, -3))).toBeNull();
    const loop = closeLoop(open)!;
    expect(loop).toHaveLength(open.length + 1);
    const t = prepareGesture({ path: open, any_start: true, start_points: 2 }).seeds[0];
    // Measured on the 64-point template, which cuts corners a hair differently from the 23 points.
    expect(t.storedShare).toBeCloseTo(pathLength(open) / pathLength(loop), 3);
    expect(t.storedShare).toBeLessThan(1);
    // On the closing segment: the stored path's end.
    expect(toStoredFraction(t, 0.999, true)).toBe(1);
  });

  it('samples a loop from any shift, closed', () => {
    const v = sampleLoop(PROTEGO, 0.5);
    expect(v).toHaveLength(POINTS);
    expect(v[0]).toEqual(v[POINTS - 1]);
    expect(v[0][1]).toBeGreaterThan(0.9);
  });
});

describe('fractions on the stored path, start shifts undone', () => {
  const g = prepareGesture({ path: PROTEGO, any_start: true, start_points: 4 });

  it('reports a full loop from the top as 0 to 1', () => {
    expect(toStoredFraction(g.seeds[0], 0, false)).toBe(0);
    expect(toStoredFraction(g.seeds[0], 1, true)).toBe(1);
  });

  it('adds the shift back for a loop started at the bottom', () => {
    const bottom = g.seeds[2];
    expect(toStoredFraction(bottom, 0, false)).toBeCloseTo(0.5, 12);
    expect(toStoredFraction(bottom, 0.25, true)).toBeCloseTo(0.75, 12);
    expect(toStoredFraction(bottom, 0.5, true)).toBe(1);
    expect(toStoredFraction(bottom, 0.75, true)).toBeCloseTo(0.25, 12);
    expect(toStoredFraction(bottom, 1, true)).toBeCloseTo(0.5, 12);
    expect(toStoredFraction(bottom, -0.1, false)).toBeCloseTo(0.4, 12);
  });

  it('leaves open paths alone', () => {
    const t = prepareGesture({ path: LOCOMOTOR }).seeds[0];
    expect(toStoredFraction(t, 0.3, false)).toBe(0.3);
    expect(toStoredFraction(t, 1.2, true)).toBe(1);
  });
});

describe('learned samples as templates', () => {
  it('makes a user template from a sample, with no start-point variants', () => {
    const sample: GestureSample = { dataVersion: 1, id: 's1', spellId: 'protego', points: storedTemplates({ path: PROTEGO })[0], score: 0.9, gestureKey: 'k', savedAt: 0 };
    const t = prepareSample(sample, 2);
    expect(t).toMatchObject({ id: 'user:2', kind: 'user', pathIndex: -1, closed: false });
    expect(t.shape.xs).toHaveLength(POINTS);
  });

  it('accepts every Gesture form the contract allows', () => {
    const forms: Gesture[] = [{ flick: 'left' }, { path: LOCOMOTOR }, { paths: [LOCOMOTOR] }, { path: PROTEGO, any_start: true, start_points: 3 }];
    expect(forms.map((f) => prepareGesture(f).seeds.length)).toEqual([1, 1, 1, 3]);
  });
});
