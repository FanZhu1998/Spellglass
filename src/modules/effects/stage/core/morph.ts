// The settle (Section 10.1 step 2): "On success the line settles into the clean shape of the
// gesture and brightens." The clean shape is cast.detail.aligned when the engine sends it (already
// fitted onto the stroke, in caster space). Without it (voice casts) the stage fits the spell's
// template into the stroke's bounding box; flicks become a straight line.

import type { FlickDirection, Point, SpellbookEntry, SpellCast } from '../../../../contracts';
import { geometry } from '../../../../kernel';

/** Points in the morph. More than the recognizer's 64 so long spirals stay smooth. */
export const MORPH_POINTS = 96;

/** Side of the box a voice-only cast's sketch is drawn in, as a fraction of the caster height. */
export const VOICE_SKETCH_SIZE = 0.24;

/** Samples of a polyline, kept as parallel arrays so the hot path allocates nothing. */
export interface Samples {
  x: Float32Array;
  y: Float32Array;
  /** Optional per-point value carried through resampling (ink width). */
  w: Float32Array;
}

/**
 * Resample to n points evenly spaced along the path, measuring length isotropically (x × aspect)
 * so a horizontal stretch is not sampled more sparsely than a vertical one.
 */
export function resampleSamples(xs: ArrayLike<number>, ys: ArrayLike<number>, ws: ArrayLike<number> | null, n: number, aspect: number): Samples {
  const out: Samples = { x: new Float32Array(n), y: new Float32Array(n), w: new Float32Array(n) };
  const m = xs.length;
  if (m === 0) return out;
  if (m === 1) {
    out.x.fill(xs[0]);
    out.y.fill(ys[0]);
    out.w.fill(ws ? ws[0] : 0);
    return out;
  }
  const cum = new Float64Array(m);
  for (let i = 1; i < m; i++) cum[i] = cum[i - 1] + Math.hypot((xs[i] - xs[i - 1]) * aspect, ys[i] - ys[i - 1]);
  const total = cum[m - 1];
  let j = 1; // segment (j - 1, j) holds the current distance
  for (let k = 0; k < n; k++) {
    const d = n === 1 ? 0 : (total * k) / (n - 1);
    while (j < m - 1 && cum[j] < d) j++;
    const span = cum[j] - cum[j - 1];
    const t = span > 0 ? Math.min(1, Math.max(0, (d - cum[j - 1]) / span)) : 1;
    out.x[k] = xs[j - 1] + (xs[j] - xs[j - 1]) * t;
    out.y[k] = ys[j - 1] + (ys[j] - ys[j - 1]) * t;
    out.w[k] = ws ? ws[j - 1] + (ws[j] - ws[j - 1]) * t : 0;
  }
  return out;
}

export function samplesFromPoints(points: readonly Point[], n: number, aspect: number): Samples {
  return resampleSamples(points.map((p) => p[0]), points.map((p) => p[1]), null, n, aspect);
}

/** True when a path ends where it started (circles, figure-eights), so its start point is arbitrary. */
export function isClosed(s: Samples, aspect: number): boolean {
  const n = s.x.length;
  if (n < 3) return false;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = s.x[i] * aspect;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (s.y[i] < minY) minY = s.y[i];
    if (s.y[i] > maxY) maxY = s.y[i];
  }
  const size = Math.max(maxX - minX, maxY - minY) || 1;
  return Math.hypot((s.x[0] - s.x[n - 1]) * aspect, s.y[0] - s.y[n - 1]) < 0.15 * size;
}

/**
 * For a closed target, rotate its point order so it starts where the stroke started: people start
 * a circle anywhere (Section 7.5), and a morph between mismatched starts would sweep across the
 * shape. Returns the shift that minimizes the summed squared distance.
 */
export function bestCyclicShift(from: Samples, to: Samples, aspect: number): number {
  const n = Math.min(from.x.length, to.x.length);
  let best = 0, bestCost = Infinity;
  // The last point of a closed path repeats the first, so cycle over n - 1 distinct points.
  const m = n - 1;
  for (let s = 0; s < m; s++) {
    let cost = 0;
    for (let i = 0; i < n && cost < bestCost; i++) {
      const j = (i + s) % m;
      const dx = (from.x[i] - to.x[j]) * aspect, dy = from.y[i] - to.y[j];
      cost += dx * dx + dy * dy;
    }
    if (cost < bestCost) {
      bestCost = cost;
      best = s;
    }
  }
  return best;
}

export function shiftClosed(s: Samples, shift: number): Samples {
  const n = s.x.length;
  if (!shift || n < 3) return s;
  const m = n - 1;
  const out: Samples = { x: new Float32Array(n), y: new Float32Array(n), w: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    const j = (i + shift) % m;
    out.x[i] = s.x[j];
    out.y[i] = s.y[j];
    out.w[i] = s.w[j];
  }
  return out;
}

/** Align `to` with `from` for the morph: same count, and a matching start for closed shapes. */
export function alignForMorph(from: Samples, to: Samples, aspect: number): Samples {
  return isClosed(to, aspect) ? shiftClosed(to, bestCyclicShift(from, to, aspect)) : to;
}

/** Linear interpolation of two aligned sample sets into `out` (t is already eased). */
export function morphInto(from: Samples, to: Samples, t: number, out: Samples): void {
  const n = Math.min(from.x.length, to.x.length, out.x.length);
  const k = Math.min(1, Math.max(0, t));
  for (let i = 0; i < n; i++) {
    out.x[i] = from.x[i] + (to.x[i] - from.x[i]) * k;
    out.y[i] = from.y[i] + (to.y[i] - from.y[i]) * k;
  }
}

