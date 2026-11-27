import { describe, expect, it } from 'vitest';
import { casterAspect, casterSize, DEFAULT_ASPECT, eventTime, thinSamples, toCaster } from './mapping';

const element = { x: 100, y: 50, width: 800, height: 600 };

describe('toCaster', () => {
  it('uses the whole element until the stage has a surface', () => {
    expect(toCaster(100, 50, element, null)).toEqual([0, 0]);
    expect(toCaster(900, 650, element, null)).toEqual([1, 1]);
    expect(toCaster(500, 350, element, null)).toEqual([0.5, 0.5]);
  });

  it('maps through the letterboxed caster rectangle, with no x flip', () => {
    // A 16:9 camera in an 800 x 600 mirror: 450 px tall, 75 px bars above and below.
    const surface = { caster: { x: 0, y: 75, width: 800, height: 450 }, width: 800, height: 600 };
    expect(toCaster(100, 125, element, surface)).toEqual([0, 0]);
    expect(toCaster(900, 575, element, surface)).toEqual([1, 1]);
    const [x, y] = toCaster(300, 350, element, surface);
    expect(x).toBeCloseTo(0.25, 10); // left of centre stays left: the pointer already lives in the mirror view
    expect(y).toBeCloseTo(0.5, 10);
  });

  it('scales client px into the stage px when the element is shown at another size', () => {
    // The stage measured 400 x 300 (a CSS transform shows it twice as large).
    const surface = { caster: { x: 0, y: 37.5, width: 400, height: 225 }, width: 400, height: 300 };
    expect(toCaster(500, 350, element, surface)).toEqual([0.5, 0.5]);
  });

  it('lets points fall outside 0..1 a little, and holds them to the session bounds', () => {
    expect(toCaster(0, 50, element, null)[0]).toBeCloseTo(-0.125, 10);
    expect(toCaster(-10000, 10000, element, null)).toEqual([-1, 2]);
  });

  it('survives an element with no size', () => {
    expect(toCaster(10, 10, { x: 0, y: 0, width: 0, height: 0 }, null)).toEqual([0.5, 0.5]);
  });
});

describe('casterAspect and casterSize', () => {
  it('prefers the caster rectangle, then the element, then 16:9', () => {
    const surface = { caster: { x: 0, y: 75, width: 800, height: 450 }, width: 800, height: 600 };
    expect(casterAspect(element, surface)).toBeCloseTo(16 / 9, 10);
    expect(casterAspect(element, null)).toBeCloseTo(4 / 3, 10);
    expect(casterAspect(null, null)).toBe(DEFAULT_ASPECT);
    expect(casterAspect({ x: 0, y: 0, width: 0, height: 0 }, { caster: { x: 0, y: 0, width: 0, height: 0 }, width: 0, height: 0 })).toBe(DEFAULT_ASPECT);
    expect(casterSize(element, surface)).toEqual({ width: 800, height: 450 });
    expect(casterSize(element, null)).toEqual({ width: 800, height: 600 });
    expect(casterSize(null, null)).toBeNull();
  });
});

describe('eventTime', () => {
  it('keeps a performance.now() stamp and replaces implausible ones with now', () => {
    expect(eventTime(1234.5, 1240)).toBe(1234.5);
    expect(eventTime(1.7e12, 1240)).toBe(1240); // epoch milliseconds
    expect(eventTime(0, 1240)).toBe(1240);
    expect(eventTime(Number.NaN, 1240)).toBe(1240);
  });
});

describe('thinSamples', () => {
  it('keeps samples at least 8 ms apart and always the last one', () => {
    // A 1000 Hz mouse: 16 coalesced samples in one frame.
    const times = Array.from({ length: 16 }, (_, i) => 100 + i);
    expect(thinSamples(times, 99)).toEqual([7, 15]);
    expect(thinSamples(times, null)).toEqual([0, 8, 15]);
  });

  it('keeps every sample of an ordinary 60 Hz stream', () => {
    expect(thinSamples([100], 84)).toEqual([0]);
    expect(thinSamples([100, 116.7, 133.3], 83.3)).toEqual([0, 1, 2]);
  });
});
