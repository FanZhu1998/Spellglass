// Integration: recorded sessions through 'replay.play' into the real pipeline (kernel, pack loader,
// segmenter, recognizer, engine; tests/pipeline/harness.ts supplies the file fetch and an effects stand-in),
// and the diagnostics recorder's output played back by the replay tracker (Section 9.1 rule 8, Section 13).
//
// The decision checks need the real stroke module (src/modules/stroke): they skip themselves while it is
// the 0.0.0 stub, which cuts no strokes. The event checks run regardless.

import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope, Module, RecordedSession, SessionEvent, SpellCast, SpellFizzle, TipSample } from '../../../contracts';
import { checkSession, createKernel, memoryPersistence, on, type KernelHost } from '../../../kernel';
import { fakeEffects, fileFetch, loadSession, PACK_INDEX_URL } from '../../../../tests/pipeline/harness';
import { createDiagnosticsModule } from '../../diagnostics';
import { createTemplateRecognizer } from '../../recognizers/template';
import { createSpellEngine } from '../../spell-engine';
import { createStrokeModule, MANIFEST as STROKE_MANIFEST } from '../../stroke';
import { createReplayTracker } from './index';

const DIR = fileURLToPath(new URL('../../../../tests/fixtures/sessions/', import.meta.url));
const FIXTURES = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith('.json')).sort() : [];
const STROKES_READY = STROKE_MANIFEST.version !== '0.0.0';
/** Decisions may land a little earlier or later than recorded (as in tests/pipeline/sessions.test.ts). */
const TOLERANCE_MS = 600;

/** The player's own tracker, which the replay hands the slot back to. */
function liveTracker(id = 'tracker.bright-tip'): Module {
  return {
    manifest: { id, kind: 'tracker', version: '1.0.0', contract: '^1.1', provides: ['tip.source'] },
    async init() {},
    async start() {},
    async stop() {},
  };
}

interface Rig {
  kernel: KernelHost;
  events: Envelope[];
  decisions: { kind: 'cast' | 'fizzle'; spellId: string | null; t: number; cast?: SpellCast; fizzle?: SpellFizzle }[];
}

async function rig(settings: Record<string, unknown>, extra: Module[] = []): Promise<Rig> {
  const kernel = createKernel({
    persistence: memoryPersistence({ 'spells.unlockAll': true, 'tracker.active': 'tracker.bright-tip', ...settings }),
    features: ['platform.dom', 'platform.pointer'],
    fetch: fileFetch,
  });
  kernel.register(liveTracker(), createStrokeModule(), createTemplateRecognizer(), createSpellEngine(), fakeEffects(), createReplayTracker(), ...extra);
  await kernel.init();
  await kernel.loadPacks(PACK_INDEX_URL);
  await kernel.start();
  const events: Envelope[] = [];
  const decisions: Rig['decisions'] = [];
  kernel.subscribe('*', (e) => events.push(e));
  on(kernel, 'spell.cast', (c) => decisions.push({ kind: 'cast', spellId: c.spellId, t: c.t, cast: c }));
  on(kernel, 'spell.fizzle', (f) => decisions.push({ kind: 'fizzle', spellId: null, t: f.t, fizzle: f }));
  return { kernel, events, decisions };
}

/** The tip events a stream of envelopes carries, as session events relative to `start`. */
function asSessionEvents(events: Envelope[], start: number): SessionEvent[] {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  return events
    .filter((e) => e.type === 'tip.found' || e.type === 'tip.sample' || e.type === 'tip.lost')
    .map((e) => {
      const p = e.payload as TipSample & { lastSeen?: number };
      if (e.type === 'tip.lost') return { type: 'tip.lost', t: r1(p.t - start), ...(p.lastSeen !== undefined ? { lastSeen: r1(p.lastSeen - start) } : {}) } as SessionEvent;
      return {
        type: e.type, t: r1(p.t - start), x: p.x, y: p.y, conf: p.conf,
        ...(e.type === 'tip.sample' && p.size !== undefined ? { size: p.size } : {}),
        ...(p.frame !== undefined ? { frame: p.frame } : {}),
      } as SessionEvent;
    });
}

