// Synthetic casts: a gesture's stored path, distorted the way a hand in the air distorts it.
// Used by the simulated check (simulate.ts) and the recorded-session fixtures (make-sessions.ts).
//
// The noise model follows Section 7.5: "tilt (6° standard deviation), independent stretch on each
// axis (12%), shear, slow wobble, rounded corners, ragged starts and ends, and 30 to 70 jittered
// samples". The blueprint gives magnitudes only for tilt and stretch; the others below are this
// lab's own choice, picked to look like a careful but unpractised caster, NOT tuned to reproduce
// the blueprint's table. Every magnitude scales with the noise factor (1, or 1.5 for "noise × 1.5").
//
//   tilt     whole-stroke rotation, normal, sd 6°
//   stretch  x and y scaled independently by 1 + normal(sd 0.12)
//   shear    x += k·y, k normal with sd 0.08
//   wobble   slow drift: on each axis a sinusoid of 0.5 to 1.5 cycles per stroke, amplitude normal
//            with sd 2% of the gesture's size
//   round    corners rounded by a Gaussian smoothing along the path, sd up to 3% of its length
//   ragged   each end trimmed by up to 5% of the length, and with even odds given a hook of up to
//            5% of the gesture's size turned back 90° to 180° from the way the path was going
//   speed    uneven pace: samples spaced along the path by a smooth random warp
//   jitter   each sample moved by normal noise, sd 0.6% of the gesture's size
//   samples  30 to 70, uniform
// Flick spells are noisy straight strokes: the same model applied to a straight line, plus a bow
// (a wrist pivots, so flicks arc slightly) with sagitta normal, sd 4% of the length.

import type { FlickDirection, Gesture, Point } from '../../src/contracts';
import { DEFAULT_START_POINTS } from '../../src/contracts';
import { arcFractions, bbox, centroid, flickVector, pointAt, resample } from '../../src/kernel/geometry';
import { gesturePaths } from '../../src/kernel/gestures';
import type { Rng } from './random';

export interface NoiseModel {
  tiltDeg: number;
  stretch: number;
  shear: number;
  wobble: number;
  round: number;
  ragged: number;
  jitter: number;
  /** Sagitta of a flick's bow, as a share of its length (sd). */
  bow: number;
  minSamples: number;
  maxSamples: number;
}

export const NOISE: NoiseModel = {
  tiltDeg: 6,
  stretch: 0.12,
  shear: 0.08,
  wobble: 0.02,
  round: 0.03,
  ragged: 0.05,
  jitter: 0.006,
  bow: 0.04,
  minSamples: 30,
  maxSamples: 70,
};

const DENSE = 256;

/**
 * Where a cast of an any_start gesture begins:
 *   'stored'    at one of the gesture's start points (start_points of them, evenly round the loop),
 *               which is what the recognizer stores as templates (Appendix B: "Protego is stored
 *               once and expanded to four start points"). The default, and the blueprint's check.
 *   'anywhere'  at a uniformly random point of the loop, as the gesture text promises ("A circle,
 *               clockwise, from any point"). The lab reports this separately: with four start points
 *               and ±15° of rotation, only starts within about 15° of a start point match well.
 */
export type StartMode = 'stored' | 'anywhere';

/**
 * One distorted cast of a gesture, as isotropic points centred on the origin with the gesture's
 * larger side about 1 (before distortion). `noise` scales every magnitude of the model.
 * `samples` overrides the sample count (the session fixtures sample by time instead).
 */
export function distortGesture(gesture: Gesture, rng: Rng, noise = 1, model: NoiseModel = NOISE, samples?: number, start: StartMode = 'stored'): Point[] {
  const base = 'flick' in gesture ? flickLine(gesture.flick, rng, noise, model) : pathFor(gesture, rng, start);
  return distortPath(base, rng, noise, model, samples);
}

/** The stored path to draw: one of the gesture's paths, at random, from a start point. */
function pathFor(gesture: Gesture, rng: Rng, start: StartMode): Point[] {
  const paths = gesturePaths(gesture);
  const path = paths.length > 1 ? rng.pick(paths) : paths[0];
  if (!('flick' in gesture) && gesture.any_start) {
    const count = Math.max(1, Math.floor(gesture.start_points ?? DEFAULT_START_POINTS));
    return startAnywhere(path, start === 'anywhere' ? rng.float() : rng.int(0, count - 1) / count);
  }
  return path.map((p) => [p[0], p[1]] as Point);
}

