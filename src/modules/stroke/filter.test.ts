// The One Euro filter, and the tuning behind the recommended defaults.
//
// Tuning follows the published recipe (Casiez et al., https://gery.casiez.net/1euro/): with beta at 0,
// set minCutoff so a still tip stops jittering while slow motion still feels responsive; then raise
// beta until fast motion no longer lags. On synthetic 30 fps data in frame widths (a still tip with
// 0.15% jitter; constant-speed moves; tracking jitter of 0.08% while moving):
//
//   minCutoff 1 Hz: rest jitter 0.15% → 0.04% (beta 0) ... 0.045% (beta 20); 1.5 Hz: 0.05%
//   beta 0.5 (the contract's first default, with minCutoff 1.5): 80 ms of lag at 0.3 frame widths
//   per second, which rounds corners and makes pauses register late
//   beta 20: 22 ms at 0.2, 17 ms at 0.3, 12 ms at 0.5 frame widths per second
//   beta 30: 17 ms, 13 ms, 9 ms, for a little more jitter at rest (0.048%)
//
// Recommended: minCutoff 1 Hz, beta 20, dCutoff 1 Hz (the paper's derivative cutoff). A wand gesture
// travels at 0.2 to 0.4 frame widths per second and a flick at 0.6 to 1 or more, so this keeps the lag
// under about 30 ms whenever the tip is really moving. On the recorded sessions it brings the
// recognizer's weakest score from 0.85 (contract defaults) to 0.88, close to unfiltered.

import { describe, expect, it } from 'vitest';
import type { TipSample } from '../../contracts';
import { OneEuroFilter, TipFilter, smoothingFactor, type OneEuroParams } from './filter';
import { Noise } from './test-support';

const RECOMMENDED: OneEuroParams = { minCutoff: 1, beta: 20, dCutoff: 1 };
const CONTRACT_FIRST: OneEuroParams = { minCutoff: 1.5, beta: 0.5, dCutoff: 1 };
const ASPECT = 16 / 9;

/** Frame times at `fps` over `ms`, with 0.6 ms of timing jitter. */
function frames(fps: number, ms: number, noise: Noise): number[] {
  const out: number[] = [];
  for (let t = 0; t <= ms; t += 1000 / fps) out.push(t + noise.gauss(0.6));
  return out;
}

/** Mean lag (ms) of a 2D tip filter behind a constant-speed move, after it has settled. */
function lagMs(filter: (x: number, y: number, t: number) => [number, number], speed: number, angleDeg = 0, fps = 30): number {
  const noise = new Noise(2);
  const a = (angleDeg * Math.PI) / 180;
  const lags: number[] = [];
  for (const t of frames(fps, 3000, noise)) {
    const s = (speed * t) / 1000;
    const x = 0.1 + Math.cos(a) * s, y = 0.1 + Math.sin(a) * s;
    const [fx, fy] = filter(x + noise.gauss(0.0008), y + noise.gauss(0.0008), t);
    if (t > 1500) lags.push((((x - fx) * Math.cos(a) + (y - fy) * Math.sin(a)) / speed) * 1000);
  }
  return lags.reduce((s, v) => s + v, 0) / lags.length;
}

/** Standard deviation (per axis, frame widths) of a filtered still tip with Gaussian jitter. */
function restJitter(filter: (x: number, y: number, t: number) => [number, number], sigma: number): number {
  const noise = new Noise(7);
  const outs: [number, number][] = [];
  for (const t of frames(30, 5000, noise)) {
    const o = filter(0.5 + noise.gauss(sigma), 0.3 + noise.gauss(sigma), t);
    if (t > 1000) outs.push(o);
  }
  const mx = outs.reduce((s, o) => s + o[0], 0) / outs.length;
  const my = outs.reduce((s, o) => s + o[1], 0) / outs.length;
  return Math.sqrt(outs.reduce((s, o) => s + (o[0] - mx) ** 2 + (o[1] - my) ** 2, 0) / outs.length / 2);
}

