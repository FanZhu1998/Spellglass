// The simulated check of the seed set (Section 7.5): N synthetic casts per spell, distorted with the
// noise model in synth.ts, recognized by the real recognizer, and decided two ways:
//   best match wins   the top candidate is the answer (nothing fizzles)
//   thresholds        accept the top candidate at 0.72 or more and a lead of 0.04 or more over the
//                     runner-up (no lead rule for a stage-1 flick, as the engine does); otherwise fizzle
// Deterministic: every spell's casts come from their own seeded stream, so the 12 core spells are
// drawn identically in the 12, 24 and 27 sets, and a run can be repeated exactly.
//
// A spell's score does not depend on which other spells are enabled, so each cast is recognized once
// against every spell and the smaller sets are read off by leaving the others out.

import type { SpellPack } from '../../src/contracts';
import { DEFAULT_SETTINGS } from '../../src/contracts';
import { DEFAULT_ASPECT, DEFAULT_PARAMS, recognize, type RecognizerParams, type SpellMatch } from '../../src/modules/recognizers/template/recognize';
import { prepareSpells, spellsOf } from './packs';
import { Rng, seedFrom } from './random';
import { NOISE, distortGesture, toCaster, type NoiseModel, type StartMode } from './synth';

export interface Counts {
  total: number;
  correct: number;
  wrong: number;
  fizzled: number;
}

export interface SetSpec {
  name: string;
  spellIds: string[];
}

export interface SimulationRow {
  set: string;
  noise: number;
  rule: 'best' | 'thresholds';
  counts: Counts;
}

export interface SimulateOptions {
  /** Casts per spell (Section 7.5: 400). */
  casts?: number;
  /** Noise factors to run (1 and 1.5 for the blueprint's table). */
  noise?: number[];
  seed?: number;
  sets?: SetSpec[];
  model?: NoiseModel;
  params?: RecognizerParams;
  acceptScore?: number;
  leadMargin?: number;
  aspect?: number;
  /** Where casts of any_start gestures begin (synth.ts StartMode). Default 'stored'. */
  start?: StartMode;
  /** Only simulate these spells (the sets still decide which spells are candidates). */
  only?: string[];
}

export interface SimulationResult {
  rows: SimulationRow[];
  /** Thresholds rule, per spell and noise factor, in the largest set containing the spell. */
  perSpell: Record<string, Record<string, Counts>>;
  /** Wrong answers under 'best match wins' in the largest set: 'truth → answer' with counts. */
  confusions: Record<string, Record<string, number>>;
  /** Mean milliseconds per recognition (without details). */
  msPerStroke: number;
}

export type Decision = { kind: 'cast'; spellId: string } | { kind: 'fizzle'; spellId: null };

/** The engine's gesture-mode rule (Section 7.5 "Decision"; the lab's copy, the engine owns the real one). */
export function decide(matches: readonly SpellMatch[], acceptScore: number, leadMargin: number): Decision {
  const top = matches[0];
  if (!top) return { kind: 'fizzle', spellId: null };
  const flicks = matches.filter((m) => m.stage === 'flick').length;
  const flick = top.stage === 'flick' && flicks === 1;
  const lead = top.score - (matches[1]?.score ?? 0);
  if (top.score >= acceptScore && (flick || lead >= leadMargin)) return { kind: 'cast', spellId: top.spellId };
  return { kind: 'fizzle', spellId: null };
}

/** The sets of the blueprint's table: the 12 core spells, the 24 of the two default packs, all 27. */
export function seedSets(packs: readonly SpellPack[]): SetSpec[] {
  const ids = (...packIds: string[]) => spellsOf(packs.filter((p) => packIds.includes(p.id))).map((s) => s.id);
  return [
    { name: '12 core', spellIds: ids('core-charms') },
    { name: '24', spellIds: ids('core-charms', 'further-spells') },
    { name: 'All 27', spellIds: ids('core-charms', 'further-spells', 'restricted-section') },
  ].filter((s) => s.spellIds.length > 0);
}

const empty = (): Counts => ({ total: 0, correct: 0, wrong: 0, fizzled: 0 });

