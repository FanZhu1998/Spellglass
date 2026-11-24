import { describe, expect, it } from 'vitest';
import { EFFECT_LIMITS } from '../../../../contracts';
import { scaleParticleCount } from './limits';
import { arcThrough, arcX, arcY, particleFade, ParticleSystem, PRESETS, type Arc } from './particles';
import { createRandom } from './random';

function system(reduced = false): ParticleSystem {
  const p = new ParticleSystem(createRandom(3), () => reduced);
  p.setAspect(16 / 9);
  return p;
}

describe('particle counts and reduced motion (Section 10.6)', () => {
  it('ParticleApi.burst takes the count it is given: the props cut their own counts', () => {
    // A prop under reduced motion asks for its already-cut count (PropBase.count); cutting again
    // here would apply EFFECT_LIMITS.reducedMotionParticleFactor twice.
    const p = system(true);
    p.burst({ preset: 'smoke', x: 0.5, y: 0.5, count: 7 });
    expect(p.count).toBe(7);
  });

  it('the core cuts its own counts once, before spawning', () => {
    const p = system(true);
    p.spawn({ preset: 'stars', x: 0.5, y: 0.5, count: scaleParticleCount(24, true) });
    expect(p.count).toBe(Math.round(24 * EFFECT_LIMITS.reducedMotionParticleFactor));
  });

  it('never exceeds the pool, and ignores junk positions and counts', () => {
    const p = system();
    for (let i = 0; i < 10; i++) p.spawn({ preset: 'sparks', x: 0.5, y: 0.5, count: 400 });
    expect(p.count).toBe(EFFECT_LIMITS.particlesMax);
    const q = system();
    expect(q.spawn({ preset: 'sparks', x: Number.NaN, y: 0.5, count: 10 })).toBe(0);
    expect(q.spawn({ preset: 'sparks', x: 0.5, y: 0.5, count: Number.NaN })).toBe(16);
  });
});

describe('streams (particles.stream)', () => {
  it('flies particles along the arc and drops the stream once its last particle lands', () => {
    const p = system();
    const handle = p.addStream({
      preset: 'water', durationMs: 400, rate: 150, arc: 0.35,
      resolve: () => ({ from: { x: 0.6, y: 0.4 }, to: { x: 0.14, y: 0.86 } }),
    }, 0);
    let t = 0;
    for (; t < 400; t += 16) p.update(16);
    expect(p.count).toBeGreaterThan(20);
    expect(handle.finished(t)).toBe(true);
    // No more are made; the ones in the air land (and splash) within about a second.
    for (let k = 0; k < 120; k++) p.update(16);
    expect(p.count).toBe(0);
  });

  it('stop() ends a stream early', () => {
    const p = system();
    const handle = p.addStream({ preset: 'stars', durationMs: 5000, rate: 45, arc: 0.2, resolve: () => ({ from: { x: 0.2, y: 0.8 }, to: { x: 0.5, y: 0.5 } }) }, 0);
    p.update(16);
    handle.stop();
    p.update(16);
    expect(handle.finished(32)).toBe(true);
  });

  it('bows the arc upward and reaches both ends', () => {
    const a: Arc = { ax: 0, ay: 0, bx: 0, by: 0, cx: 0, cy: 0, nx: 0, ny: 0 };
    arcThrough(1, 0.4, 0.2, 0.86, 0.35, a);
    expect(arcX(a, 0)).toBeCloseTo(1);
    expect(arcY(a, 0)).toBeCloseTo(0.4);
    expect(arcX(a, 1)).toBeCloseTo(0.2);
    expect(arcY(a, 1)).toBeCloseTo(0.86);
    // Up the screen is smaller y: the middle of the arc sits above the straight line's middle.
    expect(arcY(a, 0.5)).toBeLessThan((0.4 + 0.86) / 2);
    expect(a.ny).toBeLessThan(0);
  });
});

describe('soft presets', () => {
  it('fade in slowly, so mist and smoke never jump to full brightness', () => {
    expect(particleFade(0, 0.35)).toBe(0);
    expect(particleFade(0.1, 0.35)).toBeCloseTo(0.1 / 0.35);
    expect(particleFade(0.4, 0.35)).toBe(1);
    expect(particleFade(1, 0.35)).toBe(0);
    expect(PRESETS.mist.fadeIn).toBeGreaterThan(PRESETS.sparks.fadeIn ?? 0.08);
  });
});
