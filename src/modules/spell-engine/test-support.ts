// Test support for the spell engine's *.test.ts files (never imported by the app): spellbooks built
// from the seed packs the way the pack service presents them (contracts/packs.ts SpellbookEntry),
// and synthetic strokes, recognitions and details.

import type { Point, Recognition, RecognitionDetail, Spell, SpellPack, Spellbook, SpellbookEntry, Stroke, TipSample } from '../../contracts';
import { gestureKey } from '../../kernel';
import coreCharms from '../../../public/packs/core-charms/pack.json';
import furtherSpells from '../../../public/packs/further-spells/pack.json';
import restrictedSection from '../../../public/packs/restricted-section/pack.json';
import type { EngineSettings } from './types';
import { DEFAULT_ENGINE_SETTINGS } from './types';

export const SEED_PACKS: SpellPack[] = [coreCharms, furtherSpells, restrictedSection].map((p) => p as unknown as SpellPack);

/** SpellbookEntry.lasts as the pack service computes it: duration_ms, else 'until-ended' when a
 *  step holds, else null (instant). */
export function lastsOf(spell: Spell): SpellbookEntry['lasts'] {
  if (typeof spell.duration_ms === 'number' && spell.duration_ms > 0) return spell.duration_ms;
  return spell.effect.steps.some((s) => s.hold === true) ? 'until-ended' : null;
}

export function entryOf(spell: Spell, pack: SpellPack, over: Partial<SpellbookEntry> = {}): SpellbookEntry {
  return {
    spell,
    packId: pack.id,
    packTitle: pack.title,
    available: true,
    status: 'open',
    enabled: true,
    overridden: false,
    gestureSource: 'pack',
    gestureKey: gestureKey(spell.gesture),
    mirrored: false,
    templates: [],
    lasts: lastsOf(spell),
    skippedSteps: [],
    accepted: 0,
    ...over,
  };
}

/** Every seed spell, open and enabled, unless `over` says otherwise for a spell id. */
export function seedSpellbook(over: Record<string, Partial<SpellbookEntry>> = {}, revision = 1): Spellbook {
  return {
    revision,
    packs: SEED_PACKS.map((p) => ({ id: p.id, kind: 'spellpack' as const, title: p.title, version: p.version, enabled: true, user: false, unmet: [] })),
    spells: SEED_PACKS.flatMap((p) => p.spells.map((s) => entryOf(s, p, over[s.id]))),
    theme: null,
    unlockedTier: 7,
    learnAfter: 3,
  };
}

export function seedSpell(id: string): Spell {
  for (const p of SEED_PACKS) {
    const s = p.spells.find((x) => x.id === id);
    if (s) return s;
  }
  throw new Error(`no seed spell ${id}`);
}

export function settingsWith(over: Partial<EngineSettings> = {}): EngineSettings {
  return { ...DEFAULT_ENGINE_SETTINGS, playArea: { ...DEFAULT_ENGINE_SETTINGS.playArea }, ...over };
}

/** A stroke along a polyline (caster space), sampled evenly by arc length at an even pace. */
export function strokeAlong(
  id: string,
  path: readonly Point[],
  opts: { t0: number; durationMs: number; quality?: number; aspect?: number; src?: string; samples?: number },
): Stroke {
  const n = Math.max(2, opts.samples ?? 30);
  const lengths = [0];
  for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const total = lengths[lengths.length - 1] || 1;
  const points: TipSample[] = [];
  for (let k = 0; k < n; k++) {
    const f = k / (n - 1);
    const d = f * total;
    let i = 1;
    while (i < path.length - 1 && lengths[i] < d) i++;
    const seg = lengths[i] - lengths[i - 1] || 1;
    const u = Math.min(1, Math.max(0, (d - lengths[i - 1]) / seg));
    points.push({
      t: opts.t0 + f * opts.durationMs,
      x: path[i - 1][0] + u * (path[i][0] - path[i - 1][0]),
      y: path[i - 1][1] + u * (path[i][1] - path[i - 1][1]),
      conf: 1,
      src: opts.src ?? 'tracker.pointer',
    });
  }
  return {
    id,
    points,
    t0: opts.t0,
    t1: opts.t0 + opts.durationMs,
    quality: opts.quality ?? 0.95,
    aspect: opts.aspect ?? 16 / 9,
    src: opts.src ?? 'tracker.pointer',
    endReason: 'pause',
  };
}

/** A straight flick of `length` (caster units on the moving axis) through (cx, cy). */
export function flickStroke(
  id: string,
  dir: 'up' | 'down' | 'left' | 'right',
  opts: { t0: number; durationMs: number; length?: number; cx?: number; cy?: number; quality?: number; src?: string },
): Stroke {
  const L = opts.length ?? 0.35;
  const cx = opts.cx ?? 0.5;
  const cy = opts.cy ?? 0.5;
  const v: Point = dir === 'up' ? [0, -1] : dir === 'down' ? [0, 1] : dir === 'left' ? [-1, 0] : [1, 0];
  const a: Point = [cx - (v[0] * L) / 2, cy - (v[1] * L) / 2];
  const b: Point = [cx + (v[0] * L) / 2, cy + (v[1] * L) / 2];
  return strokeAlong(id, [a, b], { t0: opts.t0, durationMs: opts.durationMs, quality: opts.quality, src: opts.src, samples: 12 });
}

/** A pack path (unit square, isotropic) placed in caster space: `size` caster-y units tall, centred. */
export function pathStroke(
  id: string,
  spellId: string,
  opts: { t0: number; durationMs: number; size?: number; cx?: number; cy?: number; quality?: number; aspect?: number; src?: string },
): Stroke {
  const g = seedSpell(spellId).gesture;
  if (!('path' in g)) throw new Error(`${spellId} has no single path`);
  const aspect = opts.aspect ?? 16 / 9;
  const size = opts.size ?? 0.4;
  const cx = opts.cx ?? 0.5;
  const cy = opts.cy ?? 0.5;
  const placed = g.path.map(([x, y]) => [cx + ((x - 0.5) * size) / aspect, cy + (y - 0.5) * size] as Point);
  return strokeAlong(id, placed, { ...opts, aspect, samples: 48 });
}

export function detailOf(spellId: string, score: number, over: Partial<RecognitionDetail> = {}): RecognitionDetail {
  return {
    spellId,
    score,
    template: 'seed:0',
    pathIndex: 0,
    deviation: Array.from({ length: 64 }, () => 0.03),
    aligned: [],
    rotation: 0,
    reached: 1,
    started: 0,
    ...over,
  };
}

/** A recognition with the given scores (best first) and details for the named spells. */
export function recognitionOf(
  strokeId: string,
  scores: Record<string, number>,
  opts: { stage?: 'flick' | 'template'; details?: RecognitionDetail[]; linearity?: number; shadow?: boolean } = {},
): Recognition {
  const candidates = Object.entries(scores)
    .map(([spellId, score]) => ({ spellId, score }))
    .sort((a, b) => b.score - a.score);
  return {
    strokeId,
    recognizer: 'recognizer.template',
    candidates,
    stage: opts.stage ?? 'template',
    linearity: opts.linearity,
    details: opts.details ?? candidates.slice(0, 3).map((c) => detailOf(c.spellId, c.score)),
    shadow: opts.shadow,
  };
}

/** Deterministic ids for tests: 'cast-1', 'fizzle-2', ... */
export function counterIds(): (prefix: string) => string {
  let n = 0;
  return (prefix) => `${prefix}-${++n}`;
}
