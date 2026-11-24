// A headless pipeline for recorded-session tests (Section 13 "Recorded sessions"): the real kernel,
// pack loader, segmenter, recognizer and spell engine, fed a RecordedSession under fake timers.
// Effects are a stand-in module that only declares the capabilities packs need.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import type { Module, RecordedSession, SegmentationNeeds, SessionEvent, SpellCast, SpellFizzle } from '../../src/contracts';
import { EFFECT_CAPABILITY, eventVersion } from '../../src/contracts';
import { createKernel, memoryPersistence, on, type KernelHost } from '../../src/kernel';
import { createStrokeModule } from '../../src/modules/stroke';
import { createTemplateRecognizer } from '../../src/modules/recognizers/template';
import { createSpellEngine } from '../../src/modules/spell-engine';
import { SEGMENTATION } from '../../src/modules/trackers/hand/tracking';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const PACK_INDEX_URL = 'http://spellglass.test/packs/index.json';

/** fetch that serves public/ from disk. */
export const fileFetch: typeof fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const path = `${ROOT}public${decodeURIComponent(url.pathname)}`;
  try {
    const bytes = readFileSync(path);
    return new Response(bytes, { status: 200, headers: { 'content-type': 'application/json' } });
  } catch {
    return new Response('not found', { status: 404 });
  }
};

/** Declares every effect capability and primitive, so no spell is unavailable and no step skipped. */
export function fakeEffects(): Module {
  const uses = Object.keys(EFFECT_CAPABILITY);
  return {
    manifest: {
      id: 'effect.test', kind: 'effect', version: '1.0.0', contract: '^1.1',
      provides: [...new Set(Object.values(EFFECT_CAPABILITY))], effects: uses,
    },
    async init() {},
    async start() {},
    async stop() {},
  };
}

export interface Decision {
  kind: 'cast' | 'fizzle';
  spellId: string | null;
  /** ms since the session started, on the capture clock */
  t: number;
  cast?: SpellCast;
  fizzle?: SpellFizzle;
}

export interface Pipeline {
  kernel: KernelHost;
  t0: number;
  decisions: Decision[];
  dispose(): Promise<void>;
}

export async function createPipeline(settings: Record<string, unknown> = {}): Promise<Pipeline> {
  const kernel = createKernel({
    persistence: memoryPersistence({ 'spells.unlockAll': true, ...settings }),
    features: ['platform.dom', 'platform.pointer'],
    fetch: fileFetch,
  });
  kernel.register(createStrokeModule(), createTemplateRecognizer(), createSpellEngine(), fakeEffects());
  await kernel.init();
  await kernel.loadPacks(PACK_INDEX_URL);
  await kernel.start();
  const t0 = kernel.now();
  const decisions: Decision[] = [];
  const offs = [
    on(kernel, 'spell.cast', (c) => decisions.push({ kind: 'cast', spellId: c.spellId, t: c.t - t0, cast: c })),
    on(kernel, 'spell.fizzle', (f) => decisions.push({ kind: 'fizzle', spellId: null, t: f.t - t0, fizzle: f })),
  ];
  return {
    kernel,
    t0,
    decisions,
    async dispose() {
      offs.forEach((off) => off());
      await kernel.stop();
    },
  };
}

/** Feed a session's events at their recorded times. Requires vi.useFakeTimers() with performance faked.
 *  The tracker's status carries the session's segmentation needs when it has some (contracts 1.2), as
 *  the replay tracker's does, so the samples are segmented as they were when recorded. */
