// One plain, specific hint per attempt.
//
// Section 7.5 Decision: a fizzle "names the nearest spell and shows where the stroke strayed".
// Section 10.3: practice gives "a grade and one specific hint", also for casts that could be better.
// Section 10.5: flavor lives in names; instructions stay plain, one sentence, sentence case.
// Hints never name the spell itself: the shell prefixes "Close to {Spell}." (contracts/v1.ts).
//
// Where the stroke went wrong comes from the RecognitionDetail: `reached` (stopped short below about
// 0.9), `started` (a late start above about 0.1) and the window that strayed most, mapped to the
// gesture's named parts (GesturePart.until, fractions of the stored path). The pack's own wording
// wins (short_hint, stray_hint); otherwise the contract's defaults are used.

import type { FlickDirection, Gesture, GesturePart, RecognitionDetail, SpellbookEntry } from '../../contracts';
import { geometry } from '../../kernel';
import type { StrokeFacts } from './measure';
import { isFlickGesture, tempoVerdict } from './measure';
import { clamp01 } from './types';

export type HintKind =
  | 'flick-direction' | 'flick-straight' | 'stopped-short' | 'late-start' | 'too-fast' | 'unsteady'
  | 'too-small' | 'stray' | 'too-slow' | 'general';

export interface HintContext {
  /** The effective gesture of the spell the hint is about. */
  gesture: Gesture;
  /** How the stroke lined up against that spell. */
  detail?: RecognitionDetail;
  facts?: StrokeFacts;
  /** gesturePaceMs(gesture). */
  paceMs: number;
  /** Setting recognizer.flickLinearity. */
  flickLinearity: number;
}

export interface HintAdvice {
  hint?: string;
  kind?: HintKind;
  /** The part of the stroke that strayed most, as fractions of the stroke's length (for drawing). */
  stray?: { from: number; to: number };
}

interface Thresholds {
  /** A flick more than this many degrees off its direction. */
  flickAngleDeg: number;
  /** A flick less straight than flickLinearity × this. */
  straightFactor: number;
  reachedBelow: number;
  startedAbove: number;
  /** Stroke.quality under this: dropouts and jitter. */
  unsteadyBelow: number;
  /** Stroke extent (of the play area) under this. */
  smallBelow: number;
  /** Mean deviation of the worst window above this (normalized units, longer side 1); null means
   *  any stray window counts. */
  strayMeanAbove: number | null;
}

/** A fizzle names the most likely cause, so its bars are low. */
const FIZZLE: Thresholds = {
  flickAngleDeg: 20, straightFactor: 1, reachedBelow: 0.9, startedAbove: 0.1, unsteadyBelow: 0.5, smallBelow: 0.25, strayMeanAbove: null,
};
/** An accepted cast only hears about something clearly improvable. A mean deviation of 0.1 over a
 *  window is roughly where the shape visibly leaves the guide (a whole stroke at that distance scores
 *  about 0.86). Size does not change the grade (only power), so only a really small accepted stroke,
 *  under a fifth of the play area, is told to grow. */
const IMPROVE: Thresholds = {
  flickAngleDeg: 12, straightFactor: 0.6, reachedBelow: 0.9, startedAbove: 0.1, unsteadyBelow: 0.6, smallBelow: 0.2, strayMeanAbove: 0.1,
};
/** Accepted casts below this quality (Exceeds Expectations) always get a hint, the worst window if
 *  nothing more specific. */
const ALWAYS_HINT_BELOW = 0.8;
/** Below this score a stroke does not resemble the spell enough for one part to be the problem
 *  (scribbles score about 0.43 to 0.52 against the seed packs), so no part is named as wandering. */
const STRAY_HINT_MIN_SCORE = 0.55;
/** Points in the sliding window that finds the stretch that strayed most: an eighth of the stroke,
 *  the same as the template recognizer's window for detail.strayPath (see findStray). */
export const STRAY_WINDOW_POINTS = 8;

export const TEXT = {
  flick: {
    up: 'Flick straight up.',
    down: 'Flick straight down.',
    left: 'Flick straight from right to left.',
    right: 'Flick straight from left to right.',
  } satisfies Record<FlickDirection, string>,
  flickStraight: 'Keep the flick straight.',
  flickSlow: 'Make the flick quicker.',
  flickFast: 'Flick a little more slowly.',
  flickSmall: 'Make the flick longer.',
  tooFast: 'Trace it more slowly.',
  tooSlow: 'Trace it a little faster.',
  tooSmall: 'Make the gesture larger.',
  unsteady: 'Move steadily and keep the tip in view.',
  general: 'Trace the shape more closely to the guide.',
  ambiguous: 'It looked like more than one spell: trace the shape more clearly.',
  cooldown: 'Wait a moment before casting it again.',
  strictNoneHeard: 'Say the incantation as you trace.',
  strictDisagreed: 'The incantation and the gesture named different spells.',
  unavailable: 'It is unavailable right now: check its pack in the Workshop.',
  /** Name used for a gesture without parts. */
  wholeStroke: 'the stroke',
} as const;

