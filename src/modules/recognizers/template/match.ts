// The geometric core of the template recognizer (Section 7.5): pure, deterministic functions, no
// kernel, no browser APIs. Everything here works on isotropic points, where one unit means the same
// distance on both axes (caster x multiplied by the stroke's aspect, see Stroke.aspect).
//
// Stage 2 follows the "$-family" recipe with the blueprint's changes:
//   1. resample to 64 points evenly spaced along the path;
//   2. move the centre of mass to the origin;
//   3. scale uniformly so the longer side of the bounding box is 1 (uniform, not per axis);
//   4. mean point-to-point distance to a template, minimized over a small band of rotations
//      (±15° in 3° steps), never rotated to a reference angle, so direction and orientation matter;
//   5. score = 1 − distance ÷ 0.707.
// Stage 1 (straight flicks) has its own analytic score, see flickScore().

import type { FlickDirection, Point } from '../../../contracts';
import { bbox, centroid, resample } from '../../../kernel/geometry';

/** Points per normalized path (Section 7.5 step 1, Appendix B "resampled to 64 on load"). */
export const POINTS = 64;

/** Section 7.5 step 5: score = 1 − distance ÷ 0.707. 0.707 is half the diagonal of the unit square,
 *  the same normalizer the $1 recognizer uses, so a template at the far corner scores 0. */
export const SCORE_DISTANCE = 0.707;

/** A normalized path, stored as two typed arrays because the matcher's inner loop runs a few
 *  hundred thousand times per stroke in the simulation. */
export interface Shape {
  xs: Float64Array;
  ys: Float64Array;
}

/** How a path was normalized: normalized = (p − centre) × scale. Kept so that a template aligned in
 *  the normalized frame can be mapped back onto the stroke with exactly the centroid and scale used
 *  for matching (the contract review: geometry.fitInto centres on the bounding box, normalize on the
 *  centroid; mixing them would shift the settled shape off the ink). */
export interface Frame {
  cx: number;
  cy: number;
  scale: number;
}

export interface NormalizedPath {
  shape: Shape;
  frame: Frame;
  /** The path resampled to POINTS points, before centring and scaling (same units as the input). */
  resampled: Point[];
}

/** Steps 1 to 3: resample, centroid to the origin, longer bounding-box side to 1. This is
 *  geometry.normalize() with the frame kept. A path of zero size keeps scale 1 (all points at 0). */
export function normalizePath(points: readonly Point[]): NormalizedPath {
  const resampled = resample(points, POINTS);
  const [cx, cy] = centroid(resampled);
  const b = bbox(resampled);
  const side = Math.max(b.w, b.h);
  const scale = side > 0 ? 1 / side : 1;
  const xs = new Float64Array(POINTS);
  const ys = new Float64Array(POINTS);
  for (let i = 0; i < POINTS; i++) {
    xs[i] = (resampled[i][0] - cx) * scale;
    ys[i] = (resampled[i][1] - cy) * scale;
  }
  return { shape: { xs, ys }, frame: { cx, cy, scale }, resampled };
}

/** Normalize points that are already POINTS evenly spaced points (window sampling), skipping the
 *  resample. Returns null when the window has no extent. */
export function normalizeSampled(xsIn: Float64Array, ysIn: Float64Array): Shape | null {
  let sx = 0, sy = 0;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < POINTS; i++) {
    const x = xsIn[i], y = ysIn[i];
    sx += x; sy += y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const side = Math.max(maxX - minX, maxY - minY);
  if (!(side > 0)) return null;
  const cx = sx / POINTS, cy = sy / POINTS, s = 1 / side;
  const xs = new Float64Array(POINTS);
  const ys = new Float64Array(POINTS);
  for (let i = 0; i < POINTS; i++) {
    xs[i] = (xsIn[i] - cx) * s;
    ys[i] = (ysIn[i] - cy) * s;
  }
  return { xs, ys };
}

export function shapeToPoints(shape: Shape): Point[] {
  return Array.from(shape.xs, (x, i) => [x, shape.ys[i]] as Point);
}

export function shapeFromPoints(points: readonly Point[]): Shape {
  const xs = new Float64Array(points.length);
  const ys = new Float64Array(points.length);
  points.forEach((p, i) => { xs[i] = p[0]; ys[i] = p[1]; });
  return { xs, ys };
}

/** Rotate about the origin by `deg` degrees, clockwise positive on screen (y points down), the
 *  convention of geometry.rotate(). */
export function rotateShape(shape: Shape, deg: number): Shape {
  const rad = (deg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const n = shape.xs.length;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = shape.xs[i], y = shape.ys[i];
    xs[i] = x * cos - y * sin;
    ys[i] = x * sin + y * cos;
  }
  return { xs, ys };
}

/** Most rotation angles we will try, whatever the settings say (a 0.1° step would be 300 angles). */
const MAX_ANGLES = 121;

/**
 * The rotation band of Section 7.5 step 4: 0, ±step, ±2·step ... up to ±max degrees. Zero comes first
 * and each angle before its larger neighbours, so when two angles fit equally well the smaller tilt
 * wins (comparisons below are strict).
 */
