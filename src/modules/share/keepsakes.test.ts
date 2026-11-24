// Keepsakes: built from 'stroke.end' and 'spell.cast' through a real kernel, kept in memory and in the
// real storage module (on fake-indexeddb), and turned into links.

import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import type { Keepsake, Point, SpellCast, Stroke, StorageChanged, UserDataExport } from '../../contracts';
import { KernelError, ask, createKernel, emit, memoryPersistence, type KernelHost } from '../../kernel';
import { createStorage } from '../storage';
import { decodeReplay, replayParam } from './codec';
import { createShareModule, MANIFEST, SHARE_MESSAGES } from './index';
import { KEEPSAKE_LIMIT, StrokeCache, buildKeepsake, isKeepsake, keepsakeToReplay, newestFirst, strokeRecord } from './keepsakes';

const APP = 'https://example.test/Spellglass/';
const kernels: KernelHost[] = [];

afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop();
});

async function boot(options: { factory?: IDBFactory | null; dbName?: string; appUrl?: string } = {}) {
  const kernel = createKernel({ persistence: memoryPersistence(), features: ['platform.dom'] });
  kernels.push(kernel);
  const modules = [createShareModule({ appUrl: options.appUrl ?? APP })];
  if (options.factory !== null) {
    const factory = options.factory ?? new IDBFactory();
    modules.unshift(createStorage({ factory: () => factory, dbName: options.dbName ?? 'spellglass' }));
  }
  kernel.register(...modules);
  await kernel.init();
  await kernel.start();
  return kernel;
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

/** A circle traced over 1.2 s, in caster space of a 16:9 camera. */
function circleStroke(id: string, src = 'tracker.pointer', t0 = 1000): Stroke {
  const points = Array.from({ length: 40 }, (_, i) => {
    const a = (i / 39) * Math.PI * 2;
    return { t: t0 + i * 30, x: 0.5 + (0.2 * Math.cos(a)) / (16 / 9), y: 0.5 + 0.2 * Math.sin(a), conf: 1, src };
  });
  return { id, points, t0, t1: t0 + 39 * 30, quality: 0.9, aspect: 16 / 9, src };
}

function cast(id: string, over: Partial<SpellCast> = {}): SpellCast {
  return { id, spellId: 'protego', t: 2170, via: 'gesture', quality: 0.91, power: 0.5, aim: { x: 0.6, y: 0.5 }, incantation: 'Protego', ...over };
}

describe('keepsake helpers', () => {
  it('resamples the stroke to 64 points, keeping its ends, duration and aspect', () => {
    const record = strokeRecord(circleStroke('s1'))!;
    const k = buildKeepsake(cast('cast-1', { strokeId: 's1', detail: { spellId: 'protego' } as SpellCast['detail'] }), record, 'Protego', 4 / 3, 5);
    expect(k).toMatchObject({ dataVersion: 1, id: 'cast-1', spellName: 'Protego', durationMs: 1170, aspect: 16 / 9, savedAt: 5 });
    expect(k.points).toHaveLength(64);
    expect(k.points[0][0]).toBeCloseTo(record.points[0][0], 3);
    expect(k.points[63][1]).toBeCloseTo(record.points[39][1], 3);
    expect('detail' in k.cast).toBe(false);
    expect(isKeepsake(k)).toBe(true);
  });

  it('keeps no points for a voice-only cast, with the aspect it was given', () => {
    const k = buildKeepsake(cast('cast-2', { via: 'voice' }), undefined, 'Protego', 4 / 3, 5);
    expect(k).toMatchObject({ points: [], durationMs: 0, aspect: 4 / 3 });
    expect(keepsakeToReplay(k)).toMatchObject({ points: [], via: 'voice' });
  });

  it('remembers the last strokes by id, forgetting the oldest', () => {
    const cache = new StrokeCache(3);
    for (const id of ['a', 'b', 'c', 'd']) cache.add({ id, points: [], durationMs: 0 });
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('d')?.id).toBe('d');
  });

  it('sorts newest first and recognises bad records', () => {
    const k = (id: string, savedAt: number) => buildKeepsake(cast(id), undefined, 'Protego', 16 / 9, savedAt);
    expect(newestFirst([k('cast-a', 1), k('cast-c', 3), k('cast-b', 3)]).map((x) => x.id)).toEqual(['cast-c', 'cast-b', 'cast-a']);
    expect(isKeepsake({ id: 'x' })).toBe(false);
    expect(isKeepsake({ ...k('cast-a', 1), id: 'other' })).toBe(false);
  });
});

