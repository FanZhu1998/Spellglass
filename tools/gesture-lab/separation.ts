// Template separation (Section 7.5 "Pack lint"): a pack fails its check if any two of its non-line
// templates score above 0.80 against each other. The pack-lint tool imports templateSeparation()
// with exactly this signature.
//
// Every pair of spells is scored with the recognizer's own matcher: each template normalized as
// in stage 2, the distance minimized over the ±15° rotation band, any_start loops expanded to their
// start points. The distance is symmetric (rotating one path by −θ is rotating the other by +θ), so
// each pair is scored once, as the best over all their template variants.

import type { SpellPack } from '../../src/contracts';
import { bestAlignment, rotationAngles, scoreOf, strokeRotations } from '../../src/modules/recognizers/template/match';
import { DEFAULT_PARAMS, type RecognizerParams } from '../../src/modules/recognizers/template/recognize';
import { prepareSpells } from './packs';

export interface SeparationPair {
  a: string;
  b: string;
  score: number;
}

export interface Separation {
  /** Every pair of spells with non-line templates, closest first. */
  pairs: SeparationPair[];
  closest: SeparationPair | null;
}

/** Pack lint's threshold: two templates scoring above this against each other are too close. */
export const SEPARATION_LIMIT = 0.8;

export function templateSeparation(packs: SpellPack[], params: RecognizerParams = DEFAULT_PARAMS): Separation {
  const angles = rotationAngles(params.rotationDeg, params.rotationStepDeg);
  // Line templates (flicks, and any path at or under the flick linearity) are left out: they are
  // compared only with nearly straight strokes, and every line resembles every other line.
  const spells = prepareSpells(packs)
    .map((s) => ({ id: s.spellId, templates: s.gesture.flick ? [] : s.gesture.seeds.filter((t) => t.linearity > params.flickLinearity) }))
    .filter((s) => s.templates.length > 0);
  const rotated = spells.map((s) => s.templates.map((t) => strokeRotations(t.shape, angles)));

  const pairs: SeparationPair[] = [];
  for (let i = 0; i < spells.length; i++) {
    for (let j = i + 1; j < spells.length; j++) {
      let best = Infinity;
      for (const rot of rotated[i]) {
        for (const t of spells[j].templates) {
          const d = bestAlignment(rot, t.shape, undefined, best).distance;
          if (d < best) best = d;
        }
      }
      // Full precision: pack lint compares with 0.80, and rounding could hide 0.8004.
      pairs.push({ a: spells[i].id, b: spells[j].id, score: scoreOf(best) });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return { pairs, closest: pairs[0] ?? null };
}