/** "{Part} stopped short: carry it through." unless the pack words it (GesturePart.short_hint). */
export function shortHint(part: GesturePart | null): string {
  if (part?.short_hint) return part.short_hint;
  return `${sentenceStart(part?.name ?? TEXT.wholeStroke)} stopped short: carry it through.`;
}

/** "{Part} wandered: keep it closer to the guide." unless the pack words it (GesturePart.stray_hint). */
export function strayHint(part: GesturePart | null): string {
  if (part?.stray_hint) return part.stray_hint;
  return `${sentenceStart(part?.name ?? TEXT.wholeStroke)} wandered: keep it closer to the guide.`;
}

export function lateStartHint(part: GesturePart | null): string {
  return `${sentenceStart(part?.name ?? TEXT.wholeStroke)} started late: begin where the guide begins.`;
}

/** "Cast Lumos first." for a spell whose needs_active are not active (Nox needs Lumos). */
export function needsActiveHint(names: readonly string[]): string {
  return `Cast ${joinNames(names)} first.`;
}

/** No hint for a locked spell: the shell's own sentence names it and says how to open it. */
export function unavailableHint(entry: SpellbookEntry | undefined): string | undefined {
  return entry && !entry.available ? TEXT.unavailable : undefined;
}

export function strictHint(issue: 'none-heard' | 'disagreed' | undefined): string {
  return issue === 'disagreed' ? TEXT.strictDisagreed : TEXT.strictNoneHeard;
}

/** The part a fraction of the stored path falls in: the first part it has not yet passed. */
export function partAt(parts: readonly GesturePart[] | undefined, fraction: number): GesturePart | null {
  if (!Array.isArray(parts) || !parts.length) return null;
  for (const p of parts) if (fraction < p.until) return p;
  return parts[parts.length - 1];
}

/** A fizzle's hint: the most likely cause, and where the stroke strayed. */
export function adviseFizzle(ctx: HintContext, reason: 'low-score' | 'ambiguous'): HintAdvice {
  const stray = findStray(ctx.detail);
  const strayRange = stray ? { from: stray.from, to: stray.to } : undefined;
  const found = firstIssue(ctx, FIZZLE, stray);
  if (found) return { ...found, stray: strayRange };
  return { kind: 'general', hint: reason === 'ambiguous' ? TEXT.ambiguous : TEXT.general, stray: strayRange };
}

/** An accepted cast's hint, when it could be better (practice, Section 10.3). Empty for a clean cast. */
export function adviseImprovement(ctx: HintContext, quality: number): HintAdvice {
  const stray = findStray(ctx.detail);
  const found = firstIssue(ctx, IMPROVE, stray);
  if (found) return found.kind === 'stray' && stray ? { ...found, stray: { from: stray.from, to: stray.to } } : found;
  if (quality < ALWAYS_HINT_BELOW && stray && !isFlickGesture(ctx.gesture)) {
    return { kind: 'stray', hint: strayHint(partAt(partsOf(ctx.gesture), stray.pathCentre)), stray: { from: stray.from, to: stray.to } };
  }
  return {};
}

/**
 * The checks, most telling first. Shape problems come before tempo and size, except that a stroke
 * traced far too fast is named before its wobbles, since the speed causes them. A stroke too small
 * for the tracker's jitter comes before the stray window for the same reason.
 */
function firstIssue(ctx: HintContext, th: Thresholds, stray: StrayWindow | null): { kind: HintKind; hint: string } | null {
  const { gesture, detail, facts } = ctx;
  const flick = isFlickGesture(gesture);
  if (flick && facts) {
    const off = flickAngleOff(facts, gesture.flick);
    if (off !== null && off > th.flickAngleDeg) return { kind: 'flick-direction', hint: TEXT.flick[gesture.flick] ?? TEXT.flickStraight };
    if (facts.linearity > ctx.flickLinearity * th.straightFactor) return { kind: 'flick-straight', hint: TEXT.flickStraight };
  }
  if (!flick && detail) {
    const shortAt = stoppedShortAt(gesture, detail, th.reachedBelow);
    if (shortAt !== null) return { kind: 'stopped-short', hint: shortHint(partAt(partsOf(gesture), shortAt)) };
    // A closed shape drawn "from any point" (Protego) cannot start late.
    if (!anyStart(gesture) && typeof detail.started === 'number' && detail.started > th.startedAbove) {
      return { kind: 'late-start', hint: lateStartHint(partAt(partsOf(gesture), detail.started)) };
    }
  }
  const tempo = facts ? tempoVerdict(facts.durationMs, ctx.paceMs, flick) : 'ok';
  if (tempo === 'fast') return { kind: 'too-fast', hint: flick ? TEXT.flickFast : TEXT.tooFast };
  if (facts && facts.smoothness < th.unsteadyBelow) return { kind: 'unsteady', hint: TEXT.unsteady };
  if (facts && facts.extent < th.smallBelow) return { kind: 'too-small', hint: flick ? TEXT.flickSmall : TEXT.tooSmall };
  const resembles = !detail || !Number.isFinite(detail.score) || detail.score >= STRAY_HINT_MIN_SCORE;
  if (!flick && stray && resembles && (th.strayMeanAbove === null || (stray.mean !== null && stray.mean > th.strayMeanAbove))) {
    return { kind: 'stray', hint: strayHint(partAt(partsOf(gesture), stray.pathCentre)) };
  }
  if (tempo === 'slow') return { kind: 'too-slow', hint: flick ? TEXT.flickSlow : TEXT.tooSlow };
  return null;
}

