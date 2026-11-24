// Gesture transforms the pack service applies: the left-handed mirror (Section 10.6), filling a redrawn
// gesture's hint parts from the pack's gesture, and turning a Workshop drawing into a stored gesture
// (requests.ts 'spellbook.override.set'). Pure functions.

import type { FlickDirection, Gesture, Point, Stroke } from '../../contracts';
import { asFlick, strokeToUnitPath } from '../gestures';
import { bbox, mirrorX, toIsotropic } from '../geometry';

/** Mirror left to right: every path x → 1 - x, and left and right flicks swap. Applied the same way to
 *  spell.gesture and the templates, so what the player sees is what is matched. Mirroring twice gives
 *  the original back, which is how a drawing made in the mirrored view is stored right-handed. */
export function mirrorGesture(g: Gesture): Gesture {
  if ('flick' in g) return { ...g, flick: mirrorFlick(g.flick) };
  if ('paths' in g) return { ...g, paths: g.paths.map(mirrorPath) };
  return { ...g, path: mirrorPath(g.path) };
}

/** geometry.mirrorX, rounded to 6 decimals: 1 - 0.9 is 0.09999999999999998 in floating point, and
 *  mirrored drawings are stored, exported and hashed into gestureKey, so they should read cleanly. */
function mirrorPath(path: readonly Point[]): Point[] {
  return mirrorX(path).map(([x, y]) => [Math.round(x * 1e6) / 1e6, y] as Point);
}

export function mirrorFlick(dir: FlickDirection): FlickDirection {
  return dir === 'left' ? 'right' : dir === 'right' ? 'left' : dir;
}

/** A redrawn gesture keeps the pack gesture's parts (for hints), any_start and start_points unless it
 *  gives its own (requests.ts). Only path gestures take them: a flick has no parts to name, and a pack
 *  flick has none to give. pace_ms is not inherited: a redrawn path has its own length. */
export function inheritFromPack(g: Gesture, packGesture: Gesture | undefined): Gesture {
  if (!packGesture || 'flick' in g || 'flick' in packGesture) return g;
  const out = { ...g };
  if (out.parts === undefined && packGesture.parts !== undefined) out.parts = packGesture.parts;
  if (out.any_start === undefined && packGesture.any_start !== undefined) out.any_start = packGesture.any_start;
  if (out.start_points === undefined && packGesture.start_points !== undefined) out.start_points = packGesture.start_points;
  return out;
}

export interface DrawingOptions {
  /** 'access.leftHanded': the drawing was made in the mirrored view. */
  leftHanded: boolean;
  /** 'recognizer.flickLinearity' and 'recognizer.flickAngleDeg': when a drawing counts as a flick. */
  flickLinearity: number;
  flickAngleDeg: number;
  /** Caster aspect for strokes that do not carry one (the active tracker's, else 16/9). */
  fallbackAspect: number;
}

export type DrawingResult = { ok: true; gesture: Gesture; drawnLeftHanded: boolean } | { ok: false; reason: string };

/** The smallest drawing worth storing, as a fraction of the caster height (isotropic units). */
const MIN_EXTENT = 0.02;

/** Turn the payload of 'spellbook.override.set' into the gesture to store: from a captured stroke
 *  (caster space, converted with its aspect) or a given gesture (isotropic unit square, as drawn in
 *  the current view). A nearly straight single path is stored as a flick (asFlick, with the
 *  recognizer's thresholds). With the left-handed switch on, the drawing is mirrored back, so overrides
 *  are always stored right-handed (contracts/storage.ts GestureOverride). */
export function drawingToGesture(input: { gesture?: Gesture; stroke?: Stroke }, opts: DrawingOptions): DrawingResult {
  let drawn: Gesture;
  if (input.gesture !== undefined) {
    drawn = input.gesture;
    if ('path' in drawn) {
      const flick = asFlick(drawn.path, opts.flickLinearity, opts.flickAngleDeg);
      if (flick) drawn = drawn.pace_ms !== undefined ? { flick, pace_ms: drawn.pace_ms } : { flick };
    }
  } else if (input.stroke !== undefined) {
    const points = (Array.isArray(input.stroke.points) ? input.stroke.points : [])
      .filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => [p.x, p.y] as Point);
    if (points.length < 2) return { ok: false, reason: 'The drawing is too short to use. Draw the whole gesture in one stroke.' };
    const aspect = typeof input.stroke.aspect === 'number' && input.stroke.aspect > 0 ? input.stroke.aspect : opts.fallbackAspect;
    const iso = toIsotropic(points, aspect);
    const box = bbox(iso);
    if (Math.max(box.w, box.h) < MIN_EXTENT) return { ok: false, reason: 'The drawing is too small to use. Draw the gesture larger.' };
    const flick = asFlick(iso, opts.flickLinearity, opts.flickAngleDeg);
    drawn = flick ? { flick } : { path: strokeToUnitPath(points, aspect) };
  } else {
    return { ok: false, reason: 'Nothing was drawn. Draw the gesture, or pass a gesture.' };
  }
  return opts.leftHanded ? { ok: true, gesture: mirrorGesture(drawn), drawnLeftHanded: true } : { ok: true, gesture: drawn, drawnLeftHanded: false };
}
