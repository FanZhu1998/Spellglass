import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticsStats, Envelope, Module, RecordedSession, Stroke, TrackerStatus } from '../../contracts';
import { DEFAULT_SETTINGS } from '../../contracts';
import { checkSession, createKernel, memoryPersistence, type KernelHost } from '../../kernel';
import { cameraOf, createDiagnosticsModule, isPipelineSetting, pipelineSettings } from './index';

const TRACKER = 'tracker.bright-tip';

function status(extra: Partial<TrackerStatus> = {}): TrackerStatus {
  return { tracker: TRACKER, state: 'tracking', lock: 1, fps: 30, aspect: 16 / 9, pen: false, ...extra };
}

/** A storage stand-in that keeps what is put. */
function fakeStorage(puts: { store: string; key: string; value: unknown }[]): Module {
  return {
    manifest: { id: 'storage.idb', kind: 'storage', version: '1.0.0', contract: '^1.1', provides: ['storage@1'] },
    async init(k) {
      k.handle('storage.put', (p: { store: string; key: string; value: unknown }) => {
        puts.push(p);
      });
    },
    async start() {},
    async stop() {},
  };
}

interface Harness {
  kernel: KernelHost;
  puts: { store: string; key: string; value: unknown }[];
  events: Envelope[];
  tip: (type: 'tip.found' | 'tip.sample', dt: number, x?: number, src?: string) => void;
  lost: (dt: number, src?: string) => void;
  status: (s?: Partial<TrackerStatus>) => void;
  stroke: (id: string, t0: number, t1: number, src?: string) => void;
  cast: (strokeId: string | undefined, spellId: string, t: number, replay?: boolean) => void;
  fizzle: (strokeId: string, t: number) => void;
}

async function harness(opts: { storage?: boolean } = {}): Promise<Harness> {
  const kernel = createKernel({ persistence: memoryPersistence({ 'engine.mode': 'assisted', 'theme.id': 'other', 'segmenter.pauseMs': 250 }), features: [] });
  const puts: Harness['puts'] = [];
  if (opts.storage !== false) kernel.register(fakeStorage(puts));
  kernel.register(createDiagnosticsModule());
  await kernel.init();
  await kernel.start();
  const events: Envelope[] = [];
  kernel.subscribe('*', (e) => events.push(e));
  const now = () => kernel.now();
  return {
    kernel, puts, events,
    tip: (type, dt, x = 0.5, src = TRACKER) => {
      const t = now() + dt;
      kernel.publish({ type, v: 1, t, source: src, payload: { t, x, y: 0.5, conf: 0.9, src } });
    },
    lost: (dt, src = TRACKER) => {
      const t = now() + dt;
      kernel.publish({ type: 'tip.lost', v: 1, t, source: src, payload: { t, src } });
    },
    status: (s = {}) => kernel.publish({ type: 'tracker.status', v: 1, t: now(), source: s.tracker ?? TRACKER, payload: status(s) }),
    stroke: (id, t0, t1, src = TRACKER) => {
      const s: Stroke = { id, points: [], t0, t1, quality: 1, src, aspect: 16 / 9 };
      kernel.emit('stroke.end', s, 'segmenter.hold-still');
    },
    cast: (strokeId, spellId, t, replay) => kernel.emit('spell.cast', { id: `c-${spellId}`, spellId, t, via: 'gesture', quality: 1, power: 0.5, aim: { x: 0.5, y: 0.5 }, strokeId, replay }, 'engine.rules'),
    fizzle: (strokeId, t) => kernel.emit('spell.fizzle', { id: `f-${strokeId}`, t, strokeId, reason: 'low-score', quality: 0.3 }, 'engine.rules'),
  };
}

