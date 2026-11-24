// Keepsakes (Section 10.4: "Recent casts as replays, cards and clips to share"): one record per cast,
// holding the stroke resampled to 64 points in caster space, so a link, a card or a clip can be made
// later. Pure functions; shelf.ts keeps the list and stores it.

import type { Keepsake, Point, ReplayData, SpellCast, Stroke } from '../../contracts';
import { DATA_VERSION, REPLAY_FORMAT_VERSION } from '../../contracts';
import { POINT_COUNT, sixtyFour } from './codec';

/** The shelf keeps this many, newest first (older ones are deleted from storage too). */
export const KEEPSAKE_LIMIT = 50;

/** What is kept of a 'stroke.end' until the engine decides about it. */
export interface StrokeRecord {
  id: string;
  /** Caster space, in time order. */
  points: Point[];
  durationMs: number;
  aspect?: number;
}

export function strokeRecord(stroke: Stroke): StrokeRecord | null {
  if (!stroke || typeof stroke.id !== 'string' || !Array.isArray(stroke.points)) return null;
  const points: Point[] = [];
  for (const s of stroke.points) if (s && Number.isFinite(s.x) && Number.isFinite(s.y)) points.push([s.x, s.y]);
  const first = stroke.points[0]?.t;
  const t0 = Number.isFinite(stroke.t0) ? stroke.t0 : first;
  const t1 = Number.isFinite(stroke.t1) ? stroke.t1 : stroke.points[stroke.points.length - 1]?.t;
  const durationMs = Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, (t1 as number) - (t0 as number)) : 0;
  return {
    id: stroke.id,
    points,
    durationMs,
    ...(typeof stroke.aspect === 'number' && stroke.aspect > 0 && Number.isFinite(stroke.aspect) ? { aspect: stroke.aspect } : {}),
  };
}

/** A small cache of recent strokes by id: the decision about a stroke can come seconds after it
 *  ended (assisted and strict modes wait for speech). */
export class StrokeCache {
  private entries = new Map<string, StrokeRecord>();

  constructor(private readonly size = 16) {}

  add(record: StrokeRecord): void {
    this.entries.delete(record.id);
    this.entries.set(record.id, record);
    while (this.entries.size > this.size) this.entries.delete(this.entries.keys().next().value as string);
  }

  get(id: string | undefined): StrokeRecord | undefined {
    return id === undefined ? undefined : this.entries.get(id);
  }

  clear(): void {
    this.entries.clear();
  }
}

const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

/**
 * The keepsake for a cast. The stroke is resampled to 64 points evenly spaced in isotropic space
 * (x × aspect), then mapped back to caster space, so a replay moves at an even speed along the shape;
 * coordinates are kept to 4 decimals (far finer than a link's 1/255). Voice-only casts, and casts
 * whose stroke was not seen, keep no points. The cast's recognition detail is left out: it is large
 * and nothing a keepsake makes needs it.
 */
export function buildKeepsake(cast: SpellCast, stroke: StrokeRecord | undefined, spellName: string, fallbackAspect: number, now: number): Keepsake {
  const aspect = stroke?.aspect ?? (fallbackAspect > 0 && Number.isFinite(fallbackAspect) ? fallbackAspect : 16 / 9);
  const points = stroke && stroke.points.length ? sixtyFour(stroke.points, aspect).map(([x, y]) => [round4(x), round4(y)] as Point) : [];
  const { detail: _detail, ...kept } = cast;
  return {
    dataVersion: DATA_VERSION,
    id: cast.id,
    cast: kept,
    spellName,
    points,
    durationMs: points.length ? Math.round(stroke?.durationMs ?? 0) : 0,
    aspect,
    savedAt: now,
  };
}

/** What a link carries for a keepsake. */
export function keepsakeToReplay(k: Keepsake): ReplayData {
  return {
    format: REPLAY_FORMAT_VERSION,
    spellId: k.cast.spellId,
    via: k.cast.via,
    quality: k.cast.quality,
    power: k.cast.power,
    variant: typeof k.cast.variant === 'string' && k.cast.variant.length > 0,
    durationMs: k.durationMs,
    aspect: k.aspect,
    points: k.points.length === POINT_COUNT || k.points.length === 0 ? k.points : sixtyFour(k.points, k.aspect),
    ...(k.cast.targetId ? { target: k.cast.targetId } : {}),
  };
}

/** A stored record that can be used as a keepsake (storage may hold anything an import brought). */
export function isKeepsake(v: unknown): v is Keepsake {
  if (!v || typeof v !== 'object') return false;
  const k = v as Partial<Keepsake>;
  const c = k.cast as Partial<SpellCast> | undefined;
  return typeof k.id === 'string' && !!c && typeof c === 'object' && c.id === k.id && typeof c.spellId === 'string'
    && (c.via === 'gesture' || c.via === 'voice' || c.via === 'both')
    && Number.isFinite(c.quality) && Number.isFinite(c.power)
    && typeof k.spellName === 'string' && Array.isArray(k.points)
    && k.points.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    && Number.isFinite(k.durationMs) && Number.isFinite(k.aspect) && (k.aspect as number) > 0 && Number.isFinite(k.savedAt);
}

/** Newest first: by savedAt, then by id (cast ids made with newId sort by time). */
export function newestFirst(list: readonly Keepsake[]): Keepsake[] {
  return [...list].sort((a, b) => b.savedAt - a.savedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

/** Split a newest-first list into the ones to keep and the ones past the limit. */
export function overLimit(list: readonly Keepsake[], limit = KEEPSAKE_LIMIT): { keep: Keepsake[]; drop: Keepsake[] } {
  return { keep: list.slice(0, limit), drop: list.slice(limit) };
}
