// Templates ready to match: built once per gesture (cached by gestureKey in the module) and once
// per learned sample, never per stroke. Pure functions.
//
// Naming (RecognitionDetail.template): 'seed:K' is the spell's K-th stored path (the pack's, a
// gesture pack's or the player's redrawn one; whatever the spellbook says is in effect),
// 'seed:K@startS' its S-th start-point variant, 'flick:up' the straight line of a flick spell, and
// 'user:N' the N-th learned sample (best scoring first).

import type { FlickDirection, Gesture, GestureSample, Point } from '../../../contracts';
import { DEFAULT_START_POINTS } from '../../../contracts';
import { arcFractions, bbox, dist, flickPath, linearity, pathLength, resample } from '../../../kernel/geometry';
import { gesturePaths } from '../../../kernel/gestures';
import { POINTS, normalizePath, type Shape } from './match';

export interface PreparedTemplate {
  id: string;
  kind: 'seed' | 'flick' | 'user';
  /** Index into the spell's stored paths (seed), 0 for flicks, −1 for learned samples. */
  pathIndex: number;
  /** Start shift as a fraction of the closed loop: 0, or s ÷ start_points for an any_start variant. */
  shift: number;
  /** The variant is a closed loop (any_start), so windows may wrap around its seam. */
  closed: boolean;
  /** Stored path length ÷ loop length: below 1 when the loop had to be closed with a short segment. */
  storedShare: number;
  /** The unit-square path this template was made from, in the variant's own order (POINTS points). */
  path: Point[];
  /** Cumulative arc fractions of `path`, for sampling windows of it. */
  fractions: Float64Array;
  /** Normalized for matching (Section 7.5 steps 1 to 3). */
  shape: Shape;
  /** The template's own linearity. At or below recognizer.flickLinearity it is a line template, which
   *  is only compared when the stroke's linearity is under recognizer.lineTemplateLinearity. */
  linearity: number;
}

export interface PreparedGesture {
  flick: FlickDirection | null;
  anyStart: boolean;
  /** Stored paths and their start-point variants, or the flick's synthesized line. */
  seeds: PreparedTemplate[];
}

export interface PreparedSpell {
  spellId: string;
  gesture: PreparedGesture;
  /** Learned samples in effect for this spell (empty until the spell has enough of them). */
  user: PreparedTemplate[];
}

/** What the recognizer needs to know about one spell. SpellbookEntry provides all of it. */
export interface SpellInput {
  spellId: string;
  gesture: Gesture;
  /** SpellbookEntry.templates: 64-point stored paths in an isotropic unit square. Computed from the
   *  gesture when absent or empty, the way the pack loader does. */
  templates?: Point[][];
}

/** A gap between the ends of an any_start path no larger than this share of its size is closed with a
 *  straight segment; a wider one means the path is not a loop and gets no start-point variants
 *  (Section 7.5: several start points for closed shapes). */
const CLOSE_GAP_SHARE = 0.2;
/** Upper bound on start points, whatever a pack asks for (each one is a full template). */
const MAX_START_POINTS = 16;

/** The stored paths of a gesture as 64-point templates (what SpellbookEntry.templates holds). */
export function storedTemplates(gesture: Gesture): Point[][] {
  return gesturePaths(gesture)
    .filter((p) => Array.isArray(p) && p.length >= 2)
    .map((p) => resample(p, POINTS));
}

export function prepareGesture(gesture: Gesture, stored?: readonly Point[][]): PreparedGesture {
  if ('flick' in gesture) {
    const dir = gesture.flick;
    return { flick: dir, anyStart: false, seeds: [makeTemplate(`flick:${dir}`, 'flick', 0, flickPath(dir, POINTS), 0, false, 1)] };
  }
  const paths = stored && stored.length ? stored.map((p) => (p.length === POINTS ? p : resample(p, POINTS))) : storedTemplates(gesture);
  const anyStart = gesture.any_start === true;
  const count = Math.min(MAX_START_POINTS, Math.max(1, Math.floor(gesture.start_points ?? DEFAULT_START_POINTS)));
  const seeds: PreparedTemplate[] = [];
  paths.forEach((path, k) => {
    const loop = anyStart ? closeLoop(path) : null;
    if (!loop) {
      seeds.push(makeTemplate(`seed:${k}`, 'seed', k, path, 0, false, 1));
      return;
    }
    // Appendix B: "Protego is stored once and expanded to four start points". Each variant is the
    // same loop traced in the same direction from a point s/count of the way round.
    // Known limit (measured by `npm run lab`): with four start points and ±15° of rotation, a circle
    // begun more than about 15° from a start point matches poorly, so "from any point" really means
    // "from near the top, right, bottom or left". More start points would fix that but bring Incendio's
    // triangle within 0.82 of Protego, past pack lint's 0.80; the count stays the pack's to choose.
    const share = pathLength(path) / pathLength(loop);
    for (let s = 0; s < count; s++) {
      const shift = s / count;
      const variant = sampleLoop(loop, shift);
      seeds.push(makeTemplate(s === 0 ? `seed:${k}` : `seed:${k}@start${s}`, 'seed', k, variant, shift, true, share));
    }
  });
  return { flick: null, anyStart, seeds };
}

