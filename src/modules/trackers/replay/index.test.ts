import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope, Incantation, Module, RecordedSession, SessionEvent, TipSample, TrackerStatus } from '../../../contracts';
import { createKernel, memoryPersistence, type KernelHost } from '../../../kernel';
import { createReplayTracker } from './index';
import { REPLAY_TAIL_MS } from './plan';

const FIXTURE = fileURLToPath(new URL('../../../../tests/fixtures/sessions/synthetic-01-core.json', import.meta.url));

/** The player's own tracker: a stand-in that says when it runs. */
function playerTracker(log: string[]): Module {
  let k: KernelHost | null = null;
  return {
    manifest: { id: 'tracker.player', kind: 'tracker', version: '1.0.0', contract: '^1.1', provides: ['tip.source'] },
    async init(kernel) {
      k = kernel as KernelHost;
    },
    async start() {
      log.push('player:start');
      k!.publish({ type: 'tracker.status', v: 1, t: k!.now(), source: 'tracker.player', payload: { tracker: 'tracker.player', state: 'searching', lock: 0, fps: 0, aspect: 16 / 9, pen: false } });
    },
    async stop() {
      log.push('player:stop');
    },
  };
}

interface Published {
  type: string;
  /** kernel.now() when it was delivered */
  at: number;
  env: Envelope;
}

interface Harness {
  kernel: KernelHost;
  log: string[];
  published: Published[];
  of: <T>(type: string) => { payload: T; at: number; env: Envelope }[];
}

async function harness(): Promise<Harness> {
  const kernel = createKernel({ persistence: memoryPersistence({ 'tracker.active': 'tracker.player' }), features: [] });
  const log: string[] = [];
  const published: Published[] = [];
  kernel.register(playerTracker(log), createReplayTracker());
  await kernel.init();
  await kernel.start();
  kernel.subscribe('*', (e) => published.push({ type: e.type, at: kernel.now(), env: e }));
  return {
    kernel, log, published,
    of: <T>(type: string) => published.filter((p) => p.type === type).map((p) => ({ payload: p.env.payload as T, at: p.at, env: p.env })),
  };
}

function session(events: SessionEvent[], extra: Partial<RecordedSession> = {}): RecordedSession {
  return { schema: 'session/1', id: 'test', recordedAt: '2026-11-21T00:00:00Z', tracker: 'tracker.hand', aspect: 4 / 3, events, expected: [], ...extra };
}

const SHORT: SessionEvent[] = [
  { type: 'tip.found', t: 100, x: 0.5, y: 0.5, conf: 0.9, frame: 3 },
  { type: 'tip.sample', t: 100, x: 0.5, y: 0.5, conf: 0.9, size: 0.1, frame: 3 },
  { type: 'tip.sample', t: 133.3, x: 0.52, y: 0.49, conf: 0.91, frame: 4 },
  { type: 'voice.incantation', t: 150, text: 'Lumos', spellId: 'lumos', conf: 0.8, final: true, id: 'utt-1', t0: 150, t1: 450 },
  { type: 'tip.lost', t: 300, lastSeen: 133.3 },
];

