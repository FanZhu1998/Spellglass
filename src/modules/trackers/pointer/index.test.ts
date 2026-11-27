// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Envelope, StageSurface, TipSample, TrackerStatus } from '../../../contracts';
import { createKernel, memoryPersistence, type KernelHost } from '../../../kernel';
import { createPointerTracker } from './index';

interface Harness {
  kernel: KernelHost;
  el: HTMLElement;
  clock: { t: number };
  events: Envelope[];
  types: () => string[];
  of: <T>(type: string) => T[];
}

const RECT = { left: 100, top: 50, width: 800, height: 600 };

async function harness(): Promise<Harness> {
  const clock = { t: 5000 };
  const kernel = createKernel({ persistence: memoryPersistence(), clock: () => clock.t, features: ['platform.pointer', 'platform.dom'] });
  const el = document.createElement('div');
  document.body.append(el);
  el.getBoundingClientRect = () => ({ ...RECT, x: RECT.left, y: RECT.top, right: RECT.left + RECT.width, bottom: RECT.top + RECT.height, toJSON: () => ({}) }) as DOMRect;
  const events: Envelope[] = [];
  kernel.subscribe('*', (e) => events.push(e));
  kernel.register(createPointerTracker({ element: el }));
  await kernel.init();
  await kernel.start();
  return {
    kernel, el, clock, events,
    types: () => events.map((e) => e.type).filter((t) => t.startsWith('tip.') || t === 'tracker.status'),
    of: <T>(type: string) => events.filter((e) => e.type === type).map((e) => e.payload as T),
  };
}

function pointer(type: string, init: PointerEventInit & { timeStamp?: number } = {}, target?: EventTarget): PointerEvent {
  const { timeStamp, ...rest } = init;
  const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, ...rest });
  if (timeStamp !== undefined) Object.defineProperty(e, 'timeStamp', { value: timeStamp });
  if (target) target.dispatchEvent(e);
  return e;
}

