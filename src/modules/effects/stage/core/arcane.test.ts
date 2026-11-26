import { describe, expect, it } from 'vitest';
import type { Point } from '../../../../contracts';
import {
  addStar, Arcana, BIG_BUCKET, bucketFor, CACHE_SIZE, CAST_CIRCLE, castColor, type CastCircle, CIRCLE_GAP_MS, circleFor, constructBrightness,
  ConstructLayer, emblemLike, FrameCache, glyph, hashString, MAX_CIRCLES, prewarmCircles, restingTurn, sidesFor, starStep,
} from './arcane';
import { isColor } from './color';
import { View } from './view';

/** Records path calls. */
function recorder() {
  const calls: string[] = [];
  return {
    calls,
    moveTo: () => calls.push('M'),
    lineTo: () => calls.push('L'),
    arc: () => calls.push('A'),
  };
}

describe('the invented script', () => {
  it('draws the same glyph for the same seed, inside its box', () => {
    for (let seed = 0; seed < 200; seed++) {
      const g = glyph(seed);
      expect(glyph(seed)).toEqual(g);
      expect(g.length).toBeGreaterThanOrEqual(2);
      expect(g.length).toBeLessThanOrEqual(8);
      for (const st of g) {
        const xs = st.k === 'line' ? [st.x0, st.x1] : [st.x];
        const ys = st.k === 'line' ? [st.y0, st.y1] : [st.y];
        for (const v of [...xs, ...ys]) expect(Math.abs(v)).toBeLessThanOrEqual(0.56);
      }
    }
  });

  it('has many different glyphs', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 40; seed++) seen.add(JSON.stringify(glyph(seed)));
    expect(seen.size).toBeGreaterThan(30);
  });

  it('gives every spell a stable seed and a star of 7, 8, 9, 10 or 11 points drawn as one unbroken line', () => {
    expect(hashString('protego')).toBe(hashString('protego'));
    expect(hashString('protego')).not.toBe(hashString('stupefy'));
    const seen = new Set<number>();
    for (let s = 0; s < 200; s++) {
      const n = sidesFor(s);
      seen.add(n);
      // Never five or six points (in a ring, a pentacle or a hexagram), and never a compound of
      // polygons (overlapping triangles in a ring could read as another work's emblem): one moveTo,
      // one line round.
      const r = recorder();
      addStar(r, n, starStep(n), 1, 0);
      expect(r.calls.filter((c) => c === 'M')).toHaveLength(1);
      expect(starStep(n)).toBeGreaterThan(1);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([7, 8, 9, 10, 11]);
  });

  it('never writes a bare cross: a staff with one bar across it has the bar on one side only', () => {
    let bare = 0, oneSided = 0;
    for (let seed = 0; seed < 4000; seed++) {
      const g = glyph(seed);
      const [stem, bar] = g;
      if (g.length !== 2 || stem.k !== 'line' || stem.x0 !== 0 || stem.x1 !== 0 || bar.k !== 'line' || bar.y0 !== bar.y1) continue;
      if (bar.x0 < 0 && bar.x1 > 0) bare++;
      else oneSided++;
    }
    expect(bare).toBe(0);
    expect(oneSided).toBeGreaterThan(20);
  });
});

describe('star polygons', () => {
  it('draws {5/2} as one closed line, and {6/2} as two triangles', () => {
    const a = recorder();
    addStar(a, 5, 2, 1, 0);
    expect(a.calls.join('')).toBe('MLLLLL');
    const b = recorder();
    addStar(b, 6, 2, 1, 0);
    expect(b.calls.join('')).toBe('MLLLMLLL');
  });
});