/** The tip filter as a function of frame-width positions (it takes caster space: y is in frame heights). */
function tip(params: OneEuroParams): (x: number, y: number, t: number) => [number, number] {
  const f = new TipFilter(params);
  return (x, y, t) => {
    const out = f.filter({ t, x, y: y * ASPECT, conf: 1, src: 'test' }, ASPECT);
    return [out.x, out.y / ASPECT];
  };
}

/** Two independent textbook filters, one per axis (for comparison). */
function perAxis(params: OneEuroParams): (x: number, y: number, t: number) => [number, number] {
  const fx = new OneEuroFilter(params), fy = new OneEuroFilter(params);
  return (x, y, t) => [fx.filter(x, t), fy.filter(y, t)];
}

describe('OneEuroFilter (one axis, the textbook filter)', () => {
  it('passes the first value through, and again after a reset', () => {
    const f = new OneEuroFilter(RECOMMENDED);
    expect(f.empty).toBe(true);
    expect(f.filter(0.3, 0)).toBe(0.3);
    expect(f.filter(0.4, 33)).not.toBe(0.4);
    f.reset();
    expect(f.filter(0.9, 66)).toBe(0.9);
  });

  it('smoothingFactor is the paper’s α = 1 / (1 + τ/Te)', () => {
    const tau = 1 / (2 * Math.PI * 1);
    expect(smoothingFactor(1 / 30, 1)).toBeCloseTo(1 / (1 + tau * 30), 12);
    expect(smoothingFactor(1 / 30, 0)).toBe(0);
  });

  it('with beta 0 it is a plain low-pass at minCutoff', () => {
    const f = new OneEuroFilter({ minCutoff: 2, beta: 0, dCutoff: 1 });
    f.filter(0, 0);
    const a = smoothingFactor(0.04, 2);
    expect(f.filter(1, 40)).toBeCloseTo(a, 12);
  });

  it('takes dt from the timestamps: the same motion at 30 and 60 fps lags about the same', () => {
    const at30 = lagMs(perAxis(RECOMMENDED), 0.3, 0, 30);
    const at60 = lagMs(perAxis(RECOMMENDED), 0.3, 0, 60);
    expect(at60).toBeLessThan(at30);
    expect(at60).toBeGreaterThan(at30 * 0.5);
  });

  it('copes with repeated and reordered timestamps', () => {
    const f = new OneEuroFilter(RECOMMENDED);
    f.filter(0.1, 100);
    const a = f.filter(0.2, 100);
    const b = f.filter(0.25, 90);
    expect(Number.isFinite(a) && Number.isFinite(b)).toBe(true);
    expect(a).toBeGreaterThan(0.1);
    expect(b).toBeLessThanOrEqual(0.25);
  });
});

