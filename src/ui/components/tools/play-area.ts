// The play area (setting 'playArea', in caster space: 0 to 1 across and down the camera's view) is the
// part of the view the player casts in. Power and the smallest stroke are measured against it
// (contracts/settings.ts), so a smaller box lets smaller gestures count in full. Strokes outside it
// still cast.

import type { PlayArea } from '../../../contracts';

/** The whole view, the default. */
export const WHOLE_VIEW: Readonly<PlayArea> = { x: 0, y: 0, w: 1, h: 1 };

/**
 * Seated play (Section 10.6). A caster in a chair or a wheelchair reaches less far than one standing,
 * and the hand moves lower in the view, since the camera sits at about eye height. The box is 60% of the
 * view each way, centred across and below the middle, so a gesture 60% the size of a standing one counts
 * the same. Wand tuning shows it and can move or resize it.
 */
export const SEATED_AREA: Readonly<PlayArea> = { x: 0.2, y: 0.35, w: 0.6, h: 0.6 };

/** The same box, within the 0.001 that Wand tuning rounds a box to. */
export function sameArea(a: PlayArea | null | undefined, b: Readonly<PlayArea>): boolean {
  return !!a && (['x', 'y', 'w', 'h'] as const).every((k) => typeof a[k] === 'number' && Math.abs(a[k] - b[k]) < 0.0005);
}

/** The play area is the seated one. */
export function isSeated(a: PlayArea | null | undefined): boolean {
  return sameArea(a, SEATED_AREA);
}

/** The play area is the whole view (or missing, which the pipeline reads as the whole view). */
export function isWholeView(a: PlayArea | null | undefined): boolean {
  return !a || sameArea(a, WHOLE_VIEW);
}