describe('the circle round a cast', () => {
  it('centres on the shape and reaches past it, within limits', () => {
    const c = circleFor([[0.4, 0.3], [0.6, 0.3], [0.5, 0.6]], 16 / 9)!;
    expect(c.x).toBeCloseTo(0.5, 6);
    expect(c.y).toBeCloseTo(0.45, 6);
    expect(c.radius).toBeGreaterThan(0.18);
    expect(c.radius).toBeLessThanOrEqual(CAST_CIRCLE.maxRadius);
    expect(circleFor([[0.5, 0.5]], 16 / 9)!.radius).toBe(CAST_CIRCLE.minRadius);
    expect(circleFor([[0, 0], [1, 1]], 16 / 9)!.radius).toBe(CAST_CIRCLE.maxRadius);
    expect(circleFor([], 16 / 9)).toBeNull();
  });

  it('takes the first color the steps name, else its primitive\'s, else the ink\'s gold', () => {
    expect(castColor([{ use: 'bolt.cast', color: '#FF4436' }, { use: 'light.flash', color: '#FF3B30' }], isColor)).toBe('#FF4436');
    expect(castColor([{ use: 'prop.pull' }, { use: 'shield.dome' }], isColor)).toBe('#BFE3FF');
    expect(castColor([{ use: 'prop.levitate' }, { use: 'particles.burst', color: 'nonsense' }], isColor)).toBe('#FFD27E');
    expect(castColor(undefined, isColor)).toBe('#FFD27E');
  });

  it('keeps saturated reds dimmer, as red bolts are', () => {
    expect(constructBrightness('#FF2A2A')).toBeLessThan(1);
    expect(constructBrightness('#E0313F')).toBeLessThan(1);
    expect(constructBrightness('#FFD27E')).toBe(1);
    expect(constructBrightness('#3DFF6E')).toBe(1);
  });

  it('lasts its time, sheds its motes once as it fades, then goes', () => {
    const layer = new ConstructLayer();
    const motes: number[] = [];
    const sink = { spawn: (s: { count: number }) => motes.push(s.count) };
    const c = layer.cast('c1', [[0.4, 0.3], [0.6, 0.3], [0.5, 0.6]], '#FFD27E', 'incendio', 1000, 16 / 9, false)!;
    // The same spell's circle has the same runes, wherever and however big it is drawn.
    expect(c.seed).toBe(new ConstructLayer().cast('c2', [[0.4, 0.3], [0.6, 0.5]], '#FFD27E', 'incendio', 1000, 16 / 9, false)!.seed);
    expect(layer.animating()).toBe(true);
    layer.update(1000 + CAST_CIRCLE.holdMs - 1, 16 / 9, sink, (n) => n);
    expect(motes).toEqual([]);
    layer.update(1000 + CAST_CIRCLE.holdMs, 16 / 9, sink, (n) => Math.round(n / 4));
    layer.update(1000 + CAST_CIRCLE.holdMs + 50, 16 / 9, sink, (n) => n);
    expect(motes.length).toBe(4);
    layer.update(1000 + c.total, 16 / 9, sink, (n) => n);
    expect(layer.circles).toEqual([]);
    expect(layer.animating()).toBe(false);
  });

  it('lights circles no closer together than CIRCLE_GAP_MS, no more than MAX_CIRCLES at once, and never drops one early', () => {
    // Casts ten a second, Lumos and Nox in turn, at one spot: the circles' light must never flash.
    const layer = new ConstructLayer();
    const lit: CastCircle[] = [];
    for (let t = 0; t <= 6000; t += 100) {
      layer.update(t, 16 / 9, null, (n) => n);
      const c = layer.cast(`k${t}`, [[0.5, 0.4], [0.5, 0.6]], '#FFE7B3', t % 200 ? 'nox' : 'lumos', t, 16 / 9, false);
      if (c) lit.push(c);
      expect(layer.circles.filter((k) => !k.done(t)).length).toBeLessThanOrEqual(MAX_CIRCLES);
      // A lit circle stays until its time is up: none vanishes in one frame.
      for (const k of lit) if (t - k.born < k.total) expect(layer.circles).toContain(k);
    }
    for (let i = 1; i < lit.length; i++) expect(lit[i].born - lit[i - 1].born).toBeGreaterThanOrEqual(CIRCLE_GAP_MS);
    expect(lit.length).toBeGreaterThan(8);
    // An ordinary pace lights every cast's circle.
    const calm = new ConstructLayer();
    for (let i = 0; i < 6; i++) expect(calm.cast(`c${i}`, [[0.5, 0.5]], '#FFD27E', 'lumos', i * 700, 16 / 9, false)).not.toBeNull();
  });

  it('lights no circle round a shape that would make an emblem in a ring: a closed star, a lightning bolt', () => {
    const star: Point[] = [];
    for (let i = 0; i <= 5; i++) {
      const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
      star.push([0.5 + 0.3 * Math.cos(a), 0.5 + 0.3 * Math.sin(a)]);
    }
    const bolt: Point[] = [[0.9, 0.05], [0.16, 0.44], [0.84, 0.56], [0.1, 0.95]];
    expect(emblemLike(star, 1)).toBe(true);
    expect(emblemLike(bolt, 1)).toBe(true);
    // Shapes that stay: a circle, a triangle, a check mark, a W, a figure-eight, an X in one stroke.
    const circle: Point[] = Array.from({ length: 25 }, (_, i) => [0.5 + 0.3 * Math.cos((i / 24) * Math.PI * 2), 0.5 + 0.3 * Math.sin((i / 24) * Math.PI * 2)]);
    const others: Point[][] = [
      circle,
      [[0.8, 0.8], [0.5, 0.2], [0.2, 0.8], [0.8, 0.8]],
      [[0.2, 0.5], [0.4, 0.75], [0.85, 0.2]],
      [[0.1, 0.1], [0.3, 0.9], [0.5, 0.3], [0.7, 0.9], [0.9, 0.1]],
      Array.from({ length: 41 }, (_, i) => [0.5 + 0.3 * Math.sin((i / 40) * Math.PI * 2), 0.5 + 0.2 * Math.sin((i / 40) * Math.PI * 4)] as Point),
      [[0.2, 0.2], [0.8, 0.8], [0.8, 0.2], [0.2, 0.8]],
    ];
    for (const s of others) expect(emblemLike(s, 1)).toBe(false);
    const layer = new ConstructLayer();
    expect(layer.cast('s', star, '#FF2A2A', 'crucio', 0, 1, false)).toBeNull();
    expect(layer.cast('b', bolt, '#3DFF6E', 'avada-kedavra', 1000, 1, false)).toBeNull();
    expect(layer.cast('c', circle, '#BFE3FF', 'protego', 2000, 1, false)).not.toBeNull();
  });

  it('holds a circle still when it lights over one still fully lit: only one turns there at a time', () => {
    const layer = new ConstructLayer();
    const first = layer.cast('a', [[0.5, 0.4], [0.5, 0.6]], '#FFE7B3', 'lumos', 0, 16 / 9, false)!;
    expect(first.still).toBe(false);
    // Over it, while it shows: still (it only fades in and out, as under reduced motion).
    const over = layer.cast('b', [[0.52, 0.42], [0.52, 0.62]], '#FFD27E', 'nox', 600, 16 / 9, false)!;
    expect(over.still).toBe(true);
    // Far from it (no overlap): turns as usual.
    const apart = layer.cast('c', [[0.05, 0.1], [0.05, 0.15]], '#FFD27E', 'accio', 1200, 16 / 9, false)!;
    expect(apart.still).toBe(false);
    // While casts keep coming fast, a still one keeps the next one still too (STILL_HOLD_MS); at a
    // steadier pace the next one turns again: every other one turns at about one a second.
    const fast = new ConstructLayer();
    fast.cast('a', [[0.5, 0.4], [0.5, 0.6]], '#FFE7B3', 'lumos', 0, 16 / 9, false);
    expect(fast.cast('b', [[0.5, 0.4], [0.5, 0.6]], '#FFD27E', 'nox', 600, 16 / 9, false)!.still).toBe(true);
    expect(fast.cast('c', [[0.5, 0.4], [0.5, 0.6]], '#FFE7B3', 'lumos', 1200, 16 / 9, false)!.still).toBe(true);
    const steady = new ConstructLayer();
    const turns: boolean[] = [];
    for (let i = 0; i < 6; i++) turns.push(!steady.cast(`s${i}`, [[0.5, 0.4], [0.5, 0.6]], '#FFE7B3', i % 2 ? 'nox' : 'lumos', i * 1000, 16 / 9, false)!.still);
    expect(turns).toEqual([true, false, true, false, true, false]);
    // Over one that is only fading (past its hold): turns, as Nox does a second or two after Lumos.
    const fading = new ConstructLayer();
    fading.cast('a', [[0.5, 0.4], [0.5, 0.6]], '#FFE7B3', 'lumos', 0, 16 / 9, false);
    expect(fading.cast('b', [[0.5, 0.4], [0.5, 0.6]], '#FFD27E', 'nox', CAST_CIRCLE.holdMs + 1, 16 / 9, false)!.still).toBe(false);
    // Once the place is clear again, a circle there turns again.
    const later = new ConstructLayer();
    const one = later.cast('a', [[0.5, 0.4], [0.5, 0.6]], '#FFE7B3', 'lumos', 0, 16 / 9, false)!;
    later.update(one.total + 1, 16 / 9, null, (n) => n);
    expect(later.cast('b', [[0.5, 0.4], [0.5, 0.6]], '#FFE7B3', 'lumos', one.total + 1, 16 / 9, false)!.still).toBe(false);
  });

  it('draws nothing where nothing can be painted (Node), without failing', () => {
    const layer = new ConstructLayer();
    layer.cast('c1', [[0.4, 0.3], [0.6, 0.3]], '#FFD27E', 'lumos', 0, 16 / 9, false);
    const view = new View();
    view.update(1280, 720, 1, 16 / 9);
    let images = 0;
    const ctx = {
      globalAlpha: 1, globalCompositeOperation: 'source-over',
      save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, beginPath() {}, moveTo() {}, arc() {}, closePath() {}, clip() {},
      drawImage() { images++; },
    } as unknown as CanvasRenderingContext2D;
    for (const t of [0, 200, 600, 1500]) layer.draw(ctx, view, t);
    expect(images).toBe(0);
  });
});

