// The two choices a cast makes from pack data besides its rules: its target and its variant.
//
// Targets (Section 7.8): "A spell that acts on something picks the prop nearest to where the
// stroke ended." A spell's `targets` are prop tags in order of preference: the first tag that any
// prop carries wins, and among the props carrying it the nearest to the aim is chosen. Distances are
// compared isotropically (x scaled by the scene's aspect), so "nearest" matches what the player sees.
// When nothing matches, the spell is still cast, without a target (contracts/packs.ts Spell.targets).

import type { PropId, SceneProps, Variant } from '../../contracts';
import { PROP_IDS, PROP_START, PROP_TAGS, SHELF_LAYOUT } from '../../contracts';
import { SCORE_EPSILON } from './decision';
import { DEFAULT_ASPECT } from './types';

/** Rough prop radius (caster-x units) for the shelf before the stage has published one. */
const DEFAULT_PROP_RADIUS = 0.05;

/** The shelf as it starts (contracts/scene.ts PROP_START and SHELF_LAYOUT), used until the stage
 *  publishes 'scene.props'. */
export function startingProps(aspect: number = DEFAULT_ASPECT): SceneProps {
  return {
    revision: 0,
    aspect,
    props: PROP_IDS.map((id: PropId) => ({
      id,
      label: PROP_START[id].label,
      x: SHELF_LAYOUT[id].x,
      y: SHELF_LAYOUT[id].y,
      r: DEFAULT_PROP_RADIUS,
      tags: [...PROP_START[id].tags],
      state: { ...PROP_START[id].state },
    })),
  };
}

export function pickTarget(targets: readonly string[] | undefined, aim: { x: number; y: number }, scene: SceneProps): string | undefined {
  if (!Array.isArray(targets) || !targets.length || !scene.props.length) return undefined;
  const aspect = scene.aspect > 0 ? scene.aspect : DEFAULT_ASPECT;
  for (const tag of targets) {
    const matching = tag === PROP_TAGS.any ? scene.props : scene.props.filter((p) => Array.isArray(p.tags) && p.tags.includes(tag));
    if (!matching.length) continue;
    let best = matching[0];
    let bestD = Infinity;
    for (const p of matching) {
      const d = Math.hypot((p.x - aim.x) * aspect, p.y - aim.y);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    return best.id;
  }
  return undefined;
}

/** The first variant whose `when` matches sets the label and effect scale (Section 7.7: "A pack can
 *  map a power band to a variant, such as a brighter Lumos above 0.8"). Bounds are inclusive. */
export function pickVariant(variants: readonly Variant[] | undefined, power: number, quality: number): Variant | undefined {
  if (!Array.isArray(variants)) return undefined;
  return variants.find((v) => {
    const w = v?.when ?? {};
    if (typeof w.power_min === 'number' && power < w.power_min - SCORE_EPSILON) return false;
    if (typeof w.power_max === 'number' && power > w.power_max + SCORE_EPSILON) return false;
    if (typeof w.quality_min === 'number' && quality < w.quality_min - SCORE_EPSILON) return false;
    return typeof v?.label === 'string';
  });
}

/** effect_scale of a variant: a positive number, default 1. */
export function effectScaleOf(variant: Variant | undefined): number {
  const s = variant?.effect_scale;
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1;
}
