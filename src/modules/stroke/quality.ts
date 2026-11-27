// Stroke.quality (0..1): "lowered by dropouts and jitter" (Section 6). The spell engine uses it as
// the stroke's smoothness, which weighs 0.15 in a cast's quality and so in its grade (Section 7.7).
//
//   quality = dropoutFactor × jitterFactor, rounded to 3 decimals
//
// dropoutFactor. The typical frame interval is the median step between the stroke's samples. A step
// longer than 2.5 typical intervals is a dropout (two or more frames missing in a row: "gaps longer
// than about two frame intervals"); it hides round(step ÷ interval) − 1 frames. A single dropped or
// late frame is not counted: cameras do that all the time, and it costs the shape nothing.
//   missedShare   = missed ÷ (steps + missed)          the share of frames that never arrived
//   dropoutFactor = 1 − missedShare ÷ 0.5, clamped     a quarter of the frames lost halves it;
//                                                      half of them lost takes it to 0
// Only a camera tracker sends a frame whether or not the tip moved. A pointer-style tracker
// (TrackerStatus.pen) sends nothing while the pointer is still, so a gap in its samples is a rest,
// not a dropout (the segmenter times a resting pointer the same way): its strokes are judged on
// jitter alone, dropoutFactor 1.
//
// jitterFactor. Roughness is how far the points sit from a smooth curve through their neighbours:
// for every point with two neighbours on each side, the distance from the centre of a least-squares
// quadratic through those five points (a Savitzky-Golay smoother), in isotropic frame widths. The
// median over the stroke, divided by the stroke's size (the longer side of its isotropic bounding
// box), is the roughness. A quadratic follows curves and changes of speed, so a clean flick that
// accelerates hard is not rough; jitter is. The median ignores the few points at a sharp corner.
//   jitterFactor = 1 at roughness 0.005 or less, falling linearly to 0 at 0.03
// Calibration (quality.test.ts: strokes 0.2 frame widths across, 30 fps, through the recommended
// filter, jitter in frame widths per axis): the bright tip's tracking jitter (0.08%, as in the
// recorded sessions) and 0.15% stay at 1; 0.3% gives about 0.9; 0.5% about 0.7; 1% about 0.3. The
// same jitter costs a small stroke more than a large one: it is the jitter you see in the trail.

import type { TipSample } from '../../contracts';

export const QUALITY = {
  /** A step longer than this many typical frame intervals is a dropout. */
  dropoutGapFrames: 2.5,
  /** The share of missing frames that takes the dropout factor to 0. */
  dropoutZeroShare: 0.5,
  /** Roughness at or under this is clean. */
  jitterClean: 0.005,
  /** Roughness at or over this makes the jitter factor 0. */
  jitterRough: 0.03,
} as const;

/** Savitzky-Golay weights for the centre of a quadratic fitted to 5 evenly spaced points. */
const SG5 = [-3, 12, 17, 12, -3].map((w) => w / 35);

/** Stroke.quality for these points (filtered, in time order). `pen`: they come from a pointer-style
 *  tracker, whose gaps are rests rather than dropouts. */
export function strokeQuality(points: readonly TipSample[], aspect: number, opts: { pen?: boolean } = {}): number {
  return round3((opts.pen ? 1 : dropoutFactor(points)) * jitterFactor(points, aspect));
}

/** The typical frame interval: the median step between the samples, or 0 with fewer than two steps
 *  to tell from. */
export function sampleInterval(points: readonly { t: number }[]): number {
  const steps = stepsOf(points);
  return steps.length < 2 ? 0 : median(steps);
}

/** Frames that never arrived, judged from the timestamps. */
export function missedFrames(points: readonly { t: number }[]): { missed: number; steps: number } {
  const steps = stepsOf(points);
  if (steps.length < 2) return { missed: 0, steps: steps.length };
  const interval = median(steps);
  let missed = 0;
  for (const d of steps) if (d > QUALITY.dropoutGapFrames * interval) missed += Math.round(d / interval) - 1;
  return { missed, steps: steps.length };
}

export function dropoutFactor(points: readonly { t: number }[]): number {
  const { missed, steps } = missedFrames(points);
  if (missed === 0) return 1;
  const share = missed / (steps + missed);
  return clamp01(1 - share / QUALITY.dropoutZeroShare);
}

/** Median distance from a local quadratic fit ÷ the stroke's size, in isotropic frame widths.
 *  0 for strokes too short to tell (fewer than 5 points) or with no size. */
export function roughness(points: readonly { x: number; y: number }[], aspect: number): number {
  if (points.length < SG5.length) return 0;
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  // Frame widths on both axes, like the segmenter's radii.
  const u = points.map((p) => p.x);
  const v = points.map((p) => p.y / a);
  const size = Math.max(Math.max(...u) - Math.min(...u), Math.max(...v) - Math.min(...v));
  if (!(size > 0)) return 0;
  const residuals: number[] = [];
  for (let i = 2; i < points.length - 2; i++) {
    let su = 0, sv = 0;
    for (let k = -2; k <= 2; k++) {
      su += SG5[k + 2] * u[i + k];
      sv += SG5[k + 2] * v[i + k];
    }
    residuals.push(Math.hypot(u[i] - su, v[i] - sv));
  }
  return median(residuals) / size;
}

export function jitterFactor(points: readonly { x: number; y: number }[], aspect: number): number {
  const r = roughness(points, aspect);
  return clamp01(1 - (r - QUALITY.jitterClean) / (QUALITY.jitterRough - QUALITY.jitterClean));
}

/** Steps between consecutive samples, leaving out repeated timestamps. */
function stepsOf(points: readonly { t: number }[]): number[] {
  const steps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const d = points[i].t - points[i - 1].t;
    if (d > 0) steps.push(d);
  }
  return steps;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
