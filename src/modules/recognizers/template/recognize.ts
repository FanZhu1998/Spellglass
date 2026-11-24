// One stroke in, one Recognition's worth of results out (Section 7.5). Pure and deterministic: the
// module, the gesture lab's simulation and the pack-lint separation check all call this.
//
// The decision (accept at 0.72 with a lead of 0.04) belongs to the spell engine. This file only
// scores, ranks and explains.

import type { Point, RecognitionDetail } from '../../../contracts';
import { DEFAULT_SETTINGS } from '../../../contracts';
import { linearity as linearityOf, pathLength } from '../../../kernel/geometry';
import { detailFor } from './details';
import {
  FLICK_ANGLES, angleDiff, bestAlignment, directionDeg, flickScore, normalizePath, rotationAngles, scoreOf, strokeRotations,
  type Alignment,
} from './match';
import type { PreparedSpell, PreparedTemplate } from './templates';

/** Caster space of most webcams (Stroke.aspect's default). */
export const DEFAULT_ASPECT = 16 / 9;

/** The recognizer settings of Section 7.5 (contracts/settings.ts 'recognizer.*'). */
export interface RecognizerParams {
  flickLinearity: number;
  flickAngleDeg: number;
  lineTemplateLinearity: number;
  rotationDeg: number;
  rotationStepDeg: number;
}

export const DEFAULT_PARAMS: RecognizerParams = {
  flickLinearity: DEFAULT_SETTINGS['recognizer.flickLinearity'],
  flickAngleDeg: DEFAULT_SETTINGS['recognizer.flickAngleDeg'],
  lineTemplateLinearity: DEFAULT_SETTINGS['recognizer.lineTemplateLinearity'],
  rotationDeg: DEFAULT_SETTINGS['recognizer.rotationDeg'],
  rotationStepDeg: DEFAULT_SETTINGS['recognizer.rotationStepDeg'],
};

export interface RecognizeOptions {
  /** Compute RecognitionDetail (the simulation and the separation check do not need them). */
  details?: boolean;
  /** The practice focus spell: it always gets a detail when it is a candidate. */
  focus?: string | null;
  /** Every candidate scoring at least this gets a detail: min(engine.acceptScore,
   *  engine.assistedScore) in the module. The top three always do. */
  detailScore?: number;
  /** Score against the stored paths only, leaving learned samples out. */
  seedsOnly?: boolean;
}

export interface SpellMatch {
  spellId: string;
  score: number;
  /** Template that produced the score, e.g. 'flick:up', 'seed:0@start2', 'user:1'. */
  template: string;
  /** 'flick' when the score is stage 1's. */
  stage: 'flick' | 'template';
  /** The best score over the stored paths alone (stage 1 included for flicks, no learned samples). */
  seedScore: number;
  /** The stored variant that fits best, and how (path spells only), for details. */
  seed: PreparedTemplate | null;
  alignment: Alignment | null;
}

export interface RecognitionCore {
  /** One entry per spell given, best first; ties keep the spells' order. */
  candidates: { spellId: string; score: number }[];
  linearity: number;
  stage: 'flick' | 'template';
  details: RecognitionDetail[];
  /** Per spell, in candidate order. */
  matches: SpellMatch[];
}

/**
 * Score a stroke (caster-space points, in time order) against spells. `spells` is what may be
 * recognized: the enabled spells for a live stroke, the available ones for a dry run.
 */
