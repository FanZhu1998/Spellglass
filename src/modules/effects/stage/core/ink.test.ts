import { describe, expect, it } from 'vitest';
import { findCorners } from './ink';

/** n points evenly along a polyline through `corners` (caster space). */
function along(corners: [number, number][], n: number): { x: number[]; y: number[] } {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < corners.length; i++) {
    const d = Math.hypot(corners[i][0] - corners[i - 1][0], corners[i][1] - corners[i - 1][1]);
    lengths.push(d);
    total += d;
  }
  const x: number[] = [], y: number[] = [];
  for (let k = 0; k < n; k++) {
    let at = (k / (n - 1)) * total, i = 0;
    while (i < lengths.length - 1 && at > lengths[i]) at -= lengths[i++];
    const t = Math.min(1, at / lengths[i]);
    x.push(corners[i][0] + (corners[i + 1][0] - corners[i][0]) * t);
    y.push(corners[i][1] + (corners[i + 1][1] - corners[i][1]) * t);
  }
  return { x, y };
}

describe('the settled shape\'s sharp turns (findCorners)', () => {
  it('finds the bend of a check mark, once, at the bend', () => {
    const { x, y } = along([[0.3, 0.4], [0.4, 0.6], [0.6, 0.2]], 96);
    const found = findCorners(x, y, 96, 1);
    expect(found).toHaveLength(1);
    expect(Math.hypot(x[found[0]] - 0.4, y[found[0]] - 0.6)).toBeLessThan(0.02);
  });

  it('finds each corner of a triangle and none on a circle', () => {
    const tri = along([[0.5, 0.2], [0.7, 0.6], [0.3, 0.6], [0.5, 0.2]], 96);
    expect(findCorners(tri.x, tri.y, 96, 1)).toHaveLength(2);
    const cx: number[] = [], cy: number[] = [];
    for (let i = 0; i < 96; i++) {
      cx.push(0.5 + 0.2 * Math.cos((i / 95) * Math.PI * 2));
      cy.push(0.5 + 0.2 * Math.sin((i / 95) * Math.PI * 2));
    }
    expect(findCorners(cx, cy, 96, 1)).toEqual([]);
  });

  it('marks at most six, and judges angles in the frame\'s true proportions', () => {
    const zig: [number, number][] = [];
    for (let i = 0; i < 12; i++) zig.push([0.1 + i * 0.07, i % 2 ? 0.3 : 0.6]);
    const z = along(zig, 96);
    expect(findCorners(z.x, z.y, 96, 1).length).toBeLessThanOrEqual(6);
    // A shallow bend in caster x stays shallow on a wide frame: no corner.
    const flat = along([[0.3, 0.5], [0.5, 0.45], [0.7, 0.5]], 96);
    expect(findCorners(flat.x, flat.y, 96, 16 / 9)).toEqual([]);
  });
});
