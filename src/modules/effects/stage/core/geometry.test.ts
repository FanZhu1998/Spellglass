import { describe, expect, it } from 'vitest';
import type { Point, SpellbookEntry, SpellCast } from '../../../../contracts';
import { geometry } from '../../../../kernel';
import { CASTER_ANCHOR, resolveAnchor, type AnchorContext } from './anchors';
import {
  alignForMorph, bestCyclicShift, guidePath, GUIDE_BOX_SIZE, isClosed, morphInto, pointAlong, resampleSamples, samplesFromPoints,
  settleTarget, shiftClosed, toCurrentAspect, VOICE_SKETCH_SIZE,
} from './morph';
import { paceFraction, GUIDE_REST_START_MS } from './practice';
import { cleanReplayPoints, pointAtIndex, replayIndex } from './replay';
import { Scheduler } from './scheduler';
import { replayTimeAt } from './stage';
import { fitCaster, pixelRatioFor, View } from './view';
import { exposureFilter } from './dom';

const ctx = (over: Partial<AnchorContext> = {}): AnchorContext => ({ aim: { x: 0.3, y: 0.4 }, tip: null, lastTip: null, target: null, ...over });

describe('anchors (contracts/packs.ts Anchor)', () => {
  it('tip: the live tip, else its last known position, else aim', () => {
    expect(resolveAnchor('tip', ctx({ tip: { x: 0.6, y: 0.2 }, lastTip: { x: 0.1, y: 0.1 } }))).toEqual({ x: 0.6, y: 0.2 });
    expect(resolveAnchor('tip', ctx({ lastTip: { x: 0.1, y: 0.1 } }))).toEqual({ x: 0.1, y: 0.1 });
    expect(resolveAnchor('tip', ctx())).toEqual({ x: 0.3, y: 0.4 });
  });

  it('target: the prop, else aim; center and caster are fixed', () => {
    expect(resolveAnchor('target', ctx({ target: { x: 0.88, y: 0.8 } }))).toEqual({ x: 0.88, y: 0.8 });
    expect(resolveAnchor('target', ctx())).toEqual({ x: 0.3, y: 0.4 });
    expect(resolveAnchor('center', ctx())).toEqual({ x: 0.5, y: 0.5 });
    expect(resolveAnchor('caster', ctx())).toEqual({ x: CASTER_ANCHOR.x, y: CASTER_ANCHOR.y });
    expect(CASTER_ANCHOR).toEqual({ x: 0.5, y: 0.38 });
  });

  it('an unknown or missing anchor uses the fallback, and never hands out shared objects', () => {
    expect(resolveAnchor('elsewhere', ctx({ tip: { x: 0.7, y: 0.7 } }), 'tip')).toEqual({ x: 0.7, y: 0.7 });
    expect(resolveAnchor(undefined, ctx(), 'center')).toEqual({ x: 0.5, y: 0.5 });
    const c = ctx();
    const a = resolveAnchor('aim', c);
    a.x = 99;
    expect(c.aim.x).toBe(0.3);
  });
});

describe('scheduler', () => {
  it('runs due tasks in time order, ties in the order added, and honours cancel', () => {
    const s = new Scheduler();
    const log: string[] = [];
    s.at(10, () => log.push('b'));
    s.at(5, () => log.push('a'));
    s.at(10, () => log.push('c'));
    const cancel = s.at(7, () => log.push('x'));
    cancel();
    expect(s.poll(4)).toBe(0);
    expect(s.next()).toBe(5);
    s.poll(10);
    expect(log).toEqual(['a', 'b', 'c']);
    expect(s.size).toBe(0);
  });

  it('runs tasks that due tasks schedule for now', () => {
    const s = new Scheduler();
    const log: string[] = [];
    s.at(1, () => {
      log.push('first');
      s.at(1, () => log.push('chained'));
    });
    s.poll(1);
    expect(log).toEqual(['first', 'chained']);
  });
});