/** A closed path re-traced from `shift` of the way round, same direction. */
export function startAnywhere(path: readonly Point[], shift: number): Point[] {
  const loop = resample(path, DENSE);
  const out: Point[] = [];
  for (let i = 0; i < DENSE; i++) {
    const u = shift + i / (DENSE - 1);
    out.push(pointAt(loop, u - Math.floor(u)));
  }
  return out;
}

/** A straight stroke in a flick's direction with a slight bow, in a unit-size frame. */
function flickLine(dir: FlickDirection, rng: Rng, noise: number, model: NoiseModel): Point[] {
  const [vx, vy] = flickVector(dir);
  const bow = rng.normal(model.bow * noise);
  const out: Point[] = [];
  for (let i = 0; i < DENSE; i++) {
    const u = i / (DENSE - 1);
    const along = u - 0.5;
    const across = bow * Math.sin(Math.PI * u);
    // Perpendicular to (vx, vy) is (−vy, vx).
    out.push([0.5 + vx * along - vy * across, 0.5 + vy * along + vx * across]);
  }
  return out;
}

export function distortPath(path: readonly Point[], rng: Rng, noise = 1, model: NoiseModel = NOISE, samples?: number): Point[] {
  let dense = resample(path, DENSE);
  const b0 = bbox(dense);
  const size = Math.max(b0.w, b0.h) || 1;

  // Rounded corners: smooth along the path.
  const sigma = rng.uniform(0, model.round * noise) * (DENSE - 1);
  if (sigma >= 0.5) dense = smooth(dense, sigma);

  // Ragged starts and ends: trim, then maybe hook.
  const trimStart = rng.uniform(0, model.ragged * noise);
  const trimEnd = rng.uniform(0, model.ragged * noise);
  dense = subPath(dense, trimStart, 1 - trimEnd);
  if (rng.chance(0.5)) dense = hook(dense, rng, rng.uniform(0, model.ragged * noise) * size, true);
  if (rng.chance(0.5)) dense = hook(dense, rng, rng.uniform(0, model.ragged * noise) * size, false);

  // Uneven pace: sample at warped arc fractions. w(u) = u + a/(2πm)·(sin(2πmu + φ) − sin φ) keeps
  // w(0) = 0 and w(1) = 1, and its slope 1 + a·cos(...) stays positive for |a| < 1, so order holds.
  const n = samples ?? rng.int(model.minSamples, model.maxSamples);
  const fr = arcFractions(dense);
  const warp = paceWarp(rng);
  const pts: Point[] = [];
  for (let i = 0; i < n; i++) pts.push(at(dense, fr, warp(n > 1 ? i / (n - 1) : 0)));

  // Slow wobble.
  const wx = { a: rng.normal(model.wobble * noise) * size, f: rng.uniform(0.5, 1.5), p: rng.uniform(0, 2 * Math.PI) };
  const wy = { a: rng.normal(model.wobble * noise) * size, f: rng.uniform(0.5, 1.5), p: rng.uniform(0, 2 * Math.PI) };
  for (let i = 0; i < pts.length; i++) {
    const u = pts.length > 1 ? i / (pts.length - 1) : 0;
    pts[i] = [pts[i][0] + wx.a * Math.sin(2 * Math.PI * wx.f * u + wx.p), pts[i][1] + wy.a * Math.sin(2 * Math.PI * wy.f * u + wy.p)];
  }

  // Tilt, stretch and shear about the centre.
  const [cx, cy] = centroid(pts);
  const theta = (rng.normal(model.tiltDeg * noise) * Math.PI) / 180;
  const sx = Math.max(0.5, 1 + rng.normal(model.stretch * noise));
  const sy = Math.max(0.5, 1 + rng.normal(model.stretch * noise));
  const k = rng.normal(model.shear * noise);
  const cos = Math.cos(theta), sin = Math.sin(theta);
  const out = pts.map(([x, y]) => {
    let dx = (x - cx) * sx, dy = (y - cy) * sy;
    dx += k * dy;
    return [dx * cos - dy * sin, dx * sin + dy * cos] as Point;
  });

  // Jitter.
  const j = model.jitter * noise * size;
  return out.map(([x, y]) => [x + rng.normal(j), y + rng.normal(j)] as Point);
}

