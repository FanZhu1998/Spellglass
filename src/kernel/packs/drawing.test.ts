import { describe, expect, it } from 'vitest';
import type { Gesture, Point, Stroke } from '../../contracts';
import { drawingToGesture, inheritFromPack, mirrorGesture } from './drawing';

const OPTS = { leftHanded: false, flickLinearity: 0.2, flickAngleDeg: 35, fallbackAspect: 16 / 9 };
const ZIG: Point[] = [[0.1, 0.1], [0.4, 0.9], [0.6, 0.1], [0.9, 0.9]];

function stroke(points: Point[], aspect?: number): Stroke {
  return { id: 's', t0: 0, t1: 1, quality: 1, ...(aspect ? { aspect } : {}), points: points.map(([x, y], i) => ({ t: i, x, y, conf: 1, src: 'tracker.pointer' })) };
}

describe('mirrorGesture', () => {
  it('mirrors paths and swaps left and right flicks; twice gives the original back', () => {
    const g: Gesture = { path: ZIG, parts: [{ until: 1, name: 'the zigzag' }] };
    const m = mirrorGesture(g);
    expect(m).toEqual({ path: [[0.9, 0.1], [0.6, 0.9], [0.4, 0.1], [0.1, 0.9]], parts: g.parts });
    expect(mirrorGesture(m)).toEqual(g);
    expect(mirrorGesture({ flick: 'left' })).toEqual({ flick: 'right' });
    expect(mirrorGesture({ flick: 'up' })).toEqual({ flick: 'up' });
    const mirrored = (m as { path: Point[] }).path;
    expect(mirrorGesture({ paths: [ZIG, ZIG] })).toEqual({ paths: [mirrored, mirrored] });
  });
});

describe('inheritFromPack', () => {
  const pack: Gesture = { path: ZIG, any_start: true, start_points: 4, parts: [{ until: 1, name: 'the circle' }], pace_ms: 900 };
  it('fills parts, any_start and start_points of a redrawn path, never pace_ms', () => {
    expect(inheritFromPack({ path: ZIG.slice(1) }, pack)).toEqual({ path: ZIG.slice(1), any_start: true, start_points: 4, parts: pack.parts });
    expect(inheritFromPack({ path: ZIG, any_start: false }, pack)).toMatchObject({ any_start: false });
  });
  it('leaves flicks alone, and takes nothing from a flick', () => {
    expect(inheritFromPack({ flick: 'up' }, pack)).toEqual({ flick: 'up' });
    expect(inheritFromPack({ path: ZIG }, { flick: 'up', parts: [{ until: 1, name: 'x' }] })).toEqual({ path: ZIG });
  });
});

describe('drawingToGesture', () => {
  it('turns a stroke into an isotropic 64-point unit-square path', () => {
    const r = drawingToGesture({ stroke: stroke([[0.3, 0.2], [0.45, 0.8], [0.55, 0.2], [0.7, 0.8]], 16 / 9) }, OPTS);
    if (!r.ok) throw new Error(r.reason);
    const path = (r.gesture as { path: Point[] }).path;
    expect(path).toHaveLength(64);
    expect(r.drawnLeftHanded).toBe(false);
    for (const [x, y] of path) {
      expect(x).toBeGreaterThanOrEqual(0.05 - 1e-9);
      expect(x).toBeLessThanOrEqual(0.95 + 1e-9);
      expect(y).toBeGreaterThanOrEqual(0.05 - 1e-9);
      expect(y).toBeLessThanOrEqual(0.95 + 1e-9);
    }
  });
  it('stores a straight drawing as a flick, using the stroke aspect', () => {
    // Straight across in caster space: a flick to the right.
    expect(drawingToGesture({ stroke: stroke([[0.2, 0.5], [0.4, 0.5], [0.6, 0.502], [0.8, 0.5]]) }, OPTS)).toEqual({ ok: true, gesture: { flick: 'right' }, drawnLeftHanded: false });
    // A given single path that is straight becomes a flick too.
    expect(drawingToGesture({ gesture: { path: [[0.5, 0.9], [0.5, 0.5], [0.5, 0.1]] } }, OPTS)).toEqual({ ok: true, gesture: { flick: 'up' }, drawnLeftHanded: false });
  });
  it('mirrors a left-handed drawing back to right-handed form', () => {
    expect(drawingToGesture({ gesture: { flick: 'left' } }, { ...OPTS, leftHanded: true })).toEqual({ ok: true, gesture: { flick: 'right' }, drawnLeftHanded: true });
    const r = drawingToGesture({ gesture: { path: ZIG } }, { ...OPTS, leftHanded: true });
    expect(r.ok && (r.gesture as { path: Point[] }).path[0]).toEqual([0.9, 0.1]);
  });
  it('refuses drawings that are too short or too small', () => {
    expect(drawingToGesture({ stroke: stroke([[0.5, 0.5]]) }, OPTS)).toMatchObject({ ok: false, reason: expect.stringMatching(/too short/) });
    expect(drawingToGesture({ stroke: stroke([[0.5, 0.5], [0.501, 0.5005]]) }, OPTS)).toMatchObject({ ok: false, reason: expect.stringMatching(/too small/) });
    expect(drawingToGesture({}, OPTS)).toMatchObject({ ok: false });
  });
});