describe('view: caster space onto the canvases', () => {
  it('letterboxes like object-fit: contain', () => {
    expect(fitCaster(1600, 900, 16 / 9)).toEqual({ x: 0, y: 0, width: 1600, height: 900 });
    const pillar = fitCaster(1600, 900, 4 / 3);
    expect(pillar.height).toBe(900);
    expect(pillar.width).toBe(1200);
    expect(pillar.x).toBe(200);
    const letter = fitCaster(1200, 900, 16 / 9);
    expect(letter.width).toBe(1200);
    expect(letter.y).toBeCloseTo((900 - 675) / 2);
  });

  it('maps caster space through the caster rectangle, and back', () => {
    const v = new View();
    v.update(1600, 900, 2, 4 / 3);
    expect(v.toPx(0, 0)).toEqual([400, 0]);
    expect(v.toPx(1, 1)).toEqual([2800, 1800]);
    const [x, y] = v.fromPx(...v.toPx(0.25, 0.75));
    expect(x).toBeCloseTo(0.25);
    expect(y).toBeCloseTo(0.75);
    expect(v.size(0.1)).toBe(180);
    expect(v.aspect).toBeCloseTo(16 / 9);
    expect(v.casterAspect).toBeCloseTo(4 / 3);
  });

  it('uses the whole mirror when there is no camera', () => {
    const v = new View();
    v.update(1000, 500, 1, null);
    expect(v.caster).toEqual({ x: 0, y: 0, width: 1000, height: 500 });
    expect(v.casterAspect).toBe(2);
  });

  it('lifts the reflection only while a short manual exposure darkens the room', () => {
    expect(exposureFilter(undefined)).toBe('');
    expect(exposureFilter({ mode: 'continuous', time: 20 })).toBe('');
    // 2 ms instead of 33 ms: about 16 times less light, lifted by its square root (capped at 4).
    expect(exposureFilter({ mode: 'manual', time: 20 })).toMatch(/^brightness\(4\.00\)/);
    expect(exposureFilter({ mode: 'manual', time: 83 })).toMatch(/^brightness\(2\.00\)/);
    // A normal manual exposure needs no help.
    expect(exposureFilter({ mode: 'manual', time: 333 })).toBe('');
    // Compensation in stops: -2 EV is a quarter of the light, lifted by 2.
    expect(exposureFilter({ mode: 'manual', compensation: -2 })).toMatch(/^brightness\(2\.00\)/);
    expect(exposureFilter({ mode: 'manual' })).toMatch(/^brightness\(2\.50\)/);
  });

  it('picks the pixel ratio from stage.quality', () => {
    expect(pixelRatioFor('high', 1)).toBe(2);
    expect(pixelRatioFor('low', 3)).toBe(1);
    expect(pixelRatioFor('auto', 3)).toBe(1.5);
    expect(pixelRatioFor('auto', 1)).toBe(1);
    expect(pixelRatioFor('auto', Number.NaN)).toBe(1);
  });
});

function entry(gesture: SpellbookEntry['spell']['gesture'], templates: Point[][] = []): SpellbookEntry {
  return {
    spell: { id: 's', incantation: 'S', gesture, effect: { steps: [] } }, packId: 'p', packTitle: 'P', available: true, status: 'open',
    enabled: true, overridden: false, gestureSource: 'pack', gestureKey: 'k', mirrored: false, templates, lasts: null, skippedSteps: [], accepted: 0,
  };
}

const cast = (over: Partial<SpellCast> = {}): SpellCast => ({ id: 'c1', spellId: 's', t: 0, via: 'gesture', quality: 1, power: 0.5, aim: { x: 0.5, y: 0.5 }, ...over });

const circle = (n: number, start = 0): Point[] =>
  Array.from({ length: n }, (_, i) => {
    const a = start + (i / (n - 1)) * Math.PI * 2;
    return [0.5 + 0.4 * Math.cos(a), 0.5 + 0.4 * Math.sin(a)] as Point;
  });

