import { describe, expect, it } from 'vitest';
import { CAMERA, Feed, Noise, POINTER } from './test-support';
import { AT_REST_SHARE, DEFAULT_SEGMENTER_SETTINGS, PENDING_MARGIN_MS, PROGRESS_INTERVAL_MS } from './segmenter';

const S = DEFAULT_SEGMENTER_SETTINGS;
/** A right-then-up hook: 0.2 frame widths right, then 0.2 frame heights up. */
const HOOK: [number, number][] = [[0.4, 0.5], [0.6, 0.5], [0.6, 0.3]];

/** A hand's reach from rest to rest (minimum jerk): slow to start, fastest midway, slow to stop. */
function reach(f: Feed, a: readonly [number, number], b: readonly [number, number], ms: number): Feed {
  const n = Math.max(1, Math.round(ms / f.frameMs));
  for (let i = 1; i <= n; i++) {
    const k = i / n;
    const s = k * k * k * (10 - 15 * k + 6 * k * k);
    f.frame(a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s);
  }
  return f;
}

/** Found, held still long enough to arm, traced, and paused: one stroke, now evaluating. */
function castOne(f: Feed, path: [number, number][] = HOOK, ms = 900): Feed {
  const [x, y] = path[0];
  f.found(x, y).hold(x, y, 400).path(path, ms);
  const end = path[path.length - 1];
  return f.hold(end[0], end[1], 300);
}