export async function play(p: Pipeline, session: RecordedSession, tailMs = 3000): Promise<void> {
  const { kernel, t0 } = p;
  const src = session.tracker || 'tracker.bright-tip';
  kernel.publish({
    type: 'tracker.status', v: 1, t: t0, source: src,
    payload: {
      tracker: src, state: 'tracking', lock: 1, fps: 30, aspect: session.aspect, pen: session.pen ?? false,
      ...(session.segmentation ? { segmentation: session.segmentation } : {}),
    },
  });
  let now = 0;
  for (const e of session.events) {
    if (e.t > now) {
      await vi.advanceTimersByTimeAsync(e.t - now);
      now = e.t;
    }
    const t = t0 + e.t;
    switch (e.type) {
      case 'tip.sample':
      case 'tip.found':
        kernel.publish({ type: e.type, v: eventVersion(e.type), t, source: src, payload: { t, x: e.x, y: e.y, conf: e.conf, src, size: 'size' in e ? e.size : undefined } });
        break;
      case 'tip.lost':
        kernel.publish({ type: 'tip.lost', v: 1, t, source: src, payload: { t, src, lastSeen: e.lastSeen !== undefined ? t0 + e.lastSeen : undefined } });
        break;
      case 'voice.incantation':
        kernel.publish({ type: 'voice.incantation', v: 1, t, source: 'voice.test', payload: { ...e, t, t0: e.t0 !== undefined ? t0 + e.t0 : undefined, t1: e.t1 !== undefined ? t0 + e.t1 : undefined } });
        break;
    }
  }
  await vi.advanceTimersByTimeAsync(tailMs);
}

export function loadSession(path: string): RecordedSession {
  return JSON.parse(readFileSync(path, 'utf8')) as RecordedSession;
}

/** The hand tracker's segmentation needs, a plain copy as its tracker.status carries them. */
export const HAND_NEEDS: SegmentationNeeds = { ...SEGMENTATION };

/**
 * A cast as the hand tracker reports one, at 30 fps, in session events (times from the session's start):
 * held still to arm, traced right with a 350 ms dropout in the middle (frames without a hand, which the
 * tracker bridges: it keeps the tip for 400 ms), a stop of about 230 ms at a corner, then down, at rest,
 * and the hand lost. Segmented with HAND_NEEDS it is one stroke across the dropout, ending in a pause
 * at (0.65, 0.3); with the settings alone the stroke is cut at the dropout, at (0.5, 0.5).
 */
export function handCastEvents(): SessionEvent[] {
  const dt = 1000 / 30;
  const r = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
  const events: SessionEvent[] = [];
  let t = 200;
  const at = (x: number, y: number) => {
    events.push({ type: 'tip.sample', t: r(t, 1), x: r(x, 5), y: r(y, 5), conf: 0.95, size: 0.1 });
    t += dt;
  };
  const hold = (x: number, y: number, ms: number) => {
    for (const end = t + ms; t < end - 1e-6; ) at(x, y);
  };
  const move = (a: [number, number], b: [number, number], ms: number) => {
    const n = Math.max(1, Math.round(ms / dt));
    for (let i = 1; i <= n; i++) at(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n);
  };
  events.push({ type: 'tip.found', t: r(t, 1), x: 0.3, y: 0.5, conf: 0.95 });
  hold(0.3, 0.5, 400);
  move([0.3, 0.5], [0.5, 0.5], 300);
  t += 350;
  move([0.5, 0.5], [0.65, 0.5], 300);
  hold(0.65, 0.5, 230);
  move([0.65, 0.5], [0.65, 0.3], 300);
  hold(0.65, 0.3, 500);
  const lastSeen = events[events.length - 1].t;
  events.push({ type: 'tip.lost', t: r(lastSeen + 400, 1), lastSeen });
  return events;
}

/** The longest gap between two samples of a session, in session time (handCastEvents: its dropout). */
export function longestGap(events: readonly SessionEvent[]): { from: number; to: number } {
  const times = events.filter((e) => e.type === 'tip.sample').map((e) => e.t);
  let gap = { from: 0, to: 0 };
  for (let i = 1; i < times.length; i++) if (times[i] - times[i - 1] > gap.to - gap.from) gap = { from: times[i - 1], to: times[i] };
  return gap;
}