describe('recorded sessions through replay.play', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has fixtures to play', () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  it('plays a fixture into the pipeline at its recorded pace, as the replay tracker', async () => {
    const session = loadSession(DIR + FIXTURES[0]);
    const r = await rig(session.settings ?? {});
    try {
      const done = r.kernel.request<{ played: number }>('replay.play', { session, speed: 1 });
      await vi.advanceTimersByTimeAsync(0);
      const start = r.kernel.now();
      await vi.advanceTimersByTimeAsync(session.events.at(-1)!.t + 3000);
      const { played } = await done;
      expect(played).toBe(session.events.length);
      const tips = r.events.filter((e) => e.type.startsWith('tip.') && e.type !== 'tip.filtered');
      expect(tips.length).toBe(session.events.length);
      for (const e of tips) {
        expect(e.source).toBe('tracker.replay');
        expect((e.payload as { src: string }).src).toBe('tracker.replay');
      }
      expect(asSessionEvents(r.events, start)).toEqual(session.events);
      // The replay announced itself to the segmenter with the session's shape before any tip event.
      const firstTip = r.events.findIndex((e) => e.type.startsWith('tip.'));
      const status = r.events.findIndex((e) => e.type === 'tracker.status' && (e.payload as { tracker: string }).tracker === 'tracker.replay');
      expect(status).toBeLessThan(firstTip);
      // The player's tracker setting is untouched.
      expect(r.kernel.settings.get('tracker.active', '')).toBe('tracker.bright-tip');
    } finally {
      await r.kernel.stop();
    }
  });

  for (const file of FIXTURES) {
    it.runIf(STROKES_READY)(`produces the recorded decisions for ${file}, marked as replays`, async () => {
      const session = loadSession(DIR + file);
      const r = await rig(session.settings ?? {});
      try {
        const done = r.kernel.request('replay.play', { session, speed: 1 });
        await vi.advanceTimersByTimeAsync(0);
        const start = r.kernel.now();
        await vi.advanceTimersByTimeAsync(session.events.at(-1)!.t + 3000);
        await done;
        expect(r.decisions.map((d) => d.spellId)).toEqual(session.expected.map((e) => e.spellId));
        session.expected.forEach((e, i) => expect(Math.abs(r.decisions[i].t - start - e.t)).toBeLessThanOrEqual(TOLERANCE_MS));
        // Replays never count toward progress, never become templates, never become keepsakes.
        for (const d of r.decisions) if (d.cast) expect(d.cast.replay).toBe(true);
      } finally {
        await r.kernel.stop();
      }
    });
  }
});

describe('the recorder and the replay tracker round-trip', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records a live session in the fixture format and plays the recording back unchanged', async () => {
    const fixture = loadSession(DIR + FIXTURES[0]);
    const r = await rig(fixture.settings ?? {}, [createDiagnosticsModule()]);
    try {
      const src = 'tracker.bright-tip';
      const k = r.kernel;
      k.publish({ type: 'tracker.status', v: 1, t: k.now(), source: src, payload: { tracker: src, state: 'tracking', lock: 1, fps: 30, aspect: fixture.aspect, pen: false } });
      await k.request('session.record.start', { title: 'Round trip' });
      const t0 = k.now();
      // The fixture, published live by the player's tracker at its recorded times.
      let now = 0;
      for (const e of fixture.events) {
        if (e.t > now) {
          await vi.advanceTimersByTimeAsync(e.t - now);
          now = e.t;
        }
        const t = t0 + e.t;
        if (e.type === 'tip.lost') k.publish({ type: 'tip.lost', v: 1, t, source: src, payload: { t, src, lastSeen: e.lastSeen !== undefined ? t0 + e.lastSeen : undefined } });
        else if (e.type === 'tip.found' || e.type === 'tip.sample') {
          k.publish({ type: e.type, v: 1, t, source: src, payload: { t, x: e.x, y: e.y, conf: e.conf, src, ...('size' in e && e.size !== undefined ? { size: e.size } : {}), ...(e.frame !== undefined ? { frame: e.frame } : {}) } });
        }
      }
      await vi.advanceTimersByTimeAsync(3000);
      const stopping = k.request<RecordedSession>('session.record.stop');
      await vi.advanceTimersByTimeAsync(2500);
      const recorded = await stopping;

      expect(checkSession(recorded)).toEqual({ ok: true });
      expect(recorded).toMatchObject({ schema: 'session/1', tracker: src, pen: false, title: 'Round trip' });
      // The pipeline settings that differ from the defaults travel with the recording.
      expect(recorded.settings).toEqual(fixture.settings);
      expect(recorded.aspect).toBeCloseTo(fixture.aspect, 10);
      expect(recorded.events).toEqual(fixture.events);
      expect(recorded.enabledSpells?.length).toBeGreaterThan(0);
      if (STROKES_READY) expect(recorded.expected.map((e) => e.decided)).toEqual(fixture.expected.map((e) => e.decided));

      // Played back, the recording comes out as it went in.
      r.events.length = 0;
      await k.request('replay.play', { session: recorded, speed: 0 });
      expect(asSessionEvents(r.events, k.now())).toEqual(recorded.events);
    } finally {
      await r.kernel.stop();
    }
  });
});
