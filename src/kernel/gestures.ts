// Gesture helpers several modules must agree on: the intended pace (the stage's practice guide and
// the engine's tempo score), a key that changes when a gesture changes (learned samples), and the
// conversion of a captured caster-space stroke into a stored unit-square path (Workshop redraw).

import type { Gesture, Point } from '../contracts';
import { DEFAULT_PACE_MS_PER_UNIT, FLICK_PACE_MS } from '../contracts';
import { bbox, linearity, pathLength, resample, toIsotropic } from './geometry';

/** The stored paths of a gesture (none for flicks). */
export function gesturePaths(g: Gesture): Point[][] {
  if ('flick' in g) return [];
  if ('paths' in g) return g.paths;
  return [g.path];
}

/** Duration of the gesture at its intended pace, ms (Gesture.pace_ms, else from path length). */
export function gesturePaceMs(g: Gesture): number {
  if (typeof g.pace_ms === 'number' && g.pace_ms > 0) return g.pace_ms;
  if ('flick' in g) return FLICK_PACE_MS;
  const first = gesturePaths(g)[0] ?? [];
  return Math.max(FLICK_PACE_MS, Math.round(pathLength(first) * DEFAULT_PACE_MS_PER_UNIT));
}

/** A short stable hash (FNV-1a, 32 bits, hex) of any JSON-able value. */
export function stableHash(value: unknown): string {
  const text = JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v));
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Key that changes whenever the effective gesture changes (shape, mirroring, start points). */
export function gestureKey(g: Gesture): string {
  const { parts: _parts, pace_ms: _pace, ...shape } = g as Gesture & { parts?: unknown; pace_ms?: unknown };
  return stableHash(shape);
}

/** A captured stroke (caster space) as a path in an isotropic unit square: x × aspect, resampled,
 *  scaled uniformly so the longer side is 0.9 and centred, like the pack paths (Appendix B). */
export function strokeToUnitPath(points: readonly Point[], aspect: number, n = 64): Point[] {
  const iso = resample(toIsotropic(points, aspect), n);
  const b = bbox(iso);
  const side = Math.max(b.w, b.h) || 1;
  const s = 0.9 / side;
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  return iso.map(([x, y]) => [round3(0.5 + (x - cx) * s), round3(0.5 + (y - cy) * s)] as Point);
}

/** The flick a nearly straight drawing stands for, or null. Isotropic points expected. */
export function asFlick(isoPoints: readonly Point[], maxLinearity: number, maxAngleDeg: number): 'up' | 'down' | 'left' | 'right' | null {
  if (isoPoints.length < 2) return null;
  if (linearity(resample(isoPoints, 64)) > maxLinearity) return null;
  const a = isoPoints[0], b = isoPoints[isoPoints.length - 1];
  const angle = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI; // 0 = right, 90 = down
  const dirs: [number, 'right' | 'down' | 'left' | 'up'][] = [[0, 'right'], [90, 'down'], [180, 'left'], [-90, 'up'], [-180, 'left']];
  for (const [deg, name] of dirs) if (Math.abs(angle - deg) <= maxAngleDeg) return name;
  return null;
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
