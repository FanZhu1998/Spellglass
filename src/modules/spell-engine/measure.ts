// What the engine measures on a stroke, and the numbers it derives: tempo, quality and power
// (Section 7.7 "Quality and power"). Pure functions. Every calibration constant is here, with the
// reasoning, so it can be retuned against recorded casts (Section 13) in one place.

import type { Gesture, PlayArea, Point, Stroke } from '../../contracts';
import { geometry, gesturePaceMs } from '../../kernel';
import { clamp01, DEFAULT_ASPECT } from './types';

/** Measurements of one stroke. Lengths and sizes are relative to the play area, per axis, which is
 *  the measure the segmenter uses for its minimum stroke size (setting segmenter.minExtent). */
export interface StrokeFacts {
  /** t1 - t0, ms. */
  durationMs: number;
  /** max(bbox width ÷ playArea.w, bbox height ÷ playArea.h). */
  extent: number;
  /** Mean speed along the path, play-area units per second. */
  speed: number;
  /** Stroke.quality (0..1): lowered by dropouts and jitter. */
  smoothness: number;
  /** Width ÷ height of caster space for this stroke. */
  aspect: number;
  /** First and last points, caster space. The last point is the cast's aim (contracts/v1.ts). */
  start: { x: number; y: number };
  end: { x: number; y: number };
  /** Narrow ÷ long spread of the isotropic stroke (0 is a perfect line). */
  linearity: number;
}

/** Below this the duration is treated as this, so a two-sample stroke cannot claim infinite speed. */
const MIN_DURATION_MS = 16;

export function isFlickGesture(g: Gesture | undefined): g is Extract<Gesture, { flick: unknown }> {
  return !!g && 'flick' in g;
}

/** Where pen-style trackers (mouse and touch) play: the whole mirror (contracts/settings.ts
 *  segmenter.minExtent). The calibrated play area applies to camera trackers. */
export const WHOLE_MIRROR: PlayArea = { x: 0, y: 0, w: 1, h: 1 };

/** A play area with a usable size (a zero-width one from a bad setting falls back to the frame). */
export function sanePlayArea(pa: PlayArea | undefined): PlayArea {
  if (!pa || !(pa.w > 0) || !(pa.h > 0)) return { x: 0, y: 0, w: 1, h: 1 };
  return pa;
}

export function playAreaCentre(pa: PlayArea): { x: number; y: number } {
  const p = sanePlayArea(pa);
  return { x: p.x + p.w / 2, y: p.y + p.h / 2 };
}

/** Measure a stroke. `linearity` is the recognizer's value when it sent one (Recognition.linearity). */
export function strokeFacts(stroke: Stroke, playArea: PlayArea, linearity?: number): StrokeFacts {
  const pa = sanePlayArea(playArea);
  const pts = stroke.points ?? [];
  const aspect = stroke.aspect && stroke.aspect > 0 ? stroke.aspect : DEFAULT_ASPECT;
  const span = stroke.t1 - stroke.t0;
  const durationMs = Number.isFinite(span) ? Math.max(0, span) : 0;
  const caster: Point[] = pts.map((p) => [p.x, p.y]);
  const box = geometry.bbox(caster);
  const extent = pts.length ? Math.max(box.w / pa.w, box.h / pa.h) : 0;
  let length = 0;
  for (let i = 1; i < pts.length; i++) {
    length += Math.hypot((pts[i].x - pts[i - 1].x) / pa.w, (pts[i].y - pts[i - 1].y) / pa.h);
  }
  const speed = length / (Math.max(MIN_DURATION_MS, durationMs) / 1000);
  const centre = playAreaCentre(pa);
  const first = pts[0];
  const last = pts[pts.length - 1];
  let lin = 1;
  if (typeof linearity === 'number' && Number.isFinite(linearity)) lin = linearity;
  else if (caster.length >= 2) lin = geometry.linearity(geometry.resample(geometry.toIsotropic(caster, aspect), 64));
  return {
    durationMs,
    extent,
    speed,
    smoothness: clamp01(stroke.quality),
    aspect,
    start: first ? { x: first.x, y: first.y } : centre,
    end: last ? { x: last.x, y: last.y } : centre,
    linearity: lin,
  };
}

// ------------------------------------------------------------------------------------- tempo

/** Tempo compares the stroke's duration with the gesture's intended pace (gesturePaceMs: the same
 *  pace the practice guide's dot moves at). Inside the comfortable band the tempo scores 1.
 *  Paths: half to 1.8 times the pace (an Alohomora at a 1.95 s pace is comfortable from about 1 s
 *  to 3.5 s; the segmenter caps strokes at 4 s anyway). Flicks are quicker and a snap is fine, so
 *  their band is wider at the fast end: a quarter to 2.5 times the 350 ms flick pace (90 to 875 ms).
 *  Outside the band the score halves for every doubling beyond it. */
export const TEMPO = {
  path: { lo: 0.5, hi: 1.8 },
  flick: { lo: 0.25, hi: 2.5 },
  falloffPerDoubling: 0.5,
} as const;

export type TempoVerdict = 'fast' | 'ok' | 'slow';

export function tempoRatio(durationMs: number, paceMs: number): number {
  return durationMs / Math.max(1, paceMs);
}