describe('hold-still: the Section 7.4 diagram', () => {
  it('searching → hovering → armed → tracing → evaluating, with stroke.begin and stroke.end', () => {
    const f = castOne(new Feed());
    expect(f.states()).toEqual(['searching', 'hovering', 'armed', 'tracing', 'evaluating']);
    const begin = f.lastStroke('stroke.begin')!;
    const end = f.lastStroke('stroke.end')!;
    expect(end.id).toBe(begin.id);
    expect(end).toMatchObject({ src: CAMERA, endReason: 'pause', aspect: 16 / 9, quality: 1 });
    // The status says which stroke is traced and evaluated.
    expect(f.statuses().filter((s) => s.state === 'tracing' || s.state === 'evaluating').map((s) => s.strokeId)).toEqual([end.id, end.id]);
  });

  it('arms after armMs held within armRadius, not before', () => {
    const f = new Feed();
    f.found(0.5, 0.5).hold(0.5, 0.5, S.armMs - 40);
    expect(f.seg.state).toBe('hovering');
    f.hold(0.5, 0.5, 60);
    expect(f.seg.state).toBe('armed');
    // Armed at the first sample whose capture time is armMs after the hold began.
    const armed = f.statuses().find((s) => s.state === 'armed')!;
    expect(armed.t).toBeCloseTo(1000 + S.armMs, 0);
  });

  it('a tip that keeps moving never arms', () => {
    const f = new Feed();
    f.found(0.1, 0.5).move([0.1, 0.5], [0.9, 0.5], 2000);
    expect(f.states()).toEqual(['searching', 'hovering']);
  });

  it('a hold broken by a move restarts: armProgress falls back to 0', () => {
    const f = new Feed();
    f.found(0.3, 0.5).hold(0.3, 0.5, 200).move([0.3, 0.5], [0.4, 0.5], 100).hold(0.4, 0.5, 200);
    expect(f.seg.state).toBe('hovering');
    const progress = f.statuses().filter((s) => s.state === 'hovering').map((s) => s.armProgress);
    expect(progress[0]).toBe(0);
    expect(Math.max(...(progress as number[]))).toBeGreaterThan(0.4);
    expect(progress).toContain(0);
    f.hold(0.4, 0.5, 200);
    expect(f.seg.state).toBe('armed');
  });

  it('reports armProgress while hovering at most about 15 times a second, rising to arming', () => {
    const f = new Feed({ fps: 60 });
    f.found(0.5, 0.5).hold(0.5, 0.5, 400);
    const reports = f.statuses().filter((s) => s.state === 'hovering' && s.armProgress! > 0);
    expect(reports.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < reports.length; i++) {
      expect(reports[i].armProgress!).toBeGreaterThan(reports[i - 1].armProgress!);
      expect(reports[i].t - reports[i - 1].t).toBeGreaterThanOrEqual(PROGRESS_INTERVAL_MS - 1);
    }
    expect(f.seg.state).toBe('armed');
  });

  it('measures distances isotropically in frame widths (y divided by the aspect)', () => {
    // 3% of the frame height is 1.7% of the frame width: inside the 2% arm radius.
    const f = new Feed();
    f.found(0.5, 0.5).hold(0.5, 0.5, 100);
    for (let i = 0; i < 10; i++) f.frame(0.5, i % 2 ? 0.53 : 0.5);
    expect(f.seg.state).toBe('armed');
    // 3% of the frame width is not.
    const g = new Feed();
    g.found(0.5, 0.5).hold(0.5, 0.5, 100);
    for (let i = 0; i < 10; i++) g.frame(i % 2 ? 0.53 : 0.5, 0.5);
    expect(g.seg.state).toBe('hovering');
  });

  it('uses the aspect of the tracker that sent the samples', () => {
    // A 4:3 camera: 3% of the frame height is 2.25% of the frame width, outside the arm radius.
    const f = new Feed({ aspect: 4 / 3 });
    f.status(false, 16 / 9, 'tracker.hand'); // another tracker's status does not count
    f.found(0.5, 0.5).hold(0.5, 0.5, 100);
    for (let i = 0; i < 10; i++) f.frame(0.5, i % 2 ? 0.53 : 0.5);
    expect(f.seg.state).toBe('hovering');
    expect(castOne(new Feed({ aspect: 4 / 3 })).lastStroke()!.aspect).toBe(4 / 3);
  });

  it('starts the stroke at the armed position and keeps a slow start', () => {
    const f = new Feed();
    f.found(0.4, 0.5).hold(0.4, 0.5, 400);
    // A slow start: 0.6% of the frame width per frame, inside the 2% arm radius for three frames.
    for (let i = 1; i <= 4; i++) f.frame(0.4 + 0.006 * i, 0.5);
    expect(f.seg.state).toBe('tracing');
    const begin = f.lastStroke('stroke.begin')!;
    // The stroke so far: the last sample still at the armed position, then the slow start.
    expect(begin.points.map((p) => +p.x.toFixed(3))).toEqual([0.4, 0.406, 0.412, 0.418, 0.424]);
    expect(begin.t0).toBe(begin.points[0].t);
    expect(begin.endReason).toBeUndefined();
  });

  it('ends at the first still sample: the trailing pause is not part of the stroke', () => {
    const f = new Feed();
    f.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.6, 0.5], 600);
    const stop = f.t - f.frameMs; // the last moving frame lands on (0.6, 0.5)
    f.hold(0.6, 0.5, 400);
    const stroke = f.lastStroke()!;
    expect(stroke.points[stroke.points.length - 1].x).toBeCloseTo(0.6, 6);
    expect(stroke.t1).toBeCloseTo(stop, 0);
    expect(stroke.points.filter((p) => p.x === 0.6)).toHaveLength(1);
    // Decided pauseMs after the tip came to rest.
    const evaluating = f.statuses().find((s) => s.state === 'evaluating')!;
    expect(evaluating.t - stroke.t1).toBeGreaterThanOrEqual(S.pauseMs);
    expect(evaluating.t - stroke.t1).toBeLessThan(S.pauseMs + 40);
  });

  it('keeps the end of a slow approach that the pause radius alone would cut', () => {
    // Steps of 1% of the frame width are inside the 1.2% pause radius: a still run starts one step
    // before the tip stops. The stroke still reaches the point where it stopped.
    const f = new Feed();
    f.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.5, 0.5], 400);
    for (let i = 1; i <= 3; i++) f.frame(0.5 + 0.01 * i, 0.5);
    f.hold(0.53, 0.5, 400);
    const stroke = f.lastStroke()!;
    expect(stroke.points[stroke.points.length - 1].x).toBeCloseTo(0.53, 6);
    expect(stroke.endReason).toBe('pause');
  });

  it('cast → cooldown → hovering after cooldownMs, then needs a fresh hold', () => {
    const f = castOne(new Feed());
    f.decide('cast');
    expect(f.seg.state).toBe('cooldown');
    const castAt = f.now;
    f.hold(0.6, 0.3, S.cooldownMs - 50);
    expect(f.seg.state).toBe('cooldown');
    f.hold(0.6, 0.3, 60);
    expect(f.seg.state).toBe('hovering');
    const hovering = f.statuses().filter((s) => s.state === 'hovering').pop()!;
    expect(hovering.t - castAt).toBeGreaterThanOrEqual(S.cooldownMs);
    // The stillness before and during the cooldown does not count: arming takes a full hold from
    // the first sample after it.
    f.hold(0.6, 0.3, S.armMs - 100);
    expect(f.seg.state).toBe('hovering');
    f.hold(0.6, 0.3, 150);
    expect(f.seg.state).toBe('armed');
  });

  it('cooldown ends on a tick too, when no samples arrive', () => {
    const f = castOne(new Feed({ pen: null }));
    f.decide('cast');
    // The tip goes out of view during the cooldown: it ends in searching.
    f.lost().wait(S.cooldownMs + 50);
    expect(f.states().slice(-2)).toEqual(['cooldown', 'searching']);
  });

  it('fizzle → hovering at once; the still tip must hold again before it arms', () => {
    const f = castOne(new Feed());
    f.decide('fizzle');
    expect(f.seg.state).toBe('hovering');
    f.hold(0.6, 0.3, S.armMs - 50);
    expect(f.seg.state).toBe('hovering');
    f.hold(0.6, 0.3, 100);
    expect(f.seg.state).toBe('armed');
  });

  it('ignores a decision for another stroke, and decisions while not evaluating', () => {
    const f = castOne(new Feed());
    f.decide('cast', 'stroke-other');
    expect(f.seg.state).toBe('evaluating');
    f.out.push(...f.seg.decided(undefined, 'fizzle', f.now));
    expect(f.seg.state).toBe('evaluating');
    f.decide('fizzle');
    f.decide('cast'); // a second decision for the same stroke changes nothing
    expect(f.seg.state).toBe('hovering');
  });

  it('a decision that never comes: back to hovering after evaluateTimeoutMs', () => {
    const f = castOne(new Feed());
    const since = f.now;
    f.hold(0.6, 0.3, S.evaluateTimeoutMs - 100);
    expect(f.seg.state).toBe('evaluating');
    f.hold(0.6, 0.3, 200);
    expect(f.seg.state).toBe('hovering');
    const back = f.statuses().pop()!;
    expect(back.t - since).toBeGreaterThanOrEqual(S.evaluateTimeoutMs);
    // A late decision is ignored.
    f.decide('cast');
    expect(f.seg.state).toBe('hovering');
  });

  it('the evaluation timeout passes with no samples at all (ticks)', () => {
    const f = castOne(new Feed());
    f.lost().wait(S.evaluateTimeoutMs + 100);
    expect(f.seg.state).toBe('searching');
  });

  it('spell.pending keeps it evaluating until `until` + 250 ms, and a later until wins', () => {
    const f = castOne(new Feed());
    const stroke = f.lastStroke()!;
    const until = f.now + 2000;
    f.out.push(...f.seg.pending(stroke.id, until, f.now));
    f.hold(0.6, 0.3, 2000);
    expect(f.seg.state).toBe('evaluating');
    // The engine extends once (an utterance under way).
    f.out.push(...f.seg.pending(stroke.id, until + 800, f.now));
    f.hold(0.6, 0.3, 800 + PENDING_MARGIN_MS - 50);
    expect(f.seg.state).toBe('evaluating');
    f.hold(0.6, 0.3, 100);
    expect(f.seg.state).toBe('hovering');
  });

  it('spell.pending for another stroke changes nothing', () => {
    const f = castOne(new Feed());
    f.out.push(...f.seg.pending('stroke-other', f.now + 5000, f.now));
    f.hold(0.6, 0.3, S.evaluateTimeoutMs + 50);
    expect(f.seg.state).toBe('hovering');
  });

  it('a decision that arrives while pending still decides', () => {
    const f = castOne(new Feed());
    const stroke = f.lastStroke()!;
    f.out.push(...f.seg.pending(stroke.id, f.now + 1500, f.now));
    f.hold(0.6, 0.3, 600).decide('cast');
    expect(f.seg.state).toBe('cooldown');
  });
});