export function recognize(
  points: readonly Point[],
  aspect: number,
  spells: readonly PreparedSpell[],
  params: RecognizerParams = DEFAULT_PARAMS,
  options: RecognizeOptions = {},
): RecognitionCore {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_ASPECT;
  // Isotropic first, before anything else (Stroke.aspect): a circle in the air is an ellipse in caster space.
  const iso: Point[] = [];
  for (const p of points) if (Number.isFinite(p[0]) && Number.isFinite(p[1])) iso.push([p[0] * a, p[1]]);

  if (iso.length < 2 || !(pathLength(iso) > 1e-6)) return degenerate(spells);

  const stroke = normalizePath(iso);
  const lin = linearityOf(stroke.resampled);
  const rot = strokeRotations(stroke.shape, rotationAngles(params.rotationDeg, params.rotationStepDeg));
  // Straight-line templates take part only when the stroke is nearly straight (Section 7.5 step 5);
  // they look a little like every elongated shape otherwise.
  const linesAllowed = lin < params.lineTemplateLinearity;
  const isLine = (t: PreparedTemplate) => t.linearity <= params.flickLinearity;
  // Stage 1 applies to straight strokes only, by their start-to-end direction.
  const dir = lin <= params.flickLinearity ? directionDeg(stroke.resampled) : null;

  const matches: SpellMatch[] = spells.map((spell) => {
    const g = spell.gesture;
    let stage1: number | null = null;
    if (g.flick && dir !== null) {
      const err = Math.abs(angleDiff(dir, FLICK_ANGLES[g.flick]));
      if (err <= params.flickAngleDeg) stage1 = flickScore(lin, err, params.flickLinearity, params.flickAngleDeg);
    }

    // Stage 2 over the stored paths. Two bests: the best template that takes part (its distance is
    // the score), and the closest stored path of all. Details refer to the first, or to the second
    // when no template took part (a line template left out still shows a player in practice how
    // close the stroke came).
    let compared: { t: PreparedTemplate; al: Alignment } | null = null;
    let closest: { t: PreparedTemplate; al: Alignment } | null = null;
    for (const t of g.seeds) {
      const gated = isLine(t) && !linesAllowed;
      // Flick details are a straight line from the stroke's start to its end; no fit needed.
      if (gated && g.flick) continue;
      // Only an alignment that can improve one of the bests needs its exact distance.
      const al = bestAlignment(rot, t.shape, undefined, (gated ? closest : compared)?.al.distance ?? Infinity);
      if (!Number.isFinite(al.distance)) continue;
      if (!closest || al.distance < closest.al.distance) closest = { t, al };
      if (!gated && (!compared || al.distance < compared.al.distance)) compared = { t, al };
    }
    const seedDistance = compared?.al.distance ?? Infinity;
    const ref = compared ?? closest;

    let score = scoreOf(seedDistance);
    let template = compared?.t.id ?? g.seeds[0]?.id ?? 'seed:0';
    const seedScore = stage1 ?? score;
    if (!options.seedsOnly && stage1 === null) {
      let userDistance = seedDistance;
      for (const t of spell.user) {
        if (isLine(t) && !linesAllowed) continue;
        const al = bestAlignment(rot, t.shape, undefined, userDistance);
        if (al.distance < userDistance) {
          userDistance = al.distance;
          template = t.id;
        }
      }
      score = scoreOf(userDistance);
    }
    if (stage1 !== null) {
      // The contract review: when stage 1 fires, the flick spell's score is the stage-1 score.
      score = stage1;
      template = g.seeds[0]?.id ?? `flick:${g.flick}`;
    }
    return {
      spellId: spell.spellId,
      score,
      template,
      stage: stage1 !== null ? 'flick' : 'template',
      seedScore,
      seed: g.flick ? null : ref?.t ?? null,
      alignment: g.flick ? null : ref?.al ?? null,
    } satisfies SpellMatch;
  });

  const order = matches.map((m, i) => ({ m, i })).sort((x, y) => y.m.score - x.m.score || x.i - y.i).map((e) => e.m);
  // 'flick' tells the engine to skip the lead rule, which is only safe when exactly one spell came
  // through stage 1 (two flick spells drawn the same way are as ambiguous as any other pair).
  const flicks = order.filter((m) => m.stage === 'flick').length;
  const stage = order[0]?.stage === 'flick' && flicks === 1 ? 'flick' : 'template';

  const details: RecognitionDetail[] = [];
  if (options.details) {
    const minScore = options.detailScore ?? Infinity;
    const byId = new Map(spells.map((s) => [s.spellId, s]));
    order.forEach((m, rank) => {
      if (rank < 3 || m.score >= minScore || m.spellId === options.focus) {
        details.push(detailFor({ spell: byId.get(m.spellId)!, score: m.score, template: m.template, seed: m.seed, alignment: m.alignment }, { stroke, rot, aspect: a }));
      }
    });
  }

  return {
    candidates: order.map((m) => ({ spellId: m.spellId, score: m.score })),
    linearity: lin,
    stage,
    details,
    matches: order,
  };
}

/** A stroke with no extent (a dot, or fewer than two usable points): every spell scores 0, and there
 *  is nothing to explain. */
function degenerate(spells: readonly PreparedSpell[]): RecognitionCore {
  const matches: SpellMatch[] = spells.map((s) => ({
    spellId: s.spellId,
    score: 0,
    template: s.gesture.seeds[0]?.id ?? 'seed:0',
    stage: 'template',
    seedScore: 0,
    seed: null,
    alignment: null,
  }));
  return { candidates: matches.map((m) => ({ spellId: m.spellId, score: 0 })), linearity: 1, stage: 'template', details: [], matches };
}