describe('pointer tracker', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.kernel.stop();
    h.el.remove();
  });

  it('publishes tracker.status with pen and the element aspect on start, before any tip event', () => {
    const statuses = h.of<TrackerStatus>('tracker.status');
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses[0]).toMatchObject({ tracker: 'tracker.pointer', state: 'searching', pen: true, lock: 0, hint: null });
    expect(statuses[0].aspect).toBeCloseTo(800 / 600, 10);
    expect(h.types()[0]).toBe('tracker.status');
  });

  it('finds the tip on pointerdown, samples on moves and loses it on pointerup, in order', () => {
    h.events.length = 0;
    pointer('pointerdown', { clientX: 500, clientY: 350, timeStamp: 4990 }, h.el);
    pointer('pointermove', { clientX: 580, clientY: 350, timeStamp: 5006 }, h.el);
    pointer('pointerup', { clientX: 660, clientY: 410, timeStamp: 5023 }, h.el);
    expect(h.types()).toEqual(['tracker.status', 'tip.found', 'tip.sample', 'tip.sample', 'tip.sample', 'tip.lost', 'tracker.status']);
    const [found] = h.of<TipSample>('tip.found');
    const samples = h.of<TipSample>('tip.sample');
    // Rule 2: the found carries the same t and position as the first sample.
    expect(found).toEqual(samples[0]);
    expect(samples[0]).toEqual({ t: 4990, x: 0.5, y: 0.5, conf: 1, src: 'tracker.pointer' });
    expect(samples[1]).toMatchObject({ t: 5006, x: 0.6, y: 0.5 });
    expect(samples[2]).toMatchObject({ t: 5023, x: 0.7, y: 0.6 });
    const lost = h.of<{ t: number; src: string; lastSeen: number }>('tip.lost')[0];
    expect(lost).toEqual({ t: 5023, src: 'tracker.pointer', lastSeen: 5023 });
    const statuses = h.of<TrackerStatus>('tracker.status');
    expect(statuses.map((s) => s.state)).toEqual(['tracking', 'searching']);
    // Envelope times are the capture times.
    expect(h.events.find((e) => e.type === 'tip.found')!.t).toBe(4990);
  });

  it('does not repeat the last point on pointerup when the pointer did not move', () => {
    pointer('pointerdown', { clientX: 500, clientY: 350, timeStamp: 4990 }, h.el);
    pointer('pointerup', { clientX: 500, clientY: 350, timeStamp: 5000 }, h.el);
    expect(h.of('tip.sample')).toHaveLength(1);
    expect(h.of<{ lastSeen: number }>('tip.lost')[0].lastSeen).toBe(4990);
  });

  it('maps through the stage caster rectangle and republishes status when the aspect changes', () => {
    const surface = {
      mirror: h.el, caster: { x: 0, y: 75, width: 800, height: 450 }, aspect: 16 / 9, video: null, videoMirrored: true,
      layers: [], width: 800, height: 600, dpr: 1,
    } as StageSurface;
    h.events.length = 0;
    h.kernel.emit('stage.surface', surface, 'effects.stage');
    const status = h.of<TrackerStatus>('tracker.status');
    expect(status).toHaveLength(1);
    expect(status[0].aspect).toBeCloseTo(16 / 9, 10);
    expect(status[0]).toMatchObject({ width: 800, height: 450, pen: true });
    pointer('pointerdown', { clientX: 300, clientY: 350, timeStamp: 4999 }, h.el);
    const [s] = h.of<TipSample>('tip.sample');
    expect(s.x).toBeCloseTo(0.25, 5);
    expect(s.y).toBeCloseTo(0.5, 5);
    // The same surface again changes nothing.
    h.events.length = 0;
    h.kernel.emit('stage.surface', surface, 'effects.stage');
    expect(h.of('tracker.status')).toHaveLength(0);
  });

  it('ignores a surface that describes another element', () => {
    const other = document.createElement('div');
    h.kernel.emit('stage.surface', { mirror: other, caster: { x: 0, y: 75, width: 800, height: 450 }, aspect: 16 / 9, video: null, videoMirrored: true, layers: [], width: 800, height: 600, dpr: 1 } as StageSurface, 'effects.stage');
    pointer('pointerdown', { clientX: 500, clientY: 50, timeStamp: 4999 }, h.el);
    expect(h.of<TipSample>('tip.sample')[0].y).toBe(0);
  });

  it('publishes coalesced samples, thinned to 8 ms', () => {
    pointer('pointerdown', { clientX: 500, clientY: 350, timeStamp: 4980 }, h.el);
    // A 1000 Hz mouse: 16 coalesced samples in one frame (plain objects: jsdom re-wraps real ones).
    const coalesced = Array.from({ length: 16 }, (_, i) => ({ pointerId: 1, clientX: 500 + (i + 1) * 5, clientY: 350, timeStamp: 4981 + i }));
    const move = pointer('pointermove', { clientX: 580, clientY: 350, timeStamp: 4996 });
    Object.defineProperty(move, 'getCoalescedEvents', { value: () => coalesced });
    h.el.dispatchEvent(move);
    const samples = h.of<TipSample>('tip.sample');
    expect(samples.map((s) => s.t)).toEqual([4980, 4988, 4996]);
    // The kept coalesced samples: i = 7 (x 540) and the last one, i = 15 (x 580).
    expect(samples[1].x).toBeCloseTo(440 / 800, 5);
    expect(samples[2].x).toBeCloseTo(480 / 800, 5);
  });

  it('treats pointercancel and lostpointercapture as tip.lost', () => {
    pointer('pointerdown', { clientX: 500, clientY: 350, timeStamp: 4990 }, h.el);
    pointer('pointercancel', { timeStamp: 4995 }, h.el);
    pointer('pointerdown', { clientX: 500, clientY: 350, timeStamp: 4996 }, h.el);
    pointer('lostpointercapture', { timeStamp: 4998 }, h.el);
    // A lostpointercapture after pointerup is not a second loss.
    pointer('lostpointercapture', { timeStamp: 4999 }, h.el);
    expect(h.types().filter((t) => t.startsWith('tip.'))).toEqual(['tip.found', 'tip.sample', 'tip.lost', 'tip.found', 'tip.sample', 'tip.lost']);
    expect(h.of<{ t: number }>('tip.lost').map((l) => l.t)).toEqual([4995, 4998]);
  });

  it('follows one pointer: other buttons, other fingers and shell controls are left alone', () => {
    pointer('pointerdown', { button: 2, clientX: 500, clientY: 350 }, h.el);
    const button = document.createElement('button');
    h.el.append(button);
    pointer('pointerdown', { clientX: 500, clientY: 350 }, button);
    expect(h.of('tip.found')).toHaveLength(0);
    pointer('pointerdown', { pointerId: 7, pointerType: 'touch', clientX: 500, clientY: 350, timeStamp: 4990 }, h.el);
    pointer('pointerdown', { pointerId: 8, pointerType: 'touch', isPrimary: false, clientX: 600, clientY: 350, timeStamp: 4991 }, h.el);
    pointer('pointermove', { pointerId: 8, pointerType: 'touch', isPrimary: false, clientX: 650, clientY: 350, timeStamp: 4992 }, h.el);
    pointer('pointerup', { pointerId: 8, pointerType: 'touch', isPrimary: false, timeStamp: 4993 }, h.el);
    expect(h.of('tip.found')).toHaveLength(1);
    expect(h.of('tip.sample')).toHaveLength(1);
    expect(h.of('tip.lost')).toHaveLength(0);
  });

  it('prevents text selection on the stroke it follows', () => {
    const e = pointer('pointerdown', { clientX: 500, clientY: 350 });
    h.el.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it('uses the kernel clock when an event stamp is not on it', () => {
    h.clock.t = 7777;
    pointer('pointerdown', { clientX: 500, clientY: 350, timeStamp: 1.7e12 }, h.el);
    expect(h.of<TipSample>('tip.sample')[0].t).toBe(7777);
  });

  it('never lets capture times run backwards', () => {
    pointer('pointerdown', { clientX: 500, clientY: 350, timeStamp: 4990 }, h.el);
    pointer('pointermove', { clientX: 510, clientY: 350, timeStamp: 4980 }, h.el);
    expect(h.of<TipSample>('tip.sample').map((s) => s.t)).toEqual([4990, 4990]);
  });

  it('loses a held tip on stop, publishes stopped, and removes every listener', async () => {
    pointer('pointerdown', { clientX: 500, clientY: 350, timeStamp: 4990 }, h.el);
    h.clock.t = 5100;
    await h.kernel.stop();
    const after = h.types();
    expect(after.slice(-2)).toEqual(['tip.lost', 'tracker.status']);
    expect(h.of<{ t: number; lastSeen: number }>('tip.lost')[0]).toMatchObject({ t: 5100, lastSeen: 4990 });
    expect(h.of<TrackerStatus>('tracker.status').at(-1)!.state).toBe('stopped');
    h.events.length = 0;
    pointer('pointerdown', { clientX: 500, clientY: 350, timeStamp: 5200 }, h.el);
    pointer('pointermove', { clientX: 510, clientY: 350, timeStamp: 5210 }, h.el);
    expect(h.events.filter((e) => e.type.startsWith('tip.'))).toHaveLength(0);
    // Restart for afterEach's stop (harmless when already stopped).
    await h.kernel.start();
  });

  it('sets touch-action only when nothing above the element does, and restores it on stop', async () => {
    // The harness element has no touch-action anywhere above it: the tracker set it.
    expect(h.el.style.touchAction).toBe('none');
    await h.kernel.stop();
    expect(h.el.style.touchAction).toBe('');

    const parent = document.createElement('div');
    parent.style.touchAction = 'none';
    const inner = document.createElement('div');
    parent.append(inner);
    document.body.append(parent);
    const k2 = createKernel({ persistence: memoryPersistence(), features: ['platform.pointer'] });
    k2.register(createPointerTracker({ element: inner }));
    await k2.init();
    await k2.start();
    expect(inner.style.touchAction).toBe('');
    await k2.stop();
    parent.remove();
    await h.kernel.start();
  });
});
