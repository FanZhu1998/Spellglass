// The module through a real kernel and bus, with fake timers driving the ticker. A stand-in engine
// answers stroke.end from inside its handler, as the real one does, so the bus's run-to-completion
// order is exercised.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope, EventMap, SegmenterStatus, Stroke, TipSample } from '../../contracts';
import type { KernelHost } from '../../kernel';
import { ask, createKernel, emit, memoryPersistence, on } from '../../kernel';
import { createStrokeModule, MANIFEST, TICK_MS } from './index';

const FRAME = 33;
const CAMERA = 'tracker.bright-tip';
const POINTER = 'tracker.pointer';

type Seen = { type: string; t: number; payload: unknown };

/** The filter defaults this package recommends (settingsDefaults in its report), so these tests do not
 *  depend on DEFAULT_SETTINGS; filter.test.ts covers the tuning. */
const FILTER = { 'filter.minCutoff': 1, 'filter.beta': 20, 'filter.dCutoff': 1 };

async function boot(settings: Record<string, unknown> = {}, before?: (k: KernelHost) => void) {
  const kernel = createKernel({ persistence: memoryPersistence({ ...FILTER, ...settings }), features: [], clock: () => Date.now() });
  kernel.register(createStrokeModule());
  await kernel.init();
  before?.(kernel);
  const seen: Seen[] = [];
  kernel.subscribe('*', (e: Envelope<unknown>) => {
    if (e.source === MANIFEST.id) seen.push({ type: e.type, t: e.t, payload: e.payload });
  });
  await kernel.start();
  return { kernel, seen };
}

/** A tracker publishing at the fake clock's time, one frame every 33 ms. */
function tracker(kernel: KernelHost, src = CAMERA) {
  const sample = (x: number, y: number): TipSample => ({ t: Date.now(), x, y, conf: 0.9, src });
  const api = {
    status(pen = false, aspect = 16 / 9) {
      emit(kernel, src, 'tracker.status', { tracker: src, state: 'tracking', lock: 1, fps: 30, aspect, pen });
      return api;
    },
    found(x: number, y: number) {
      const s = sample(x, y);
      emit(kernel, src, 'tip.found', s, s.t);
      return api;
    },
    frame(x: number, y: number) {
      const s = sample(x, y);
      emit(kernel, src, 'tip.sample', s, s.t);
      vi.advanceTimersByTime(FRAME);
      return api;
    },
    hold(x: number, y: number, ms: number) {
      for (let i = 0; i < Math.round(ms / FRAME); i++) api.frame(x, y);
      return api;
    },
    move(a: [number, number], b: [number, number], ms: number) {
      const n = Math.max(1, Math.round(ms / FRAME));
      for (let i = 1; i <= n; i++) api.frame(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n);
      return api;
    },
    lost() {
      emit(kernel, src, 'tip.lost', { t: Date.now(), src });
      return api;
    },
  };
  return api;
}

/** Found, held, traced right and up, paused (as long as the recorded sessions pause). */
function castOne(tr: ReturnType<typeof tracker>) {
  return tr.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.6, 0.5], 500).move([0.6, 0.5], [0.6, 0.3], 400).hold(0.6, 0.3, 450);
}

/** Stand in for the recognizer and engine: decide every stroke.end at once, from inside the handler. */
function decideWith(kernel: KernelHost, kind: 'cast' | 'fizzle') {
  on(kernel, 'stroke.end', (s) => {
    if (kind === 'cast') emit(kernel, 'engine.rules', 'spell.cast', { id: `cast-${s.id}`, spellId: 'lumos', t: s.t1, via: 'gesture', quality: 0.9, power: 0.5, aim: { x: 0, y: 0 }, strokeId: s.id });
    else emit(kernel, 'engine.rules', 'spell.fizzle', { id: `fizzle-${s.id}`, t: s.t1, strokeId: s.id, reason: 'low-score', quality: 0.4 });
  });
}

const of = <K extends keyof EventMap>(seen: Seen[], type: K) => seen.filter((e) => e.type === type).map((e) => e.payload as EventMap[K]);
const states = (seen: Seen[]) => {
  const seq: string[] = [];
  for (const s of of(seen, 'segmenter.state')) if (seq[seq.length - 1] !== s.state) seq.push(s.state);
  return seq;
};