// ----------------------------------------------------------------------------- stray window

export interface StrayWindow {
  /** Stroke fractions (for drawing). */
  from: number;
  to: number;
  /** Centre of the window as a fraction of the stored path (for finding the part). */
  pathCentre: number;
  /** Mean deviation over the window, when the detail carries deviations. */
  mean: number | null;
}

/**
 * The stretch that strayed most, in two frames.
 *
 * Stroke fractions (for drawing, SpellFizzle.stray) come straight from the deviations: deviation[i]
 * is the distance from point i of the stroke, resampled to 64 points, to point i of the aligned stored
 * path, so window [i, j] is the stroke from i/63 to j/63. The window is STRAY_WINDOW_POINTS long and
 * found the way the template recognizer finds its own (largest total, first one on a tie), so on
 * the recognizer's details the two frames describe the same stretch.
 *
 * Stored-path fractions (for naming the part) come from detail.strayPath, which already undoes the
 * start shift of a closed loop (Protego may be traced from any point). Without it, the stroke window's
 * centre is used, which equals the stored-path fraction for every open path (index i of the aligned
 * path is fraction i/63 of it) and is only approximate on a shifted loop.
 */
export function findStray(detail: RecognitionDetail | undefined): StrayWindow | null {
  if (!detail) return null;
  const dev = Array.isArray(detail.deviation) ? detail.deviation.filter((d) => Number.isFinite(d)) : [];
  const sp = detail.strayPath && Number.isFinite(detail.strayPath.from) && Number.isFinite(detail.strayPath.to) ? detail.strayPath : null;
  const pathCentre = sp ? clamp01((sp.from + sp.to) / 2) : null;
  if (dev.length < 2) {
    if (!sp) return null;
    return { from: clamp01(Math.min(sp.from, sp.to)), to: clamp01(Math.max(sp.from, sp.to)), pathCentre: pathCentre!, mean: null };
  }
  const w = Math.min(STRAY_WINDOW_POINTS, dev.length);
  let sum = 0;
  let bestSum = -Infinity;
  let bestStart = 0;
  for (let i = 0; i < dev.length; i++) {
    sum += dev[i];
    if (i >= w) sum -= dev[i - w];
    if (i >= w - 1 && sum > bestSum + 1e-12) {
      bestSum = sum;
      bestStart = i - w + 1;
    }
  }
  const last = dev.length - 1;
  const from = bestStart / last;
  const to = (bestStart + w - 1) / last;
  return { from, to, pathCentre: pathCentre ?? (from + to) / 2, mean: bestSum / w };
}

// ----------------------------------------------------------------------------------- helpers

/**
 * Where on the stored path the stroke ended, when it stopped short (reached under `below`); null
 * otherwise. On an any_start loop the stroke may begin anywhere, and the recognizer's window may wrap
 * the loop's seam (a full Protego can come back as started 0.01, reached 0.01), so there what counts
 * is how much of the loop the stroke covered, from `started` round to `reached`.
 */
function stoppedShortAt(gesture: Gesture, detail: RecognitionDetail, below: number): number | null {
  if (!Number.isFinite(detail.reached)) return null;
  const reached = clamp01(detail.reached);
  if (!anyStart(gesture)) return reached < below ? reached : null;
  const started = typeof detail.started === 'number' && Number.isFinite(detail.started) ? clamp01(detail.started) : 0;
  const covered = reached > started ? reached - started : reached - started + 1;
  return covered < below ? reached : null;
}

function anyStart(g: Gesture): boolean {
  return !isFlickGesture(g) && g.any_start === true;
}

function partsOf(g: Gesture): GesturePart[] | undefined {
  return Array.isArray(g.parts) ? g.parts.filter((p) => p && typeof p.name === 'string' && Number.isFinite(p.until)) : undefined;
}

/** Degrees between the stroke's start-to-end direction (isotropic) and the flick's direction, or
 *  null when the stroke has no length. */
function flickAngleOff(facts: StrokeFacts, dir: FlickDirection): number | null {
  const dx = (facts.end.x - facts.start.x) * facts.aspect;
  const dy = facts.end.y - facts.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  const [vx, vy] = geometry.flickVector(dir);
  const cos = Math.min(1, Math.max(-1, (dx * vx + dy * vy) / len));
  return (Math.acos(cos) * 180) / Math.PI;
}

function sentenceStart(phrase: string): string {
  return phrase ? phrase[0].toUpperCase() + phrase.slice(1) : phrase;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
