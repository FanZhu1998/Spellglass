// Filter and segmenter (segmenter.hold-still): tip positions to strokes (Section 7.4). This file is
// the thin module: it feeds kernel events into the pure state machine (segmenter.ts, which owns the
// One Euro filter of filter.ts), publishes what comes back in order, and drives time with a ticker.
// All the behavior lives in those files and is unit-tested without a browser.
//
// Inputs:  tip.sample, tip.found, tip.lost, tracker.status (kept per tracker); spell.cast,
//          spell.fizzle and spell.pending (the decision on our stroke); replay.state and voice.status;
//          settings filter.*, segmenter.*, playArea and engine.mode.
// Outputs: tip.filtered (every sample, at once, same t and src), segmenter.state, stroke.begin,
//          stroke.end.
// Requests handled: segmenter.pause, segmenter.capture.
//
// Voice-only casting pauses the segmenter (pausedFor 'voice-only') while the voice module says it is
// ready or listening. The brief says "while engine.mode is 'voice'"; the spell engine plays every
// mode by gesture rules whenever voice is not working (Section 7.9: gesture play is unaffected), so
// pausing then would leave a player with no way to cast at all. The two modules agree this way.

import type { Kernel, Module, ModuleManifest, Stroke } from '../../contracts';
import { KernelError, emit, lastPayload, newId, on, serve, setting } from '../../kernel';
import type { SegmenterOutput, SegmenterSettings } from './segmenter';
import { DEFAULT_SEGMENTER_SETTINGS, Segmenter } from './segmenter';

export const MANIFEST: ModuleManifest = {
  id: 'segmenter.hold-still',
  kind: 'segmenter',
  title: 'Filter and segmenter',
  version: '1.0.0',
  contract: '^1.1',
  provides: ['stroke.source'],
  requires: [],
};

/** Timeouts need time to pass when no samples arrive (a tip lost mid-stroke, a cooldown). The timer
 *  only wakes the machine; it decides from kernel.now() and capture times. */
export const TICK_MS = 40;
/** How long 'segmenter.capture' waits when the caller gives no timeout. */
export const DEFAULT_CAPTURE_TIMEOUT_MS = 60_000;

const SETTING_KEYS = new Set([
  'filter.minCutoff', 'filter.beta', 'filter.dCutoff', 'segmenter.mode', 'segmenter.armMs', 'segmenter.armRadius',
  'segmenter.pauseMs', 'segmenter.pauseRadius', 'segmenter.lostMs', 'segmenter.maxMs', 'segmenter.minSamples',
  'segmenter.minExtent', 'segmenter.cooldownMs', 'segmenter.evaluateTimeoutMs', 'playArea',
]);

