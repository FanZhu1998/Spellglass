import { describe, expect, it } from 'vitest';
import { ActionHandle, color, num, pick } from './actions';
import { Glide, Levitate, easeInOut, easeOutBack, springBody, wobble, type Body, type MotionEnv } from './motion';
import { ChangeNotifier, MOVE_NOTIFY_MS } from './notify';
import { ScaleChannel } from './scale';
import { fakeStage } from './testing';
import { ViewCache } from './view';

const body = (x = 0.5, y = 0.9): Body => ({ x, y, vx: 0, vy: 0, rot: 0, vrot: 0 });

function env(over: Partial<MotionEnv> = {}): MotionEnv {
  return {
    dt: 16, tipX: 0, tipY: 0, hasTip: false, reduced: false, homeX: 0.5, homeY: 0.9,
    hToX: 0.5625, hToY: 1, sway: 0.5, hang: 0.05, complete: () => {}, ...over,
  };
}

describe('easing and springs', () => {
  it('easing curves start at 0 and end at 1', () => {
    expect(easeInOut(0)).toBe(0);
    expect(easeInOut(1)).toBe(1);
    expect(easeOutBack(0)).toBeCloseTo(0, 9);
    expect(easeOutBack(1)).toBeCloseTo(1, 9);
    // It overshoots on the way.
    expect(Math.max(...Array.from({ length: 50 }, (_, i) => easeOutBack(i / 49)))).toBeGreaterThan(1);
  });

  it('a critically damped spring reaches its target without overshooting', () => {
    const b = body(0, 0);
    let max = 0;
    for (let i = 0; i < 200; i++) {
      springBody(b, 1, 0, 6, 0.016);
      max = Math.max(max, b.x);
    }
    expect(b.x).toBeCloseTo(1, 3);
    expect(max).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('is stable for any step', () => {
    const b = body(0, 0);
    springBody(b, 1, 1, 50, 10);
    expect(b.x).toBeCloseTo(1, 6);
    expect(Number.isFinite(b.vx)).toBe(true);
  });

  it('the underdamped wobble swings past and settles', () => {
    const s = { p: 0, v: 3 };
    let min = 0;
    for (let i = 0; i < 300; i++) {
      wobble(s, 0, 9, 0.22, 0.016);
      min = Math.min(min, s.p);
    }
    expect(min).toBeLessThan(-0.01);
    expect(Math.abs(s.p)).toBeLessThan(1e-3);
  });
});

describe('motions', () => {
  it('a glide arrives exactly home and ends', () => {
    const b = body(0.2, 0.3);
    let m: Glide | null = new Glide('float');
    let frames = 0;
    while (m && frames < 1000) {
      m = m.step(b, env()) as Glide | null;
      frames++;
    }
    expect(m).toBeNull();
    expect([b.x, b.y, b.rot]).toEqual([0.5, 0.9, 0]);
    expect(frames * 16).toBeLessThan(2500);
  });

  it('a levitation completes its handle once, at the end of its duration', () => {
    let completed = 0;
    const h = new ActionHandle('c', () => {});
    const e = env({ complete: (x) => { if (x === h) completed++; } });
    const b = body();
    let m: ReturnType<Levitate['step']> = new Levitate(h, false, 0.2, 500, 'float');
    for (let i = 0; i < 40 && m; i++) m = m.step(b, e);
    expect(completed).toBe(1);
  });

  it('release() drops the handle so done() is never sent', () => {
    let called = 0;
    const h = new ActionHandle('c', () => called++);
    const m = new Levitate(h, true, 0.2, 5000, 'float');
    m.release();
    expect(h.open).toBe(false);
    expect(h.close()).toBeNull();
    expect(called).toBe(0);
  });
});

describe('scale channel', () => {
  it('holds the size for its duration, completes once, and returns to 1', () => {
    const s = new ScaleChannel();
    let completed = 0;
    s.start(1.6, 1000, new ActionHandle('g', () => {}), false);
    for (let t = 0; t < 3000; t += 16) s.step(16, false, () => completed++);
    expect(completed).toBe(1);
    expect(s.value).toBe(1);
    expect(s.active).toBe(false);
  });
});

describe('param readers', () => {
  it('keep untrusted pack values sane', () => {
    expect(num('12', 3)).toBe(3);
    expect(num(Number.POSITIVE_INFINITY, 3)).toBe(3);
    expect(num(50, 3, 0, 10)).toBe(10);
    expect(pick('follow', ['away', 'follow'] as const, 'away')).toBe('follow');
    expect(pick('sideways', ['away', 'follow'] as const, 'away')).toBe('away');
    expect(color('#BFD8FF', '#fff')).toBe('#BFD8FF');
    expect(color('red; background:url(x)', '#fff')).toBe('#fff');
  });
});

describe('change notifier', () => {
  it('publishes changes at once, moves at most every MOVE_NOTIFY_MS, and holds early changes until bound', () => {
    const stage = fakeStage();
    const n = new ChangeNotifier();
    n.changed(0);
    expect(stage.changes).toBe(0);
    n.bind(stage.services);
    expect(stage.changes).toBe(1);
    n.changed(10);
    expect(stage.changes).toBe(2);
    for (let t = 20; t < 1000; t += 16) {
      n.moved();
      n.tick(t);
    }
    expect(stage.changes - 2).toBeLessThanOrEqual(Math.ceil(1000 / MOVE_NOTIFY_MS));
    expect(stage.changes - 2).toBeGreaterThanOrEqual(3);
  });
});

describe('view cache', () => {
  it('reads the caster mapping and keeps the last good one when the mirror has no size', () => {
    const v = new ViewCache();
    v.sync(fakeStage({ width: 1000, height: 500, caster: { x: 100, y: 0, w: 800, h: 450 } }).services.view, 1);
    expect(v.px(0)).toBe(100);
    expect(v.px(1)).toBe(900);
    expect(v.pxPerH).toBe(500);
    expect(v.hToX).toBeCloseTo(500 / 800, 9);
    expect(v.hToY).toBeCloseTo(500 / 450, 9);
    v.sync(fakeStage({ width: 0, height: 0 }).services.view, 2);
    expect(v.px(1)).toBe(900);
  });
});