describe('hold-still: losing the tip (Section 7.9)', () => {
  it('hovering → searching and armed → searching on tip.lost', () => {
    const f = new Feed();
    f.found(0.5, 0.5).hold(0.5, 0.5, 100).lost();
    expect(f.seg.state).toBe('searching');
    f.found(0.5, 0.5).hold(0.5, 0.5, 400).lost();
    expect(f.states()).toEqual(['searching', 'hovering', 'searching', 'hovering', 'armed', 'searching']);
  });

  it('tip.lost mid-stroke ends the stroke and evaluates what it has', () => {
    const f = new Feed();
    f.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.6, 0.5], 500);
    const lastT = f.t - f.frameMs;
    f.lost();
    const stroke = f.lastStroke()!;
    expect(stroke).toMatchObject({ endReason: 'lost' });
    expect(stroke.t1).toBeCloseTo(lastT, 0);
    expect(f.seg.state).toBe('evaluating');
    // The tip is gone, so after the decision it searches.
    f.decide('fizzle');
    expect(f.seg.state).toBe('searching');
  });

  it('samples that stop end the stroke at the last sample + lostMs, without waiting for tip.lost', () => {
    const f = new Feed();
    f.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.6, 0.5], 500);
    const lastT = f.t - f.frameMs;
    f.wait(S.lostMs - 50);
    expect(f.seg.state).toBe('tracing');
    f.wait(100);
    expect(f.seg.state).toBe('evaluating');
    const evaluating = f.statuses().find((s) => s.state === 'evaluating')!;
    expect(evaluating.t).toBeCloseTo(lastT + S.lostMs, 0);
    expect(f.lastStroke()).toMatchObject({ endReason: 'lost', t1: Math.round(lastT * 10) / 10 });
    // The tracker's tip.lost arrives later and changes nothing.
    const before = f.out.length;
    f.lost();
    expect(f.out.length).toBe(before);
  });

  it('measures the gap on arrival times, so camera latency cannot end a stroke early', () => {
    const f = new Feed({ latencyMs: 150 });
    castOne(f);
    expect(f.lastStroke()).toMatchObject({ endReason: 'pause' });
  });

  it('samples resuming after a gap, with no tip.found, are a new appearance', () => {
    const f = new Feed();
    f.found(0.5, 0.5).hold(0.5, 0.5, 400);
    expect(f.seg.state).toBe('armed');
    f.wait(S.lostMs + 50).hold(0.5, 0.5, 100);
    expect(f.states().slice(-3)).toEqual(['armed', 'searching', 'hovering']);
  });

  it('a gap seen only when the next sample arrives (no ticks in between) also ends the stroke', () => {
    const f = new Feed();
    f.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.6, 0.5], 500);
    // Jump the clock without ticking, then a sample.
    f.t += 400;
    f.out.push(...f.seg.sample({ t: f.t, x: 0.6, y: 0.5, conf: 1, src: CAMERA }, f.t));
    expect(f.lastStroke()).toMatchObject({ endReason: 'lost' });
    expect(f.seg.state).toBe('evaluating');
  });

  it('a lost tip during evaluation or cooldown is remembered: it ends in searching', () => {
    const f = castOne(new Feed());
    f.lost().decide('cast');
    f.wait(S.cooldownMs + 50);
    expect(f.seg.state).toBe('searching');
  });

  it('ignores a stale tip.lost from another tracker', () => {
    const f = new Feed();
    f.found(0.5, 0.5).hold(0.5, 0.5, 100);
    f.out.push(...f.seg.lost({ t: f.t, src: 'tracker.hand' }, f.now));
    expect(f.seg.state).toBe('hovering');
  });

  it('a sample from another tracker means the first tracker’s tip has gone', () => {
    const f = new Feed();
    f.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.6, 0.5], 500);
    f.out.push(...f.seg.sample({ t: f.t, x: 0.2, y: 0.2, conf: 1, src: 'tracker.hand' }, f.now));
    expect(f.lastStroke()).toMatchObject({ endReason: 'lost', src: CAMERA });
  });

  it('time running backwards is a discontinuity', () => {
    const f = new Feed();
    f.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.6, 0.5], 500);
    f.out.push(...f.seg.sample({ t: f.t - 300, x: 0.6, y: 0.5, conf: 1, src: CAMERA }, f.now));
    expect(f.lastStroke()).toMatchObject({ endReason: 'lost' });
  });

  it('a second tip.found without tip.lost is a loss and a new appearance', () => {
    const f = new Feed();
    f.found(0.5, 0.5).hold(0.5, 0.5, 400).found(0.2, 0.2);
    expect(f.states().slice(-3)).toEqual(['armed', 'searching', 'hovering']);
  });
});