describe('replay tracker', () => {
  let h: Harness;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
    h = await harness();
  });

  afterEach(async () => {
    await h.kernel.stop();
    vi.useRealTimers();
  });

  it('plays the events at their recorded times re-based onto kernel.now()', async () => {
    const begun = h.kernel.now();
    const done = h.kernel.request<{ played: number }>('replay.play', { session: session(SHORT) });
    await vi.advanceTimersByTimeAsync(0);
    const start = h.of<TrackerStatus>('tracker.status').find((s) => s.payload.tracker === 'tracker.replay' && s.payload.state === 'tracking')!.at;
    expect(start).toBe(begun);
    await vi.advanceTimersByTimeAsync(300 + REPLAY_TAIL_MS);
    await expect(done).resolves.toEqual({ played: 5 });

    const samples = h.of<TipSample>('tip.sample');
    expect(samples.map((s) => s.payload.t - start)).toEqual([100, 133.3]);
    // Envelope t equals payload t, and nothing goes out before its time (timers only wake the loop).
    for (const s of samples) {
      expect(s.env.t).toBe(s.payload.t);
      expect(s.at).toBeGreaterThanOrEqual(s.payload.t);
      expect(s.at - s.payload.t).toBeLessThan(1);
    }
    expect(samples[0].payload).toEqual({ t: start + 100, x: 0.5, y: 0.5, conf: 0.9, src: 'tracker.replay', size: 0.1, frame: 3 });
    const lost = h.of<{ t: number; src: string; lastSeen: number }>('tip.lost')[0].payload;
    expect(lost).toEqual({ t: start + 300, src: 'tracker.replay', lastSeen: start + 133.3 });
    const voice = h.of<Incantation>('voice.incantation')[0];
    expect(voice.env.source).toBe('tracker.replay');
    expect(voice.payload).toMatchObject({ t: start + 150, t0: start + 150, t1: start + 450, text: 'Lumos', spellId: 'lumos', final: true });
    // Each id serves one decision, so every playback has its own.
    expect(voice.payload.id).toMatch(/^replay\d+:utt-1$/);
    // Everything from the replay carries its id.
    for (const p of h.published.filter((x) => x.type.startsWith('tip.'))) {
      expect(p.env.source).toBe('tracker.replay');
      expect((p.env.payload as { src: string }).src).toBe('tracker.replay');
    }
  });

  it('activates itself transiently, announces the session first, and hands the tracker back afterwards', async () => {
    expect(h.log).toEqual(['player:start']);
    const done = h.kernel.request<{ played: number }>('replay.play', { session: session(SHORT, { pen: true }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.log).toEqual(['player:start', 'player:stop']);
    // The first replay status comes before any tip event and carries the session's aspect and pen flag.
    const firstTip = h.published.findIndex((p) => p.type.startsWith('tip.'));
    const firstStatus = h.published.findIndex((p) => p.type === 'tracker.status' && (p.env.payload as TrackerStatus).tracker === 'tracker.replay');
    expect(firstStatus).toBeGreaterThanOrEqual(0);
    expect(firstStatus).toBeLessThan(firstTip === -1 ? Infinity : firstTip);
    const status = h.published[firstStatus].env.payload as TrackerStatus;
    expect(status.aspect).toBeCloseTo(4 / 3, 10);
    expect(status.pen).toBe(true);

    await vi.advanceTimersByTimeAsync(300 + REPLAY_TAIL_MS);
    await done;
    await vi.advanceTimersByTimeAsync(0);
    const replayStatuses = h.of<TrackerStatus>('tracker.status').filter((s) => s.payload.tracker === 'tracker.replay').map((s) => s.payload);
    // After the events: pen false, then stopped when the kernel switches back.
    expect(replayStatuses.at(-2)).toMatchObject({ state: 'searching', pen: false });
    expect(replayStatuses.at(-1)).toMatchObject({ state: 'stopped', pen: false });
    expect(h.log).toEqual(['player:start', 'player:stop', 'player:start']);
    // The persisted choice never changed.
    expect(h.kernel.settings.get('tracker.active', '')).toBe('tracker.player');
  });

  it('keeps the spacing at other speeds and publishes everything at once at speed 0', async () => {
    const fast = h.kernel.request<{ played: number }>('replay.play', { session: session(SHORT), speed: 2 });
    await vi.advanceTimersByTimeAsync(0);
    const start = h.kernel.now();
    await vi.advanceTimersByTimeAsync(150 + REPLAY_TAIL_MS / 2);
    await expect(fast).resolves.toEqual({ played: 5 });
    const samples = h.of<TipSample>('tip.sample');
    expect(samples.map((s) => s.payload.t - start)).toEqual([100, 133.3]);
    expect(samples.map((s) => s.at - start)).toEqual([50, 67]);
    await vi.advanceTimersByTimeAsync(0);

    h.published.length = 0;
    const instant = await h.kernel.request<{ played: number }>('replay.play', { session: session(SHORT), speed: 0 });
    expect(instant).toEqual({ played: 5 });
    const now = h.kernel.now();
    const round = (v: number) => Math.round(v * 10) / 10;
    expect(h.of<TipSample>('tip.sample').map((s) => [round(s.payload.t - now), round(s.at - now)])).toEqual([[100, 0], [133.3, 0]]);
  });

  it('stops on replay.stop, letting go of a held tip, and still resolves', async () => {
    const long: SessionEvent[] = [
      { type: 'tip.found', t: 0, x: 0.5, y: 0.5, conf: 1 },
      ...Array.from({ length: 30 }, (_, i) => ({ type: 'tip.sample' as const, t: i * 33, x: 0.5 + i * 0.01, y: 0.5, conf: 1 })),
      { type: 'tip.lost', t: 1000, lastSeen: 957 },
    ];
    const done = h.kernel.request<{ played: number }>('replay.play', { session: session(long) });
    await vi.advanceTimersByTimeAsync(0);
    const start = h.kernel.now();
    await vi.advanceTimersByTimeAsync(200);
    await h.kernel.request('replay.stop');
    const result = await done;
    // found + samples at 0, 33, ..., 198
    expect(result.played).toBe(1 + 7);
    const lost = h.of<{ t: number; lastSeen: number }>('tip.lost');
    expect(lost).toHaveLength(1);
    expect(lost[0].payload).toMatchObject({ t: start + 200, lastSeen: start + 198 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.of('tip.sample')).toHaveLength(7);
    expect(h.log.at(-1)).toBe('player:start');
  });

  it('ends a playback when another tracker takes over', async () => {
    const done = h.kernel.request<{ played: number }>('replay.play', { session: session(SHORT) });
    await vi.advanceTimersByTimeAsync(110);
    await h.kernel.request('modules.activate', { kind: 'tracker', id: 'tracker.player' });
    await expect(done).resolves.toEqual({ played: 2 });
    expect(h.of('tip.lost')).toHaveLength(1);
    expect(h.of<TrackerStatus>('tracker.status').filter((s) => s.payload.tracker === 'tracker.replay').at(-1)!.payload.state).toBe('stopped');
  });

  it('refuses a second playback and input that is not a session', async () => {
    const first = h.kernel.request('replay.play', { session: session(SHORT) });
    await vi.advanceTimersByTimeAsync(0);
    await expect(h.kernel.request('replay.play', { session: session(SHORT) })).rejects.toMatchObject({ name: 'InvalidStateError' });
    await expect(h.kernel.request('replay.play', { session: { schema: 'session/9', events: [] } })).rejects.toThrow('newer version');
    await expect(h.kernel.request('replay.play', undefined)).rejects.toThrow('That is not a recorded session.');
    await vi.advanceTimersByTimeAsync(300 + REPLAY_TAIL_MS);
    await first;
  });

  it('round-trips a recorded fixture: the same events come out, re-based', async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as RecordedSession;
    const result = await h.kernel.request<{ played: number }>('replay.play', { session: fixture, speed: 0 });
    expect(result.played).toBe(fixture.events.length);
    const start = h.kernel.now();
    const out: SessionEvent[] = h.published
      .filter((p) => p.type.startsWith('tip.'))
      .map((p) => {
        const e = p.env.payload as TipSample & { lastSeen?: number };
        const t = Math.round((e.t - start) * 10) / 10;
        if (p.type === 'tip.lost') return { type: 'tip.lost', t, ...(e.lastSeen !== undefined ? { lastSeen: Math.round((e.lastSeen - start) * 10) / 10 } : {}) } as SessionEvent;
        const base = { type: p.type, t, x: e.x, y: e.y, conf: e.conf, ...(p.type === 'tip.sample' && e.size !== undefined ? { size: e.size } : {}), ...(e.frame !== undefined ? { frame: e.frame } : {}) };
        return base as SessionEvent;
      });
    expect(out).toEqual(fixture.events);
  });

  it('never applies the session settings to the player', async () => {
    await h.kernel.request('replay.play', { session: session(SHORT, { settings: { 'engine.mode': 'strict', 'spells.unlockAll': true } }), speed: 0 });
    expect(h.kernel.settings.get('engine.mode', 'gesture')).toBe('gesture');
    expect(h.kernel.settings.get('spells.unlockAll', false)).toBe(false);
  });
});
