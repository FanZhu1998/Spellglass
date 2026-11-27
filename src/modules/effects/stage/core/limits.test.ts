import { describe, expect, it } from 'vitest';
import { EFFECT_LIMITS } from '../../../../contracts';
import { isSaturatedRed, parseColor } from './color';
import {
  FlashLimiter, MAX_DIM_RATE_PER_MS, ORB_BLOOM_MS, prepareBolt, prepareBurst, prepareCreature, prepareDim, prepareFlash, prepareOrb,
  prepareReveal, prepareShake, prepareShield, prepareSlow, prepareStream, prepareText, scaleParticleCount, stepDim, wrapText,
  type PrepareContext,
} from './limits';

const ctx = (over: Partial<PrepareContext> = {}): PrepareContext => ({ scale: 1, reducedMotion: false, lasts: null, ...over });

describe('flash limiter (Section 10.6: at most three flashes a second, one at a time)', () => {
  it('allows three flashes in any rolling second and refuses the fourth', () => {
    const lim = new FlashLimiter();
    expect(lim.request(0, 100)).toBe(0);
    expect(lim.request(200, 100)).toBe(200);
    expect(lim.request(400, 100)).toBe(400);
    expect(lim.request(600, 100)).toBeNull();
    // The window rolls: a second after the first flash there is room again.
    expect(lim.request(1001, 100)).toBe(1001);
    expect(lim.recent(1001)).toBe(3);
  });

  it('never shows two flashes at once: a flash that arrives during another waits briefly or is refused', () => {
    const lim = new FlashLimiter();
    expect(lim.request(0, 150)).toBe(0);
    // Arrives 100 ms in: waits for the first to finish at 150.
    expect(lim.request(100, 200)).toBe(150);
    // Arrives while the second is showing, and it would have to wait too long.
    expect(lim.request(160, 200, 120)).toBeNull();
  });

  it('holds the budget across a burst of requests at the same moment', () => {
    const lim = new FlashLimiter();
    const granted = [0, 0, 0, 0, 0].map(() => lim.request(0, 1, 50)).filter((x) => x !== null);
    expect(granted.length).toBeLessThanOrEqual(EFFECT_LIMITS.flashesPerSecond);
  });

  it('counts a quick change in an orb like a flash, which never waits and holds no flash back', () => {
    const lim = new FlashLimiter();
    expect(lim.change(0)).toBe(true);
    // A flash straight after an orb's bloom is not held back by it.
    expect(lim.request(10, 200)).toBe(10);
    // While that flash shows, an orb changes softly.
    expect(lim.change(100)).toBe(false);
    expect(lim.change(300)).toBe(true);
    // Three in the last second: the budget is spent.
    expect(lim.change(400)).toBe(false);
    expect(lim.request(500, 100)).toBeNull();
    expect(lim.change(1001)).toBe(true);
  });
});

