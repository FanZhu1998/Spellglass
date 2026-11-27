import { describe, expect, it } from 'vitest';
import { isSeated, isWholeView, SEATED_AREA, WHOLE_VIEW } from './play-area';

describe('seated play (Section 10.6)', () => {
  it('fits the play area to a seated reach: smaller, inside the view, and below the middle', () => {
    const a = SEATED_AREA;
    expect(a.w).toBeLessThan(1);
    expect(a.h).toBeLessThan(1);
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.y).toBeGreaterThanOrEqual(0);
    expect(a.x + a.w).toBeLessThanOrEqual(1);
    expect(a.y + a.h).toBeLessThanOrEqual(1);
    expect(a.x + a.w / 2).toBeCloseTo(0.5);
    expect(a.y + a.h / 2).toBeGreaterThan(0.5);
  });

  it('is on exactly while the seated box is the play area', () => {
    expect(isSeated({ ...SEATED_AREA })).toBe(true);
    // Wand tuning stores boxes rounded to 0.001.
    expect(isSeated({ x: 0.2, y: 0.35, w: 0.6, h: 0.6000001 })).toBe(true);
    expect(isSeated({ x: 0.21, y: 0.35, w: 0.6, h: 0.6 })).toBe(false);
    expect(isSeated({ ...WHOLE_VIEW })).toBe(false);
    expect(isSeated(null)).toBe(false);
  });

  it('tells the whole view, the default, from a box of the player’s own', () => {
    expect(isWholeView({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
    expect(isWholeView(undefined)).toBe(true);
    expect(isWholeView({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 })).toBe(false);
  });
});