describe('hold-still: the other ways a stroke ends', () => {
  it('ends at maxMs in total', () => {
    const f = new Feed();
    f.found(0.2, 0.5).hold(0.2, 0.5, 400);
    // A circle traced again and again, never pausing.
    const circle: [number, number][] = [];
    for (let i = 0; i <= 64; i++) circle.push([0.5 + 0.2 * Math.cos(Math.PI + (i / 64) * Math.PI * 2 * 4), 0.5 + 0.3 * Math.sin(Math.PI + (i / 64) * Math.PI * 2 * 4)]);
    circle[0] = [0.2, 0.5];
    f.path(circle, 6000);
    const stroke = f.strokes()[0];
    expect(stroke.endReason).toBe('max');
    expect(stroke.t1 - stroke.t0).toBeGreaterThanOrEqual(S.maxMs - 1);
    expect(stroke.t1 - stroke.t0).toBeLessThan(S.maxMs + 40);
    // After a fizzle the moving tip is hovering and does not arm.
    f.decide('fizzle').path([[0.5, 0.5], [0.7, 0.6], [0.3, 0.6]], 1000);
    expect(f.seg.state).toBe('hovering');
    expect(f.strokes()).toHaveLength(1);
  });

  it('discards a stroke with fewer than minSamples samples: no stroke.end, back to hovering', () => {
    const f = new Feed();
    f.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.6, 0.5], 150).hold(0.6, 0.5, 300);
    expect(f.strokes('stroke.begin')).toHaveLength(1);
    expect(f.strokes('stroke.end')).toHaveLength(0);
    const id = f.lastStroke('stroke.begin')!.id;
    expect(f.statuses().find((s) => s.discarded)).toMatchObject({ state: 'hovering', discarded: 'too-short', strokeId: id });
    // A fresh hold is needed: the still tip arms again only after armMs from the discard.
    f.hold(0.6, 0.5, S.armMs - 60);
    expect(f.seg.state).toBe('hovering');
    f.hold(0.6, 0.5, 100);
    expect(f.seg.state).toBe('armed');
  });

  it('discards a stroke smaller than minExtent of the play area', () => {
    const f = new Feed();
    f.found(0.4, 0.5).hold(0.4, 0.5, 400).path([[0.4, 0.5], [0.5, 0.5], [0.4, 0.55]], 600).hold(0.4, 0.55, 300);
    expect(f.strokes()).toHaveLength(0);
    expect(f.statuses().find((s) => s.discarded)).toMatchObject({ discarded: 'too-small' });
  });

  it('measures the extent against the play area, per axis', () => {
    // 0.1 of the frame width is too small for the whole frame, but 20% of a play area half as wide.
    const small: [number, number][] = [[0.4, 0.5], [0.5, 0.5], [0.4, 0.52]];
    const f = new Feed();
    f.found(0.4, 0.5).hold(0.4, 0.5, 400).path(small, 600).hold(0.4, 0.52, 300);
    expect(f.strokes()).toHaveLength(0);
    const g = new Feed({ settings: { playArea: { x: 0.25, y: 0, w: 0.5, h: 1 } } });
    g.found(0.4, 0.5).hold(0.4, 0.5, 400).path(small, 600).hold(0.4, 0.52, 300);
    expect(g.strokes()).toHaveLength(1);
  });

  it('a discarded stroke whose tip was lost ends in searching', () => {
    const f = new Feed();
    f.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.6, 0.5], 100).lost();
    expect(f.statuses().pop()).toMatchObject({ state: 'searching', discarded: 'too-short' });
  });

  it('trims the trailing still samples whatever ended the stroke', () => {
    const f = new Feed();
    f.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.6, 0.5], 500).hold(0.6, 0.5, 150).lost();
    const stroke = f.lastStroke()!;
    expect(stroke.endReason).toBe('lost');
    expect(stroke.points.filter((p) => p.x === 0.6)).toHaveLength(1);
  });
});