describe('construct details', () => {
  it('keeps every layer this frame or the last one used, however many, and drops the least recently used of the rest', () => {
    const cache = new FrameCache<number>(3);
    cache.beginFrame();
    // One frame that needs five: all are kept, rather than each dropping the next one drawn.
    for (const k of ['a', 'b', 'c', 'd', 'e']) cache.set(k, 1);
    expect(cache.size).toBe(5);
    cache.beginFrame();
    for (const k of ['a', 'b', 'c', 'd', 'e']) expect(cache.get(k)).toBe(1);
    // Frames that need fewer: the cap holds again once the others are two frames old, the oldest
    // going first.
    cache.beginFrame();
    cache.get('e');
    cache.beginFrame();
    cache.get('e');
    cache.set('f', 2);
    expect(cache.size).toBe(3);
    expect(['d', 'e', 'f'].every((k) => cache.has(k))).toBe(true);
    expect(cache.has('a')).toBe(false);
    // Room for the layers of a few spells cast in turn.
    expect(CACHE_SIZE).toBeGreaterThanOrEqual(16);
  });

  it('never lets a frame that needs more than the cap drop a layer it is about to draw (no layer missing frame after frame)', () => {
    // Frames draw their layers in the same order and paint at most one missing layer each, as the
    // stage does (Arcana). A new layer that comes first in the order joins a full cache.
    const cache = new FrameCache<number>(3);
    const frame = (keys: string[]): number => {
      cache.beginFrame();
      let painted = false, missing = 0;
      for (const k of keys) {
        if (cache.get(k) !== undefined) continue;
        if (painted) missing++;
        else {
          painted = true;
          cache.set(k, 1);
        }
      }
      return missing;
    };
    for (let f = 0; f < 4; f++) frame(['b', 'c', 'd']);
    let missing = 0;
    for (let f = 0; f < 12; f++) missing += frame(['a', 'b', 'c', 'd']);
    expect(missing).toBe(0);
  });

  it('warms each kind and size of cast circle once, ahead, for the sizes the view may draw', () => {
    const a = new Arcana();
    a.warm('ring', 512);
    a.warm('ring', 512);
    a.warm('sigil', 256);
    expect(a.waiting).toBe(2);
    const v = new View();
    v.update(1280, 720, 1, 16 / 9);
    const b = new Arcana();
    prewarmCircles(b, v);
    // From the smallest circle to the largest: a few buckets of each, never all seven.
    expect(b.waiting).toBeGreaterThanOrEqual(4);
    expect(b.waiting).toBeLessThanOrEqual(10);
    b.unwant();
    expect(b.waiting).toBe(0);
  });

  it('paints at the size bucket at or above what is drawn: up to 1024, or 1536 for a mirror-sized layer', () => {
    expect(bucketFor(100)).toBe(128);
    expect(bucketFor(128)).toBe(128);
    expect(bucketFor(600)).toBe(768);
    expect(bucketFor(5000)).toBe(1024);
    expect(bucketFor(1300, BIG_BUCKET)).toBe(1536);
    expect(bucketFor(900, BIG_BUCKET)).toBe(1024);
    expect(bucketFor(5000, BIG_BUCKET)).toBe(1536);
  });

  it('finds the same layer at another size, to draw scaled while the new size waits its turn', () => {
    const cache = new FrameCache<string>(4);
    cache.beginFrame();
    cache.set('ring:5150:40:160:0.8:0.875:1:#d8e4ff:768', 'old');
    cache.beginFrame();
    expect(cache.sibling('ring:5150:40:160:0.8:0.875:1:#d8e4ff:1024')).toBe('old');
    expect(cache.sibling('ring:6260:28:112:0.79:0.87:0:#d8e4ff:1024')).toBeUndefined();
  });

  it('turns that come to rest: they slow and stop by their time, so a held construct holds still', () => {
    const rate = 0.2;
    let last = -1;
    for (let t = 0; t <= 20000; t += 250) {
      const a = restingTurn(t, rate, 4000);
      expect(a).toBeGreaterThanOrEqual(last);
      last = a;
    }
    const final = restingTurn(1e9, rate, 4000);
    expect(restingTurn(4000, rate, 4000)).toBeGreaterThan(0.94 * final);
    expect(final).toBeCloseTo((rate * 4000) / 3 / 1000, 6);
  });
});