describe('stroke module', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the manifest id and kind the app depends on', () => {
    expect(MANIFEST).toMatchObject({ id: 'segmenter.hold-still', kind: 'segmenter', contract: '^1.1', version: '1.0.0', provides: ['stroke.source'] });
  });

  it('reports searching on start and publishes tip.filtered for every sample at once, same t and src', async () => {
    const { kernel, seen } = await boot();
    expect(of(seen, 'segmenter.state')[0]).toMatchObject({ state: 'searching', mode: 'hold-still' });
    const tr = tracker(kernel).status();
    let filteredDuringCascade = 0;
    on(kernel, 'tip.sample', () => {
      filteredDuringCascade = of(seen, 'tip.filtered').length;
    });
    tr.found(0.5, 0.5).frame(0.5, 0.5);
    // Published in the same cascade as the sample (it is delivered after the sample's subscribers).
    expect(of(seen, 'tip.filtered')).toHaveLength(1);
    expect(filteredDuringCascade).toBe(0);
    tr.hold(0.51, 0.5, 200);
    const filtered = seen.filter((e) => e.type === 'tip.filtered');
    expect(filtered).toHaveLength(7);
    for (const e of filtered) {
      const p = e.payload as TipSample;
      expect(p.src).toBe(CAMERA);
      expect(e.t).toBe(p.t);
    }
  });

  it('casts through the bus: state before stroke.end, the decision after, cooldown then hovering on ticks', async () => {
    const { kernel, seen } = await boot();
    decideWith(kernel, 'cast');
    castOne(tracker(kernel).status());
    const order = seen.filter((e) => e.type !== 'tip.filtered').map((e) => (e.type === 'segmenter.state' ? (e.payload as SegmenterStatus).state : e.type));
    expect(order.filter((x, i) => order[i - 1] !== x)).toEqual(['searching', 'hovering', 'armed', 'tracing', 'stroke.begin', 'evaluating', 'stroke.end', 'cooldown']);
    const stroke = of(seen, 'stroke.end')[0];
    expect(stroke).toMatchObject({ src: CAMERA, aspect: 16 / 9, endReason: 'pause' });
    expect(stroke.points.length).toBeGreaterThan(20);
    // No samples at all: the ticker ends the cooldown.
    tracker(kernel).lost();
    vi.advanceTimersByTime(400 + TICK_MS);
    expect(states(seen).slice(-2)).toEqual(['cooldown', 'searching']);
  });

  it('a fizzle goes straight back to hovering', async () => {
    const { kernel, seen } = await boot();
    decideWith(kernel, 'fizzle');
    castOne(tracker(kernel).status());
    expect(states(seen).slice(-2)).toEqual(['evaluating', 'hovering']);
  });

  it('ends a stroke lostMs after the samples stop, without tip.lost', async () => {
    const { kernel, seen } = await boot();
    const tr = tracker(kernel).status();
    tr.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.6, 0.5], 500);
    const last = of(seen, 'tip.filtered').pop()!;
    vi.advanceTimersByTime(150);
    expect(of(seen, 'stroke.end')).toHaveLength(0);
    vi.advanceTimersByTime(100);
    expect(of(seen, 'stroke.end')).toMatchObject([{ endReason: 'lost', t1: last.t }]);
  });

  it('waits evaluateTimeoutMs for a decision that never comes, and honours spell.pending', async () => {
    const { kernel, seen } = await boot();
    on(kernel, 'stroke.end', (s) => emit(kernel, 'engine.rules', 'spell.pending', { strokeId: s.id, until: Date.now() + 3000, waitingFor: 'voice' }));
    castOne(tracker(kernel).status()).lost();
    vi.advanceTimersByTime(3000);
    expect(states(seen).pop()).toBe('evaluating');
    vi.advanceTimersByTime(300);
    expect(states(seen).pop()).toBe('searching');
  });

  it('keeps tracker.status per tracker: pointer trackers get pen mode', async () => {
    const { kernel, seen } = await boot();
    decideWith(kernel, 'fizzle');
    tracker(kernel, CAMERA).status(false);
    const pointer = tracker(kernel, POINTER).status(true);
    pointer.found(0.2, 0.2).frame(0.2, 0.2).move([0.2, 0.2], [0.7, 0.6], 500).lost();
    expect(of(seen, 'stroke.end')).toMatchObject([{ src: POINTER, endReason: 'pen-up' }]);
    expect(of(seen, 'segmenter.state').pop()).toMatchObject({ mode: 'pen' });
    // The camera's tip uses the camera's status again: hold-still.
    tracker(kernel, CAMERA).found(0.5, 0.5).hold(0.5, 0.5, 400);
    expect(of(seen, 'segmenter.state').pop()).toMatchObject({ state: 'armed', mode: 'hold-still' });
  });

  it('segmenter.mode forces a rule; settings changes apply at once', async () => {
    const { kernel, seen } = await boot({ 'segmenter.mode': 'pen' });
    const tr = tracker(kernel).status(false);
    tr.found(0.2, 0.5);
    expect(states(seen).pop()).toBe('tracing');
    tr.lost();
    await ask(kernel, 'settings.set', { key: 'segmenter.mode', value: 'hold-still' });
    await ask(kernel, 'settings.set', { key: 'segmenter.armMs', value: 600 });
    tr.found(0.5, 0.5).hold(0.5, 0.5, 450);
    expect(states(seen).pop()).toBe('hovering');
    tr.hold(0.5, 0.5, 200);
    expect(states(seen).pop()).toBe('armed');
  });

  it('serves segmenter.pause: paused with pausedFor, tip.filtered keeps flowing, then resumes', async () => {
    const { kernel, seen } = await boot();
    const tr = tracker(kernel).status();
    await ask(kernel, 'segmenter.pause', { paused: true, reason: 'workshop' });
    expect(of(seen, 'segmenter.state').pop()).toMatchObject({ state: 'paused', pausedFor: 'workshop' });
    castOne(tr);
    expect(of(seen, 'stroke.begin')).toHaveLength(0);
    expect(of(seen, 'tip.filtered').length).toBeGreaterThan(40);
    await ask(kernel, 'segmenter.pause', { paused: false, reason: 'workshop' });
    expect(of(seen, 'segmenter.state').pop()).toMatchObject({ state: 'hovering' });
    await expect(ask(kernel, 'segmenter.pause', {} as never)).rejects.toMatchObject({ code: 'invalid-payload' });
  });

  it('pauses for voice-only casting while voice works, not when it does not', async () => {
    const { kernel, seen } = await boot({ 'engine.mode': 'voice' });
    // No voice status yet: voice is not working, so gestures still cast (Section 7.9).
    expect(states(seen).pop()).toBe('searching');
    emit(kernel, 'voice.web-speech', 'voice.status', { state: 'listening', local: true });
    expect(of(seen, 'segmenter.state').pop()).toMatchObject({ state: 'paused', pausedFor: 'voice-only' });
    emit(kernel, 'voice.web-speech', 'voice.status', { state: 'error', local: true });
    expect(states(seen).pop()).toBe('searching');
    emit(kernel, 'voice.web-speech', 'voice.status', { state: 'ready', local: true });
    await ask(kernel, 'settings.set', { key: 'engine.mode', value: 'gesture' });
    expect(states(seen).slice(-2)).toEqual(['paused', 'searching']);
  });

  it('pauses while a replay plays on the stage, also when it was already playing at start', async () => {
    const { seen, kernel } = await boot({}, (k) => emit(k, 'effect.stage', 'replay.state', { playing: true, castId: 'c1' }));
    expect(of(seen, 'segmenter.state')[0]).toMatchObject({ state: 'paused', pausedFor: 'replay' });
    emit(kernel, 'effect.stage', 'replay.state', { playing: false });
    expect(states(seen).pop()).toBe('searching');
  });

  it('serves segmenter.capture: the next stroke resolves the request and is never published as stroke.end', async () => {
    const { kernel, seen } = await boot();
    const got = ask(kernel, 'segmenter.capture', { timeoutMs: 10_000 });
    castOne(tracker(kernel).status());
    const stroke = (await got) as Stroke;
    expect(stroke).toMatchObject({ src: CAMERA, endReason: 'pause' });
    expect(of(seen, 'stroke.end')).toHaveLength(0);
    expect(of(seen, 'segmenter.state').find((s) => s.captured)).toMatchObject({ captured: true, strokeId: stroke.id });
  });

  it('segmenter.capture resolves null on timeout, and a newer request replaces an older one', async () => {
    const { kernel } = await boot();
    const first = ask(kernel, 'segmenter.capture', { timeoutMs: 5000 });
    const second = ask(kernel, 'segmenter.capture', { timeoutMs: 1000 });
    await expect(first).resolves.toBeNull();
    vi.advanceTimersByTime(1000);
    await expect(second).resolves.toBeNull();
  });

  it('stops cleanly: no ticks, no output, a pending capture gets null; it can start again', async () => {
    const { kernel, seen } = await boot();
    const tr = tracker(kernel).status();
    tr.found(0.3, 0.5).hold(0.3, 0.5, 400).move([0.3, 0.5], [0.5, 0.5], 300);
    const capture = ask(kernel, 'segmenter.capture', undefined);
    await kernel.stop();
    await expect(capture).resolves.toBeNull();
    expect(of(seen, 'segmenter.state').pop()).toMatchObject({ state: 'searching', discarded: 'interrupted' });
    const count = seen.length;
    tr.hold(0.5, 0.5, 500);
    vi.advanceTimersByTime(5000);
    expect(seen.length).toBe(count);
    expect(vi.getTimerCount()).toBe(0);
    await kernel.start();
    expect(of(seen, 'segmenter.state').pop()).toMatchObject({ state: 'searching' });
    castOne(tr);
    expect(of(seen, 'stroke.end')).toHaveLength(1);
  });
});
