import { describe, expect, it } from 'vitest';
import { gesturePaceMs, gradeFor } from '../../kernel';
import { castPower, castQuality, fizzleQuality, strokeFacts, strokeQuality, tempoScore, tempoVerdict } from './measure';
import { flickStroke, pathStroke, seedSpell } from './test-support';

const FULL = { x: 0, y: 0, w: 1, h: 1 };
const MIN_EXTENT = 0.15;

describe('strokeFacts', () => {
  it('measures duration, extent relative to the play area, speed and the end point', () => {
    const s = flickStroke('s', 'up', { t0: 1000, durationMs: 250, length: 0.4, cx: 0.5, cy: 0.5 });
    const f = strokeFacts(s, FULL);
    expect(f.durationMs).toBe(250);
    expect(f.extent).toBeCloseTo(0.4, 6);
    expect(f.speed).toBeCloseTo(1.6, 6); // 0.4 units in 0.25 s
    expect(f.end).toEqual({ x: 0.5, y: 0.3 });
    expect(f.linearity).toBeLessThan(0.01);
    // A play area half the frame doubles the relative size.
    expect(strokeFacts(s, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }).extent).toBeCloseTo(0.8, 6);
  });
});

describe('tempo against the gesture pace', () => {
  it('is comfortable from half to 1.8 times a path pace, and falls off outside', () => {
    expect(tempoScore(1000, 2000, false)).toBe(1);
    expect(tempoScore(3600, 2000, false)).toBe(1);
    expect(tempoScore(500, 2000, false)).toBeCloseTo(0.5, 6); // a doubling too fast
    expect(tempoScore(250, 2000, false)).toBeCloseTo(0, 6);
    expect(tempoVerdict(400, 2000, false)).toBe('fast');
    expect(tempoVerdict(4000, 2000, false)).toBe('slow');
  });

  it('lets flicks be quick', () => {
    expect(tempoScore(120, 350, true)).toBe(1);
    expect(tempoVerdict(120, 350, true)).toBe('ok');
    expect(tempoVerdict(1200, 350, true)).toBe('slow');
  });
});

const grade = (q: number) => gradeFor(q, 'cast');

describe('quality calibration (candlelit grades)', () => {
  it('grades a clean cast at a natural pace Outstanding', () => {
    const g = seedSpell('alohomora').gesture;
    const s = pathStroke('s', 'alohomora', { t0: 0, durationMs: gesturePaceMs(g), quality: 0.95 });
    const q = strokeQuality(g, 0.92, strokeFacts(s, FULL));
    expect(q).toBeGreaterThanOrEqual(0.9);
    expect(grade(q)).toBe('Outstanding');
    // A flick, too.
    const lumos = seedSpell('lumos').gesture;
    const f = flickStroke('f', 'up', { t0: 0, durationMs: 300, quality: 0.95 });
    expect(grade(strokeQuality(lumos, 0.93, strokeFacts(f, FULL)))).toBe('Outstanding');
  });

  it('grades a passable cast Exceeds Expectations or Acceptable', () => {
    const g = seedSpell('alohomora').gesture;
    const s = pathStroke('s', 'alohomora', { t0: 0, durationMs: 1800, quality: 0.85 });
    const facts = strokeFacts(s, FULL);
    expect(grade(strokeQuality(g, 0.81, facts))).toBe('Exceeds Expectations');
    expect(grade(strokeQuality(g, 0.74, facts))).toBe('Acceptable');
    expect(grade(strokeQuality(g, 0.72, facts))).toBe('Acceptable');
  });

  it('lowers quality for a jittery or rushed stroke with the same score', () => {
    const g = seedSpell('alohomora').gesture;
    const clean = strokeQuality(g, 0.9, strokeFacts(pathStroke('a', 'alohomora', { t0: 0, durationMs: 2000, quality: 0.95 }), FULL));
    const jittery = strokeQuality(g, 0.9, strokeFacts(pathStroke('b', 'alohomora', { t0: 0, durationMs: 2000, quality: 0.3 }), FULL));
    const rushed = strokeQuality(g, 0.9, strokeFacts(pathStroke('c', 'alohomora', { t0: 0, durationMs: 400, quality: 0.95 }), FULL));
    expect(jittery).toBeLessThan(clean);
    expect(rushed).toBeLessThan(clean);
    expect(gradeFor(rushed, 'cast')).not.toBe('Outstanding');
  });

  it('weights the shape most', () => {
    expect(castQuality({ score: 0.9, smoothness: 1, tempo: 1 })).toBeCloseTo(1, 6);
    expect(castQuality({ score: 0.5, smoothness: 1, tempo: 1 })).toBeCloseTo(0.35, 6);
  });

  it('costs a grade for rushing a perfect shape', () => {
    const g = seedSpell('accio').gesture;
    const rushed = strokeFacts(pathStroke('s', 'accio', { t0: 0, durationMs: gesturePaceMs(g) / 4, quality: 0.95 }), FULL);
    expect(grade(strokeQuality(g, 0.99, rushed))).toBe('Exceeds Expectations');
  });

  it('grades fizzles on the nearest score: near miss Poor, worse Dreadful, scribble Troll', () => {
    const fizzleGrade = (score: number) => gradeFor(fizzleQuality(score), 'fizzle');
    // Near misses keep their score exactly.
    expect(fizzleQuality(0.66)).toBe(0.66);
    expect(fizzleQuality(0.72)).toBe(0.72);
    expect(fizzleGrade(0.66)).toBe('Poor');
    expect(fizzleGrade(0.6)).toBe('Poor');
    // A wrong but recognizable shape, and scribbles (whose nearest score is about 0.43 to 0.52).
    expect(fizzleGrade(0.55)).toBe('Dreadful');
    expect(fizzleGrade(0.47)).toBe('Troll');
    expect(fizzleGrade(0.43)).toBe('Troll');
    expect(fizzleQuality(0)).toBe(0);
  });
});

describe('power calibration', () => {
  it('gives an everyday flick modest power and a large, quick flick high power', () => {
    const everyday = strokeFacts(flickStroke('a', 'up', { t0: 0, durationMs: 300, length: 0.33 }), FULL);
    expect(castPower(everyday, true, MIN_EXTENT)).toBeGreaterThan(0.2);
    expect(castPower(everyday, true, MIN_EXTENT)).toBeLessThan(0.45);
    const big = strokeFacts(flickStroke('b', 'up', { t0: 0, durationMs: 220, length: 0.85 }), FULL);
    expect(castPower(big, true, MIN_EXTENT)).toBeGreaterThanOrEqual(0.8);
  });

  it('needs both size and speed for full power', () => {
    const bigSlow = strokeFacts(flickStroke('a', 'up', { t0: 0, durationMs: 1200, length: 0.85 }), FULL);
    expect(castPower(bigSlow, true, MIN_EXTENT)).toBeLessThan(0.8);
    const smallFast = strokeFacts(flickStroke('b', 'up', { t0: 0, durationMs: 80, length: 0.2 }), FULL);
    expect(castPower(smallFast, true, MIN_EXTENT)).toBeLessThan(0.5);
  });

  it('is relative to the play area', () => {
    const s = flickStroke('a', 'up', { t0: 0, durationMs: 220, length: 0.45 });
    const whole = castPower(strokeFacts(s, FULL), true, MIN_EXTENT);
    const small = castPower(strokeFacts(s, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }), true, MIN_EXTENT);
    expect(small).toBeGreaterThan(whole);
    expect(small).toBeGreaterThanOrEqual(0.8);
  });
});
