// Pure path geometry shared by the pack loader, recognizer, stage and share modules.
// Points are [x, y]. Caster space is normalized per axis; call toIsotropic() with the source's
// aspect ratio before comparing shapes, so a circle in the air stays a circle.

import type { Point } from '../contracts';

export interface Box { minX: number; minY: number; maxX: number; maxY: number; w: number; h: number }

export function dist(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

export function pathLength(pts: readonly Point[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i]);
  return d;
}

/** Resample to n points evenly spaced along the path (the $1 recognizer's step 1). */
export function resample(pts: readonly Point[], n = 64): Point[] {
  if (pts.length === 0) return [];
  if (pts.length === 1 || n < 2) return Array.from({ length: n }, () => [pts[0][0], pts[0][1]] as Point);
  const total = pathLength(pts);
  if (total === 0) return Array.from({ length: n }, () => [pts[0][0], pts[0][1]] as Point);
  const step = total / (n - 1);
  const out: Point[] = [[pts[0][0], pts[0][1]]];
  let acc = 0;
  let prev: Point = [pts[0][0], pts[0][1]];
  for (let i = 1; i < pts.length && out.length < n; i++) {
    let cur: Point = [pts[i][0], pts[i][1]];
    let d = dist(prev, cur);
    while (d > 0 && acc + d >= step && out.length < n) {
      const t = (step - acc) / d;
      const q: Point = [prev[0] + t * (cur[0] - prev[0]), prev[1] + t * (cur[1] - prev[1])];
      out.push(q);
      prev = q;
      d = dist(prev, cur);
      acc = 0;
    }
    acc += d;
    prev = cur;
  }
  const last = pts[pts.length - 1];
  while (out.length < n) out.push([last[0], last[1]]);
  out[n - 1] = [last[0], last[1]];
  return out;
}

export function centroid(pts: readonly Point[]): Point {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  const n = Math.max(1, pts.length);
  return [x / n, y / n];
}

export function bbox(pts: readonly Point[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] > maxY) maxY = p[1];
  }
  if (!pts.length) minX = minY = maxX = maxY = 0;
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

export function translate(pts: readonly Point[], dx: number, dy: number): Point[] {
  return pts.map((p) => [p[0] + dx, p[1] + dy] as Point);
}

/** Scale uniformly about the origin so the longer side of the bounding box is `size`. */
export function scaleUniform(pts: readonly Point[], size = 1): Point[] {
  const b = bbox(pts);
  const side = Math.max(b.w, b.h);
  if (side === 0) return pts.map((p) => [p[0], p[1]] as Point);
  const s = size / side;
  return pts.map((p) => [p[0] * s, p[1] * s] as Point);
}

/** Resample, move the centre of mass to the origin, scale so the longer side is 1 (Section 7.5 steps 1 to 3). */
export function normalize(pts: readonly Point[], n = 64): Point[] {
  const r = resample(pts, n);
  const c = centroid(r);
  return scaleUniform(translate(r, -c[0], -c[1]));
}

/** Rotate by `rad` (positive is clockwise on screen, since y points down) about a point. */
export function rotate(pts: readonly Point[], rad: number, about: Point = [0, 0]): Point[] {
  const cos = Math.cos(rad), sin = Math.sin(rad);
  return pts.map(([x, y]) => {
    const dx = x - about[0], dy = y - about[1];
    return [about[0] + dx * cos - dy * sin, about[1] + dx * sin + dy * cos] as Point;
  });
}

/** Mirror a unit-square path left to right (left-handed casters, Section 10.6). */
export function mirrorX(pts: readonly Point[]): Point[] {
  return pts.map((p) => [1 - p[0], p[1]] as Point);
}

/** Caster space (normalized per axis) to isotropic units: x is scaled by width ÷ height. */
export function toIsotropic(pts: readonly Point[], aspect: number): Point[] {
  return pts.map((p) => [p[0] * aspect, p[1]] as Point);
}

export function fromIsotropic(pts: readonly Point[], aspect: number): Point[] {
  return pts.map((p) => [p[0] / aspect, p[1]] as Point);
}

/** Cumulative fraction of the path's length at each point (0 at the start, 1 at the end). */
export function arcFractions(pts: readonly Point[]): number[] {
  const total = pathLength(pts);
  const out = [0];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += dist(pts[i - 1], pts[i]);
    out.push(total > 0 ? acc / total : i / (pts.length - 1));
  }
  return out;
}

/** The point at a fraction of the path's length. */
export function pointAt(pts: readonly Point[], fraction: number): Point {
  if (pts.length === 0) return [0, 0];
  const f = Math.min(1, Math.max(0, fraction));
  const fr = arcFractions(pts);
  for (let i = 1; i < pts.length; i++) {
    if (fr[i] >= f) {
      const span = fr[i] - fr[i - 1] || 1;
      const t = (f - fr[i - 1]) / span;
      return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])];
    }
  }
  const l = pts[pts.length - 1];
  return [l[0], l[1]];
}

/** Principal axes of a point set: angle of the long axis, and standard deviation along each. */
export function principalAxes(pts: readonly Point[]): { angle: number; major: number; minor: number } {
  const [cx, cy] = centroid(pts);
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) {
    const dx = x - cx, dy = y - cy;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  const n = Math.max(1, pts.length);
  sxx /= n; syy /= n; sxy /= n;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const l1 = tr / 2 + disc;
  const l2 = Math.max(0, tr / 2 - disc);
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { angle, major: Math.sqrt(l1), minor: Math.sqrt(l2) };
}

/** Narrow spread ÷ long spread (Section 7.5 stage 1). 0 is a perfect line; 1 is round.
 *  Pass isotropic points, ideally resampled so slow parts do not weigh more. */
export function linearity(pts: readonly Point[]): number {
  const { major, minor } = principalAxes(pts);
  return major > 0 ? minor / major : 1;
}

/** Fit a path into a box, uniformly scaled and centred (for drawing templates over strokes). */
export function fitInto(pts: readonly Point[], box: Box): Point[] {
  const b = bbox(pts);
  const side = Math.max(b.w, b.h) || 1;
  const target = Math.max(box.w, box.h);
  const s = target / side;
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const tx = (box.minX + box.maxX) / 2, ty = (box.minY + box.maxY) / 2;
  return pts.map((p) => [tx + (p[0] - cx) * s, ty + (p[1] - cy) * s] as Point);
}

/** Unit vector for a flick direction in screen coordinates (y down). */
export function flickVector(dir: 'up' | 'down' | 'left' | 'right'): Point {
  return dir === 'up' ? [0, -1] : dir === 'down' ? [0, 1] : dir === 'left' ? [-1, 0] : [1, 0];
}

/** A drawable path for a flick, in a unit square: a straight line through the middle. */
export function flickPath(dir: 'up' | 'down' | 'left' | 'right', n = 24): Point[] {
  const [vx, vy] = flickVector(dir);
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1) - 0.5;
    return [0.5 + vx * t * 0.8, 0.5 + vy * t * 0.8] as Point;
  });
}
