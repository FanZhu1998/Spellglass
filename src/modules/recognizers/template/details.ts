// RecognitionDetail: how a stroke lined up against one spell (contracts/v1.ts). The engine turns
// this into the fizzle hint ("The downstroke stopped short: carry it through the circle", Section
// 10.5), practice grades it, and the stage settles the ink onto `aligned` when the spell is cast.
//
// Every detail of a path spell is computed against the spell's stored paths, even when a learned
// sample produced the score, so its fractions line up with GesturePart.until.
//
// Closed shapes (any_start): the fractions are positions on the stored loop with the start shift
// undone, as the contract asks. A full circle begun at the bottom therefore reports started 0.5 and
// reached 0.5, and one begun at the top reports 0 and 1. The part a stroke ended in is still the
// part at `reached`; how much of the loop it covered is (reached − started) mod 1, a full loop when
// the two meet. The late-start rule (started above about 0.1) does not apply to any_start gestures.

import type { RecognitionDetail } from '../../../contracts';
import { FLICK_ANGLES, POINTS, angleDiff, bestAlignment, directionDeg, normalizeSampled, rotateShape, type Alignment, type NormalizedPath, type StrokeRotations } from './match';
import { toStoredFraction, type PreparedSpell, type PreparedTemplate } from './templates';

export interface DetailInput {
  spell: PreparedSpell;
  /** The spell's candidate score and the id of the template that produced it. */
  score: number;
  template: string;
  /** Best stored variant and its alignment (null for flick spells). */
  seed: PreparedTemplate | null;
  alignment: Alignment | null;
}

export interface DetailContext {
  stroke: NormalizedPath;
  rot: StrokeRotations;
  aspect: number;
}

/** Window of the stroke, in points, used to find where it strayed most (about an eighth of it). */
export const STRAY_WINDOW = 8;

/** Smallest share of the stored path a stroke is matched against when looking for where it began
 *  and ended. */
const MIN_COVER = 0.25;
/** A slight preference for covering more of the path, so a stroke that matches several windows
 *  equally well (a line matches every piece of a line) is said to cover the whole path. In units of
 *  mean distance per whole path left out: leaving out a tenth costs 0.002, a few percent of a good
 *  match's distance (0.05 to 0.1). */
const COVER_PENALTY = 0.02;
/** How far a window search may tilt beyond the best full-path tilt, degrees. */
const WINDOW_TILT_DEG = 6;

export function detailFor(input: DetailInput, ctx: DetailContext): RecognitionDetail {
  return input.spell.gesture.flick ? flickDetail(input, ctx) : pathDetail(input, ctx);
}

/** Flicks: the settled shape is a straight line from the stroke's start to its end, and a flick has
 *  no parts, so it always counts as reached (contract review). */
function flickDetail(input: DetailInput, ctx: DetailContext): RecognitionDetail {
  const { shape } = ctx.stroke;
  const r = ctx.stroke.resampled;
  const last = POINTS - 1;
  const deviation: number[] = [];
  const aligned: [number, number][] = [];
  for (let i = 0; i < POINTS; i++) {
    const f = i / last;
    const lx = shape.xs[0] + (shape.xs[last] - shape.xs[0]) * f;
    const ly = shape.ys[0] + (shape.ys[last] - shape.ys[0]) * f;
    deviation.push(round(Math.hypot(shape.xs[i] - lx, shape.ys[i] - ly), 4));
    const ix = r[0][0] + (r[last][0] - r[0][0]) * f;
    const iy = r[0][1] + (r[last][1] - r[0][1]) * f;
    aligned.push([round(ix / ctx.aspect, 5), round(iy, 5)]);
  }
  const dir = directionDeg(r);
  const flick = input.spell.gesture.flick!;
  const stray = strayIndices(deviation);
  return {
    spellId: input.spell.spellId,
    score: input.score,
    template: input.template,
    pathIndex: 0,
    deviation,
    aligned,
    rotation: dir === null ? 0 : round(angleDiff(dir, FLICK_ANGLES[flick]), 1),
    reached: 1,
    started: 0,
    strayPath: { from: round(stray.from / last, 3), to: round(stray.to / last, 3) },
  };
}

function pathDetail(input: DetailInput, ctx: DetailContext): RecognitionDetail {
  const t = input.seed;
  const al = input.alignment;
  if (!t || !al) return emptyDetail(input, ctx);
  const { shape, frame } = ctx.stroke;
  // The stored path tilted onto the stroke, in the stroke's normalized frame.
  const a = rotateShape(t.shape, al.angle);
  const deviation: number[] = [];
  const aligned: [number, number][] = [];
  for (let i = 0; i < POINTS; i++) {
    deviation.push(round(Math.hypot(shape.xs[i] - a.xs[i], shape.ys[i] - a.ys[i]), 4));
    // Back through the same centroid and scale the stroke was normalized with, then to caster space.
    const ix = a.xs[i] / frame.scale + frame.cx;
    const iy = a.ys[i] / frame.scale + frame.cy;
    aligned.push([round(ix / ctx.aspect, 5), round(iy, 5)]);
  }
  const window = matchWindow(t, ctx.rot, nearbyAngles(ctx.rot, al.angle));
  const last = POINTS - 1;
  const stray = strayIndices(deviation);
  return {
    spellId: input.spell.spellId,
    score: input.score,
    template: input.template,
    pathIndex: t.pathIndex,
    deviation,
    aligned,
    rotation: round(al.angle, 1),
    reached: round(toStoredFraction(t, window.to, true), 3),
    started: round(toStoredFraction(t, window.from, false), 3),
    strayPath: storedSpan(t, stray.from / last, stray.to / last),
  };
}