describe('pen mode (mouse and touch)', () => {
  it('tip.found begins tracing at once and tip.lost ends it (pen-up); no arming', () => {
    const f = new Feed({ src: POINTER, pen: true });
    f.found(0.2, 0.2);
    expect(f.seg.state).toBe('tracing');
    expect(f.lastStroke('stroke.begin')).toMatchObject({ points: [], src: POINTER });
    // The sample of the same frame follows tip.found.
    f.frame(0.2, 0.2).path([[0.2, 0.2], [0.5, 0.6], [0.8, 0.2]], 700).lost();
    const stroke = f.lastStroke()!;
    expect(stroke).toMatchObject({ endReason: 'pen-up', src: POINTER });
    expect(stroke.points[0]).toMatchObject({ x: 0.2, y: 0.2 });
    expect(f.states()).toEqual(['searching', 'tracing', 'evaluating']);
    // Before the pointer tracker's status arrived the rule was hold-still; its status switched it.
    expect(f.statuses().map((s) => s.mode)).toEqual(['hold-still', 'pen', 'pen', 'pen']);
    f.decide('cast').wait(S.cooldownMs + 50);
    expect(f.seg.state).toBe('searching');
  });

  it('a pointer tracker’s samples outside tip.found … tip.lost move the trail but start nothing', () => {
    const f = new Feed({ src: POINTER, pen: true });
    f.move([0.2, 0.2], [0.6, 0.6], 500);
    expect(f.seg.state).toBe('searching');
    expect(f.filtered()).toHaveLength(15);
    f.found(0.6, 0.6).frame(0.6, 0.6).move([0.6, 0.6], [0.2, 0.6], 400).lost().move([0.2, 0.6], [0.5, 0.2], 400);
    expect(f.strokes('stroke.begin')).toHaveLength(1);
    expect(f.lastStroke()!.points[0]).toMatchObject({ x: 0.6, y: 0.6 });
  });

  it('a pause does not end a pen stroke, and gaps between pointer events do not lose the tip', () => {
    const f = new Feed({ src: POINTER, pen: true });
    f.found(0.2, 0.2).move([0.2, 0.2], [0.5, 0.2], 300);
    // The pointer rests (no events) and then moves on.
    f.wait(1000).move([0.5, 0.2], [0.5, 0.6], 300).lost();
    expect(f.strokes()).toHaveLength(1);
    expect(f.lastStroke()!.endReason).toBe('pen-up');
  });

  it('a rest after the press is no dropout and no part of the stroke: it starts where the pointer moves', () => {
    // pointerdown (tip.found and the sample of the same event), then the mouse rests and sends nothing.
    const f = new Feed({ src: POINTER, pen: true, fps: 60 });
    f.found(0.5, 0.6).frame(0.5, 0.6).wait(800);
    const firstMove = f.t;
    f.move([0.5, 0.6], [0.5, 0.3], 200).lost();
    const stroke = f.lastStroke()!;
    expect(stroke.quality).toBe(1);
    // The press position stays, held there until one sample interval before the first movement, so
    // the stroke lasts as long as the flick did.
    expect(stroke.points).toHaveLength(13);
    expect(stroke.points[0]).toMatchObject({ x: 0.5, y: 0.6 });
    expect(stroke.t0).toBeCloseTo(firstMove - f.frameMs, 0);
    expect(stroke.t1 - stroke.t0).toBeCloseTo(200, 0);
    // What was already published keeps the press time: the trail's sample and stroke.begin, whose id
    // lets a consumer find the press of this stroke.
    expect(f.filtered()[0]).toMatchObject({ t: 1000, x: 0.5, y: 0.6 });
    expect(f.lastStroke('stroke.begin')).toMatchObject({ id: stroke.id, t0: 1000, points: [] });
  });

  it('a finger or pen resting after the press sends samples that stay put: the stroke starts at the last', () => {
    const f = new Feed({ src: POINTER, pen: true, fps: 60 });
    f.found(0.5, 0.6).hold(0.5, 0.6, 500, 0.0003);
    const lastStill = f.t - f.frameMs;
    f.move([0.5, 0.6], [0.5, 0.3], 200).lost();
    const stroke = f.lastStroke()!;
    expect(stroke.points).toHaveLength(13);
    expect(stroke.t0).toBeCloseTo(lastStill, 0);
    expect(stroke.t1 - stroke.t0).toBeCloseTo(200, 0);
    expect(stroke.quality).toBe(1);
  });

  it('a pen stroke that moves at once keeps its press, though the filter holds the next samples near it', () => {
    for (const fps of [60, 125]) {
      const f = new Feed({ src: POINTER, pen: true, fps, filter: true });
      f.found(0.5, 0.6).frame(0.5, 0.6).move([0.5, 0.6], [0.5, 0.3], 300).lost();
      const stroke = f.lastStroke()!;
      expect(stroke.points[0], `${fps} Hz`).toMatchObject({ t: 1000, x: 0.5, y: 0.6 });
      expect(stroke.points[1].t, `${fps} Hz`).toBeCloseTo(1000 + f.frameMs, 0);
    }
  });

  it('a pen stroke that starts slowly without resting keeps its press: only a rest is cut', () => {
    // Sampled throughout, as a finger or pen is: a flick, and a slow stroke whose start stays within
    // AT_REST_SHARE of the press for about 0.18 s through the filter.
    for (const fps of [60, 125]) {
      for (const [a, b, ms] of [[[0.5, 0.65], [0.5, 0.35], 300], [[0.25, 0.5], [0.75, 0.5], 1600]] as const) {
        const f = new Feed({ src: POINTER, pen: true, fps, filter: true });
        f.found(a[0], a[1]).frame(a[0], a[1]);
        reach(f, a, b, ms).lost();
        const stroke = f.lastStroke()!;
        expect(stroke.points[0], `${fps} Hz, ${ms} ms`).toMatchObject({ t: 1000, x: a[0], y: a[1] });
        expect(stroke.points[1].t, `${fps} Hz, ${ms} ms`).toBeCloseTo(1000 + f.frameMs, 0);
        expect(stroke.t0).toBe(1000);
      }
    }
  });

  it('samples that stay put at the press are a rest from a pause on (segmenter.pauseMs)', () => {
    for (const [ms, rested] of [[S.pauseMs - 50, false], [S.pauseMs + 50, true]] as const) {
      const f = new Feed({ src: POINTER, pen: true, fps: 60 });
      f.found(0.5, 0.6).hold(0.5, 0.6, ms, 0.0003);
      const lastStill = f.t - f.frameMs;
      f.move([0.5, 0.6], [0.5, 0.3], 200).lost();
      expect(f.lastStroke()!.t0, `${ms} ms`).toBeCloseTo(rested ? lastStill : 1000, 0);
    }
  });

  it('a mouse silent for a moment after the press: the silence is cut, the slow start after it kept', () => {
    // pointerdown, no events for 100 ms (less than a pause), then a reach whose first samples creep
    // within AT_REST_SHARE of the press.
    const f = new Feed({ src: POINTER, pen: true, fps: 60 });
    f.found(0.5, 0.6).frame(0.5, 0.6).wait(100);
    const firstMove = f.t;
    reach(f, [0.5, 0.6], [0.5, 0.3], 500).lost();
    const stroke = f.lastStroke()!;
    // Held at the press until one sample interval before the first event after the silence.
    expect(stroke.points[0]).toMatchObject({ x: 0.5, y: 0.6 });
    expect(stroke.t0).toBeCloseTo(firstMove - f.frameMs, 0);
    expect(stroke.points[1].t).toBeCloseTo(firstMove, 0);
    expect(stroke.quality).toBe(1);
  });

  it('a pointer stopping on the way is no dropout either, and the stop stays in the stroke', () => {
    const f = new Feed({ src: POINTER, pen: true, fps: 60 });
    f.found(0.4, 0.5).frame(0.4, 0.5).move([0.4, 0.5], [0.6, 0.5], 500).wait(150).move([0.6, 0.5], [0.6, 0.3], 500).lost();
    const stroke = f.lastStroke()!;
    expect(stroke.quality).toBe(1);
    expect(stroke.t0).toBe(1000);
    // The stop is kept: the stroke's longest step is the 150 ms stop and the frame after it.
    const steps = stroke.points.slice(1).map((p, i) => p.t - stroke.points[i].t);
    expect(Math.max(...steps)).toBeCloseTo(150 + f.frameMs, 0);
  });

  it('a camera tracker in pen mode: a gap is still a dropout, and the stroke starts at tip.found', () => {
    const f = new Feed({ settings: { mode: 'pen' } });
    f.found(0.4, 0.5).frame(0.4, 0.5).wait(150).move([0.4, 0.5], [0.6, 0.5], 500).move([0.6, 0.5], [0.6, 0.3], 500).wait(S.lostMs + 50);
    const stroke = f.lastStroke()!;
    expect(stroke).toMatchObject({ src: CAMERA, endReason: 'pen-up', t0: 1000 });
    expect(stroke.quality).toBeLessThan(1);
  });

  it('caps a pen stroke at maxMs, also while the pointer rests (ticks)', () => {
    const f = new Feed({ src: POINTER, pen: true });
    f.found(0.2, 0.2).move([0.2, 0.2], [0.5, 0.5], 500).wait(S.maxMs);
    expect(f.lastStroke()).toMatchObject({ endReason: 'max' });
    f.decide('fizzle');
    // Still pressed: hovering, and nothing more until the pointer lifts and presses again.
    f.move([0.5, 0.5], [0.8, 0.2], 300);
    expect(f.seg.state).toBe('hovering');
    f.lost().found(0.3, 0.3);
    expect(f.seg.state).toBe('tracing');
  });

  it('applies the same minimum checks, with the whole mirror as the play area', () => {
    const f = new Feed({ src: POINTER, pen: true, settings: { playArea: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } } });
    f.found(0.4, 0.4).move([0.4, 0.4], [0.5, 0.45], 400).lost();
    // 10% of the mirror: too small, although it is half of the camera play area.
    expect(f.statuses().pop()).toMatchObject({ discarded: 'too-small', state: 'searching' });
    // A click: too short.
    f.found(0.4, 0.4).lost();
    expect(f.statuses().pop()).toMatchObject({ discarded: 'too-short' });
  });

  it('a press during the cooldown begins a stroke; a press while evaluating is ignored', () => {
    const f = new Feed({ src: POINTER, pen: true });
    f.found(0.2, 0.2).move([0.2, 0.2], [0.6, 0.6], 400).lost();
    f.found(0.3, 0.3).move([0.3, 0.3], [0.7, 0.3], 300).lost();
    expect(f.strokes('stroke.begin')).toHaveLength(1);
    f.decide('cast').found(0.3, 0.3);
    expect(f.seg.state).toBe('tracing');
    expect(f.strokes('stroke.begin')).toHaveLength(2);
  });

  it('segmenter.mode pen forces pen mode on a camera tracker; its gaps still lose the tip', () => {
    const f = new Feed({ settings: { mode: 'pen' } });
    f.found(0.2, 0.5).move([0.2, 0.5], [0.6, 0.5], 500).wait(S.lostMs + 50);
    expect(f.lastStroke()).toMatchObject({ endReason: 'pen-up', src: CAMERA });
  });

  it('segmenter.mode hold-still on a pointer: a resting pointer arms and pauses on ticks', () => {
    const f = new Feed({ src: POINTER, pen: true, settings: { mode: 'hold-still' } });
    // pointerdown, then no events while the pointer rests.
    f.found(0.3, 0.5).frame(0.3, 0.5).wait(S.armMs + 50);
    expect(f.seg.state).toBe('armed');
    f.move([0.3, 0.5], [0.6, 0.5], 400).wait(S.pauseMs + 50);
    expect(f.lastStroke()).toMatchObject({ endReason: 'pause', src: POINTER });
    expect(f.statuses().every((s) => s.mode === 'hold-still')).toBe(true);
  });

  it('segmenter.mode hold-still on a pointer: a stop on the way is no dropout, the stroke is the same', () => {
    const f = new Feed({ src: POINTER, pen: true, fps: 60, settings: { mode: 'hold-still' } });
    f.found(0.4, 0.5).frame(0.4, 0.5).wait(S.armMs + 50);
    const firstMove = f.t;
    f.move([0.4, 0.5], [0.6, 0.5], 500).wait(150).move([0.6, 0.5], [0.6, 0.3], 500).wait(S.pauseMs + 50);
    const stroke = f.lastStroke()!;
    expect(stroke).toMatchObject({ endReason: 'pause', src: POINTER, quality: 1 });
    // The hold-still lead-in rule is unchanged: the stroke starts at the first sample that moved.
    expect(stroke.t0).toBeCloseTo(firstMove, 0);
  });

  it('auto mode follows the tracker of the samples', () => {
    const f = new Feed({ pen: null });
    f.status(true, 16 / 9, POINTER);
    expect(f.seg.mode).toBe('pen');
    f.status(false, 16 / 9, CAMERA);
    expect(f.seg.mode).toBe('hold-still');
    expect(f.statuses().map((s) => s.mode)).toEqual(['hold-still', 'pen', 'hold-still']);
  });
});