describe('share module: keepsakes', () => {
  it('keeps the manifest id and kind, and requires nothing', () => {
    expect(MANIFEST).toMatchObject({ id: 'share.links', kind: 'share', contract: '^1.1', provides: ['share@1'], requires: [] });
  });

  it('makes a keepsake from stroke.end and the spell.cast that follows, and stores it', async () => {
    const kernel = await boot();
    emit(kernel, 'segmenter.test', 'stroke.end', circleStroke('s1'));
    emit(kernel, 'engine.rules', 'spell.cast', cast('cast-1', { strokeId: 's1' }));
    const [k] = await ask(kernel, 'keepsakes.list');
    expect(k).toMatchObject({ id: 'cast-1', spellName: 'Protego', durationMs: 1170, aspect: 16 / 9 });
    expect(k.points).toHaveLength(64);
    await settle();
    expect(await ask(kernel, 'storage.get', { store: 'keepsakes', key: 'cast-1' })).toEqual(k);
  });

  it('waits for decisions that come seconds after the stroke', async () => {
    const kernel = await boot();
    emit(kernel, 'segmenter.test', 'stroke.end', circleStroke('s1'));
    for (let i = 2; i <= 10; i++) emit(kernel, 'segmenter.test', 'stroke.end', circleStroke(`s${i}`));
    emit(kernel, 'engine.rules', 'spell.cast', cast('cast-1', { strokeId: 's1' }));
    expect((await ask(kernel, 'keepsakes.list'))[0].points).toHaveLength(64);
  });

  it('never keeps replays, nor strokes played back from recorded sessions', async () => {
    const kernel = await boot();
    emit(kernel, 'segmenter.test', 'stroke.end', circleStroke('s1'));
    emit(kernel, 'engine.rules', 'spell.cast', cast('cast-1', { strokeId: 's1', replay: true }));
    emit(kernel, 'segmenter.test', 'stroke.end', circleStroke('s2', 'tracker.replay'));
    emit(kernel, 'engine.rules', 'spell.cast', cast('cast-2', { strokeId: 's2', replay: true }));
    expect(await ask(kernel, 'keepsakes.list')).toEqual([]);
  });

  it('keeps the 50 newest, in memory and in storage', async () => {
    const kernel = await boot();
    for (let i = 0; i < KEEPSAKE_LIMIT + 5; i++) emit(kernel, 'engine.rules', 'spell.cast', cast(`cast-${String(i).padStart(3, '0')}`, { via: 'voice' }));
    const list = await ask(kernel, 'keepsakes.list');
    expect(list).toHaveLength(KEEPSAKE_LIMIT);
    expect(list[0].id).toBe('cast-054');
    expect(list.at(-1)!.id).toBe('cast-005');
    await settle();
    await settle();
    const stored = await ask(kernel, 'storage.list', { store: 'keepsakes' });
    expect(stored.map((r) => r.key)).toEqual(list.map((k) => k.id).reverse());
    expect(await ask(kernel, 'keepsakes.list', { limit: 2 })).toHaveLength(2);
  });

  it('deletes a keepsake from both places', async () => {
    const kernel = await boot();
    emit(kernel, 'engine.rules', 'spell.cast', cast('cast-1', { via: 'voice' }));
    await settle();
    await ask(kernel, 'keepsakes.delete', { id: 'cast-1' });
    expect(await ask(kernel, 'keepsakes.list')).toEqual([]);
    expect(await ask(kernel, 'storage.get', { store: 'keepsakes', key: 'cast-1' })).toBeUndefined();
  });

  it('finds keepsakes stored in an earlier session', async () => {
    const factory = new IDBFactory();
    const first = await boot({ factory });
    emit(first, 'segmenter.test', 'stroke.end', circleStroke('s1'));
    emit(first, 'engine.rules', 'spell.cast', cast('cast-1', { strokeId: 's1' }));
    await settle();
    await first.stop();
    const second = await boot({ factory });
    const list = await ask(second, 'keepsakes.list');
    expect(list.map((k) => k.id)).toEqual(['cast-1']);
    expect(list[0].points).toHaveLength(64);
  });

  it('picks up keepsakes brought in by a data import', async () => {
    const kernel = await boot();
    const k = buildKeepsake(cast('cast-9', { via: 'voice' }), undefined, 'Protego', 16 / 9, 1234);
    const doc: UserDataExport = { schema: 'spellglass-data/1', dataVersion: 1, settingsVersion: 1, exportedAt: 'now', settings: {}, stores: { keepsakes: [{ key: k.id, value: k }] } };
    await ask(kernel, 'storage.import', { data: doc });
    await settle();
    expect((await ask(kernel, 'keepsakes.list')).map((x) => x.id)).toEqual(['cast-9']);
  });

  it('works without any storage module', async () => {
    const kernel = await boot({ factory: null });
    emit(kernel, 'segmenter.test', 'stroke.end', circleStroke('s1'));
    emit(kernel, 'engine.rules', 'spell.cast', cast('cast-1', { strokeId: 's1' }));
    expect((await ask(kernel, 'keepsakes.list')).map((x) => x.id)).toEqual(['cast-1']);
    const { hash } = await ask(kernel, 'share.link', { castId: 'cast-1' });
    expect(decodeReplay(replayParam(hash)!).spellId).toBe('protego');
  });

  it('ignores the echo of its own writes', async () => {
    const kernel = await boot();
    const changes: StorageChanged[] = [];
    kernel.subscribe<StorageChanged>('storage.changed', (e) => changes.push(e.payload));
    emit(kernel, 'engine.rules', 'spell.cast', cast('cast-1', { via: 'voice' }));
    await settle();
    expect(changes).toEqual([{ stores: ['keepsakes'], reason: 'put', keys: ['cast-1'] }]);
    // Had it reloaded, the list would still match; what matters is that it stays correct.
    expect((await ask(kernel, 'keepsakes.list')).map((x) => x.id)).toEqual(['cast-1']);
  });
});

