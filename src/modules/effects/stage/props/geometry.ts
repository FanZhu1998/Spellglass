// Where the shelf and the props sit, and how big the props are (Section 7.8, "The stage").
//
// Two units meet here:
//  - Caster space (0..1 on both axes, the camera frame as shown in the mirror) for positions. Homes come
//    from SHELF_LAYOUT in contracts/scene.ts; the core maps caster space onto the canvas with view.toPx.
//  - mH, thousandths of the mirror's height, for sizes. view.size() turns mH into canvas pixels, so the
//    whole shelf scales with the mirror. All prop art is authored in mH.

import { SHELF_LAYOUT, type PropId } from '../../../../contracts';

/** Caster-space y of the shelf's top surface: every prop's base rests on this line. SHELF_LAYOUT gives
 *  each prop's centre, so a prop's base sits (SHELF_TOP − home.y) below its centre. 0.935 made those
 *  offsets agree with the props' first heights; the props have since grown about a third (art brief:
 *  real weight and detail), so each published centre now sits a little below the middle of its body,
 *  still well inside it, and each radius is measured from it to cover the body. */
export const SHELF_TOP = 0.935;

/** One mH as a fraction of the mirror's height. */
export const MH = 1 / 1000;

export interface PropDims {
  /** Body height, base to top, in mH (not counting a flame or a costume). */
  height: number;
  /** Width of the footprint, for the contact shadow, in mH. */
  foot: number;
  /** Hit radius for targeting and highlights, in mH (published in caster-x units): the body's mean
   *  half-extent, √((w² + h²) / 8) for a body w wide and h tall, as the first radii were
   *  (geometry.test.ts keeps it so). */
  radius: number;
}

export const DIMS: Record<PropId, PropDims> = {
  candle: { height: 199, foot: 124, radius: 90 },
  feather: { height: 62, foot: 196, radius: 84 },
  box: { height: 150, foot: 186, radius: 88 },
  teacup: { height: 117, foot: 166, radius: 75 },
  plant: { height: 228, foot: 104, radius: 104 },
  dummy: { height: 334, foot: 128, radius: 150 },
};

/** How far below its centre a prop's base sits, in caster-y units. */
export function baseOffset(id: PropId): number {
  return SHELF_TOP - SHELF_LAYOUT[id].y;
}

/** Where props may travel (caster space): inside the frame, never below their home on the shelf. */
export const BOUNDS = { minX: 0.03, maxX: 0.97, minY: 0.07, slideMinX: 0.04, slideMaxX: 0.96 } as const;
