import { describe, expect, it } from 'vitest';
import type { SpellCast, SpellProgress } from '../../contracts';
import {
  advanceTier, applyCast, applyPracticeAttempt, completedTier, countsTowardProgress, isLearned, mergeProgress, readProgressRecord, readUnlockedTier,
} from './progress';

const cast = (extra: Partial<SpellCast> = {}): SpellCast => ({ id: 'c', spellId: 'lumos', t: 0, via: 'gesture', quality: 0.7, power: 0.5, aim: { x: 0, y: 0 }, ...extra });
const item = (tier: number, learned: boolean, available = true) => ({ tier, learned, available });

describe('countsTowardProgress', () => {
  it('counts gesture, both and practice casts, never replays, and voice only in voice mode', () => {
    expect(countsTowardProgress(cast(), 'gesture')).toBe(true);
    expect(countsTowardProgress(cast({ via: 'both' }), 'assisted')).toBe(true);
    expect(countsTowardProgress(cast({ practice: true }), 'gesture')).toBe(true);
    expect(countsTowardProgress(cast({ replay: true }), 'gesture')).toBe(false);
    expect(countsTowardProgress(cast({ replay: true, via: 'voice' }), 'voice')).toBe(false);
    expect(countsTowardProgress(cast({ via: 'voice' }), 'strict')).toBe(false);
    expect(countsTowardProgress(cast({ via: 'voice' }), 'voice')).toBe(true);
  });
});

describe('applyCast', () => {
  it('counts, keeps the best quality, and stamps learnedAt once', () => {
    let p = applyCast(undefined, cast({ quality: 0.6 }), 2, 100);
    expect(p).toEqual({ dataVersion: 1, spellId: 'lumos', casts: 1, practiceAttempts: 0, best: 0.6, learnedAt: null });
    p = applyCast(p, cast({ quality: 0.4 }), 2, 200);
    expect(p).toMatchObject({ casts: 2, best: 0.6, learnedAt: 200 });
    p = applyCast(p, cast({ quality: 1.4 }), 2, 300);
    expect(p).toMatchObject({ casts: 3, best: 1, learnedAt: 200 });
    expect(isLearned(p, 10)).toBe(true); // stays learned when the threshold rises
    expect(applyPracticeAttempt(p, { spellId: 'lumos', attempt: 1, success: false, score: 0, quality: 0 }).practiceAttempts).toBe(1);
  });
});

describe('stored records', () => {
  it('reads progress tolerantly and drops what is not a record', () => {
    expect(readProgressRecord('nox', { casts: 2.7, best: 'x', note: 'kept' })).toEqual({ dataVersion: 1, spellId: 'nox', casts: 2, practiceAttempts: 0, best: 0, learnedAt: null, note: 'kept' });
    expect(readProgressRecord('nox', 'garbage')).toBeNull();
    expect(readUnlockedTier({ dataVersion: 1, value: 3 })).toBe(3);
    expect(readUnlockedTier(4)).toBe(4);
    expect(readUnlockedTier({ value: 0 })).toBeNull();
    expect(readUnlockedTier(undefined)).toBeNull();
  });
});

describe('advanceTier', () => {
  it('stays while the current tier has an unlearned available spell', () => {
    expect(advanceTier([item(1, true), item(1, false), item(2, false)], 1)).toBe(1);
  });
  it('moves to the next tier that exists once the current one is learned', () => {
    expect(advanceTier([item(1, true), item(3, false)], 1)).toBe(3);
    expect(advanceTier([item(1, true), item(2, true), item(3, false)], 1)).toBe(3);
  });
  it('ignores unavailable spells and passes through empty tiers', () => {
    expect(advanceTier([item(1, false, false), item(2, false)], 1)).toBe(2);
    expect(advanceTier([item(4, false)], 1)).toBe(4);
  });
  it('stops at the last tier and never goes down', () => {
    expect(advanceTier([item(1, true), item(2, true)], 1)).toBe(2);
    expect(advanceTier([item(1, false)], 5)).toBe(5);
    expect(advanceTier([], 1)).toBe(1);
    expect(advanceTier([item(1, false)], Number.NaN)).toBe(1);
  });
  it('does not let lower unlearned tiers block a higher current tier', () => {
    expect(advanceTier([item(1, false), item(2, true), item(3, false)], 2)).toBe(3);
  });
});