export function tempoVerdict(durationMs: number, paceMs: number, flick: boolean): TempoVerdict {
  const r = tempoRatio(durationMs, paceMs);
  const band = flick ? TEMPO.flick : TEMPO.path;
  return r < band.lo ? 'fast' : r > band.hi ? 'slow' : 'ok';
}

export function tempoScore(durationMs: number, paceMs: number, flick: boolean): number {
  const r = tempoRatio(durationMs, paceMs);
  const band = flick ? TEMPO.flick : TEMPO.path;
  if (r >= band.lo && r <= band.hi) return 1;
  const doublings = r < band.lo ? Math.log2(band.lo / Math.max(r, 1e-6)) : Math.log2(r / band.hi);
  return clamp01(1 - doublings * TEMPO.falloffPerDoubling);
}

// ----------------------------------------------------------------------------------- quality

/** Quality blends the match score with smoothness and tempo (Section 7.7), and the theme turns it
 *  into a grade (candlelit: Outstanding from 0.9, Exceeds Expectations from 0.8, else Acceptable).
 *  The shape carries most of the weight. The score is mapped so that 0.5 earns nothing and 0.9 (a
 *  clean match: mean distance about 0.07 of the stroke's size) earns everything; the template
 *  recognizer scores clean seed shapes about 0.99 and a clean flick about 0.95. Calibration, with a
 *  smooth stroke (0.95) at a comfortable tempo:
 *    score 0.92 → 0.99 Outstanding    score 0.86 → 0.93 Outstanding
 *    score 0.80 → 0.83 Exceeds        score 0.74 → 0.73 Acceptable    score 0.72 → 0.70 Acceptable
 *  Assisted casts (0.60 to 0.72) land around 0.5 to 0.7: Acceptable. A perfect shape traced twice
 *  too fast (tempo 0.5) drops to 0.89, Exceeds Expectations: rushing costs a grade. */
export const QUALITY = {
  scoreFloor: 0.5,
  scoreFull: 0.9,
  weights: { match: 0.65, smoothness: 0.15, tempo: 0.2 },
} as const;

/** A fizzle's quality is the nearest spell's score where it matters, so a near miss (0.6 to the
 *  acceptance score) grades Poor exactly as scored. Below 0.6 the scale is stretched 1.5 times away
 *  from 0.6: measured against the seed packs, a random scribble's nearest score sits between 0.43 and
 *  0.52 (median 0.47), which taken as-is would grade Dreadful; stretched it grades Troll (0.47 → 0.41),
 *  while a recognizable but wrong attempt (0.55) stays Dreadful (0.53). */
export const FIZZLE_QUALITY = { pivot: 0.6, stretch: 1.5 } as const;

export function fizzleQuality(score: number): number {
  const s = clamp01(score);
  return s >= FIZZLE_QUALITY.pivot ? s : clamp01(FIZZLE_QUALITY.pivot - (FIZZLE_QUALITY.pivot - s) * FIZZLE_QUALITY.stretch);
}

export function matchQuality(score: number): number {
  return clamp01((score - QUALITY.scoreFloor) / (QUALITY.scoreFull - QUALITY.scoreFloor));
}

export function castQuality(p: { score: number; smoothness: number; tempo: number }): number {
  const w = QUALITY.weights;
  return clamp01(w.match * matchQuality(p.score) + w.smoothness * clamp01(p.smoothness) + w.tempo * clamp01(p.tempo));
}

/** Quality of a stroke cast as `gesture` with match `score`. */
export function strokeQuality(gesture: Gesture, score: number, facts: StrokeFacts): number {
  const flick = isFlickGesture(gesture);
  return castQuality({
    score,
    smoothness: facts.smoothness,
    tempo: tempoScore(facts.durationMs, gesturePaceMs(gesture), flick),
  });
}

// ------------------------------------------------------------------------------------- power

/** Power (0..1) comes from stroke size and speed relative to the play area (Section 7.7).
 *  Size: 0 at the smallest stroke the segmenter evaluates (segmenter.minExtent, 0.15), 1 at three
 *  quarters of the play area. Speed: mean speed against a reference that earns full credit,
 *  3 play-area units per second for flicks (a flick across 0.75 of the area in 250 ms) and 1.5 for
 *  paths. Size weighs 0.6 and speed 0.4, so the pack's "brighter Lumos above 0.8" (Lumos Maxima)
 *  needs a flick both large (over half the play area) and quick; an everyday flick across a third
 *  of the area in 300 ms gives about 0.33. */
export const POWER = {
  sizeFull: 0.75,
  sizeWeight: 0.6,
  speedWeight: 0.4,
  flickSpeed: 3,
  pathSpeed: 1.5,
} as const;

/** Voice-only casts have no stroke to measure: they cast at middling power (no power variant). */
export const VOICE_POWER = 0.5;

export function castPower(facts: StrokeFacts, flick: boolean, minExtent: number): number {
  const lo = Math.min(Math.max(0, minExtent), POWER.sizeFull - 0.05);
  const size = clamp01((facts.extent - lo) / (POWER.sizeFull - lo));
  const speed = clamp01(facts.speed / (flick ? POWER.flickSpeed : POWER.pathSpeed));
  return clamp01(POWER.sizeWeight * size + POWER.speedWeight * speed);
}
