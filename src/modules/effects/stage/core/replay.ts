// Replay timing (request 'stage.replay', Section 11.1: "Opening the link replays the trace and the
// effect on a plain backdrop"). A replay carries 64 points evenly spaced along the stroke and the
// stroke's duration; the stage draws them as ink over that duration, easing in and out like a
// hand, so the ink swells at the ends the way a real stroke does.

import type { Point } from '../../../../contracts';

/** How far along the replayed points the tip is, as a fractional index, `elapsed` ms in. */
export function replayIndex(elapsed: number, durationMs: number, count: number): number {
  if (count <= 1) return 0;
  if (!(durationMs > 0)) return count - 1;
  const k = Math.min(1, Math.max(0, elapsed / durationMs));
  const eased = 0.5 - 0.5 * Math.cos(Math.PI * k);
  return eased * (count - 1);
}

/** The point at a fractional index (linear between neighbours). */
export function pointAtIndex(points: readonly Point[], index: number): Point {
  if (points.length === 0) return [0.5, 0.5];
  const i = Math.max(0, Math.min(points.length - 1, index));
  const a = Math.floor(i), b = Math.min(points.length - 1, a + 1);
  const t = i - a;
  return [points[a][0] + (points[b][0] - points[a][0]) * t, points[a][1] + (points[b][1] - points[a][1]) * t];
}

/** After the effect, once its props have finished showing it (PropView.settled), a beat for
 *  particles and the incantation to fade, and for the result to be seen, before the shelf resets. */
export const REPLAY_TAIL_MS = 900;
/** A replay never holds the stage longer than this after its cast, whatever a pack asks. */
export const REPLAY_MAX_EFFECT_MS = 16_000;

/** Points from a replay payload, cleaned: finite numbers only, at most 256. */
export function cleanReplayPoints(input: unknown): Point[] {
  if (!Array.isArray(input)) return [];
  const out: Point[] = [];
  for (const p of input.slice(0, 256)) {
    if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) out.push([Number(p[0]), Number(p[1])]);
  }
  return out;
}