describe('flash and bolt params obey the limits after effectScale', () => {
  it('caps radius and intensity', () => {
    const p = prepareFlash({ use: 'light.flash', radius: 0.3, intensity: 0.6 }, ctx({ scale: 1.6 }));
    expect(p.radius).toBe(EFFECT_LIMITS.flashMaxRadius);
    expect(p.intensity).toBe(EFFECT_LIMITS.flashMaxIntensity);
  });

  it('caps saturated red flashes lower', () => {
    const p = prepareFlash({ use: 'light.flash', color: '#FF3B30', intensity: 0.55 }, ctx());
    expect(p.red).toBe(true);
    expect(p.intensity).toBe(EFFECT_LIMITS.redFlashMaxIntensity);
    const warm = prepareFlash({ use: 'light.flash', color: '#FF8A2A', intensity: 0.45 }, ctx());
    expect(warm.red).toBe(false);
    expect(warm.intensity).toBe(0.45);
  });

  it('falls back to safe defaults for junk params from an imported pack', () => {
    const p = prepareFlash({ use: 'light.flash', color: 'red; background:url(x)', radius: Number.NaN, intensity: 'bright', duration_ms: 1e9 }, ctx());
    expect(p.color).toMatch(/^#/);
    expect(p.radius).toBeLessThanOrEqual(EFFECT_LIMITS.flashMaxRadius);
    expect(p.intensity).toBeLessThanOrEqual(EFFECT_LIMITS.flashMaxIntensity);
    expect(p.duration_ms).toBeLessThanOrEqual(1000);
  });

  it('treats bolt width as a multiplier, clamped, then capped by boltMaxWidth', () => {
    expect(prepareBolt({ use: 'bolt.cast', width: 0.6 }, ctx()).width).toBeCloseTo(0.0048);
    expect(prepareBolt({ use: 'bolt.cast', width: 50 }, ctx({ scale: 1.6 })).width).toBeLessThanOrEqual(EFFECT_LIMITS.boltMaxWidth);
    expect(prepareBolt({ use: 'bolt.cast', width: 0.01 }, ctx()).width).toBeCloseTo(0.002);
  });

  it('keeps shake short and small, and off under reduced motion', () => {
    const p = prepareShake({ use: 'screen.shake', intensity: 3, duration_ms: 5000 }, ctx());
    expect(p.px).toBe(EFFECT_LIMITS.shakeMaxPx);
    expect(p.duration_ms).toBe(EFFECT_LIMITS.shakeMaxMs);
    expect(prepareShake({ use: 'screen.shake', intensity: 0.4 }, ctx({ reducedMotion: true })).px).toBe(0);
  });

  it('scales the orb with Lumos Maxima', () => {
    const plain = prepareOrb({ use: 'light.orb', at: 'tip', hold: true }, ctx());
    const maxima = prepareOrb({ use: 'light.orb', at: 'tip', hold: true }, ctx({ scale: 1.6 }));
    expect(maxima.radius).toBeCloseTo(plain.radius * 1.6);
    expect(maxima.intensity).toBe(1);
    expect(plain.duration_ms).toBeUndefined();
  });

  it('keeps a saturated red orb as dim as a red flash, and a timed orb long enough to bloom', () => {
    expect(prepareOrb({ use: 'light.orb', color: '#FF2A2A', intensity: 1 }, ctx({ scale: 1.6 })).intensity).toBe(EFFECT_LIMITS.redFlashMaxIntensity);
    expect(prepareOrb({ use: 'light.orb', color: '#FF8A2A', intensity: 1 }, ctx()).intensity).toBe(1);
    expect(prepareOrb({ use: 'light.orb', duration_ms: 100 }, ctx()).duration_ms).toBe(ORB_BLOOM_MS);
  });
});

describe('held steps (EffectStep.hold: "keep the step running until the spell ends")', () => {
  it('have no duration of their own, given or default; other lasting steps keep theirs', () => {
    const c = ctx({ lasts: 'until-ended' });
    const held = [
      prepareStream({ use: 'particles.stream', hold: true, duration_ms: 900 }, c),
      prepareShield({ use: 'shield.dome', hold: true }, c),
      prepareCreature({ use: 'creature.summon', hold: true }, c),
      prepareSlow({ use: 'time.slow', hold: true }),
      prepareReveal({ use: 'scene.reveal', hold: true }),
      prepareText({ use: 'text.inscribe', hold: true }),
    ];
    for (const p of held) {
      expect(p.hold).toBe(true);
      expect(p.duration_ms).toBeUndefined();
    }
    expect(prepareShield({ use: 'shield.dome' }, c)).toMatchObject({ hold: false, duration_ms: 5000 });
    expect(prepareStream({ use: 'particles.stream', duration_ms: 1e9 }, c).duration_ms).toBe(EFFECT_LIMITS.maxStepMs);
    // screen.shake is never held: short whatever a pack asks.
    expect(prepareShake({ use: 'screen.shake', hold: true }, c).duration_ms).toBeLessThanOrEqual(EFFECT_LIMITS.shakeMaxMs);
  });
});

describe('scene.dim', () => {
  it('caps the amount and the fade, and holds while its spell is active', () => {
    const d = prepareDim({ use: 'scene.dim', amount: 0.7, hold: true }, ctx({ scale: 1.6, lasts: 'until-ended' }));
    expect(d.amount).toBe(EFFECT_LIMITS.dimMax);
    expect(d.fade_ms).toBeGreaterThanOrEqual(EFFECT_LIMITS.dimMinFadeMs);
    expect(d.hold).toBe(true);
  });

  it('a dim with no duration on an instant spell gets a default length instead of holding forever', () => {
    const d = prepareDim({ use: 'scene.dim', amount: 0.3 }, ctx({ lasts: null }));
    expect(d.hold).toBe(false);
    expect(d.duration_ms).toBeGreaterThan(0);
  });

  it('never changes faster than 0.1 per 100 ms, so dimming never counts as a flash', () => {
    let v = 0;
    let worst = 0;
    for (let t = 0; t < 2000; t += 16) {
      const next = stepDim(v, 0.8, 16, 1);
      worst = Math.max(worst, Math.abs(next - v) / 16);
      v = next;
    }
    expect(worst * 100).toBeLessThan(0.1);
    expect(MAX_DIM_RATE_PER_MS * 100).toBeLessThan(0.1);
    expect(v).toBeCloseTo(0.8);
  });
});

describe('reduced motion and particles', () => {
  it('drops particle counts by the reduced-motion factor', () => {
    expect(scaleParticleCount(60, false)).toBe(60);
    expect(scaleParticleCount(60, true)).toBe(Math.round(60 * EFFECT_LIMITS.reducedMotionParticleFactor));
    expect(scaleParticleCount(1, true)).toBe(1);
    expect(scaleParticleCount(0, true)).toBe(0);
  });

  it('applies effectScale, then the reduced-motion factor, to bursts', () => {
    expect(prepareBurst({ use: 'particles.burst', preset: 'stars', count: 30 }, ctx({ scale: 1.6 })).count).toBe(48);
    expect(prepareBurst({ use: 'particles.burst', preset: 'stars', count: 30 }, ctx({ scale: 1.6, reducedMotion: true })).count).toBe(14);
    expect(prepareBurst({ use: 'particles.burst', preset: 'nope' as never, count: 1e6 }, ctx()).count).toBeLessThanOrEqual(400);
  });
});

describe('text on the glass', () => {
  it('wraps at word boundaries within maxTextChars per line, at most two lines', () => {
    expect(wrapText('What is hidden is only waiting to be asked.')).toEqual(['What is hidden is only waiting to be', 'asked.']);
    expect(wrapText('Lumos Maxima', 40, 1)).toEqual(['Lumos Maxima']);
    const long = wrapText('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen', 40, 2);
    expect(long).toHaveLength(2);
    expect(long.every((l) => l.length <= 40)).toBe(true);
    expect(long[1].endsWith('…')).toBe(true);
  });

  it('drops control characters and never returns empty lines', () => {
    expect(wrapText('  \u0007hello\n\nworld  ')).toEqual(['hello world']);
    expect(wrapText('')).toEqual([]);
    expect(prepareText({ use: 'text.inscribe', text: 42 }).text).toBeUndefined();
  });
});

describe('WCAG saturated red', () => {
  it('recognizes the seed packs’ red bolts and flashes, but not orange fire or green', () => {
    for (const c of ['#E0313F', '#FF4436', '#FF3B30', '#FF2A2A']) expect(isSaturatedRed(parseColor(c, '#000'))).toBe(true);
    for (const c of ['#FF8A2A', '#3DFF6E', '#DDE8FF', '#FFFFFF']) expect(isSaturatedRed(parseColor(c, '#000'))).toBe(false);
  });
});