describe('pauses', () => {
  it('voice-only: paused with pausedFor, no strokes, tip.filtered keeps flowing', () => {
    const f = new Feed();
    f.out.push(...f.seg.setAutoPause('voice-only', true, f.now));
    castOne(f);
    expect(f.states()).toEqual(['searching', 'paused']);
    expect(f.statuses().pop()).toMatchObject({ state: 'paused', pausedFor: 'voice-only' });
    expect(f.strokes('stroke.begin')).toHaveLength(0);
    expect(f.filtered().length).toBeGreaterThan(30);
    f.out.push(...f.seg.setAutoPause('voice-only', false, f.now));
    expect(f.seg.state).toBe('hovering');
    // Resuming needs a fresh hold.
    f.hold(0.6, 0.3, S.armMs - 50);
    expect(f.seg.state).toBe('hovering');
  });

  it('pausing mid-stroke drops the stroke with its id', () => {
    const f = new Feed();
    f.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.5, 0.5], 300);
    const id = f.lastStroke('stroke.begin')!.id;
    f.out.push(...f.seg.setAutoPause('replay', true, f.now));
    expect(f.statuses().pop()).toMatchObject({ state: 'paused', pausedFor: 'replay', strokeId: id, discarded: 'interrupted' });
    f.hold(0.5, 0.5, 300);
    expect(f.strokes()).toHaveLength(0);
  });

  it('a decision for a stroke being evaluated when the pause began is ignored', () => {
    const f = castOne(new Feed());
    f.out.push(...f.seg.setRequestPause(true, 'workshop', f.now));
    f.decide('cast');
    expect(f.seg.state).toBe('paused');
  });

  it('requested pauses stack by reason; resuming without a reason clears them all', () => {
    const f = new Feed();
    f.found(0.5, 0.5);
    f.out.push(...f.seg.setRequestPause(true, 'workshop', f.now), ...f.seg.setRequestPause(true, undefined, f.now));
    expect(f.statuses().pop()).toMatchObject({ state: 'paused', pausedFor: 'workshop' });
    f.out.push(...f.seg.setRequestPause(false, 'workshop', f.now));
    expect(f.statuses().pop()).toMatchObject({ state: 'paused', pausedFor: 'request' });
    f.out.push(...f.seg.setRequestPause(true, 'workshop', f.now), ...f.seg.setRequestPause(false, undefined, f.now));
    expect(f.seg.state).toBe('hovering');
  });

  it('a replay pause wins over the others in pausedFor', () => {
    const f = new Feed();
    f.out.push(...f.seg.setRequestPause(true, 'workshop', f.now), ...f.seg.setAutoPause('voice-only', true, f.now));
    expect(f.statuses().pop()).toMatchObject({ pausedFor: 'voice-only' });
    f.out.push(...f.seg.setAutoPause('replay', true, f.now));
    expect(f.statuses().pop()).toMatchObject({ pausedFor: 'replay' });
  });
});