describe('the settle (Section 10.1 step 2)', () => {
  it('resamples evenly along the path, measuring isotropically', () => {
    const s = resampleSamples([0, 1], [0, 0], [1, 3], 5, 1);
    expect(Array.from(s.x)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(Array.from(s.w)).toEqual([1, 1.5, 2, 2.5, 3]);
    const one = resampleSamples([0.2], [0.3], null, 3, 1);
    expect(Array.from(one.x)).toEqual([0.2, 0.2, 0.2].map((v) => Math.fround(v)));
  });

  it('interpolates between aligned shapes', () => {
    const a = samplesFromPoints([[0, 0], [1, 0]], 3, 1);
    const b = samplesFromPoints([[0, 1], [1, 1]], 3, 1);
    const out = samplesFromPoints([[0, 0], [0, 0]], 3, 1);
    morphInto(a, b, 0.5, out);
    expect(Array.from(out.y)).toEqual([0.5, 0.5, 0.5]);
    morphInto(a, b, 2, out);
    expect(Array.from(out.y)).toEqual([1, 1, 1]);
  });

  it('starts a closed target where the stroke started, so the morph does not sweep across the shape', () => {
    const stroke = samplesFromPoints(circle(65, Math.PI / 2), 65, 1);
    const target = samplesFromPoints(circle(65, 0), 65, 1);
    expect(isClosed(target, 1)).toBe(true);
    const shift = bestCyclicShift(stroke, target, 1);
    expect(shift).toBe(16);
    const aligned = alignForMorph(stroke, target, 1);
    expect(aligned.x[0]).toBeCloseTo(stroke.x[0], 2);
    expect(aligned.y[0]).toBeCloseTo(stroke.y[0], 2);
    // Open shapes are left alone.
    const line = samplesFromPoints([[0, 0], [1, 0]], 9, 1);
    expect(alignForMorph(line, line, 1)).toBe(line);
    expect(shiftClosed(line, 0)).toBe(line);
  });

  it('uses detail.aligned when the engine sends it', () => {
    const aligned: Point[] = [[0.1, 0.1], [0.2, 0.2]];
    const c = cast({ detail: { spellId: 's', score: 1, template: 'seed:0', pathIndex: 0, deviation: [], aligned, rotation: 0, reached: 1 } });
    expect(settleTarget([[0, 0], [1, 1]], c, entry({ flick: 'up' }), 16 / 9)).toEqual(aligned);
  });

  it('without detail: flicks become a straight line from the stroke’s start to its end', () => {
    const stroke: Point[] = [[0.5, 0.8], [0.52, 0.5], [0.49, 0.2]];
    expect(settleTarget(stroke, cast(), entry({ flick: 'up' }), 16 / 9)).toEqual([[0.5, 0.8], [0.49, 0.2]]);
  });

  it('without detail: the template is fitted into the stroke’s bounding box', () => {
    const template = geometry.resample(circle(24), 64);
    const stroke: Point[] = [[0.4, 0.3], [0.6, 0.3], [0.6, 0.5], [0.4, 0.5]];
    const aspect = 16 / 9;
    const t = settleTarget(stroke, cast(), entry({ path: circle(24) }, [template]), aspect)!;
    const box = geometry.bbox(geometry.toIsotropic(t, aspect));
    const strokeBox = geometry.bbox(geometry.toIsotropic(stroke, aspect));
    expect(Math.max(box.w, box.h)).toBeCloseTo(Math.max(strokeBox.w, strokeBox.h), 3);
    expect((box.minX + box.maxX) / 2).toBeCloseTo((strokeBox.minX + strokeBox.maxX) / 2, 3);
  });

  it('voice only: sketches the gesture at the aim, kept inside the frame', () => {
    const template = geometry.resample(circle(24), 64);
    const t = settleTarget(null, cast({ via: 'voice', aim: { x: 0.99, y: 0.01 } }), entry({ path: circle(24) }, [template]), 16 / 9)!;
    const b = geometry.bbox(t);
    expect(b.minX).toBeGreaterThan(0);
    expect(b.maxX).toBeLessThan(1);
    expect(b.minY).toBeGreaterThan(0);
    expect(b.h).toBeCloseTo(VOICE_SKETCH_SIZE, 2);
    expect(settleTarget(null, cast(), null, 16 / 9)).toBeNull();
  });
});

describe('pointAlong (allocation-free pointAt for drawing)', () => {
  it('agrees with geometry.pointAt everywhere along a path', () => {
    const path: Point[] = [[0, 0], [0.2, 0.1], [0.5, 0.1], [0.5, 0.6], [0.9, 0.9]];
    const fr = geometry.arcFractions(path);
    const out = { x: 0, y: 0 };
    for (const f of [-0.5, 0, 0.01, 0.25, 0.5, 0.73, 0.999, 1, 2]) {
      pointAlong(path, fr, f, out);
      const [x, y] = geometry.pointAt(path, f);
      expect(out.x).toBeCloseTo(x, 9);
      expect(out.y).toBeCloseTo(y, 9);
    }
  });

  it('copes with empty and single-point paths', () => {
    const out = { x: 9, y: 9 };
    pointAlong([], [], 0.5, out);
    expect(out).toEqual({ x: 0, y: 0 });
    pointAlong([[0.3, 0.4]], [0], 0.5, out);
    expect(out).toEqual({ x: 0.3, y: 0.4 });
  });
});

describe('practice guide', () => {
  it('fits the template into a box about 45% of the height, in the middle', () => {
    const template = geometry.resample(circle(24), 64);
    const p = guidePath(entry({ path: circle(24) }, [template]), 16 / 9)!;
    const b = geometry.bbox(geometry.toIsotropic(p, 16 / 9));
    expect(Math.max(b.w, b.h)).toBeCloseTo(GUIDE_BOX_SIZE, 3);
    expect((b.minX + b.maxX) / 2 / (16 / 9)).toBeCloseTo(0.5, 3);
    // Flicks have no templates: a line through the box.
    const flick = guidePath(entry({ flick: 'left' }), 16 / 9)!;
    expect(flick[0][0]).toBeGreaterThan(flick[flick.length - 1][0]);
  });

  it('moves the pace dot over exactly the intended pace, resting at both ends, and loops', () => {
    const pace = 1000;
    expect(paceFraction(0, pace)).toEqual({ f: 0, phase: 'start' });
    const mid = paceFraction(GUIDE_REST_START_MS + pace / 2, pace);
    expect(mid.phase).toBe('moving');
    expect(mid.f).toBeCloseTo(0.5, 5);
    expect(paceFraction(GUIDE_REST_START_MS + pace + 10, pace).phase).toBe('end');
    const cycle = GUIDE_REST_START_MS + pace + 750;
    expect(paceFraction(cycle + 10, pace)).toEqual(paceFraction(10, pace));
    // Monotonic while moving.
    let last = 0;
    for (let t = GUIDE_REST_START_MS; t < GUIDE_REST_START_MS + pace; t += 25) {
      const f = paceFraction(t, pace).f;
      expect(f).toBeGreaterThanOrEqual(last);
      last = f;
    }
  });
});

describe('replays', () => {
  it('draws the trace over its duration, easing in and out', () => {
    expect(replayIndex(0, 1000, 64)).toBe(0);
    expect(replayIndex(500, 1000, 64)).toBeCloseTo(31.5);
    expect(replayIndex(5000, 1000, 64)).toBe(63);
    expect(replayIndex(100, 0, 64)).toBe(63);
    // Slower at the ends than in the middle.
    expect(replayIndex(100, 1000, 64)).toBeLessThan(6.4);
  });

  it('knows when the replayed tip passes each point (the inverse of the ease)', () => {
    for (const i of [0, 10, 31.5, 50, 63]) expect(replayIndex(replayTimeAt(i, 1200, 64), 1200, 64)).toBeCloseTo(i, 6);
  });

  it('interpolates between points and cleans untrusted input', () => {
    expect(pointAtIndex([[0, 0], [1, 2]], 0.5)).toEqual([0.5, 1]);
    expect(cleanReplayPoints([[0.1, 0.2], ['x', 1], [Number.NaN, 0], [0.3, 0.4]])).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(cleanReplayPoints('nope')).toEqual([]);
  });

  it('keeps a replay’s shape when the mirror has another aspect', () => {
    const pts: Point[] = [[0.25, 0.5], [0.75, 0.5]];
    const out = toCurrentAspect(pts, 4 / 3, 16 / 9);
    const before = (0.75 - 0.25) * (4 / 3);
    const after = (out[1][0] - out[0][0]) * (16 / 9);
    expect(after).toBeCloseTo(before);
    expect((out[0][0] + out[1][0]) / 2).toBeCloseTo(0.5);
  });
});
