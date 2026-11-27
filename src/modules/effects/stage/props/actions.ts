// Bookkeeping for ongoing actions, and safe readers for effect-step params.
//
// done() contract (types.ts PropAction, and the contract review): call action.done() once when an
// action with a duration finishes on its own, so the core sends 'effect.end' and clears 'stage.steering'
// for follow-the-tip actions. The core never hears done() for an action it ended itself (end(castId),
// reset()); that is drop(). An action replaced by a newer one on the same prop (Accio on a levitating
// feather) did end without the core asking, so it is closed with done() too, or the core would keep
// steering for a cast whose feather has flown elsewhere.

import { EFFECT_LIMITS } from '../../../../contracts';
import type { PropAction } from '../types';

export class ActionHandle {
  private isOpen = true;

  constructor(
    readonly castId: string,
    private readonly onDone: (() => void) | null,
  ) {}

  get open(): boolean {
    return this.isOpen;
  }

  /** The action is over and the core already knows (it ended it, or the shelf was reset). */
  drop(): void {
    this.isOpen = false;
  }

  /** The action is over on its own: returns the done callback to run, once, after state has settled. */
  close(): (() => void) | null {
    if (!this.isOpen) return null;
    this.isOpen = false;
    return this.onDone;
  }

  /** end(castId) targets this action: its own cast, or '*' for every action. */
  matches(castId: string): boolean {
    return castId === '*' || castId === this.castId;
  }
}

export function handleOf(action: PropAction): ActionHandle {
  return new ActionHandle(action.cast.id, () => action.done());
}

// ------------------------------------------------------------------ step params
// Packs are untrusted data (Section 9.2): every param is checked, and anything odd falls back.

export function num(v: unknown, fallback: number, min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(max, Math.max(min, n));
}

export function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function color(v: unknown, fallback: string): string {
  return typeof v === 'string' && HEX.test(v) ? v : fallback;
}

/** A step's duration in ms: duration_ms if given, else the fallback, capped by EFFECT_LIMITS.maxStepMs
 *  ("steps without hold end by this long at the latest"). A held step (hold: true) has no end of its
 *  own: it runs until its spell ends and the core calls end(castId) (contracts/packs.ts EffectStep). */
export function durationOf(action: PropAction, fallback: number, key = 'duration_ms'): number {
  if (action.step.hold === true) return Number.POSITIVE_INFINITY;
  return num(action.step[key], fallback, 0, EFFECT_LIMITS.maxStepMs);
}

/** cast.effectScale as given to the action (variants such as a brighter Lumos), kept sane. */
export function effectScale(action: PropAction): number {
  return num(action.scale, 1, 0.25, 3);
}
