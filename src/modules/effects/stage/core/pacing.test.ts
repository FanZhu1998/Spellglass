import { describe, expect, it } from 'vitest';
import { AMBIENT_FPS, AMBIENT_FRAME_MS, drawThisFrame } from './pacing';

describe('drawThisFrame', () => {
  it('draws every frame while something is busy', () => {
    expect(drawThisFrame({ busy: true, newTip: false, sinceDraw: 0 })).toBe(true);
    expect(drawThisFrame({ busy: true, newTip: false, sinceDraw: 16.7 })).toBe(true);
  });

  it('draws on the first frame after a new tip', () => {
    expect(drawThisFrame({ busy: false, newTip: true, sinceDraw: 0 })).toBe(true);
    expect(drawThisFrame({ busy: false, newTip: true, sinceDraw: 16.7 })).toBe(true);
  });

  it('otherwise skips frames, drawing at least AMBIENT_FPS times a second', () => {
    expect(drawThisFrame({ busy: false, newTip: false, sinceDraw: 16.7 })).toBe(false);
    expect(drawThisFrame({ busy: false, newTip: false, sinceDraw: 1000 / AMBIENT_FPS })).toBe(true);
    expect(drawThisFrame({ busy: false, newTip: false, sinceDraw: 1000 })).toBe(true);
  });

  it('at 60 Hz the second frame after a drawing draws, at 120 Hz the fourth', () => {
    // Refreshes come a little early or late; the slack keeps the ambient rate at 30, not 20.
    expect(drawThisFrame({ busy: false, newTip: false, sinceDraw: 2 * 16.4 })).toBe(true);
    expect(drawThisFrame({ busy: false, newTip: false, sinceDraw: 3 * 8.2 })).toBe(false);
    expect(drawThisFrame({ busy: false, newTip: false, sinceDraw: 4 * 8.2 })).toBe(true);
    expect(AMBIENT_FRAME_MS).toBeLessThan(1000 / AMBIENT_FPS);
    expect(AMBIENT_FRAME_MS).toBeGreaterThan(2 * 8.4);
  });

  it('draws when the time since the last drawing is unknown (no drawing yet)', () => {
    expect(drawThisFrame({ busy: false, newTip: false, sinceDraw: Infinity })).toBe(true);
    expect(drawThisFrame({ busy: false, newTip: false, sinceDraw: Number.NaN })).toBe(true);
  });
});
