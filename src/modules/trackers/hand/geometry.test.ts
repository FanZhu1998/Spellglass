import { describe, expect, it } from 'vitest';
import {
  carriedFingerTip, fingerShape, fingerTip, gripTip, handSize, isValidLandmarks, LANDMARK, LANDMARK_COUNT, landmarksToCaster, tipConfidence,
  tipFor, toCaster,
} from './geometry';

const ASPECT = 16 / 9;

/** A hand as the model would report it on a 16:9 frame: wrist, four knuckles, an index fingertip; the other
 *  landmarks sit between the wrist and the knuckles (they are not used by the geometry). */
function hand(opts: { wrist: [number, number]; knuckles: [number, number][]; indexTip: [number, number] }): number[] {
  const pts: [number, number][] = Array.from({ length: LANDMARK_COUNT }, () => [...opts.wrist] as [number, number]);
  pts[LANDMARK.WRIST] = opts.wrist;
  [LANDMARK.INDEX_MCP, LANDMARK.MIDDLE_MCP, LANDMARK.RING_MCP, LANDMARK.PINKY_MCP].forEach((i, k) => (pts[i] = opts.knuckles[k]));
  pts[LANDMARK.INDEX_TIP] = opts.indexTip;
  return pts.flatMap(([x, y]) => [x, y, 0]);
}

/** Isotropic (pixel-proportional) units of frame width. */
const iso = (p: { x: number; y: number }) => ({ x: p.x, y: p.y / ASPECT });

// A hand pointing straight up in the frame: wrist at the bottom, knuckles in a row above it.
const UPRIGHT = hand({ wrist: [0.5, 0.8], knuckles: [[0.47, 0.6], [0.49, 0.6], [0.51, 0.6], [0.53, 0.6]], indexTip: [0.46, 0.45] });