/** A learned sample as a template. Samples are open paths in the order they were drawn, so they get
 *  no start-point variants. */
export function prepareSample(sample: GestureSample, index: number): PreparedTemplate {
  const path = sample.points.length === POINTS ? sample.points : resample(sample.points, POINTS);
  return makeTemplate(`user:${index}`, 'user', -1, path, 0, false, 1);
}

function makeTemplate(id: string, kind: PreparedTemplate['kind'], pathIndex: number, path: readonly Point[], shift: number, closed: boolean, storedShare: number): PreparedTemplate {
  const n = normalizePath(path);
  return {
    id,
    kind,
    pathIndex,
    shift,
    closed,
    storedShare,
    path: n.resampled,
    fractions: Float64Array.from(arcFractions(n.resampled)),
    shape: n.shape,
    linearity: linearity(n.resampled),
  };
}

/** The path as a closed loop (its first point appended when the ends do not already meet), or null
 *  when the ends are too far apart for it to be a loop. */
export function closeLoop(path: readonly Point[]): Point[] | null {
  if (path.length < 3) return null;
  const b = bbox(path);
  const size = Math.max(b.w, b.h);
  if (!(size > 0)) return null;
  const gap = dist(path[0], path[path.length - 1]);
  if (gap > CLOSE_GAP_SHARE * size) return null;
  return gap > 1e-9 ? [...path, path[0]] : [...path];
}

/** POINTS points evenly spaced around a closed loop, starting `shift` of the way round. The last
 *  point lands back on the first, so the variant is closed like the stored loop. */
export function sampleLoop(loop: readonly Point[], shift: number): Point[] {
  const fr = Float64Array.from(arcFractions(loop));
  const out: Point[] = [];
  for (let i = 0; i < POINTS; i++) {
    const u = shift + i / (POINTS - 1);
    out.push(pointAtFraction(loop, fr, u - Math.floor(u)));
  }
  // u = shift + 1 wraps to `shift` itself; make that explicit so rounding cannot open the loop.
  out[POINTS - 1] = [out[0][0], out[0][1]];
  return out;
}

/** The point at arc fraction u (0..1) of a path whose cumulative fractions are `fr`. */
export function pointAtFraction(path: readonly Point[], fr: Float64Array, u: number): Point {
  const n = path.length;
  if (n === 0) return [0, 0];
  if (u <= 0) return [path[0][0], path[0][1]];
  if (u >= 1) return [path[n - 1][0], path[n - 1][1]];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (fr[mid] < u) lo = mid;
    else hi = mid;
  }
  const span = fr[hi] - fr[lo];
  const t = span > 0 ? (u - fr[lo]) / span : 0;
  return [path[lo][0] + t * (path[hi][0] - path[lo][0]), path[lo][1] + t * (path[hi][1] - path[lo][1])];
}

/**
 * Convert a fraction along a template variant into a fraction of the spell's stored path, undoing the
 * start shift (RecognitionDetail: "fractions refer to the stored path with start shifts undone").
 * Open paths are unchanged. On a closed loop the start and the end are the same point, so `end` says
 * which name to give it: the end of a stroke that comes all the way round is reported as 1, a start
 * there as 0. A fraction that falls on the closing segment of a loop that was not already closed
 * counts as the stored path's end.
 */
export function toStoredFraction(t: PreparedTemplate, u: number, end: boolean): number {
  if (!t.closed) return clamp01(u);
  let l = t.shift + u;
  l -= Math.floor(l);
  if (end && l < 1e-6) l = 1;
  if (!end && l > 1 - 1e-6) l = 0;
  return clamp01(t.storedShare > 0 ? l / t.storedShare : l);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
