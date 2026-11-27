// Replays through a real kernel, pack loader and spell engine, with a stand-in stage that plays
// 'stage.replay' the way the real one does (replay.state, the trace's duration, engine.cast with
// replay: true, the effect, replay.state again), all under fake timers.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Envelope, Module, RequestPayload, SpellCast } from '../../contracts';
import { EFFECT_CAPABILITY } from '../../contracts';
import { KernelError, ask, createKernel, emit, lastPayload, memoryPersistence, type KernelHost } from '../../kernel';
import { createSpellEngine } from '../spell-engine';
import { encodeReplay } from './codec';
import { createShareModule } from './index';
import { REPLAY_MESSAGES, notInBook } from './replay';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const INDEX = 'http://spellglass.test/packs/index.json';
const fileFetch: typeof fetch = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  try {
    return new Response(readFileSync(`${ROOT}public${decodeURIComponent(url.pathname)}`), { status: 200 });
  } catch {
    return new Response('not found', { status: 404 });
  }
};

const EFFECT_TAIL_MS = 1000;

/** The stage's part of a replay, as src/modules/effects/stage/core/stage.ts plays it. */
function fakeStage(): Module & { replays: RequestPayload<'stage.replay'>[] } {
  const replays: RequestPayload<'stage.replay'>[] = [];
  return {
    manifest: {
      id: 'stage.test', kind: 'effect', version: '1.0.0', contract: '^1.1',
      provides: [...new Set(Object.values(EFFECT_CAPABILITY))], effects: Object.keys(EFFECT_CAPABILITY),
    },
    replays,
    async init(k) {
      k.handle('stage.replay', async (p: RequestPayload<'stage.replay'>) => {
        replays.push(p);
        const started = k.now();
        emit(k, 'stage.test', 'replay.state', { playing: true, spellId: p.spellId });
        let castId: string | undefined;
        try {
          await new Promise((resolve) => setTimeout(resolve, p.durationMs));
          const last = p.points[p.points.length - 1];
          const cast = await ask(k, 'engine.cast', {
            spellId: p.spellId, via: p.via, quality: p.quality, power: p.power, variant: p.variant, replay: true,
            aim: last ? { x: last[0], y: last[1] } : { x: 0.5, y: 0.5 }, ...(p.targetId ? { targetId: p.targetId } : {}),
          });
          castId = cast.id;
          await new Promise((resolve) => setTimeout(resolve, EFFECT_TAIL_MS));
          return { castId: cast.id, durationMs: k.now() - started };
        } finally {
          emit(k, 'stage.test', 'replay.state', { playing: false, spellId: p.spellId, ...(castId ? { castId } : {}) });
        }
      });
    },
    async start() {},
    async stop() {},
  };
}

const kernels: KernelHost[] = [];

async function world(options: { stage?: boolean } = {}) {
  const kernel = createKernel({ persistence: memoryPersistence(), features: ['platform.dom'], fetch: fileFetch, clock: () => Date.now() });
  kernels.push(kernel);
  const stage = fakeStage();
  // Without the stage, an effects module that only declares what it implements, so the spells stay
  // available and only the stage's request is missing.
  const effectsOnly: Module = { manifest: { ...stage.manifest, id: 'effects.test' }, async init() {}, async start() {}, async stop() {} };
  kernel.register(createSpellEngine(), options.stage === false ? effectsOnly : stage, createShareModule({ appUrl: 'https://example.test/' }));
  await kernel.init();
  await kernel.loadPacks(INDEX);
  await kernel.start();
  const seen: Envelope<unknown>[] = [];
  kernel.subscribe('*', (e) => seen.push(e));
  return { kernel, stage, seen };
}

const linkData = (spellId: string, over: Record<string, unknown> = {}) => ({
  format: 1, spellId, via: 'gesture' as const, quality: 0.93, power: 0.85, variant: true, durationMs: 1200, aspect: 16 / 9,
  points: Array.from({ length: 64 }, (_, i) => [0.3 + i / 200, 0.6 - i / 300] as [number, number]), ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop();
  vi.useRealTimers();
});

