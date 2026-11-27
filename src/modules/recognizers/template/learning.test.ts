import { describe, expect, it } from 'vitest';
import type { GestureSample, SpellCast } from '../../../contracts';
import { LEARN_MAX_OTHER_SCORE, activeSamples, castQualifies, isGestureSample, planSample, samplesFor } from './learning';

const cast = (over: Partial<SpellCast> = {}): SpellCast => ({ id: 'c', spellId: 'accio', t: 0, via: 'gesture', quality: 0.8, power: 0.5, aim: { x: 0.5, y: 0.5 }, strokeId: 's', score: 0.85, ...over });
const sample = (id: string, score: number, over: Partial<GestureSample> = {}): GestureSample => ({ dataVersion: 1, id, spellId: 'accio', points: [[0, 0], [1, 1]], score, gestureKey: 'k1', savedAt: Number(id.replace(/\D/g, '')) || 0, ...over });

describe('which casts teach the recognizer', () => {
  it('learns from accepted gesture casts', () => {
    expect(castQualifies(cast(), 'tracker.bright-tip', 0.72)).toBe(true);
    expect(castQualifies(cast({ via: 'both' }), 'tracker.hand', 0.72)).toBe(true);
    expect(castQualifies(cast({ practice: true }), 'tracker.pointer', 0.72)).toBe(true);
  });

  it('never learns from replays, voice-only casts or weak matches', () => {
    expect(castQualifies(cast({ replay: true }), 'tracker.bright-tip', 0.72)).toBe(false);
    expect(castQualifies(cast(), 'tracker.replay', 0.72)).toBe(false);
    expect(castQualifies(cast({ via: 'voice' }), 'tracker.bright-tip', 0.72)).toBe(false);
    // Assisted mode accepts at 0.60; learning still needs the full acceptance score.
    expect(castQualifies(cast({ via: 'both', score: 0.65 }), 'tracker.bright-tip', 0.72)).toBe(false);
  });

  it('falls back to the recognized score when the cast carries none', () => {
    expect(castQualifies(cast({ score: undefined }), undefined, 0.72, 0.8)).toBe(true);
    expect(castQualifies(cast({ score: undefined }), undefined, 0.72)).toBe(false);
  });

  it('keeps the pack-lint limit as the drift guard', () => {
    expect(LEARN_MAX_OTHER_SCORE).toBe(0.8);
  });
});

describe('stored samples', () => {
  it('accepts only records it can use', () => {
    expect(isGestureSample(sample('s1', 0.9))).toBe(true);
    expect(isGestureSample(null)).toBe(false);
    expect(isGestureSample({ ...sample('s1', 0.9), points: [[0, 0]] })).toBe(false);
    expect(isGestureSample({ ...sample('s1', 0.9), points: [[0, Number.NaN], [1, 1]] })).toBe(false);
    expect(isGestureSample({ ...sample('s1', 0.9), score: 'high' })).toBe(false);
    expect(isGestureSample({ ...sample('s1', 0.9), gestureKey: 3 })).toBe(false);
  });

  it('uses only samples learned under the current gesture, best first', () => {
    const all = [sample('s1', 0.8), sample('s2', 0.9), sample('s3', 0.95, { gestureKey: 'old' }), sample('s4', 0.99, { spellId: 'nox' }), sample('s5', 0.7, { gestureKey: undefined })];
    expect(samplesFor(all, 'accio', 'k1').map((s) => s.id)).toEqual(['s2', 's1']);
    expect(samplesFor(all, 'accio', '')).toEqual([]);
  });

  it('switches samples on only once the spell has enough of them', () => {
    const two = [sample('s1', 0.8), sample('s2', 0.9)];
    expect(activeSamples(two, 'accio', 'k1', 3, 5)).toEqual([]);
    expect(activeSamples([...two, sample('s3', 0.85)], 'accio', 'k1', 3, 5).map((s) => s.id)).toEqual(['s2', 's3', 's1']);
    // A cap below learnAfter still lets samples count once the cap is reached.
    expect(activeSamples(two, 'accio', 'k1', 3, 2)).toHaveLength(2);
    expect(activeSamples(two, 'accio', 'k1', 3, 0)).toEqual([]);
  });
});

describe('keeping the best samples', () => {
  it('keeps every sample while there is room', () => {
    expect(planSample([sample('s1', 0.8)], sample('n', 0.75), 5)).toEqual({ keep: true, drop: [] });
  });

  it('replaces the weakest when full, but only with a better one', () => {
    const full = [sample('s1', 0.8), sample('s2', 0.9), sample('s3', 0.85)];
    expect(planSample(full, sample('n', 0.95), 3)).toEqual({ keep: true, drop: ['s1'] });
    expect(planSample(full, sample('n', 0.8), 3)).toEqual({ keep: false, drop: [] });
  });

  it('trims samples beyond a lowered cap', () => {
    const full = [sample('s1', 0.8), sample('s2', 0.9), sample('s3', 0.85)];
    expect(planSample(full, sample('n', 0.7), 2)).toEqual({ keep: false, drop: ['s1'] });
    expect(planSample(full, sample('n', 0.95), 2)).toEqual({ keep: true, drop: ['s3', 's1'] });
    expect(planSample(full, sample('n', 0.95), 0)).toEqual({ keep: false, drop: ['s1', 's2', 's3'] });
  });
});
