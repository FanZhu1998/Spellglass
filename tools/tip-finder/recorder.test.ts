import { describe, expect, it } from 'vitest';
import { SESSION_SCHEMA } from '../../src/contracts';
import { SessionRecorder, formatExposure, sliderToTime, timeToSlider } from './recorder';

describe('tip-finder session recorder', () => {
  it('writes tip events in the fixture format, relative to the start', () => {
    const r = new SessionRecorder(1000);
    r.found({ t: 1100, x: 0.5, y: 0.5, conf: 0.9, frame: 3 });
    r.sample({ t: 1100, x: 0.5, y: 0.5, conf: 0.9, size: 0.0021, frame: 3 });
    r.sample({ t: 1133.3333, x: 0.51234567, y: 0.5, conf: 0.91234, size: 0.0021, frame: 4 });
    r.lost(1300);
    const s = r.finish(11000, { id: 'session-x', aspect: 16 / 9, title: 'Circles at 1 m', camera: { label: 'Cam', width: 1920, height: 1080, fps: 30 } });
    expect(s.schema).toBe(SESSION_SCHEMA);
    expect(s.tracker).toBe('tracker.bright-tip');
    expect(s.pen).toBe(false);
    expect(s.expected).toEqual([]);
    expect(s.events.map((e) => e.type)).toEqual(['tip.found', 'tip.sample', 'tip.sample', 'tip.lost']);
    expect(s.events[2]).toEqual({ type: 'tip.sample', t: 133.33, x: 0.51235, y: 0.5, conf: 0.912, size: 0.0021, frame: 4 });
    expect(s.events[3]).toEqual({ type: 'tip.lost', t: 300, lastSeen: 133.33 });
    expect(s.title).toBe('Circles at 1 m');
  });

  it('opens with tip.found when recording starts while the tip is held, and closes a held tip at the end', () => {
    const r = new SessionRecorder(0);
    r.sample({ t: 10, x: 0.2, y: 0.3, conf: 0.8 });
    const s = r.finish(10000, { id: 's', aspect: 4 / 3 });
    expect(s.events.map((e) => e.type)).toEqual(['tip.found', 'tip.sample', 'tip.lost']);
    expect(s.events[2]).toMatchObject({ t: 10000, lastSeen: 10 });
  });
});

describe('exposure slider', () => {
  it('maps a log scale both ways', () => {
    expect(sliderToTime(0, 1, 10000)).toBeCloseTo(1, 6);
    expect(sliderToTime(1000, 1, 10000)).toBeCloseTo(10000, 3);
    expect(sliderToTime(500, 1, 10000)).toBeCloseTo(100, 3);
    expect(timeToSlider(100, 1, 10000)).toBe(500);
    expect(timeToSlider(sliderToTime(321, 3, 2047), 3, 2047)).toBe(321);
  });
  it('formats 100 µs units as milliseconds', () => {
    expect(formatExposure(4)).toBe('0.4 ms');
    expect(formatExposure(333)).toBe('33 ms');
  });
});