describe('share module: links', () => {
  it('makes a link for a keepsake that share.parse reads back', async () => {
    const kernel = await boot();
    emit(kernel, 'segmenter.test', 'stroke.end', circleStroke('s1'));
    emit(kernel, 'engine.rules', 'spell.cast', cast('cast-1', { strokeId: 's1', targetId: 'dummy', variant: 'Protego Maxima' }));
    const { url, hash } = await ask(kernel, 'share.link', { castId: 'cast-1' });
    expect(url).toBe(`${APP}#${hash}`);
    const data = await ask(kernel, 'share.parse', { hash: `#${hash}` });
    const kept = (await ask(kernel, 'keepsakes.list'))[0] as Keepsake;
    expect(data).toMatchObject({ format: 1, spellId: 'protego', via: 'gesture', variant: true, target: 'dummy' });
    expect(data.quality).toBeCloseTo(0.91, 2);
    data.points.forEach((p: Point, i: number) => expect(Math.abs(p[0] - kept.points[i][0])).toBeLessThan(0.003));
    expect(await ask(kernel, 'share.parse', { hash: url })).toEqual(data);
  });

  it('makes no replay link without a web address to put it on (the desktop app)', async () => {
    const kernel = await boot({ appUrl: '' });
    emit(kernel, 'segmenter.test', 'stroke.end', circleStroke('s1'));
    emit(kernel, 'engine.rules', 'spell.cast', cast('cast-1', { strokeId: 's1' }));
    const err = await ask(kernel, 'share.link', { castId: 'cast-1' }).catch((e: KernelError) => e);
    expect(err).toMatchObject({ code: 'not-supported', message: SHARE_MESSAGES.noAddress });
    // The cast is still kept: cards, clips and replays here do not need the address.
    expect((await ask(kernel, 'keepsakes.list')).map((k: Keepsake) => k.id)).toEqual(['cast-1']);
  });

  it('refuses unknown casts and bad links with plain messages', async () => {
    const kernel = await boot();
    const notKept = await ask(kernel, 'share.link', { castId: 'cast-x' }).catch((e: KernelError) => e);
    expect(notKept).toMatchObject({ code: 'invalid-payload', message: SHARE_MESSAGES.notKept });
    const bad = await ask(kernel, 'share.parse', { hash: 'cast=nonsense!' }).catch((e: KernelError) => e);
    expect(bad).toMatchObject({ code: 'invalid-payload', message: expect.stringMatching(/damaged/) });
  });

  it('says plainly that cards need a browser that can draw', async () => {
    const kernel = await boot();
    emit(kernel, 'engine.rules', 'spell.cast', cast('cast-1', { via: 'voice' }));
    const err = await ask(kernel, 'share.card', { castId: 'cast-1' }).catch((e: KernelError) => e);
    expect(err).toMatchObject({ code: 'not-supported', message: SHARE_MESSAGES.noCards });
  });
});