/** A random monotone map of [0, 1] onto itself: where along the path the hand is at each moment. */
export function paceWarp(rng: Rng): (u: number) => number {
  const m = rng.int(1, 2);
  const amp = rng.uniform(-0.6, 0.6);
  const phase = rng.uniform(0, 2 * Math.PI);
  const k = amp / (2 * Math.PI * m);
  return (u) => Math.min(1, Math.max(0, u + k * (Math.sin(2 * Math.PI * m * u + phase) - Math.sin(phase))));
}

/** Gaussian smoothing along a path; near the ends the kernel is cut and renormalized, which pulls
 *  the ends in a little, as a real rounded stroke does. */
function smooth(pts: readonly Point[], sigma: number): Point[] {
  const r = Math.ceil(sigma * 3);
  const w: number[] = [];
  for (let k = -r; k <= r; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  return pts.map((_, i) => {
    let x = 0, y = 0, s = 0;
    for (let k = -r; k <= r; k++) {
      const j = i + k;
      if (j < 0 || j >= pts.length) continue;
      const wk = w[k + r];
      x += pts[j][0] * wk;
      y += pts[j][1] * wk;
      s += wk;
    }
    return [x / s, y / s] as Point;
  });
}

function subPath(pts: readonly Point[], from: number, to: number): Point[] {
  const fr = arcFractions(pts);
  const out: Point[] = [];
  for (let i = 0; i < DENSE; i++) out.push(at(pts, fr, from + ((to - from) * i) / (DENSE - 1)));
  return out;
}

/** Add a short hook at the start (arriving) or the end (leaving), turned 90° to 180° away from the
 *  path's direction there, the way a wand overshoots and comes back. */
function hook(pts: readonly Point[], rng: Rng, length: number, atStart: boolean): Point[] {
  if (length <= 0 || pts.length < 4) return [...pts];
  const k = Math.max(1, Math.floor(pts.length / 40));
  const a = atStart ? pts[k] : pts[pts.length - 1 - k];
  const b = atStart ? pts[0] : pts[pts.length - 1];
  const heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const turn = rng.uniform(Math.PI / 2, Math.PI) * (rng.chance(0.5) ? 1 : -1);
  const dir = heading + turn;
  const steps = 12;
  const extra: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    // Curve into the hook: the first part continues straight, then turns.
    const f = i / steps;
    const ang = heading + (dir - heading) * Math.min(1, f * 1.5);
    const prev = extra.length ? extra[extra.length - 1] : b;
    extra.push([prev[0] + Math.cos(ang) * (length / steps), prev[1] + Math.sin(ang) * (length / steps)]);
  }
  const joined = atStart ? [...extra.reverse(), ...pts] : [...pts, ...extra];
  return resample(joined, DENSE);
}

function at(pts: readonly Point[], fr: readonly number[], u: number): Point {
  if (u <= 0) return [pts[0][0], pts[0][1]];
  if (u >= 1) return [pts[pts.length - 1][0], pts[pts.length - 1][1]];
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fr[mid] < u) lo = mid;
    else hi = mid;
  }
  const span = fr[hi] - fr[lo] || 1;
  const t = (u - fr[lo]) / span;
  return [pts[lo][0] + t * (pts[hi][0] - pts[lo][0]), pts[lo][1] + t * (pts[hi][1] - pts[lo][1])];
}

/**
 * Place an isotropic stroke in caster space: scaled so its larger side is `height` of the frame's
 * height, centred at (cx, cy) in caster units, x divided by the aspect.
 */
export function toCaster(iso: readonly Point[], aspect: number, height: number, cx: number, cy: number): Point[] {
  const b = bbox(iso);
  const side = Math.max(b.w, b.h) || 1;
  const s = height / side;
  const mx = (b.minX + b.maxX) / 2, my = (b.minY + b.maxY) / 2;
  return iso.map(([x, y]) => [cx + ((x - mx) * s) / aspect, cy + (y - my) * s] as Point);
}
