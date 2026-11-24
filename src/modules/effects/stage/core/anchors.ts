// Where an effect step happens (contracts/packs.ts Anchor). All positions are caster space.

import type { Anchor } from '../../../../contracts';

export interface XY {
  x: number;
  y: number;
}

/** The player's head, approximated in version 1 (contracts/packs.ts Anchor 'caster'). */
export const CASTER_ANCHOR: Readonly<XY> = Object.freeze({ x: 0.5, y: 0.38 });
export const CENTER_ANCHOR: Readonly<XY> = Object.freeze({ x: 0.5, y: 0.5 });

export interface AnchorContext {
  /** SpellCast.aim: the stroke's end. */
  aim: XY;
  /** The filtered tip while it is in view (during a replay: the replay's tip). */
  tip: XY | null;
  /** The tip's last known position, when it is out of view. */
  lastTip: XY | null;
  /** Current centre of the cast's target prop, when there is one. */
  target: XY | null;
}

/**
 * tip: the live filtered tip, or its last known position, or aim.
 * aim: the stroke's end.
 * target: the target prop; falls back to aim.
 * center: (0.5, 0.5).
 * caster: the head, (0.5, 0.38).
 * Unknown names use `fallback`, so a pack typo still lands somewhere sensible (Section 9.1 rule 3).
 */
export function resolveAnchor(anchor: Anchor | string | undefined, ctx: AnchorContext, fallback: Anchor = 'aim'): XY {
  switch (anchor) {
    case 'tip':
      return copy(ctx.tip ?? ctx.lastTip ?? ctx.aim);
    case 'aim':
      return copy(ctx.aim);
    case 'target':
      return copy(ctx.target ?? ctx.aim);
    case 'center':
      return copy(CENTER_ANCHOR);
    case 'caster':
      return copy(CASTER_ANCHOR);
    default:
      return fallback === anchor ? copy(ctx.aim) : resolveAnchor(fallback, ctx, 'aim');
  }
}

function copy(p: XY): XY {
  return { x: p.x, y: p.y };
}