/** A spell with no usable stored path (should not happen with valid packs): a detail that says so
 *  without inventing a shape. */
function emptyDetail(input: DetailInput, ctx: DetailContext): RecognitionDetail {
  const r = ctx.stroke.resampled;
  return {
    spellId: input.spell.spellId,
    score: input.score,
    template: input.template,
    pathIndex: 0,
    deviation: new Array<number>(POINTS).fill(0),
    aligned: r.map((p) => [round(p[0] / ctx.aspect, 5), round(p[1], 5)] as [number, number]),
    rotation: 0,
    reached: 1,
    started: 0,
  };
}

/** Indices of the rotation band within WINDOW_TILT_DEG of the full-path tilt (at least the
 *  neighbouring steps). */
function nearbyAngles(rot: StrokeRotations, angle: number): number[] {
  const step = rot.angles.length > 1 ? Math.abs(rot.angles[1]) : 0;
  const reach = Math.max(WINDOW_TILT_DEG, step) + 1e-9;
  const out: number[] = [];
  rot.angles.forEach((a, i) => {
    if (Math.abs(a - angle) <= reach) out.push(i);
  });
  return out.length ? out : [0];
}

/**
 * Where on the template the stroke began and ended (RecognitionDetail.started and .reached): match
 * the stroke against windows [from, to] of the template, each resampled and normalized like a whole
 * template, and keep the best. A stroke that stopped short matches a prefix best; one that began late
 * matches a suffix. Coarse grid in steps of 0.05, then a local search in steps of 0.01.
 * Fractions are along the variant (start shift not yet undone). On a closed loop a window may cross
 * the seam, so `from` may be slightly negative.
 */
export function matchWindow(t: PreparedTemplate, rot: StrokeRotations, indices: number[]): { from: number; to: number; distance: number } {
  const xs = new Float64Array(POINTS);
  const ys = new Float64Array(POINTS);
  const fromMin = t.closed ? -0.15 : 0;
  const fromMax = 0.5;
  const span = (from: number) => (t.closed ? from + 1 : 1);
  let best = { from: 0, to: 1, distance: Infinity, cost: Infinity };
  const consider = (from: number, to: number) => {
    if (from < fromMin - 1e-9 || from > fromMax + 1e-9 || to > span(from) + 1e-9 || to - from < MIN_COVER - 1e-9) return;
    sampleWindow(t, from, to, xs, ys);
    const w = normalizeSampled(xs, ys);
    if (!w) return;
    // The distance this window would need to win, as a limit: a window that cannot win stops early.
    const penalty = COVER_PENALTY * (1 - (to - from));
    const al = bestAlignment(rot, w, indices, best.cost - penalty);
    const cost = al.distance + penalty;
    if (cost < best.cost) best = { from, to, distance: al.distance, cost };
  };
  const coarse = 0.05;
  for (let f = fromMin; f <= fromMax + 1e-9; f += coarse) {
    const from = round(f, 4);
    for (let to = span(from); to - from >= MIN_COVER - 1e-9; to -= coarse) consider(from, round(to, 4));
  }
  const fine = 0.01;
  const c = { from: best.from, to: best.to };
  for (let df = -4; df <= 4; df++) {
    for (let dt = -4; dt <= 4; dt++) consider(round(c.from + df * fine, 4), round(c.to + dt * fine, 4));
  }
  return { from: best.from, to: best.to, distance: best.distance };
}

/** POINTS points evenly spaced along the template between two of its fractions. */
function sampleWindow(t: PreparedTemplate, from: number, to: number, xs: Float64Array, ys: Float64Array): void {
  const path = t.path;
  const fr = t.fractions;
  const n = path.length;
  for (let j = 0; j < POINTS; j++) {
    let u = from + ((to - from) * j) / (POINTS - 1);
    if (t.closed) u -= Math.floor(u);
    if (u <= 0) { xs[j] = path[0][0]; ys[j] = path[0][1]; continue; }
    if (u >= 1) { xs[j] = path[n - 1][0]; ys[j] = path[n - 1][1]; continue; }
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (fr[mid] < u) lo = mid;
      else hi = mid;
    }
    const d = fr[hi] - fr[lo];
    const k = d > 0 ? (u - fr[lo]) / d : 0;
    xs[j] = path[lo][0] + k * (path[hi][0] - path[lo][0]);
    ys[j] = path[lo][1] + k * (path[hi][1] - path[lo][1]);
  }
}

/** The run of STRAY_WINDOW consecutive points with the largest total deviation (indices). */
export function strayIndices(deviation: readonly number[]): { from: number; to: number } {
  const w = Math.min(STRAY_WINDOW, deviation.length);
  if (w === 0) return { from: 0, to: 0 };
  let sum = 0;
  for (let i = 0; i < w; i++) sum += deviation[i];
  let best = sum, at = 0;
  for (let i = w; i < deviation.length; i++) {
    sum += deviation[i] - deviation[i - w];
    if (sum > best + 1e-12) {
      best = sum;
      at = i - w + 1;
    }
  }
  return { from: at, to: at + w - 1 };
}

/** A span of the variant as fractions of the stored path. On a shifted loop the span may cross the
 *  stored path's seam; then the larger of its two pieces is reported, so `from` ≤ `to` always holds
 *  and the middle of the span lies on the part that strayed. */
function storedSpan(t: PreparedTemplate, from: number, to: number): { from: number; to: number } {
  const a = toStoredFraction(t, from, false);
  const b = toStoredFraction(t, to, true);
  if (a <= b) return { from: round(a, 3), to: round(b, 3) };
  return 1 - a >= b ? { from: round(a, 3), to: 1 } : { from: 0, to: round(b, 3) };
}

function round(v: number, digits: number): number {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}