export function simulate(packs: SpellPack[], options: SimulateOptions = {}): SimulationResult {
  const casts = options.casts ?? 400;
  const noises = options.noise ?? [1, 1.5];
  const seed = options.seed ?? 1;
  const sets = options.sets ?? seedSets(packs);
  const model = options.model ?? NOISE;
  const params = options.params ?? DEFAULT_PARAMS;
  const accept = options.acceptScore ?? DEFAULT_SETTINGS['engine.acceptScore'];
  const lead = options.leadMargin ?? DEFAULT_SETTINGS['engine.leadMargin'];
  const aspect = options.aspect ?? DEFAULT_ASPECT;

  const union = new Set(sets.flatMap((s) => s.spellIds));
  const spells = prepareSpells(packs).filter((s) => union.has(s.spellId));
  const gestures = new Map(spellsOf(packs).map((s) => [s.id, s.gesture]));
  const largest = (id: string) => [...sets].reverse().find((s) => s.spellIds.includes(id))!;

  const rows = new Map<string, SimulationRow>();
  const row = (set: string, noise: number, rule: SimulationRow['rule']) => {
    const key = `${set}|${noise}|${rule}`;
    let r = rows.get(key);
    if (!r) rows.set(key, (r = { set, noise, rule, counts: empty() }));
    return r.counts;
  };
  for (const n of noises) for (const s of sets) { row(s.name, n, 'best'); row(s.name, n, 'thresholds'); }

  const perSpell: SimulationResult['perSpell'] = {};
  const confusions: SimulationResult['confusions'] = {};
  let strokes = 0;
  let ms = 0;

  const start = options.start ?? 'stored';
  for (const noise of noises) {
    for (const spell of spells) {
      if (options.only && !options.only.includes(spell.spellId)) continue;
      const gesture = gestures.get(spell.spellId)!;
      const rng = new Rng(seedFrom(seed, spell.spellId, noise));
      for (let c = 0; c < casts; c++) {
        const iso = distortGesture(gesture, rng, noise, model, undefined, start);
        // Anywhere in the frame, at a comfortable size: a third to a half of the frame's height.
        const height = rng.uniform(0.3, 0.5);
        const points = toCaster(iso, aspect, height, rng.uniform(0.3, 0.7), rng.uniform(0.35, 0.65));
        const began = performance.now();
        const result = recognize(points, aspect, spells, params);
        ms += performance.now() - began;
        strokes++;
        for (const set of sets) {
          if (!set.spellIds.includes(spell.spellId)) continue;
          const members = new Set(set.spellIds);
          const ranked = result.matches.filter((m) => members.has(m.spellId));
          tally(row(set.name, noise, 'best'), ranked[0]?.spellId === spell.spellId ? 'correct' : 'wrong');
          const d = decide(ranked, accept, lead);
          const verdict = d.kind === 'fizzle' ? 'fizzled' : d.spellId === spell.spellId ? 'correct' : 'wrong';
          tally(row(set.name, noise, 'thresholds'), verdict);
          if (set === largest(spell.spellId)) {
            const ps = ((perSpell[spell.spellId] ??= {})[String(noise)] ??= empty());
            tally(ps, verdict);
            if (noise === noises[0] && ranked[0] && ranked[0].spellId !== spell.spellId) {
              const to = ((confusions[spell.spellId] ??= {})[ranked[0].spellId] ??= 0);
              confusions[spell.spellId][ranked[0].spellId] = to + 1;
            }
          }
        }
      }
    }
  }
  return { rows: [...rows.values()], perSpell, confusions, msPerStroke: strokes ? ms / strokes : 0 };
}

function tally(c: Counts, verdict: 'correct' | 'wrong' | 'fizzled'): void {
  c.total++;
  c[verdict]++;
}

/** The spells that fizzle or go wrong most under a noise factor (thresholds rule). */
export function weakest(result: SimulationResult, noise: number, count = 3): { spellId: string; correct: number }[] {
  return Object.entries(result.perSpell)
    .map(([spellId, byNoise]) => {
      const c = byNoise[String(noise)];
      return { spellId, correct: c && c.total ? c.correct / c.total : 1 };
    })
    .sort((a, b) => a.correct - b.correct)
    .slice(0, count);
}