describe('share.replay', () => {
  it('plays through the stage, whose cast is a replay: no progress, no keepsake', async () => {
    const { kernel, stage, seen } = await world();
    const done = ask(kernel, 'share.replay', { data: linkData('lumos', { target: 'candle' }) });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await done).toEqual({ durationMs: 1200 + EFFECT_TAIL_MS });

    expect(stage.replays).toEqual([expect.objectContaining({
      spellId: 'lumos', aspect: 16 / 9, durationMs: 1200, via: 'gesture', quality: 0.93, power: 0.85, variant: true, targetId: 'candle',
    })]);
    expect(stage.replays[0].points).toHaveLength(64);
    const order = seen.filter((e) => ['replay.state', 'spell.cast', 'spell.ended'].includes(e.type)).map((e) => {
      const p = e.payload as { playing?: boolean; replay?: boolean; by?: string };
      return e.type === 'replay.state' ? `replay.state:${p.playing}` : e.type === 'spell.cast' ? `spell.cast:${p.replay}` : `spell.ended:${p.by}`;
    });
    expect(order).toEqual(['replay.state:true', 'spell.cast:true', 'replay.state:false', 'spell.ended:replay']);
    const cast = seen.find((e) => e.type === 'spell.cast')!.payload as SpellCast;
    expect(cast).toMatchObject({ spellId: 'lumos', replay: true, variant: 'Lumos Maxima', targetId: 'candle' });

    expect(await ask(kernel, 'keepsakes.list')).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(lastPayload(kernel, 'spellbook.changed')!.spells.find((e) => e.spell.id === 'lumos')!.accepted).toBe(0);
  });

  it('replays a keepsake by its cast id', async () => {
    const { kernel, stage } = await world();
    emit(kernel, 'engine.rules', 'spell.cast', { id: 'cast-1', spellId: 'nox', t: 1, via: 'voice', quality: 0.8, power: 0.3, aim: { x: 0.5, y: 0.5 } });
    const done = ask(kernel, 'share.replay', { castId: 'cast-1' });
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(stage.replays[0]).toMatchObject({ spellId: 'nox', via: 'voice', points: [], durationMs: 0, variant: false });
  });

  it('still replays a spell the player has not unlocked yet', async () => {
    const { kernel, stage } = await world();
    const entry = lastPayload(kernel, 'spellbook.changed')!.spells.find((e) => e.spell.id === 'reducto')!;
    expect(entry.status).toBe('locked');
    const done = ask(kernel, 'share.replay', { data: linkData('reducto', { variant: false }) });
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(stage.replays.map((r) => r.spellId)).toEqual(['reducto']);
  });

  it('does not play a spell whose pack is off, and says why', async () => {
    const { kernel, stage } = await world();
    const err = await ask(kernel, 'share.replay', { data: linkData('imperio') }).catch((e: KernelError) => e);
    expect(err).toBeInstanceOf(KernelError);
    expect(err).toMatchObject({ code: 'not-supported', message: 'Imperio is not available here, so this replay cannot play. Restricted section is turned off.' });
    expect(stage.replays).toEqual([]);
  });

  it('says so when the spell is not in the spellbook at all', async () => {
    const { kernel } = await world();
    const err = await ask(kernel, 'share.replay', { data: linkData('confundo') }).catch((e: KernelError) => e);
    expect(err).toMatchObject({ code: 'not-supported', message: notInBook('confundo') });
  });

  it('says so when there is no stage to play on', async () => {
    const { kernel } = await world({ stage: false });
    const err = await ask(kernel, 'share.replay', { data: linkData('lumos') }).catch((e: KernelError) => e);
    expect(err).toMatchObject({ code: 'not-supported', message: REPLAY_MESSAGES.noStage });
  });

  it('plays what share.parse read from a link', async () => {
    const { kernel, stage } = await world();
    const data = await ask(kernel, 'share.parse', { hash: `cast=${encodeReplay(linkData('accio', { variant: false, target: 'feather' }))}` });
    const done = ask(kernel, 'share.replay', { data });
    await vi.advanceTimersByTimeAsync(3000);
    await done;
    expect(stage.replays[0]).toMatchObject({ spellId: 'accio', targetId: 'feather', variant: false });
    expect(Math.abs(stage.replays[0].durationMs - 1200)).toBeLessThanOrEqual(16);
  });

  it('refuses replay data that is not a replay', async () => {
    const { kernel } = await world();
    for (const payload of [{}, { data: { spellId: 'Not An Id' } }, { castId: 'cast-unknown' }]) {
      const err = await ask(kernel, 'share.replay', payload as RequestPayload<'share.replay'>).catch((e: KernelError) => e);
      expect(err).toMatchObject({ code: 'invalid-payload' });
    }
  });
});