export function rotationAngles(maxDeg: number, stepDeg: number): number[] {
  const max = Number.isFinite(maxDeg) ? Math.min(180, Math.max(0, maxDeg)) : 0;
  let step = Number.isFinite(stepDeg) && stepDeg > 0 ? stepDeg : max || 1;
  if (max / step > (MAX_ANGLES - 1) / 2) step = max / ((MAX_ANGLES - 1) / 2);
  const out = [0];
  for (let k = 1; k * step <= max + 1e-9; k++) out.push(k * step, -k * step);
  return out;
}

/** The stroke rotated by −θ for every θ of the band. Rotating the stroke by −θ and comparing it with
 *  a template is the same as tilting the template by +θ onto the stroke, so angles[i] is the
 *  stroke's tilt relative to the template (RecognitionDetail.rotation). Computed once per stroke
 *  and shared by every template, which is what keeps 27 spells well inside the 50 ms budget. */
export interface StrokeRotations {
  angles: number[];
  shapes: Shape[];
}

export function strokeRotations(stroke: Shape, angles: readonly number[]): StrokeRotations {
  return { angles: [...angles], shapes: angles.map((a) => (a === 0 ? stroke : rotateShape(stroke, -a))) };
}

/** Mean point-to-point distance between two shapes of equal length. Gives up (Infinity) once the
 *  running sum shows it cannot beat `limit`, which only ever skips losing comparisons. */
export function meanDistance(a: Shape, b: Shape, limit = Infinity): number {
  const n = a.xs.length;
  const cap = limit * n;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const dx = a.xs[i] - b.xs[i];
    const dy = a.ys[i] - b.ys[i];
    sum += Math.sqrt(dx * dx + dy * dy);
    if (sum > cap) return Infinity;
  }
  return sum / n;
}

export interface Alignment {
  distance: number;
  /** Index into StrokeRotations.angles. */
  index: number;
  /** The stroke's tilt relative to the template, degrees, clockwise positive. */
  angle: number;
}

/** Step 4: the best distance over the rotation band (optionally only some of its indices). With a
 *  limit, rotations that cannot beat it are abandoned early, and the result is Infinity when none
 *  does. */
export function bestAlignment(rot: StrokeRotations, template: Shape, indices?: readonly number[], limit = Infinity): Alignment {
  let best = limit;
  let bestIndex = indices ? indices[0] ?? 0 : 0;
  const count = indices ? indices.length : rot.shapes.length;
  for (let k = 0; k < count; k++) {
    const i = indices ? indices[k] : k;
    const d = meanDistance(rot.shapes[i], template, best);
    if (d < best) {
      best = d;
      bestIndex = i;
    }
  }
  if (best === limit && limit !== Infinity) best = Infinity;
  return { distance: best, index: bestIndex, angle: rot.angles[bestIndex] ?? 0 };
}

/** Step 5, clamped to 0..1. */
export function scoreOf(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  return Math.min(1, Math.max(0, 1 - distance / SCORE_DISTANCE));
}

// ------------------------------------------------------------------------------------- stage 1

/** Screen angle of each flick direction: 0 is right, 90 down, −90 up, 180 left (y points down). */
export const FLICK_ANGLES: Record<FlickDirection, number> = { right: 0, down: 90, left: 180, up: -90 };

/** Signed difference a − b, wrapped to (−180, 180]. */
export function angleDiff(a: number, b: number): number {
  let d = (a - b) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Start-to-end direction of a path in degrees (Section 7.5 stage 1), or null for a closed or
 *  empty one. */
export function directionDeg(points: readonly Point[]): number | null {
  if (points.length < 2) return null;
  const a = points[0], b = points[points.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (dx === 0 && dy === 0) return null;
  return (Math.atan2(dy, dx) * 180) / Math.PI;
}

/**
 * Stage-1 score of a straight flick (the contract review's formula):
 *   score = 1 − 0.14 × (linearity ÷ flickLinearity) − 0.14 × (angleError ÷ flickAngleDeg)
 * A perfect flick scores 1. A clean one (linearity 0.05, 5° off) scores about 0.95. Each edge on its
 * own (linearity at 0.20, or 35° off) costs 0.14 and leaves 0.86, and a stroke at both edges at once
 * lands exactly on the 0.72 acceptance line. The two penalties are equal so that a slightly bent but
 * well-aimed flick and a straight but slightly mis-aimed one are treated alike. The result is only
 * meaningful inside the cone; callers check linearity ≤ flickLinearity and angleError ≤ flickAngleDeg.
 */
export function flickScore(linearity: number, angleErrorDeg: number, flickLinearity: number, flickAngleDeg: number): number {
  const l = flickLinearity > 0 ? Math.max(0, linearity) / flickLinearity : 1;
  const a = flickAngleDeg > 0 ? Math.abs(angleErrorDeg) / flickAngleDeg : 1;
  return Math.min(1, Math.max(0, 1 - 0.14 * l - 0.14 * a));
}
