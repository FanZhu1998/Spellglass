import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../../src/contracts';
import { OneEuro, segmentSession } from './segment';

const ASPECT = 16 / 9;

/** A stream: hold still, move along a line, hold still again; 30 fps. */
function stream(opts: { holdMs?: number; traceMs?: number; pauseMs?: number; length?: number; lose?: boolean } = {}): SessionEvent[] {
  const { holdMs = 500, traceMs = 600, pauseMs = 500, length = 0.3, lose = false } = opts;
  const out: SessionEvent[] = [];
  let t = 0;
  const step = 1000 / 30;
  const add = (x: number, y: number) => out.push({ type: 'tip.sample', t: (t += step), x, y, conf: 1 });
  for (let k = 0; k * step < holdMs; k++) add(0.3, 0.5);
  for (let k = 1; k * step <= traceMs; k++) add(0.3 + (length * k * step) / traceMs, 0.5);
  for (let k = 0; k * step < pauseMs; k++) add(0.3 + length, 0.5);
  if (lose) out.push({ type: 'tip.lost', t: t + 200, lastSeen: t });
  return out;
}

describe('One Euro filter', () => {
  it('passes the first value, smooths jitter, and settles on a constant', () => {
    const f = new OneEuro();
    expect(f.filter(1, 0)).toBe(1);
    let v = 0;
    for (let i = 1; i < 60; i++) v = f.filter(2, i * 33);
    expect(v).toBeCloseTo(2, 3);
    f.reset();
    expect(f.filter(5, 3000)).toBe(5);
  });

  it('lags less when the signal moves fast in large units', () => {
    const lag = (scale: number) => {
      const f = new OneEuro();
      let out = 0;
      for (let i = 0; i <= 10; i++) out = f.filter(((i * 0.03) * scale), i * 33) / scale;
      return 0.3 - out;
    };
    expect(lag(1920)).toBeLessThan(lag(1));
  });
});

describe('approximate hold-still segmenter', () => {
  it('finds one stroke: hold, trace, pause', () => {
    const found = segmentSession(stream(), { aspect: ASPECT }, () => true);
    expect(found).toHaveLength(1);
    expect(found[0].endReason).toBe('pause');
    expect(found[0].points[0].x).toBeCloseTo(0.3, 6);
    expect(found[0].points[found[0].points.length - 1].x).toBeCloseTo(0.6, 6);
  });

  it('needs a hold before it arms', () => {
    expect(segmentSession(stream({ holdMs: 150 }), { aspect: ASPECT }, () => true)).toHaveLength(0);
  });

  it('drops strokes that are too small, and ends a stroke when the tip is lost', () => {
    expect(segmentSession(stream({ length: 0.05 }), { aspect: ASPECT }, () => true)).toHaveLength(0);
    const lost = segmentSession(stream({ pauseMs: 0, lose: true }), { aspect: ASPECT }, () => true);
    expect(lost).toHaveLength(1);
    expect(lost[0].endReason).toBe('lost');
  });

  it('still finds the stroke through a heavy filter', () => {
    expect(segmentSession(stream(), { aspect: ASPECT, filterScale: 1 }, () => true)).toHaveLength(1);
  });
});