describe('capture (Workshop redraw)', () => {
  it('the next completed stroke is captured instead of evaluated', () => {
    const f = new Feed();
    f.out.push(...f.seg.setCapture(true, f.now));
    castOne(f);
    const captured = f.lastStroke('captured')!;
    expect(captured).toMatchObject({ endReason: 'pause', src: CAMERA });
    expect(f.strokes('stroke.end')).toHaveLength(0);
    expect(f.statuses().find((s) => s.captured)).toMatchObject({ captured: true, strokeId: captured.id, state: 'hovering' });
    // Only one: the next stroke is cast as usual.
    f.move([0.6, 0.3], [0.4, 0.5], 300);
    castOne(f);
    expect(f.strokes('stroke.end')).toHaveLength(1);
  });

  it('a discarded stroke does not complete the capture', () => {
    const f = new Feed();
    f.out.push(...f.seg.setCapture(true, f.now));
    f.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.6, 0.5], 100).hold(0.6, 0.5, 300);
    expect(f.strokes('captured')).toHaveLength(0);
    f.move([0.6, 0.5], [0.4, 0.5], 300);
    castOne(f);
    expect(f.strokes('captured')).toHaveLength(1);
  });

  it('runs through a voice-only pause, and pauses again afterwards', () => {
    const f = new Feed();
    f.out.push(...f.seg.setAutoPause('voice-only', true, f.now));
    f.out.push(...f.seg.setCapture(true, f.now));
    expect(f.seg.state).toBe('searching');
    castOne(f);
    expect(f.strokes('captured')).toHaveLength(1);
    expect(f.statuses().pop()).toMatchObject({ state: 'paused', pausedFor: 'voice-only', captured: true });
  });

  it('not through a replay pause', () => {
    const f = new Feed();
    f.out.push(...f.seg.setAutoPause('replay', true, f.now), ...f.seg.setCapture(true, f.now));
    castOne(f);
    expect(f.strokes('captured')).toHaveLength(0);
    expect(f.seg.state).toBe('paused');
  });
});