export const easeOutCubic = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
export const easeInOutCubic = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
};

/** A template (isotropic unit square) fitted into an isotropic box, returned in caster space. */
function fitTemplate(template: readonly Point[], box: geometry.Box, aspect: number): Point[] {
  return geometry.fromIsotropic(geometry.fitInto(template, box), aspect);
}

function flickOf(entry: SpellbookEntry | null): FlickDirection | null {
  const g = entry?.spell.gesture;
  return g && 'flick' in g ? g.flick : null;
}

/** The unit-square template the guide and the settle draw for a spell (flicks: a centred line). */
export function templateOf(entry: SpellbookEntry | null): Point[] | null {
  if (!entry) return null;
  const flick = flickOf(entry);
  if (flick) return geometry.flickPath(flick, 24);
  return entry.templates[0]?.length ? entry.templates[0] : null;
}

/**
 * The clean shape the ink settles into, in caster space, or null when there is nothing to draw.
 * stroke: the stroke's points in caster space, or null for a voice-only cast.
 */
export function settleTarget(stroke: readonly Point[] | null, cast: SpellCast, entry: SpellbookEntry | null, aspect: number): Point[] | null {
  const aligned = cast.detail?.aligned;
  if (stroke && stroke.length >= 2 && Array.isArray(aligned) && aligned.length >= 2 && cast.detail?.spellId === cast.spellId) {
    return aligned.map((p) => [p[0], p[1]] as Point);
  }
  const flick = flickOf(entry);
  if (stroke && stroke.length >= 2) {
    if (flick) return [[stroke[0][0], stroke[0][1]], [stroke[stroke.length - 1][0], stroke[stroke.length - 1][1]]];
    const template = templateOf(entry);
    if (!template) return null;
    return fitTemplate(template, geometry.bbox(geometry.toIsotropic(stroke, aspect)), aspect);
  }
  // Voice only: sketch the gesture around the aim, kept inside the frame.
  const template = templateOf(entry);
  if (!template) return null;
  const half = VOICE_SKETCH_SIZE / 2;
  const cx = Math.min(aspect - half - 0.04, Math.max(half + 0.04, cast.aim.x * aspect));
  const cy = Math.min(1 - half - 0.04, Math.max(half + 0.04, cast.aim.y));
  const box: geometry.Box = { minX: cx - half, minY: cy - half, maxX: cx + half, maxY: cy + half, w: half * 2, h: half * 2 };
  return fitTemplate(template, box, aspect);
}

/**
 * Practice guide path (Section 10.3): the template fitted into a comfortable box in the middle,
 * about 45% of the height, centred a little above the middle so it clears the shelf. Templates
 * arrive already mirrored for left-handed casters (SpellbookEntry.templates, gesture.flick).
 */
export const GUIDE_BOX_SIZE = 0.45;
export const GUIDE_CENTER_Y = 0.42;

export function guidePath(entry: SpellbookEntry | null, aspect: number): Point[] | null {
  const template = templateOf(entry);
  if (!template) return null;
  const half = GUIDE_BOX_SIZE / 2;
  const cx = 0.5 * aspect;
  const box: geometry.Box = { minX: cx - half, minY: GUIDE_CENTER_Y - half, maxX: cx + half, maxY: GUIDE_CENTER_Y + half, w: half * 2, h: half * 2 };
  return fitTemplate(template, box, aspect);
}

/**
 * The point at a fraction of a path's length, written into `out`. `fractions` are the path's
 * cumulative length fractions (geometry.arcFractions), computed once per path, so this is the
 * allocation-free twin of geometry.pointAt for drawing every frame. Fractions are measured in
 * caster space, as geometry.pointAt measures them, so the two agree.
 */
export function pointAlong(path: readonly Point[], fractions: readonly number[], f: number, out: { x: number; y: number }): void {
  const n = path.length;
  if (n === 0) {
    out.x = 0;
    out.y = 0;
    return;
  }
  const t = Math.min(1, Math.max(0, f));
  // Binary search for the first fraction at or past t.
  let lo = 1, hi = n - 1;
  if (n === 1 || fractions.length !== n) {
    out.x = path[n - 1][0];
    out.y = path[n - 1][1];
    return;
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fractions[mid] >= t) hi = mid;
    else lo = mid + 1;
  }
  const a = path[lo - 1], b = path[lo];
  const span = fractions[lo] - fractions[lo - 1] || 1;
  const k = Math.min(1, Math.max(0, (t - fractions[lo - 1]) / span));
  out.x = a[0] + (b[0] - a[0]) * k;
  out.y = a[1] + (b[1] - a[1]) * k;
}

/** Convert replay points recorded at one caster aspect into the current one, keeping the shape
 *  and its centre (Section 11.1: a replay link carries its own aspect). */
export function toCurrentAspect(points: readonly Point[], fromAspect: number, toAspect: number): Point[] {
  if (!(fromAspect > 0) || !(toAspect > 0) || Math.abs(fromAspect - toAspect) < 1e-6) return points.map((p) => [p[0], p[1]] as Point);
  const k = fromAspect / toAspect;
  return points.map((p) => [0.5 + (p[0] - 0.5) * k, p[1]] as Point);
}
