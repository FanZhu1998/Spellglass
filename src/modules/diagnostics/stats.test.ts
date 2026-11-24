import { describe, expect, it } from 'vitest';
import { median, RATE_TYPES, StatsMeter } from './stats';

describe('StatsMeter', () => {
  it('reports events per second by type over the interval, then starts again', () => {
    const m = new StatsMeter(1000);
    for (let i = 0; i < 30; i++) m.count('tip.sample');
    m.count('tip.found');
    expect(m.snapshot(2000, false)).toEqual({ t: 2000, rates: { 'tip.sample': 30, 'tip.found': 1 }, recording: false });
    for (let i = 0; i < 15; i++) m.count('camera.frame');
    // A short interval still gives a per-second rate.
    expect(m.snapshot(2500, true)).toEqual({ t: 2500, rates: { 'camera.frame': 30 }, recording: true });
  });

  it('measures the time from stroke end to its decision, last value', () => {
    const m = new StatsMeter(0);
    m.strokeEnded('s1', 100);
    m.decided('s1', 103.26);
    m.decided('unknown', 500);
    m.decided(undefined, 600);
    expect(m.snapshot(1000, false).decisionMs).toBe(3.3);
    m.strokeEnded('s2', 1100);
    m.decided('s2', 1900);
    expect(m.snapshot(2000, false).decisionMs).toBe(800);
    // A second decision for the same stroke does not count again.
    m.decided('s2', 2500);
    expect(m.snapshot(3000, false).decisionMs).toBe(800);
  });

  it('reports the median trail latency over the last second', () => {
    const m = new StatsMeter(0);
    m.filtered(100, 140);
    m.filtered(133, 170);
    m.filtered(166, 260);
    expect(m.snapshot(300, false).trailLatencyMs).toBe(40);
    // Older than a second: gone.
    expect(m.snapshot(1500, false).trailLatencyMs).toBeUndefined();
  });

  it('counts every contract event type except its own output', () => {
    expect(RATE_TYPES).toContain('tip.sample');
    expect(RATE_TYPES).toContain('camera.frame');
    expect(RATE_TYPES).not.toContain('diagnostics.stats');
  });

  it('takes the median of even and odd lists', () => {
    expect(median([])).toBeUndefined();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
