import { describe, expect, it } from 'vitest';
import type { SpellPack } from '../../src/contracts';
import { loadSeedPacks } from './packs';
import { SEPARATION_LIMIT, templateSeparation } from './separation';

const packs = loadSeedPacks();
const pack = (spells: SpellPack['spells']): SpellPack => ({ schema: 'spellpack/1', id: 'test', version: '1.0.0', engine: '>=1.0 <2.0', title: 'Test', needs: [], spells });
const spell = (id: string, gesture: SpellPack['spells'][number]['gesture']) => ({ id, incantation: id, gesture, effect: { steps: [] } });

describe('template separation (Section 7.5 pack lint)', () => {
  it('keeps every pair of seed templates at or under 0.80; the closest is about 0.77', () => {
    const { closest, pairs } = templateSeparation(packs);
    expect(closest).not.toBeNull();
    expect(closest!.score).toBeLessThanOrEqual(SEPARATION_LIMIT);
    // The blueprint: "The closest pair in the seed set scores 0.77."
    expect(closest!.score).toBeGreaterThan(0.75);
    expect(closest!.score).toBeLessThan(0.79);
    expect([closest!.a, closest!.b].sort()).toEqual(['engorgio', 'wingardium-leviosa']);
    expect(pairs.every((p) => p.score <= SEPARATION_LIMIT)).toBe(true);
  });

  it('scores every pair of spells with non-line templates once, closest first', () => {
    const { pairs } = templateSeparation(packs);
    // 27 spells, 4 of them flicks: 23 path spells, so 23 × 22 ÷ 2 pairs.
    expect(pairs).toHaveLength((23 * 22) / 2);
    for (let i = 1; i < pairs.length; i++) expect(pairs[i - 1].score).toBeGreaterThanOrEqual(pairs[i].score);
    const ids = new Set(pairs.flatMap((p) => [p.a, p.b]));
    for (const flick of ['lumos', 'nox', 'stupefy', 'finite-incantatem']) expect(ids.has(flick)).toBe(false);
    expect(pairs.some((p) => p.a === p.b)).toBe(false);
  });

  it('includes the start-point variants of closed shapes', () => {
    const circle = [[0.5, 0.05], [0.85, 0.2], [0.95, 0.5], [0.85, 0.8], [0.5, 0.95], [0.15, 0.8], [0.05, 0.5], [0.15, 0.2], [0.5, 0.05]] as [number, number][];
    // The same circle drawn from the bottom, as a second spell: identical once start points are tried.
    const fromBottom = [...circle.slice(4), ...circle.slice(1, 5)];
    const anyStart = templateSeparation([pack([spell('a', { path: circle, any_start: true }), spell('b', { path: fromBottom })])]);
    const fixedStart = templateSeparation([pack([spell('a', { path: circle }), spell('b', { path: fromBottom })])]);
    expect(anyStart.closest!.score).toBeGreaterThan(0.95);
    expect(fixedStart.closest!.score).toBeLessThan(anyStart.closest!.score - 0.2);
  });

  it('flags a pack whose two spells share a gesture, and skips what it cannot read', () => {
    const shape = [[0.1, 0.1], [0.9, 0.5], [0.1, 0.9]] as [number, number][];
    const bad = pack([spell('one', { path: shape }), spell('two', { path: shape }), spell('flick', { flick: 'up' }), { id: 'broken', incantation: 'x', gesture: {} as never, effect: { steps: [] } }]);
    const { closest, pairs } = templateSeparation([bad]);
    expect(closest).toMatchObject({ a: 'one', b: 'two' });
    expect(closest!.score).toBeGreaterThan(SEPARATION_LIMIT);
    expect(pairs).toHaveLength(1);
    expect(templateSeparation([]).closest).toBeNull();
  });
});
