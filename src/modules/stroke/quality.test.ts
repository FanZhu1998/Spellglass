import { describe, expect, it } from 'vitest';
import type { TipSample } from '../../contracts';
import { TipFilter } from './filter';
import { QUALITY, dropoutFactor, jitterFactor, missedFrames, roughness, sampleInterval, strokeQuality } from './quality';
import { Noise } from './test-support';

const A = 16 / 9;
const FRAME = 1000 / 30;

type Shape = 'circle' | 'hook' | 'flick';

/** A stroke 0.2 frame widths across at 30 fps, with jitter `sigma` (frame widths, per axis),
 *  through the recommended filter like the module's strokes. */
function stroke(shape: Shape, sigma: number, seed = 1, filtered = true): TipSample[] {
  const f = new TipFilter({ minCutoff: 1, beta: 20, dCutoff: 1 });
  const n = new Noise(seed);
  const ms = shape === 'flick' ? 300 : 1200;
  const out: TipSample[] = [];
  for (let t = 0; t <= ms + 1e-6; t += FRAME) {
    const u = t / ms;
    let x: number, y: number; // frame widths
    if (shape === 'circle') {
      x = 0.5 + 0.1 * Math.cos(2 * Math.PI * u);
      y = 0.3 + 0.1 * Math.sin(2 * Math.PI * u);
    } else if (shape === 'hook') {
      x = u < 0.5 ? 0.4 + 0.4 * u : 0.6;
      y = u < 0.5 ? 0.3 : 0.3 - 0.4 * (u - 0.5);
    } else {
      // A flick that accelerates and brakes hard (minimum jerk).
      x = 0.5;
      y = 0.4 - 0.2 * (10 * u ** 3 - 15 * u ** 4 + 6 * u ** 5);
    }
    const raw: TipSample = { t, x: x + n.gauss(sigma), y: (y + n.gauss(sigma)) * A, conf: 1, src: 'test' };
    out.push(filtered ? f.filter(raw, A) : raw);
  }
  return out;
}

const meanQuality = (shape: Shape, sigma: number) => {
  let sum = 0;
  for (let seed = 1; seed <= 20; seed++) sum += strokeQuality(stroke(shape, sigma, seed), A);
  return sum / 20;
};

describe('Stroke.quality', () => {
  it('is 1 for clean strokes, however they curve or accelerate', () => {
    for (const shape of ['circle', 'hook', 'flick'] as const) expect(strokeQuality(stroke(shape, 0), A)).toBe(1);
  });

  it('stays at 1 for the bright tip’s tracking jitter (0.08% and 0.15%)', () => {
    for (const shape of ['circle', 'hook'] as const) {
      expect(meanQuality(shape, 0.0008)).toBe(1);
      expect(meanQuality(shape, 0.0015)).toBe(1);
    }
  });

  it('falls with jitter: about 0.9 at 0.3%, 0.7 at 0.5%, 0.3 at 1%', () => {
    const q3 = meanQuality('circle', 0.003), q5 = meanQuality('circle', 0.005), q10 = meanQuality('circle', 0.01);
    expect(q3).toBeGreaterThan(0.85);
    expect(q3).toBeLessThan(0.97);
    expect(q5).toBeGreaterThan(0.6);
    expect(q5).toBeLessThan(0.8);
    expect(q10).toBeGreaterThan(0.15);
    expect(q10).toBeLessThan(0.45);
  });

  it('is rounded to 3 decimals and stays within 0..1', () => {
    const q = strokeQuality(stroke('flick', 0.02, 3), A);
    expect(q).toBeGreaterThanOrEqual(0);
    expect(q).toBeLessThanOrEqual(1);
    expect(Math.round(q * 1000) / 1000).toBe(q);
  });

  it('handles strokes too short to judge', () => {
    expect(strokeQuality([], A)).toBe(1);
    const two = stroke('hook', 0.01).slice(0, 4);
    expect(roughness(two, A)).toBe(0);
    expect(jitterFactor(two, A)).toBe(1);
  });
});

describe('dropouts', () => {
  const at = (ts: number[]) => ts.map((t) => ({ t }));
  const steady = (n: number) => Array.from({ length: n }, (_, i) => i * FRAME);

  it('a single dropped or late frame is not a dropout', () => {
    const ts = steady(30);
    ts.splice(10, 1); // one frame missing: a step of two intervals
    expect(missedFrames(at(ts))).toEqual({ missed: 0, steps: 28 });
    expect(dropoutFactor(at(ts))).toBe(1);
  });

  it('two or more frames missing in a row are, and count every missing frame', () => {
    const ts = steady(31);
    ts.splice(10, 2); // a step of three intervals
    ts.splice(18, 3); // a step of four intervals
    expect(missedFrames(at(ts))).toEqual({ missed: 5, steps: 25 });
    expect(dropoutFactor(at(ts))).toBeCloseTo(1 - 5 / 30 / QUALITY.dropoutZeroShare, 6);
  });

  it('losing a quarter of the frames halves the dropout factor; half of them takes it to 0', () => {
    // Steady runs of three frames, then three missing: half lost.
    const half: number[] = [];
    for (let i = 0; i < 60; i++) if (Math.floor(i / 3) % 2 === 0) half.push(i * FRAME);
    expect(dropoutFactor(at(half))).toBeLessThan(0.1);
    // A quarter: runs of nine frames, then three missing.
    const quarter: number[] = [];
    for (let i = 0; i < 96; i++) if (i % 12 < 9) quarter.push(i * FRAME);
    expect(dropoutFactor(at(quarter))).toBeCloseTo(0.5, 1);
  });

  it('lowers Stroke.quality', () => {
    const s = stroke('circle', 0);
    const holed = s.filter((_, i) => i < 10 || i > 13);
    expect(strokeQuality(holed, A)).toBeLessThan(1);
    expect(strokeQuality(holed, A)).toBeGreaterThan(0.7);
  });

  it('a pointer-style source sends nothing while still: its gaps are rests, and only jitter counts', () => {
    const s = stroke('circle', 0);
    const holed = s.filter((_, i) => i < 10 || i > 13);
    expect(strokeQuality(holed, A, { pen: true })).toBe(1);
    const rough = stroke('circle', 0.01);
    expect(strokeQuality(rough, A, { pen: true })).toBe(strokeQuality(rough, A));
    expect(strokeQuality(rough, A, { pen: true })).toBeLessThan(0.6);
  });

  it('the typical sample interval is the median step, and needs two steps to tell', () => {
    const ts = steady(30);
    ts.splice(10, 5);
    expect(sampleInterval(at(ts))).toBeCloseTo(FRAME, 6);
    expect(sampleInterval(at([0, 500]))).toBe(0);
    expect(sampleInterval(at([0, 0, 0]))).toBe(0);
  });
});