describe('filtering inside the machine', () => {
  it('publishes tip.filtered for every sample, last, with the same t and src', () => {
    const f = new Feed({ filter: true });
    f.found(0.3, 0.5).hold(0.3, 0.5, 200);
    const filtered = f.filtered();
    expect(filtered).toHaveLength(6);
    expect(filtered.every((s) => s.src === CAMERA && s.conf === 0.95)).toBe(true);
    expect(f.out[f.out.length - 1].type).toBe('tip.filtered');
  });

  it('resets the filter on tip.found, tip.lost and a change of tracker: the first sample passes through', () => {
    const f = new Feed({ filter: true });
    f.found(0.2, 0.2).hold(0.2, 0.2, 200).lost();
    f.found(0.8, 0.8).frame(0.8, 0.8);
    expect(f.filtered().pop()).toMatchObject({ x: 0.8, y: 0.8 });
    f.frame(0.7, 0.7, { src: 'tracker.hand' });
    expect(f.filtered().pop()).toMatchObject({ x: 0.7, y: 0.7, src: 'tracker.hand' });
  });

  it('casts with the filter on and jitter of 0.15% at rest', () => {
    const f = new Feed({ filter: true });
    const noise = new Noise(3);
    f.found(0.4, 0.5).hold(0.4, 0.5, 450, 0.0015, noise).path(HOOK, 900).hold(0.6, 0.3, 400, 0.0015, noise);
    expect(f.strokes()).toHaveLength(1);
    expect(f.lastStroke()!.endReason).toBe('pause');
  });
});

describe('lifecycle', () => {
  it('stop() mid-stroke drops the stroke with its id and goes back to searching', () => {
    const f = new Feed();
    f.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.5, 0.5], 300);
    const id = f.lastStroke('stroke.begin')!.id;
    f.out.push(...f.seg.stop(f.now));
    expect(f.statuses().pop()).toMatchObject({ state: 'searching', strokeId: id, discarded: 'interrupted' });
    expect(f.seg.tipPresent).toBe(false);
  });

  it('start() reports the state again, paused when a pause is in force', () => {
    const f = new Feed();
    f.out.push(...f.seg.setRequestPause(true, 'workshop', f.now));
    f.clear().out.push(...f.seg.start(f.now));
    expect(f.statuses()).toMatchObject([{ state: 'paused', pausedFor: 'workshop' }]);
  });

  it('a mode change in the settings waits for the stroke under way', () => {
    const f = new Feed();
    f.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.5, 0.5], 300);
    f.out.push(...f.seg.configure({ ...S, mode: 'pen' }, f.now));
    expect(f.seg.mode).toBe('hold-still');
    f.hold(0.5, 0.5, 300);
    expect(f.lastStroke()).toMatchObject({ endReason: 'pause' });
    f.decide('fizzle');
    expect(f.seg.mode).toBe('pen');
  });
});

describe('constants', () => {
  it('judges "at rest" within a quarter of the pause radius', () => {
    expect(S.pauseRadius * AT_REST_SHARE).toBeCloseTo(0.003, 6);
  });
});
