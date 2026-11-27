// The glass is painted once per mirror size, so what matters is that it never makes a call a browser
// would throw on or draw wrong, that it comes out the same every time (no patch moves between visits:
// Section 10.6 allows no ambient motion), that its desilvering keeps to the edges, and that the
// backdrop, the clips and the reflection's grade all come from the one glass.

import { describe, expect, it } from 'vitest';
import { recorder } from '../props/testing';
import {
  GLASS_BASE, REFLECTION_GRADE, desilverField, fillGlassBase, glassBackdropCss, glassBaseGradient, paintGlass, reflectionFilter,
  type GlassCanvas,
} from './glass';

/** The recorder's canvases have no pixels; this one hands out ImageData-like buffers, so the
 *  desilvering is built and drawn as in a browser. */
function pixelCanvas(rec: ReturnType<typeof recorder>, made: { w: number; h: number }[]): GlassCanvas {
  return (w, h) => {
    const s = rec.factory(w, h);
    if (!s) return null;
    made.push({ w, h });
    (s.ctx as unknown as { createImageData: unknown }).createImageData = (iw: number, ih: number) => ({ width: iw, height: ih, data: new Uint8ClampedArray(iw * ih * 4) });
    return s;
  };
}

/** Mean alpha (0..1) of the field's cells inside a box given in fractions of the glass. */
function alphaIn(f: ReturnType<typeof desilverField>, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0;
  let n = 0;
  for (let j = Math.floor(y0 * f.gh); j < Math.ceil(y1 * f.gh); j++) {
    for (let i = Math.floor(x0 * f.gw); i < Math.ceil(x1 * f.gw); i++) {
      sum += f.rgba[(j * f.gw + i) * 4 + 3];
      n++;
    }
  }
  return n ? sum / n / 255 : 0;
}

describe('the glass', () => {
  it('paints the desilvering, the vignette and the sheen without a single bad call', () => {
    const rec = recorder();
    const made: { w: number; h: number }[] = [];
    paintGlass(rec.layers.shade, 1600, 900, pixelCanvas(rec, made));
    expect(rec.problems).toEqual([]);
    // The patches are one small canvas, drawn smoothed up: a handful of calls, whatever the size.
    expect(made).toHaveLength(1);
    expect(made[0].w * made[0].h).toBeLessThan((1600 * 900) / 8);
    expect(rec.calls).toBeGreaterThan(5);
    expect(rec.calls).toBeLessThan(40);
    expect(rec.depth(rec.layers.shade)).toBe(0);
  });

  it('puts every patch in the same place each time it is painted', () => {
    const a = desilverField(1280, 720);
    const b = desilverField(1280, 720);
    expect(b.rgba).toEqual(a.rgba);
    const ra = recorder();
    const rb = recorder();
    paintGlass(ra.layers.shade, 1280, 720);
    paintGlass(rb.layers.shade, 1280, 720);
    expect(rb.calls).toBe(ra.calls);
  });

  it('desilvers from the corners and edges and leaves the middle clear', () => {
    const f = desilverField(1280, 720);
    const corners = [
      alphaIn(f, 0, 0, 0.06, 0.1), alphaIn(f, 0.94, 0, 1, 0.1), alphaIn(f, 0, 0.9, 0.06, 1), alphaIn(f, 0.94, 0.9, 1, 1),
    ];
    for (const a of corners) expect(a).toBeGreaterThan(0.12);
    expect(alphaIn(f, 0.25, 0.25, 0.75, 0.75)).toBe(0);
    // Mottled, not a flat stain: both fog and the dark of the backing are there.
    let fog = 0;
    let dark = 0;
    for (let k = 0; k < f.rgba.length; k += 4) {
      if (f.rgba[k + 3] < 40) continue;
      if (f.rgba[k] > 70) fog++;
      if (f.rgba[k] < 40) dark++;
    }
    expect(fog).toBeGreaterThan(50);
    expect(dark).toBeGreaterThan(50);
  });

  it('keeps the same patches at any size, scaled with the glass', () => {
    const small = desilverField(640, 360);
    const large = desilverField(2560, 1440);
    expect(large.gw).toBe(small.gw);
    expect(large.gh).toBe(small.gh);
    expect(alphaIn(large, 0, 0, 0.2, 0.3)).toBeCloseTo(alphaIn(small, 0, 0, 0.2, 0.3), 1);
  });

  it('paints nothing for a mirror that is not laid out yet', () => {
    const rec = recorder();
    paintGlass(rec.layers.shade, 0, 0);
    paintGlass(rec.layers.shade, Number.NaN, 400);
    expect(rec.calls).toBe(0);
    expect(rec.problems).toEqual([]);
  });

  it('copes with tall and tiny mirrors', () => {
    const rec = recorder();
    const made: { w: number; h: number }[] = [];
    paintGlass(rec.layers.shade, 360, 780, pixelCanvas(rec, made));
    paintGlass(rec.layers.shade, 12, 7, pixelCanvas(rec, made));
    paintGlass(rec.layers.shade, 1, 1, pixelCanvas(rec, made));
    expect(rec.problems).toEqual([]);
    const f = desilverField(3, 2);
    expect(f.gw * f.gh * 4).toBe(f.rgba.length);
  });
});

describe('the glass everywhere it shows', () => {
  it('gives the backdrop the glass tone, never the old navy', () => {
    const css = glassBackdropCss();
    expect(css).toBe('radial-gradient(120% 90% at 50% 38%, #26252B 0%, #17161C 55%, #0B0A10 100%)');
    expect(css.toLowerCase()).not.toContain('#1c2236');
  });

  it('fills a clip with the same tone, the gradient stretched onto the ellipse', () => {
    const rec = recorder();
    const ctx = rec.layers.shade;
    const g = glassBaseGradient(ctx);
    fillGlassBase(ctx, g, 1920, 1080);
    fillGlassBase(ctx, g, 0, 0);
    expect(rec.problems).toEqual([]);
    expect(rec.calls).toBe(1);
    expect(GLASS_BASE.stops.length).toBeGreaterThan(1);
  });

  it('grades the reflection like old silver, after any exposure lift, and not in high contrast', () => {
    expect(reflectionFilter('', false)).toBe(REFLECTION_GRADE);
    expect(reflectionFilter('', true)).toBe('');
    expect(reflectionFilter('brightness(2.00)', false)).toBe(`brightness(2.00) ${REFLECTION_GRADE}`);
    expect(reflectionFilter('brightness(2.00)', true)).toBe('brightness(2.00)');
    expect(REFLECTION_GRADE).toMatch(/saturate\(0\.\d+\)/);
  });
});