export function createStrokeModule(): Module {
  let kernel: Kernel | null = null;
  let machine: Segmenter | null = null;
  let running = false;
  let ticker: ReturnType<typeof setInterval> | null = null;
  let capture: { resolve: (stroke: Stroke | null) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let voiceUsable = false;

  // Publishing goes through one queue. A stroke.end published here can come back as a decision (and
  // our own segmenter.state) before emit() returns; queueing keeps everything in the order the
  // machine produced it.
  const queue: SegmenterOutput[] = [];
  let flushing = false;

  const flush = (outs: SegmenterOutput[]): void => {
    const k = kernel;
    if (!k || !running) return;
    queue.push(...outs);
    if (flushing) return;
    flushing = true;
    try {
      while (queue.length) publish(k, queue.shift()!);
    } finally {
      flushing = false;
    }
  };

  const publish = (k: Kernel, o: SegmenterOutput): void => {
    switch (o.type) {
      case 'tip.filtered':
        // Tip data carries its capture time on the envelope too (kernel/typed.ts emit).
        emit(k, MANIFEST.id, 'tip.filtered', o.payload, o.payload.t);
        break;
      case 'segmenter.state':
        emit(k, MANIFEST.id, 'segmenter.state', o.payload);
        break;
      case 'stroke.begin':
        emit(k, MANIFEST.id, 'stroke.begin', o.payload);
        break;
      case 'stroke.end':
        emit(k, MANIFEST.id, 'stroke.end', o.payload);
        break;
      case 'captured':
        settleCapture(o.payload);
        break;
    }
  };

  const settleCapture = (stroke: Stroke | null): void => {
    const c = capture;
    if (!c) return;
    capture = null;
    clearTimeout(c.timer);
    c.resolve(stroke);
  };

  /** Feed the machine while running; while stopped, inputs that are state (trackers, pauses) are
   *  still recorded, and the outputs are dropped. */
  const feed = (fn: (m: Segmenter, now: number) => SegmenterOutput[], always = false): void => {
    const k = kernel;
    const m = machine;
    if (!k || !m || (!running && !always)) return;
    const out = fn(m, k.now());
    if (running) flush(out);
  };

  const applyVoicePause = (): void => {
    const k = kernel;
    if (!k) return;
    const voiceOnly = setting(k, 'engine.mode') === 'voice' && voiceUsable;
    feed((m, now) => m.setAutoPause('voice-only', voiceOnly, now), true);
  };

  return {
    manifest: MANIFEST,

    async init(k) {
      kernel = k;
      machine = new Segmenter({ settings: readSettings(k), newId });

      // Tracker state is recorded from the start: trackers may report before this module runs.
      const status = lastPayload(k, 'tracker.status');
      if (status) machine.status(status, k.now());
      on(k, 'tracker.status', (s) => feed((m, now) => m.status(s, now), true));

      on(k, 'tip.found', (s) => feed((m, now) => m.found(s, now)));
      on(k, 'tip.sample', (s) => feed((m, now) => m.sample(s, now)));
      on(k, 'tip.lost', (e) => feed((m, now) => m.lost(e, now)));
      on(k, 'spell.cast', (c) => feed((m, now) => m.decided(c?.strokeId, 'cast', now)));
      on(k, 'spell.fizzle', (f) => feed((m, now) => m.decided(f?.strokeId, 'fizzle', now)));
      on(k, 'spell.pending', (p) => feed((m, now) => m.pending(p?.strokeId, p?.until, now)));

      on(k, 'replay.state', (r) => feed((m, now) => m.setAutoPause('replay', !!r?.playing, now), true));
      on(k, 'voice.status', (v) => {
        voiceUsable = v?.state === 'ready' || v?.state === 'listening';
        applyVoicePause();
      });
      on(k, 'settings.changed', ({ key }) => {
        if (key === 'engine.mode') applyVoicePause();
        if (SETTING_KEYS.has(key)) feed((m, now) => m.configure(readSettings(k), now), true);
      });

      // Requests are registered in init(), so other modules can ask from their start() on.
      serve(k, 'segmenter.pause', (p) => {
        if (!p || typeof p.paused !== 'boolean') throw new KernelError('invalid-payload', 'segmenter.pause needs { paused: boolean }');
        feed((m, now) => m.setRequestPause(p.paused, typeof p.reason === 'string' ? p.reason : undefined, now), true);
      });
      serve(k, 'segmenter.capture', (p) => {
        const ms = p && typeof p.timeoutMs === 'number' && p.timeoutMs >= 0 ? p.timeoutMs : DEFAULT_CAPTURE_TIMEOUT_MS;
        // One capture at a time: a newer request replaces an older one, which gets null.
        settleCapture(null);
        return new Promise<Stroke | null>((resolve) => {
          const timer = setTimeout(() => {
            if (capture?.timer !== timer) return;
            settleCapture(null);
            feed((m, now) => m.setCapture(false, now), true);
          }, ms);
          capture = { resolve, timer };
          feed((m, now) => m.setCapture(true, now), true);
        });
      });
    },

    async start() {
      const k = kernel;
      const m = machine;
      if (!k || !m || running) return;
      // Sticky state published while stopped.
      m.configure(readSettings(k), k.now());
      const status = lastPayload(k, 'tracker.status');
      if (status) m.status(status, k.now());
      const voice = lastPayload(k, 'voice.status');
      voiceUsable = voice?.state === 'ready' || voice?.state === 'listening';
      m.setAutoPause('voice-only', setting(k, 'engine.mode') === 'voice' && voiceUsable, k.now());
      m.setAutoPause('replay', !!lastPayload(k, 'replay.state')?.playing, k.now());
      running = true;
      flush(m.start(k.now()));
      ticker = setInterval(() => feed((mm, now) => mm.tick(now)), TICK_MS);
    },

    async stop() {
      const k = kernel;
      const m = machine;
      if (!k || !m || !running) return;
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
      settleCapture(null);
      // The last status goes out while still running, then nothing more.
      flush(m.stop(k.now()));
      running = false;
      queue.length = 0;
    },
  };
}

/** Settings, checked: a value of the wrong type or out of range falls back to its default. */
export function readSettings(k: Kernel): SegmenterSettings {
  const d = DEFAULT_SEGMENTER_SETTINGS;
  const mode = setting(k, 'segmenter.mode');
  return {
    mode: mode === 'auto' || mode === 'hold-still' || mode === 'pen' ? mode : d.mode,
    armMs: num(setting(k, 'segmenter.armMs'), d.armMs),
    armRadius: num(setting(k, 'segmenter.armRadius'), d.armRadius),
    pauseMs: num(setting(k, 'segmenter.pauseMs'), d.pauseMs),
    pauseRadius: num(setting(k, 'segmenter.pauseRadius'), d.pauseRadius),
    lostMs: num(setting(k, 'segmenter.lostMs'), d.lostMs),
    maxMs: num(setting(k, 'segmenter.maxMs'), d.maxMs),
    minSamples: num(setting(k, 'segmenter.minSamples'), d.minSamples),
    minExtent: num(setting(k, 'segmenter.minExtent'), d.minExtent),
    cooldownMs: num(setting(k, 'segmenter.cooldownMs'), d.cooldownMs),
    evaluateTimeoutMs: num(setting(k, 'segmenter.evaluateTimeoutMs'), d.evaluateTimeoutMs),
    playArea: setting(k, 'playArea') ?? d.playArea,
    filter: {
      minCutoff: num(setting(k, 'filter.minCutoff'), d.filter.minCutoff),
      beta: num(setting(k, 'filter.beta'), d.filter.beta),
      dCutoff: num(setting(k, 'filter.dCutoff'), d.filter.dCutoff),
    },
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;
}

// The pure pieces, for tools (the gesture lab may run the real segmenter over recordings) and tests.
export { Segmenter, DEFAULT_SEGMENTER_SETTINGS } from './segmenter';
export type { SegmenterOutput, SegmenterSettings, SegmenterMode } from './segmenter';
export { OneEuroFilter, TipFilter } from './filter';
export type { OneEuroParams } from './filter';
export { strokeQuality } from './quality';