describe('completedTier (the tier that is saved)', () => {
  it('moves on only past tiers whose available spells are all learned', () => {
    expect(completedTier([item(1, true), item(1, false), item(2, false)], 1)).toBe(1);
    expect(completedTier([item(1, true), item(2, true), item(3, false)], 1)).toBe(3);
    expect(completedTier([item(1, true), item(3, false)], 1)).toBe(3); // no tier 2 anywhere
  });
  it('stops at a tier with nothing available, so a pack turned off and on keeps its stages', () => {
    expect(completedTier([item(1, false, false), item(4, false)], 1)).toBe(1);
    // A tier completed beyond it is not saved either.
    expect(completedTier([item(1, false, false), item(4, true), item(5, false)], 1)).toBe(1);
    // Completing a tier steps onto the next tier any spell has, even one with nothing available.
    expect(completedTier([item(1, true), item(2, false, false), item(3, false)], 1)).toBe(2);
  });
  it('never goes down', () => {
    expect(completedTier([item(1, false)], 5)).toBe(5);
    expect(completedTier([], 1)).toBe(1);
    expect(completedTier([item(1, false)], Number.NaN)).toBe(1);
  });
  it('is where advanceTier starts, and gives the same spellbook tier as before', () => {
    const items = [item(1, false, false), item(2, false, false), item(4, true), item(5, false)];
    expect(advanceTier(items, completedTier(items, 1))).toBe(advanceTier(items, 1));
    expect(advanceTier(items, completedTier(items, 1))).toBe(5);
  });
});

describe('applyCast on a stored record', () => {
  it('keeps the earliest learnedAt, so a window that is behind never moves it', () => {
    const stored = { dataVersion: 1, spellId: 'lumos', casts: 5, practiceAttempts: 4, best: 0.9, learnedAt: 900 };
    expect(applyCast(stored, cast({ quality: 0.5 }), 3, 500)).toEqual({ ...stored, casts: 6, learnedAt: 500 });
    expect(applyCast(stored, cast({ quality: 0.95 }), 3, 1000)).toEqual({ ...stored, casts: 6, best: 0.95, learnedAt: 900 });
  });
});

describe('mergeProgress (what the service writes)', () => {
  const rec = (extra: Partial<SpellProgress> = {}): SpellProgress => ({ dataVersion: 1, spellId: 'lumos', casts: 0, practiceAttempts: 0, best: 0, learnedAt: null, ...extra });

  it('is behind neither record: the most counts, the best quality, the earlier learnedAt', () => {
    expect(mergeProgress(rec({ casts: 4, practiceAttempts: 1, best: 0.5 }), rec({ casts: 2, practiceAttempts: 3, best: 0.9, learnedAt: 700 }))).toEqual(
      rec({ casts: 4, practiceAttempts: 3, best: 0.9, learnedAt: 700 }),
    );
    expect(mergeProgress(rec({ learnedAt: 900 }), rec({ learnedAt: 500 }))?.learnedAt).toBe(500);
    expect(mergeProgress(rec({ learnedAt: 500 }), rec())?.learnedAt).toBe(500);
  });

  it('takes either record when the other is missing, and keeps the first one\'s other fields', () => {
    expect(mergeProgress(rec({ casts: 1 }), undefined)).toEqual(rec({ casts: 1 }));
    expect(mergeProgress(undefined, rec({ casts: 2 }))).toEqual(rec({ casts: 2 }));
    expect(mergeProgress(undefined, undefined)).toBeUndefined();
    const stored = { ...rec({ casts: 1 }), note: 'from a newer edition' } as SpellProgress;
    expect(mergeProgress(stored, rec({ casts: 2 }))).toEqual({ ...stored, casts: 2 });
  });
});