describe('diagnostics module', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    vi.setSystemTime(new Date('2026-11-21T10:00:00.000Z'));
    h = await harness();
  });

  afterEach(async () => {
    await h.kernel.stop();
    vi.useRealTimers();
  });

  it('records a session in the fixture format and stores it', async () => {
    h.status();
    h.tip('tip.sample', -5); // before the recording
    await h.kernel.request('session.record.start', { title: 'Practice round', intended: 'lumos' });
    const t0 = h.kernel.now();
    await vi.advanceTimersByTimeAsync(100);
    h.tip('tip.sample', 0, 0.51);
    h.tip('tip.sample', 0, 0.52);
    h.lost(0);
    h.stroke('s1', t0 + 20, t0 + 90);
    h.cast('s1', 'nox', t0 + 90);
    h.kernel.emit('voice.incantation', { t: t0 + 50, text: 'Lumos', conf: 0.8, final: true, id: 'u1' }, 'voice.speech');
    const session = await h.kernel.request<RecordedSession>('session.record.stop');

    expect(checkSession(session)).toEqual({ ok: true });
    expect(session).toMatchObject({
      schema: 'session/1', title: 'Practice round', tracker: TRACKER, pen: false, intended: 'lumos', recordedAt: '2026-11-21T10:00:00.000Z',
      // Only pipeline settings that differ from the defaults: theme.id is left out.
      settings: { 'engine.mode': 'assisted' },
    });
    // The tip was held when recording began: a tip.found at t = 0 opens the session.
    expect(session.events.map((e) => `${e.type}@${e.t}`)).toEqual(['tip.found@0', 'voice.incantation@50', 'tip.sample@100', 'tip.sample@100', 'tip.lost@100']);
    expect(session.expected).toEqual([{ spellId: 'lumos', t: 90, intended: 'lumos', decided: 'nox', strokeId: 's1' }]);
    expect(h.puts).toEqual([{ store: 'sessions', key: session.id, value: session }]);
  });

  it('works without storage', async () => {
    await h.kernel.stop();
    h = await harness({ storage: false });
    await h.kernel.request('session.record.start');
    const session = await h.kernel.request<RecordedSession>('session.record.stop');
    expect(session.schema).toBe('session/1');
  });

  it('waits for strokes still being decided, up to a limit', async () => {
    h.status();
    await h.kernel.request('session.record.start');
    const t0 = h.kernel.now();
    h.stroke('s1', t0 + 10, t0 + 50);
    h.stroke('s2', t0 + 60, t0 + 80);
    const stopping = h.kernel.request<RecordedSession>('session.record.stop');
    await vi.advanceTimersByTimeAsync(300);
    h.fizzle('s1', t0 + 50);
    // Events after the stop are not recorded.
    h.tip('tip.sample', 0);
    await vi.advanceTimersByTimeAsync(2000);
    const session = await stopping;
    expect(session.expected).toEqual([{ spellId: null, t: 50, decided: null, reason: 'low-score', strokeId: 's1' }]);
    expect(session.events).toEqual([]);
  });

  it('stops on its own when another tracker takes over, and hands that session to the next stop', async () => {
    h.status();
    await h.kernel.request('session.record.start');
    h.tip('tip.found', 10);
    h.status({ tracker: 'tracker.hand', state: 'loading' });
    // Samples after the switch are not part of this session.
    h.tip('tip.sample', 20, 0.5, 'tracker.hand');
    await vi.advanceTimersByTimeAsync(0);
    const stats = h.events.filter((e) => e.type === 'diagnostics.stats').map((e) => (e.payload as DiagnosticsStats).recording);
    expect(stats.at(-1)).toBe(false);
    const session = await h.kernel.request<RecordedSession>('session.record.stop');
    expect(session.tracker).toBe(TRACKER);
    expect(session.events.map((e) => e.type)).toEqual(['tip.found']);
    expect(h.puts).toHaveLength(1);
    await expect(h.kernel.request('session.record.stop')).rejects.toMatchObject({ name: 'InvalidStateError', message: 'Nothing is being recorded.' });
  });

  it('never records a replay', async () => {
    await h.kernel.request('session.record.start');
    h.status({ tracker: 'tracker.replay' });
    h.tip('tip.found', 0, 0.5, 'tracker.replay');
    h.tip('tip.sample', 0, 0.5, 'tracker.replay');
    const t0 = h.kernel.now();
    h.stroke('r1', t0, t0 + 10, 'tracker.replay');
    h.cast('r1', 'lumos', t0 + 10, true);
    const session = await h.kernel.request<RecordedSession>('session.record.stop');
    expect(session.events).toEqual([]);
    expect(session.expected).toEqual([]);
  });

  it('changes the intended spell mid-recording', async () => {
    h.status();
    await h.kernel.request('session.record.start', { intended: 'lumos' });
    const t0 = h.kernel.now();
    h.stroke('a', t0 + 1, t0 + 5);
    h.cast('a', 'lumos', t0 + 5);
    await h.kernel.request('session.record.label', { spellId: 'nox' });
    h.stroke('b', t0 + 6, t0 + 9);
    h.cast('b', 'nox', t0 + 9);
    const session = await h.kernel.request<RecordedSession>('session.record.stop');
    expect(session.intended).toBeUndefined();
    expect(session.expected.map((e) => e.intended)).toEqual(['lumos', 'nox']);
    // A label without a recording is harmless.
    await expect(h.kernel.request('session.record.label', { spellId: 'nox' })).resolves.toBeUndefined();
  });

  it('refuses a second recording', async () => {
    await h.kernel.request('session.record.start');
    await expect(h.kernel.request('session.record.start')).rejects.toMatchObject({ name: 'InvalidStateError' });
    await h.kernel.request('session.record.stop');
  });

  it('records the enabled spells and the camera', async () => {
    h.kernel.emit('camera.status', { state: 'on', generation: 1, permission: 'granted', label: 'Desk camera', width: 1280, height: 720, fps: 29.97, exposure: { mode: 'manual', time: 40 } }, 'capture.camera');
    h.kernel.emit('spellbook.changed', {
      revision: 1, packs: [], theme: null, unlockedTier: 1, learnAfter: 3,
      spells: [
        { spell: { id: 'lumos' }, enabled: true },
        { spell: { id: 'imperio' }, enabled: false },
      ],
    } as never, 'kernel');
    h.status();
    await h.kernel.request('session.record.start');
    const session = await h.kernel.request<RecordedSession>('session.record.stop');
    expect(session.enabledSpells).toEqual(['lumos']);
    expect(session.camera).toEqual({ label: 'Desk camera', width: 1280, height: 720, fps: 30, exposure: { mode: 'manual', time: 40 } });
  });

  it('publishes stats once a second', async () => {
    h.events.length = 0;
    h.stroke('s1', 0, 1);
    await vi.advanceTimersByTimeAsync(5);
    h.fizzle('s1', 1);
    h.kernel.emit('tip.filtered', { t: h.kernel.now() - 42, x: 0.5, y: 0.5, conf: 1, src: TRACKER }, 'segmenter.hold-still');
    await vi.advanceTimersByTimeAsync(1000);
    const stats = h.events.filter((e) => e.type === 'diagnostics.stats').map((e) => e.payload as DiagnosticsStats);
    expect(stats.length).toBeGreaterThanOrEqual(1);
    const last = stats.at(-1)!;
    expect(last.recording).toBe(false);
    expect(last.decisionMs).toBe(5);
    expect(last.trailLatencyMs).toBe(42);
    expect(last.rates['stroke.end']).toBeGreaterThan(0);
    expect(last.rates['diagnostics.stats']).toBeUndefined();
  });
});

describe('pipeline settings', () => {
  it('keeps only the settings that shape decisions, and only when they differ from the defaults', () => {
    const all = { ...DEFAULT_SETTINGS, 'engine.mode': 'strict', 'theme.id': 'dusk', 'capture.deviceId': 'secret-device', 'playArea': { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, 'segmenter.pauseMs': 250 } as Record<string, unknown>;
    expect(pipelineSettings(all)).toEqual({ 'engine.mode': 'strict', 'playArea': { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } });
    expect(isPipelineSetting('hand.gripReach')).toBe(true);
    expect(isPipelineSetting('audio.volume')).toBe(false);
  });

  it('describes the camera only when it is on', () => {
    expect(cameraOf(undefined)).toBeUndefined();
    expect(cameraOf({ state: 'requesting', generation: 0, permission: 'prompt' })).toBeUndefined();
    expect(cameraOf({ state: 'on', generation: 1, permission: 'granted', width: 640, height: 480 })).toEqual({ label: '', width: 640, height: 480, fps: 0 });
  });
});