describe('hand geometry', () => {
  it('finger mode is the index fingertip (landmark 8)', () => {
    expect(fingerTip(UPRIGHT)).toEqual({ x: 0.46, y: 0.45 });
    expect(tipFor(UPRIGHT, 'finger', 0.9, ASPECT)).toEqual({ x: 0.46, y: 0.45 });
  });

  it('measures the hand as wrist-to-middle-knuckle distance over frame width', () => {
    // dx 0.01 of the width, dy 0.2 of the height = 0.1125 of the width.
    expect(handSize(UPRIGHT, ASPECT)).toBeCloseTo(Math.hypot(0.01, 0.2 / ASPECT), 10);
  });

  it('grip mode projects reach hand lengths past the knuckles, along the wrist-to-knuckles line', () => {
    const L = handSize(UPRIGHT, ASPECT);
    const tip = gripTip(UPRIGHT, 0.9, ASPECT);
    // Straight up from the knuckle centre (0.5, 0.6), 0.9 L away in isotropic units.
    expect(tip.x).toBeCloseTo(0.5, 10);
    expect(0.6 / ASPECT - iso(tip).y).toBeCloseTo(0.9 * L, 10);
    expect(tipFor(UPRIGHT, 'grip', 0.9, ASPECT)).toEqual(tip);
    // No reach: the knuckles themselves.
    expect(gripTip(UPRIGHT, 0, ASPECT)).toEqual({ x: 0.5, y: 0.6 });
  });

  it('projects in pixel space, so a hand tilted 45 degrees on screen projects at 45 degrees', () => {
    // Knuckles up and to the right of the wrist by the same number of pixels on a 16:9 frame:
    // 0.1 of the width to the right is 0.1 * 16/9 of the height up.
    const dy = 0.1 * ASPECT;
    const tilted = hand({ wrist: [0.4, 0.7], knuckles: [[0.49, 0.7 - dy + 0.01 * ASPECT], [0.495, 0.7 - dy + 0.005 * ASPECT], [0.505, 0.7 - dy - 0.005 * ASPECT], [0.51, 0.7 - dy - 0.01 * ASPECT]], indexTip: [0.6, 0.3] });
    const tip = gripTip(tilted, 1, ASPECT);
    const k = { x: 0.5, y: 0.7 - dy };
    const v = { x: iso(tip).x - iso(k).x, y: iso(tip).y - iso(k).y };
    expect(Math.atan2(-v.y, v.x) * (180 / Math.PI)).toBeCloseTo(45, 6);
  });

  it('holds a mistyped reach inside bounds and survives a degenerate hand', () => {
    const far = gripTip(UPRIGHT, 100, ASPECT);
    const capped = gripTip(UPRIGHT, 4, ASPECT);
    expect(far).toEqual(capped);
    expect(gripTip(UPRIGHT, Number.NaN, ASPECT)).toEqual(gripTip(UPRIGHT, 0.9, ASPECT));
    const flat = hand({ wrist: [0.5, 0.5], knuckles: [[0.5, 0.5], [0.5, 0.5], [0.5, 0.5], [0.5, 0.5]], indexTip: [0.5, 0.5] });
    expect(gripTip(flat, 0.9, ASPECT)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('measures the finger (5 to 8) for the palm (0 to 9), in isotropic units', () => {
    const s = fingerShape(UPRIGHT, ASPECT);
    // Index knuckle (0.47, 0.6) to tip (0.46, 0.45); wrist (0.5, 0.8) to middle knuckle (0.49, 0.6).
    expect(s.finger.x).toBeCloseTo(-0.01, 10);
    expect(s.finger.y).toBeCloseTo(-0.15 / ASPECT, 10);
    expect(s.palm.x).toBeCloseTo(-0.01, 10);
    expect(s.palm.y).toBeCloseTo(-0.2 / ASPECT, 10);
    expect(s.ratio).toBeCloseTo(Math.hypot(0.01, 0.15 / ASPECT) / Math.hypot(0.01, 0.2 / ASPECT), 10);
    // A finger dropped onto the fist is short for the same palm.
    const fist = hand({ wrist: [0.5, 0.8], knuckles: [[0.47, 0.6], [0.49, 0.6], [0.51, 0.6], [0.53, 0.6]], indexTip: [0.47, 0.63] });
    expect(fingerShape(fist, ASPECT).ratio).toBeLessThan(0.6 * s.ratio);
  });

  it('carries a finger on the palm: from knuckle 5, turned and scaled as the palm has been since', () => {
    const good = fingerShape(UPRIGHT, ASPECT);
    // The same hand carries the finger it has.
    const same = carriedFingerTip(UPRIGHT, good, ASPECT);
    expect(same.x).toBeCloseTo(0.46, 10);
    expect(same.y).toBeCloseTo(0.45, 10);

    // The hand moved, turned a quarter turn clockwise on screen and grew by half, and its fingertip fell
    // onto the knuckle. Built in isotropic units, then back to the frame's.
    const isoOf = (p: [number, number]) => ({ x: p[0], y: p[1] / ASPECT });
    const turn = (v: { x: number; y: number }) => ({ x: -v.y * 1.5, y: v.x * 1.5 });
    const w0 = isoOf([0.5, 0.8]);
    const w1 = { x: 0.3, y: 0.3 };
    const moved = (p: [number, number]) => {
      const v = turn({ x: isoOf(p).x - w0.x, y: isoOf(p).y - w0.y });
      return [w1.x + v.x, (w1.y + v.y) * ASPECT] as [number, number];
    };
    const knuckles: [number, number][] = [[0.47, 0.6], [0.49, 0.6], [0.51, 0.6], [0.53, 0.6]];
    const index = moved(knuckles[0]);
    const turned = hand({ wrist: [w1.x, w1.y * ASPECT], knuckles: knuckles.map(moved), indexTip: [index[0], index[1] + 0.002] });
    const tip = carriedFingerTip(turned, good, ASPECT);
    const finger = turn(good.finger);
    expect(tip.x).toBeCloseTo(index[0] + finger.x, 10);
    expect(tip.y).toBeCloseTo((isoOf(index).y + finger.y) * ASPECT, 10);

    // A palm of no length has no direction: the finger is carried as it was.
    const flat = hand({ wrist: [0.5, 0.6], knuckles: [[0.47, 0.6], [0.5, 0.6], [0.51, 0.6], [0.53, 0.6]], indexTip: [0.47, 0.6] });
    const kept = carriedFingerTip(flat, good, ASPECT);
    expect(kept.x).toBeCloseTo(0.47 + good.finger.x, 10);
    expect(kept.y).toBeCloseTo((0.6 / ASPECT + good.finger.y) * ASPECT, 10);
  });

  it('flips x into caster space only for unmirrored cameras', () => {
    expect(toCaster({ x: 0.2, y: 0.3 }, true)).toEqual({ x: 0.8, y: 0.3 });
    expect(toCaster({ x: 0.2, y: 0.3 }, false)).toEqual({ x: 0.2, y: 0.3 });
    const lm = landmarksToCaster(UPRIGHT, true);
    expect(lm).toHaveLength(21);
    expect(lm[LANDMARK.INDEX_TIP]).toEqual([0.54, 0.45]);
    expect(landmarksToCaster(UPRIGHT, false)[LANDMARK.INDEX_TIP]).toEqual([0.46, 0.45]);
  });

  it('takes confidence from the fingertip presence, else the handedness score', () => {
    expect(tipConfidence(0.97, undefined)).toBe(0.97);
    expect(tipConfidence(0.97, 0.8)).toBe(0.8);
    expect(tipConfidence(0.97, 0)).toBe(0.97);
    expect(tipConfidence(1.3, undefined)).toBe(1);
    expect(tipConfidence(undefined, undefined)).toBe(0.5);
    expect(tipConfidence(0.123456, undefined)).toBe(0.123);
  });

  it('checks a landmark array before use', () => {
    expect(isValidLandmarks(UPRIGHT)).toBe(true);
    expect(isValidLandmarks(UPRIGHT.slice(0, 30))).toBe(false);
    expect(isValidLandmarks([...UPRIGHT.slice(0, 62), Number.NaN])).toBe(false);
    expect(isValidLandmarks(null)).toBe(false);
  });
});
