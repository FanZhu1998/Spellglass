import { describe, expect, it } from 'vitest';
import type { SpellMatch } from '../../src/modules/recognizers/template/recognize';
import { loadSeedPacks } from './packs';
import { decide, seedSets, simulate } from './simulate';

const packs = loadSeedPacks();
const rate = (n: number, total: number) => n / total;

describe('simulated check of the seed set (Section 7.5)', () => {
  it('gate: thresholds on the 24, 400 casts per spell: at least 98% correct, at most 0.5% wrong', () => {
    const r = simulate(packs, { casts: 400, noise: [1], sets: seedSets(packs).filter((s) => s.name === '24') });
    const row = r.rows.find((x) => x.rule === 'thresholds')!;
    expect(row.counts.total).toBe(24 * 400);
    expect(rate(row.counts.correct, row.counts.total)).toBeGreaterThanOrEqual(0.98);
    expect(rate(row.counts.wrong, row.counts.total)).toBeLessThanOrEqual(0.005);
    const best = r.rows.find((x) => x.rule === 'best')!;
    expect(best.counts.fizzled).toBe(0);
    expect(rate(best.counts.correct, best.counts.total)).toBeGreaterThanOrEqual(0.99);
  });

  it('is deterministic for a seed and different across seeds', () => {
    const a = simulate(packs, { casts: 20, noise: [1.5], seed: 7 });
    const b = simulate(packs, { casts: 20, noise: [1.5], seed: 7 });
    const c = simulate(packs, { casts: 20, noise: [1.5], seed: 8 });
    const counts = (x: typeof a) => x.rows.map((r) => r.counts);
    expect(counts(a)).toEqual(counts(b));
    expect(counts(a)).not.toEqual(counts(c));
  });

  it('draws the 12 core spells identically in every set, so the sets compare like for like', () => {
    const r = simulate(packs, { casts: 30, noise: [1] });
    const core = r.rows.find((x) => x.set === '12 core' && x.rule === 'best')!;
    expect(core.counts.total).toBe(12 * 30);
    expect(r.rows.find((x) => x.set === 'All 27' && x.rule === 'best')!.counts.total).toBe(27 * 30);
    expect(r.msPerStroke).toBeGreaterThan(0);
  });

  it('drops in accuracy, but not into wrong casts, under heavier noise', () => {
    const r = simulate(packs, { casts: 60, noise: [1, 1.5], sets: seedSets(packs).filter((s) => s.name === '24') });
    const at = (noise: number) => r.rows.find((x) => x.noise === noise && x.rule === 'thresholds')!.counts;
    expect(at(1.5).correct).toBeLessThan(at(1).correct);
    expect(rate(at(1.5).wrong, at(1.5).total)).toBeLessThan(0.02);
  });
});

describe('the lab decision rule', () => {
  const m = (spellId: string, score: number, stage: SpellMatch['stage'] = 'template'): SpellMatch => ({ spellId, score, stage, template: 'seed:0', seedScore: score, seed: null, alignment: null });

  it('accepts at 0.72 with a lead of 0.04, and fizzles otherwise', () => {
    expect(decide([m('a', 0.8), m('b', 0.7)], 0.72, 0.04)).toEqual({ kind: 'cast', spellId: 'a' });
    expect(decide([m('a', 0.8), m('b', 0.78)], 0.72, 0.04).kind).toBe('fizzle');
    expect(decide([m('a', 0.7), m('b', 0.1)], 0.72, 0.04).kind).toBe('fizzle');
    expect(decide([], 0.72, 0.04).kind).toBe('fizzle');
  });

  it('skips the lead rule for a single stage-1 flick', () => {
    expect(decide([m('lumos', 0.8, 'flick'), m('b', 0.79)], 0.72, 0.04)).toEqual({ kind: 'cast', spellId: 'lumos' });
    expect(decide([m('lumos', 0.8, 'flick'), m('twin', 0.8, 'flick')], 0.72, 0.04).kind).toBe('fizzle');
  });
});