describe('TipFilter (isotropic frame widths, one cutoff)', () => {
  it('changes only x and y: same t, src and every other field', () => {
    const f = new TipFilter(RECOMMENDED);
    const s: TipSample = { t: 12, x: 0.5, y: 0.5, conf: 0.8, src: 'tracker.bright-tip', size: 0.002, frame: 7 };
    expect(f.filter(s, ASPECT)).toEqual(s);
    const next = f.filter({ ...s, t: 45, x: 0.52, y: 0.49, frame: 8 }, ASPECT);
    expect(next).toMatchObject({ t: 45, conf: 0.8, src: 'tracker.bright-tip', size: 0.002, frame: 8 });
    expect(next.x).not.toBe(0.52);
  });

  it('is exactly the per-axis filter for motion along one axis', () => {
    const tf = new TipFilter(RECOMMENDED);
    const ax = new OneEuroFilter(RECOMMENDED);
    const noise = new Noise(5);
    for (const t of frames(30, 1000, noise)) {
      const x = 0.2 + 0.0003 * t + noise.gauss(0.001);
      expect(tf.filter({ t, x, y: 0.5, conf: 1, src: 's' }, ASPECT).x).toBeCloseTo(ax.filter(x, t), 12);
    }
  });

  it('smooths both axes alike: the same lag along x and along y in frame widths', () => {
    const alongX = lagMs(tip(RECOMMENDED), 0.3, 0);
    const alongY = lagMs(tip(RECOMMENDED), 0.3, 90);
    expect(Math.abs(alongX - alongY)).toBeLessThan(1);
  });

  it('lags less on diagonals than independent axes, and keeps circles round', () => {
    const shared = lagMs(tip(RECOMMENDED), 0.3, 45);
    const independent = lagMs(perAxis(RECOMMENDED), 0.3, 45);
    expect(shared).toBeLessThan(independent - 2);
    // A circle of radius 0.1 frame widths traced in 1.8 s: the filtered radius stays within 1%.
    const f = tip(RECOMMENDED);
    const noise = new Noise(4);
    const radii: number[] = [];
    for (const t of frames(30, 2400, noise)) {
      const u = Math.min(1, Math.max(0, (t - 300) / 1800));
      const [x, y] = f(0.5 + 0.1 * Math.cos(2 * Math.PI * u), 0.3 + 0.1 * Math.sin(2 * Math.PI * u), t);
      if (u > 0.1 && u < 1) radii.push(Math.hypot(x - 0.5, y - 0.3));
    }
    const mean = radii.reduce((s, r) => s + r, 0) / radii.length;
    expect(Math.abs(mean - 0.1)).toBeLessThan(0.001);
  });

  it('starts again after a reset', () => {
    const f = new TipFilter(RECOMMENDED);
    f.filter({ t: 0, x: 0.1, y: 0.1, conf: 1, src: 's' }, ASPECT);
    f.reset();
    expect(f.empty).toBe(true);
    expect(f.filter({ t: 33, x: 0.9, y: 0.8, conf: 1, src: 's' }, ASPECT)).toMatchObject({ x: 0.9, y: 0.8 });
  });
});

describe('the recommended defaults (minCutoff 1, beta 20, dCutoff 1)', () => {
  it('cut a still tip’s 0.15% jitter at least threefold', () => {
    const raw = restJitter((x, y) => [x, y], 0.0015);
    const filtered = restJitter(tip(RECOMMENDED), 0.0015);
    expect(raw).toBeCloseTo(0.0015, 3);
    expect(filtered).toBeLessThan(raw / 3);
  });

  it('lag under 30 ms once the tip moves at 0.15 frame widths per second, under 20 ms at 0.3', () => {
    expect(lagMs(tip(RECOMMENDED), 0.15)).toBeLessThan(30);
    expect(lagMs(tip(RECOMMENDED), 0.3)).toBeLessThan(20);
    expect(lagMs(tip(RECOMMENDED), 1)).toBeLessThan(8);
  });

  it('a fast flick (0.25 frame widths in 300 ms) is followed within 2% of the frame width and settles at once', () => {
    const f = tip(RECOMMENDED);
    const noise = new Noise(3);
    let maxLag = 0, settledAfter = Infinity;
    for (const t of frames(30, 1600, noise)) {
      const u = Math.min(1, Math.max(0, (t - 500) / 300));
      const s = 0.25 * (10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5); // minimum-jerk
      const [, y] = f(0.5, 0.4 - s + noise.gauss(0.0008), t);
      const behind = y - (0.4 - s);
      if (t <= 800) maxLag = Math.max(maxLag, behind);
      else if (Math.abs(behind) < 0.0025 && settledAfter === Infinity) settledAfter = t - 800;
    }
    expect(maxLag).toBeLessThan(0.02);
    expect(settledAfter).toBeLessThan(70);
  });

  it('versus the contract’s first default (beta 0.5), which lags about 80 ms at gesture speed', () => {
    expect(lagMs(tip(CONTRACT_FIRST), 0.3)).toBeGreaterThan(70);
    expect(lagMs(tip(RECOMMENDED), 0.3)).toBeLessThan(lagMs(tip(CONTRACT_FIRST), 0.3) / 4);
  });
});
