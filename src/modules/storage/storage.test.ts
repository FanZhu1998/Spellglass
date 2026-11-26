// The storage module through a real kernel, on fake-indexeddb (each test gets its own IDBFactory, so
// databases never leak between tests), including every way IndexedDB can fail.

import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IDBFactory, IDBObjectStore, IDBOpenDBRequest, forceCloseDatabase } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import type { Envelope, Module, StorageChanged, StorageStatus, UserDataExport } from '../../contracts';
import { EFFECT_CAPABILITY, STORE_NAMES } from '../../contracts';
import { KernelError, ask, createKernel, memoryPersistence, type KernelHost } from '../../kernel';
import { MANIFEST, createStorage, createStorageModule, type StorageOptions } from './index';
import { TOO_DEEP } from './records';
import { STORAGE_MESSAGES } from './status';
import { IMPORT_MESSAGES } from './transfer';

const kernels: KernelHost[] = [];

afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop();
});

async function boot(options: StorageOptions & { settings?: Record<string, unknown>; start?: boolean; modules?: Module[]; fetch?: typeof fetch } = {}) {
  const kernel = createKernel({ persistence: memoryPersistence(options.settings), features: ['platform.dom'], fetch: options.fetch });
  kernels.push(kernel);
  const events: Envelope<unknown>[] = [];
  kernel.subscribe('*', (e) => events.push(e));
  kernel.register(createStorage(options), ...(options.modules ?? []));
  await kernel.init();
  if (options.start) await kernel.start();
  const of = <T>(type: string) => events.filter((e) => e.type === type).map((e) => e.payload as T);
  return { kernel, events, of };
}

/** A factory that remembers every connection it opened, so tests can force one closed. */
function recordingFactory(real = new IDBFactory()) {
  const opened: IDBDatabase[] = [];
  const factory = {
    open(name: string, version?: number) {
      const request = real.open(name, version);
      request.addEventListener('success', () => opened.push(request.result));
      return request;
    },
    deleteDatabase: (name: string) => real.deleteDatabase(name),
    cmp: (a: unknown, b: unknown) => real.cmp(a, b),
    databases: () => real.databases(),
  } as unknown as IDBFactory;
  return { factory, opened, real };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Wait (up to about a second) until `check` holds. */
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200 && !(await check()); i++) await new Promise<void>((resolve) => setTimeout(resolve, 5));
}

/** A list holding a list holding ... `depth` levels deep. */
function nested(depth: number): unknown {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

/** A Proxy that has been revoked: every look inside it throws a TypeError. */
function revoked(): object {
  const { proxy, revoke } = Proxy.revocable({ dataVersion: 1, value: 1 }, {});
  revoke();
  return proxy;
}

/** A record whose value throws when read. */
function throwingGetter(): object {
  return Object.defineProperty({ dataVersion: 1 }, 'value', {
    enumerable: true,
    get: () => {
      throw new Error('boom');
    },
  });
}

/** A data file holding one kv record. */
const kvFile = (value: unknown) => ({
  schema: 'spellglass-data/1', dataVersion: 1, settingsVersion: 1, exportedAt: 'now', settings: {}, stores: { kv: [{ key: 'k', value }] },
});

describe('storage module', () => {
  it('keeps the manifest id and kind, and never requires IndexedDB', () => {
    expect(MANIFEST).toMatchObject({ id: 'storage.indexeddb', kind: 'storage', contract: '^1.1', provides: ['storage@1'], requires: [] });
    expect(createStorageModule().manifest).toBe(MANIFEST);
  });

  it('serves requests from the end of init, opening the database only when first asked', async () => {
    const { factory, opened } = recordingFactory();
    const { kernel } = await boot({ factory: () => factory });
    expect(opened).toHaveLength(0);
    await ask(kernel, 'storage.put', { store: 'kv', key: 'a', value: { dataVersion: 1, value: 1 } });
    expect(opened.length).toBeGreaterThan(0);
    expect(await ask(kernel, 'storage.get', { store: 'kv', key: 'a' })).toEqual({ dataVersion: 1, value: 1 });
    expect(await ask(kernel, 'storage.get', { store: 'kv', key: 'missing' })).toBeUndefined();
  });

  it('lists in key order, reversed, by prefix and up to a limit', async () => {
    const factory = new IDBFactory();
    const { kernel } = await boot({ factory: () => factory });
    for (const key of ['b', 'a2', 'c', 'a1', 'ab']) await ask(kernel, 'storage.put', { store: 'samples', key, value: { key } });
    const keys = async (p: { limit?: number; reverse?: boolean; prefix?: string }) =>
      (await ask(kernel, 'storage.list', { store: 'samples', ...p })).map((r) => r.key);
    expect(await keys({})).toEqual(['a1', 'a2', 'ab', 'b', 'c']);
    expect(await keys({ reverse: true, limit: 2 })).toEqual(['c', 'b']);
    expect(await keys({ prefix: 'a' })).toEqual(['a1', 'a2', 'ab']);
    expect(await keys({ prefix: 'a', reverse: true, limit: 2 })).toEqual(['ab', 'a2']);
    expect(await keys({ prefix: 'zz' })).toEqual([]);
    await ask(kernel, 'storage.delete', { store: 'samples', key: 'b' });
    expect(await keys({})).toEqual(['a1', 'a2', 'ab', 'c']);
    await ask(kernel, 'storage.clear', { store: 'samples' });
    expect(await keys({})).toEqual([]);
  });

  it('stores a copy: changing an object after saving it does not change what was saved', async () => {
    const factory = new IDBFactory();
    const { kernel } = await boot({ factory: () => factory });
    const value = { dataVersion: 1, value: { list: [1] } };
    await ask(kernel, 'storage.put', { store: 'kv', key: 'x', value });
    value.value.list.push(2);
    expect(await ask(kernel, 'storage.get', { store: 'kv', key: 'x' })).toEqual({ dataVersion: 1, value: { list: [1] } });
  });

  it('saves a Svelte-style Proxy as a plain copy instead of failing', async () => {
    const { kernel } = await boot({ factory: () => new IDBFactory() });
    const proxied = new Proxy({ dataVersion: 1, value: [1, 2] }, {});
    await ask(kernel, 'storage.put', { store: 'kv', key: 'p', value: proxied });
    expect(await ask(kernel, 'storage.get', { store: 'kv', key: 'p' })).toEqual({ dataVersion: 1, value: [1, 2] });
  });

  it("rejects bad requests with 'invalid-payload' only", async () => {
    const { kernel } = await boot({ factory: () => new IDBFactory() });
    const bad: [string, unknown][] = [
      ['storage.get', { store: 'wands', key: 'x' }],
      ['storage.get', { store: 'kv' }],
      ['storage.put', { store: 'kv', key: 'x' }],
      ['storage.put', { store: 'kv', key: '', value: 1 }],
      ['storage.put', { store: 'kv', key: 'x'.repeat(300), value: 1 }],
      ['storage.put', { store: 'kv', key: 'f', value: () => 1 }],
      // Values that cannot even be read: a revoked Proxy inside, a getter that throws.
      ['storage.put', { store: 'kv', key: 'r', value: { dataVersion: 1, value: revoked() } }],
      ['storage.put', { store: 'kv', key: 'r', value: revoked() }],
      ['storage.put', { store: 'kv', key: 'g', value: throwingGetter() }],
      ['storage.list', { store: 'kv', limit: -1 }],
      ['storage.clear', { store: 'wands' }],
      ['storage.export', { stores: ['wands'] }],
      ['storage.import', {}],
      ['storage.import', { data: {}, mode: 'mix' }],
      ['storage.import', { data: kvFile(revoked()) }],
      ['storage.import', { data: kvFile(throwingGetter()) }],
      ['storage.import', { data: revoked() }],
    ];
    for (const [name, payload] of bad) {
      const err = await kernel.request(name, payload).then(() => null, (e: unknown) => e);
      expect(err, name).toBeInstanceOf(KernelError);
      expect((err as KernelError).code, name).toBe('invalid-payload');
    }
  });

  it('announces committed writes once per task and store, with the keys', async () => {
    const { kernel, of } = await boot({ factory: () => new IDBFactory() });
    await Promise.all([
      ask(kernel, 'storage.put', { store: 'kv', key: 'a', value: 1 }),
      ask(kernel, 'storage.put', { store: 'kv', key: 'b', value: 2 }),
      ask(kernel, 'storage.put', { store: 'progress', key: 'lumos', value: 3 }),
    ]);
    await settle();
    expect(of<StorageChanged>('storage.changed')).toEqual([
      { stores: ['kv'], reason: 'put', keys: ['a', 'b'] },
      { stores: ['progress'], reason: 'put', keys: ['lumos'] },
    ]);
    await ask(kernel, 'storage.delete', { store: 'kv', key: 'a' });
    await ask(kernel, 'storage.clear', {});
    await settle();
    expect(of<StorageChanged>('storage.changed').slice(2)).toEqual([
      { stores: ['kv'], reason: 'delete', keys: ['a'] },
      { stores: [...STORE_NAMES], reason: 'clear' },
    ]);
  });

  it('reads what was asked for before it, even when the write was issued in the same task', async () => {
    const { kernel } = await boot({ factory: () => new IDBFactory() });
    void ask(kernel, 'storage.put', { store: 'kv', key: 'k', value: 'first' });
    void ask(kernel, 'storage.put', { store: 'kv', key: 'k', value: 'second' });
    expect(await ask(kernel, 'storage.get', { store: 'kv', key: 'k' })).toBe('second');
  });

  it('publishes a persistent status with usage and quota, again from start()', async () => {
    const quota = { estimate: async () => ({ usage: 1200, quota: 5_000_000 }), persisted: async () => true, persist: async () => true };
    const { kernel, of } = await boot({ factory: () => new IDBFactory(), quota: () => quota });
    await ask(kernel, 'storage.list', { store: 'kv' });
    await settle();
    expect(of<StorageStatus>('storage.status')).toEqual([{ persistent: true, durable: true, usage: 1200, quota: 5_000_000 }]);
    await kernel.start();
    await settle();
    expect(of<StorageStatus>('storage.status')).toHaveLength(2);
    expect(await ask(kernel, 'storage.status')).toEqual({ persistent: true, durable: true, usage: 1200, quota: 5_000_000 });
    expect(await ask(kernel, 'storage.persist')).toEqual({ durable: true });
  });

  it('closes the database on stop, so it can be deleted, and opens it again on the next request', async () => {
    const factory = new IDBFactory();
    const { kernel } = await boot({ factory: () => factory, dbName: 'closing', start: true });
    await ask(kernel, 'storage.put', { store: 'kv', key: 'a', value: 1 });
    await kernel.stop();
    const deleted = await new Promise<string>((resolve) => {
      const req = factory.deleteDatabase('closing');
      req.onsuccess = () => resolve('deleted');
      req.onblocked = () => resolve('blocked');
    });
    expect(deleted).toBe('deleted');
    expect(await ask(kernel, 'storage.get', { store: 'kv', key: 'a' })).toBeUndefined();
  });

  it('drops an open that finishes after stop(), and opens again afterwards', async () => {
    const real = new IDBFactory();
    let slow = true;
    const factory = {
      open: (name: string, version?: number) => (slow ? new IDBOpenDBRequest() : real.open(name, version)),
    } as unknown as IDBFactory;
    const { kernel, of } = await boot({ factory: () => factory, openTimeoutMs: 80, drainTimeoutMs: 20, start: true });
    // A request starts the slow open; the next open will be quick.
    const first = ask(kernel, 'storage.get', { store: 'kv', key: 'a' });
    slow = false;
    await kernel.stop();
    // The request still in flight is answered from a fresh open.
    expect(await first).toBeUndefined();
    // The abandoned open times out later without moving storage to memory.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(of<StorageStatus>('storage.status').every((s) => s.persistent)).toBe(true);
    await ask(kernel, 'storage.put', { store: 'kv', key: 'a', value: 1 });
    expect(await ask(kernel, 'storage.get', { store: 'kv', key: 'a' })).toBe(1);
  });

  it('ignores records that another program stored under keys that are not text', async () => {
    const factory = new IDBFactory();
    const { kernel } = await boot({ factory: () => factory, dbName: 'odd' });
    await ask(kernel, 'storage.put', { store: 'kv', key: 'text', value: 1 });
    await kernel.stop();
    await new Promise<void>((resolve) => {
      const req = factory.open('odd');
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(2, 42);
        tx.oncomplete = () => {
          req.result.close();
          resolve();
        };
      };
    });
    expect(await ask(kernel, 'storage.list', { store: 'kv' })).toEqual([{ key: 'text', value: 1 }]);
  });
});

describe('export and import', () => {
  async function filled() {
    const s = await boot({ factory: () => new IDBFactory(), settings: { 'audio.volume': 0.4, 'access.captions': true } });
    const k = s.kernel;
    await ask(k, 'storage.put', { store: 'progress', key: 'lumos', value: { dataVersion: 1, spellId: 'lumos', casts: 3, practiceAttempts: 1, best: 0.9, learnedAt: 10 } });
    await ask(k, 'storage.put', { store: 'samples', key: 'sample-1', value: { dataVersion: 1, id: 'sample-1', spellId: 'nox', points: [[0, 0], [0, 1]], score: 0.8, gestureKey: 'k', savedAt: 5 } });
    await ask(k, 'storage.put', { store: 'kv', key: 'progress.unlockedTier', value: { dataVersion: 1, value: 2 } });
    await ask(k, 'storage.put', { store: 'sessions', key: 'session-1', value: { big: true } });
    return s;
  }

  it('exports every store but sessions, with the player\'s own settings only', async () => {
    const { kernel } = await filled();
    const doc = await ask(kernel, 'storage.export');
    expect(doc).toMatchObject({ schema: 'spellglass-data/1', dataVersion: 1, settingsVersion: 2, settings: { 'audio.volume': 0.4, 'access.captions': true } });
    expect(Object.keys(doc.stores).sort()).toEqual(STORE_NAMES.filter((s) => s !== 'sessions').sort());
    expect(doc.stores.progress).toEqual([{ key: 'lumos', value: expect.objectContaining({ casts: 3 }) }]);
    expect(Object.keys(doc.settings)).not.toContain('engine.mode');
    const withSessions = await ask(kernel, 'storage.export', { stores: ['sessions'] });
    expect(Object.keys(withSessions.stores)).toEqual(['sessions']);
  });

  it('round-trips through a JSON file into another device', async () => {
    const { kernel } = await filled();
    const text = JSON.stringify(await ask(kernel, 'storage.export'));
    const other = await boot({ factory: () => new IDBFactory() });
    const result = await ask(other.kernel, 'storage.import', { data: text });
    expect(result).toEqual({ imported: { profiles: 0, samples: 1, overrides: 0, progress: 1, keepsakes: 0, packs: 0, kv: 1 }, settings: 2 });
    expect(await ask(other.kernel, 'storage.get', { store: 'progress', key: 'lumos' })).toMatchObject({ casts: 3, learnedAt: 10 });
    expect(await ask(other.kernel, 'storage.get', { store: 'kv', key: 'progress.unlockedTier' })).toEqual({ dataVersion: 1, value: 2 });
    expect(other.kernel.settings.get('audio.volume', 0)).toBe(0.4);
    expect(other.kernel.settings.get('access.captions', false)).toBe(true);
    await settle();
    expect(other.of<StorageChanged>('storage.changed').at(-1)).toEqual({ stores: ['samples', 'progress', 'kv'], reason: 'import' });
  });

  it('merge keeps newer records on this device; replace makes the stores match the file', async () => {
    const { kernel } = await filled();
    const doc = await ask(kernel, 'storage.export');
    await ask(kernel, 'storage.put', { store: 'progress', key: 'lumos', value: { dataVersion: 1, spellId: 'lumos', casts: 8, practiceAttempts: 1, best: 0.9, learnedAt: 10 } });
    await ask(kernel, 'storage.put', { store: 'progress', key: 'nox', value: { dataVersion: 1, spellId: 'nox', casts: 1, practiceAttempts: 0, best: 0.7, learnedAt: null } });

    const merged = await ask(kernel, 'storage.import', { data: doc, mode: 'merge' });
    expect(merged.imported.progress).toBe(0);
    expect(await ask(kernel, 'storage.get', { store: 'progress', key: 'lumos' })).toMatchObject({ casts: 8 });

    const replaced = await ask(kernel, 'storage.import', { data: doc, mode: 'replace' });
    expect(replaced.imported.progress).toBe(1);
    expect((await ask(kernel, 'storage.list', { store: 'progress' })).map((r) => r.key)).toEqual(['lumos']);
    expect(await ask(kernel, 'storage.get', { store: 'progress', key: 'lumos' })).toMatchObject({ casts: 3 });
    // Sessions were not in the file, so replace left them alone.
    expect(await ask(kernel, 'storage.get', { store: 'sessions', key: 'session-1' })).toEqual({ big: true });
  });

  it('leaves the chosen camera out of the file, and never applies one from a file', async () => {
    const { kernel } = await boot({ factory: () => new IDBFactory(), settings: { 'capture.deviceId': 'usb-cam-on-laptop', 'audio.volume': 0.4 } });
    const doc = await ask(kernel, 'storage.export');
    expect(doc.settings).toEqual({ 'audio.volume': 0.4 });
    // A file from elsewhere (or an older edition) that does carry one.
    const other = await boot({ factory: () => new IDBFactory() });
    const result = await ask(other.kernel, 'storage.import', { data: { ...doc, settings: { 'capture.deviceId': 'usb-cam-on-laptop', 'audio.volume': 0.4 } } });
    expect(result.settings).toBe(1);
    expect(other.kernel.settings.get('audio.volume', 0)).toBe(0.4);
    expect(other.kernel.settings.get<string | null>('capture.deviceId', null)).toBeNull();
  });

  it('skips invalid records and settings, and refuses files from a newer edition', async () => {
    const { kernel } = await boot({ factory: () => new IDBFactory() });
    const doc: UserDataExport = {
      schema: 'spellglass-data/1', dataVersion: 1, settingsVersion: 1, exportedAt: 'now',
      settings: { 'audio.volume': 'loud', 'audio.muted': true, 'tracker.debug': true, 'no.such': 1 },
      stores: { progress: [{ key: 'lumos', value: { spellId: 'lumos' } }], kv: [{ key: 'n', value: { dataVersion: 1, value: 1 } }] },
    };
    expect(await ask(kernel, 'storage.import', { data: doc })).toEqual({ imported: { progress: 0, kv: 1 }, settings: 1 });
    expect(kernel.settings.get('audio.volume', 0)).toBe(0.8);
    expect(kernel.settings.get('audio.muted', false)).toBe(true);
    expect(kernel.settings.get('tracker.debug', false)).toBe(false);
    const err = await ask(kernel, 'storage.import', { data: { ...doc, dataVersion: 2 } }).catch((e: KernelError) => e);
    expect(err).toMatchObject({ code: 'invalid-payload', message: expect.stringMatching(/newer edition/) });
  });
});

describe('when IndexedDB cannot be used', () => {
  async function works(kernel: KernelHost) {
    await ask(kernel, 'storage.put', { store: 'kv', key: 'works.a', value: { dataVersion: 1, value: [1] } });
    expect(await ask(kernel, 'storage.get', { store: 'kv', key: 'works.a' })).toEqual({ dataVersion: 1, value: [1] });
    expect(await ask(kernel, 'storage.list', { store: 'kv', prefix: 'works.' })).toEqual([{ key: 'works.a', value: { dataVersion: 1, value: [1] } }]);
  }

  it('runs from memory and says so when the browser has no IndexedDB', async () => {
    const { kernel, of } = await boot({ factory: () => null });
    await works(kernel);
    expect(of<StorageStatus>('storage.status')).toEqual([{ persistent: false, reason: 'unsupported', message: STORAGE_MESSAGES.unsupported }]);
  });

  it('counts IndexedDB that cannot even be looked up (a SecurityError) as blocked', async () => {
    const { kernel, of } = await boot({ factory: () => { throw Object.assign(new Error('denied'), { name: 'SecurityError' }); } });
    await works(kernel);
    expect(of<StorageStatus>('storage.status')[0]).toMatchObject({ persistent: false, reason: 'blocked', message: STORAGE_MESSAGES.blocked });
  });

  it('gives up on an open that never answers', async () => {
    const factory = { open: () => new IDBOpenDBRequest() } as unknown as IDBFactory;
    const { kernel, of } = await boot({ factory: () => factory, openTimeoutMs: 30 });
    await works(kernel);
    expect(of<StorageStatus>('storage.status')[0]).toMatchObject({ persistent: false, reason: 'blocked', message: STORAGE_MESSAGES.noAnswer });
  });

  it('runs from memory when its upgrade is blocked by another tab', async () => {
    const factory = new IDBFactory();
    // An "older tab": the database with only one store, held open, never letting go.
    const holder = await new Promise<IDBDatabase>((resolve) => {
      const req = factory.open('held', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => resolve(req.result);
    });
    const { kernel, of } = await boot({ factory: () => factory, dbName: 'held' });
    await works(kernel);
    expect(of<StorageStatus>('storage.status')[0]).toMatchObject({ persistent: false, reason: 'blocked', message: STORAGE_MESSAGES.blocked });
    holder.close();
    await settle();
    await works(kernel);
  });

  it('lets go when another tab upgrades the database, and carries on in memory', async () => {
    const factory = new IDBFactory();
    const { kernel, of } = await boot({ factory: () => factory, dbName: 'shared' });
    await ask(kernel, 'storage.put', { store: 'kv', key: 'before', value: 1 });
    const upgraded = await new Promise<string>((resolve) => {
      const req = factory.open('shared', 50);
      req.onblocked = () => resolve('blocked');
      req.onsuccess = () => {
        req.result.close();
        resolve('upgraded');
      };
    });
    expect(upgraded).toBe('upgraded');
    expect(of<StorageStatus>('storage.status').at(-1)).toMatchObject({ persistent: false, reason: 'closed', message: STORAGE_MESSAGES.otherTab });
    await works(kernel);
  });

  it('carries on in memory when the browser closes the connection', async () => {
    const { factory, opened } = recordingFactory();
    const { kernel, of } = await boot({ factory: () => factory });
    await ask(kernel, 'storage.put', { store: 'kv', key: 'before', value: 1 });
    forceCloseDatabase(opened.at(-1) as never);
    await settle();
    expect(of<StorageStatus>('storage.status').at(-1)).toMatchObject({ persistent: false, reason: 'closed', message: STORAGE_MESSAGES.closed });
    await works(kernel);
  });

  it('when storage is full, keeps what was saved, takes the write into memory and says so', async () => {
    const factory = new IDBFactory();
    const { kernel, of } = await boot({ factory: () => factory });
    await ask(kernel, 'storage.put', { store: 'progress', key: 'lumos', value: { dataVersion: 1, spellId: 'lumos', casts: 2 } });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (key === 'too-big') {
        this.transaction.abort();
        throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' });
      }
      return put.call(this, value, key);
    } as typeof put;
    try {
      await ask(kernel, 'storage.put', { store: 'kv', key: 'too-big', value: { dataVersion: 1, value: 'x' } });
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    expect(of<StorageStatus>('storage.status').at(-1)).toMatchObject({ persistent: false, reason: 'full', message: STORAGE_MESSAGES.full });
    expect(await ask(kernel, 'storage.get', { store: 'kv', key: 'too-big' })).toEqual({ dataVersion: 1, value: 'x' });
    expect(await ask(kernel, 'storage.get', { store: 'progress', key: 'lumos' })).toMatchObject({ casts: 2 });
    await works(kernel);
  });

  it('imports and exports from memory too', async () => {
    const { kernel } = await boot({ factory: () => null });
    const doc: UserDataExport = {
      schema: 'spellglass-data/1', dataVersion: 1, settingsVersion: 1, exportedAt: 'now', settings: {},
      stores: { kv: [{ key: 'n', value: { dataVersion: 1, value: 1 } }] },
    };
    expect((await ask(kernel, 'storage.import', { data: doc })).imported).toEqual({ kv: 1 });
    expect((await ask(kernel, 'storage.export')).stores.kv).toEqual([{ key: 'n', value: { dataVersion: 1, value: 1 } }]);
    // The memory store hands out copies too.
    const got = (await ask(kernel, 'storage.get', { store: 'kv', key: 'n' })) as { value: number };
    got.value = 99;
    expect(await ask(kernel, 'storage.get', { store: 'kv', key: 'n' })).toEqual({ dataVersion: 1, value: 1 });
  });
});

describe('values that cannot be saved', () => {
  // A pack or data file may carry unknown fields of any shape (Section 9.1 rule 3), so a crafted one
  // can nest thousands deep. Such a value is the caller's problem: it must never cost the session its
  // saving (Section 9.2: a pack from a friend is safe to open).
  const statuses = (of: <T>(type: string) => T[]) => of<StorageStatus>('storage.status');

  it('refuses a value nested too deeply, and keeps saving to IndexedDB', async () => {
    const { kernel, of } = await boot({ factory: () => new IDBFactory() });
    await ask(kernel, 'storage.put', { store: 'kv', key: 'before', value: 1 });
    const err = await ask(kernel, 'storage.put', { store: 'packs', key: 'deep', value: { dataVersion: 1, notes: nested(2000) } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid-payload', message: TOO_DEEP });
    await ask(kernel, 'storage.put', { store: 'kv', key: 'after', value: 2 });
    expect(statuses(of).every((s) => s.persistent)).toBe(true);
    const doc = await ask(kernel, 'storage.export');
    expect(doc.stores.kv).toEqual([{ key: 'after', value: 2 }, { key: 'before', value: 1 }]);
    expect(doc.stores.packs).toEqual([]);
  });

  it('refuses a value it cannot read, as put and as part of a file, and keeps saving to IndexedDB', async () => {
    const { kernel, of } = await boot({ factory: () => new IDBFactory() });
    await ask(kernel, 'storage.put', { store: 'kv', key: 'before', value: 1 });
    for (const value of [{ dataVersion: 1, value: revoked() }, throwingGetter()]) {
      const put = await ask(kernel, 'storage.put', { store: 'kv', key: 'odd', value }).catch((e: unknown) => e);
      expect(put).toBeInstanceOf(KernelError);
      expect(put).toMatchObject({ code: 'invalid-payload', message: expect.stringMatching(/^This value cannot be saved \(.+\)\.$/) });
      const imported = await ask(kernel, 'storage.import', { data: kvFile(value) }).catch((e: unknown) => e);
      expect(imported).toBeInstanceOf(KernelError);
      expect(imported).toMatchObject({ code: 'invalid-payload', message: IMPORT_MESSAGES.notData });
    }
    await ask(kernel, 'storage.put', { store: 'kv', key: 'after', value: 2 });
    expect(statuses(of).every((s) => s.persistent)).toBe(true);
    expect(await ask(kernel, 'storage.list', { store: 'kv' })).toEqual([{ key: 'after', value: 2 }, { key: 'before', value: 1 }]);
  });

  it("takes a value IndexedDB's put() throws on as the caller's: only that request fails, and saving goes on", async () => {
    const { kernel, of } = await boot({ factory: () => new IDBFactory() });
    await ask(kernel, 'storage.list', { store: 'kv' });
    const put = IDBObjectStore.prototype.put;
    // As Chrome's put() does when cloning a value overflows the stack: it throws at once and leaves the
    // transaction active.
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      if (key === 'deep') throw new RangeError('Maximum call stack size exceeded');
      return put.call(this, value, key);
    } as typeof put;
    let results: PromiseSettledResult<void>[];
    try {
      // One task, so one transaction.
      results = await Promise.allSettled([
        ask(kernel, 'storage.put', { store: 'kv', key: 'a', value: 1 }),
        ask(kernel, 'storage.put', { store: 'kv', key: 'deep', value: 2 }),
        ask(kernel, 'storage.put', { store: 'progress', key: 'b', value: 3 }),
      ]);
    } finally {
      IDBObjectStore.prototype.put = put;
    }
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({ code: 'invalid-payload', message: STORAGE_MESSAGES.refused });
    expect(statuses(of).every((s) => s.persistent)).toBe(true);
    expect(await ask(kernel, 'storage.list', { store: 'kv' })).toEqual([{ key: 'a', value: 1 }]);
    expect(await ask(kernel, 'storage.get', { store: 'progress', key: 'b' })).toBe(3);
    await settle();
    expect(of<StorageChanged>('storage.changed')).toEqual([
      { stores: ['kv'], reason: 'put', keys: ['a'] },
      { stores: ['progress'], reason: 'put', keys: ['b'] },
    ]);
  });

  it('refuses a data file nested too deeply, and changes nothing', async () => {
    const { kernel, of } = await boot({ factory: () => new IDBFactory() });
    const doc = {
      schema: 'spellglass-data/1', dataVersion: 1, settingsVersion: 1, exportedAt: 'now', settings: { 'audio.volume': 0.2 },
      stores: { packs: [{ key: 'my-pack', value: { dataVersion: 1, id: 'my-pack', json: { schema: 'spellpack/1', notes: nested(2000) }, importedAt: 1 } }] },
    };
    const err = await ask(kernel, 'storage.import', { data: JSON.stringify(doc) }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid-payload', message: IMPORT_MESSAGES.tooDeep });
    expect(await ask(kernel, 'storage.list', { store: 'packs' })).toEqual([]);
    expect(kernel.settings.get('audio.volume', 0.8)).toBe(0.8);
    expect(statuses(of).every((s) => s.persistent)).toBe(true);
  });

  it('refuses an import whose records cannot all be saved, and writes none of them', async () => {
    const { kernel, of } = await boot({ factory: () => new IDBFactory() });
    await ask(kernel, 'storage.put', { store: 'kv', key: 'kept', value: { dataVersion: 1, value: 0 } });
    // Handed over as an object: a record a store cannot copy (a proxy holding a BigInt) after a good one.
    const doc: UserDataExport = {
      schema: 'spellglass-data/1', dataVersion: 1, settingsVersion: 1, exportedAt: 'now', settings: {},
      stores: { kv: [{ key: 'good', value: { dataVersion: 1, value: 1 } }, { key: 'odd', value: new Proxy({ dataVersion: 1, value: 1n }, {}) }] },
    };
    const err = await ask(kernel, 'storage.import', { data: doc, mode: 'replace' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid-payload', message: IMPORT_MESSAGES.refused });
    expect(await ask(kernel, 'storage.list', { store: 'kv' })).toEqual([{ key: 'kept', value: { dataVersion: 1, value: 0 } }]);
    expect(statuses(of).every((s) => s.persistent)).toBe(true);
  });

  it('refuses them from memory too, whose reads keep working', async () => {
    const { kernel } = await boot({ factory: () => null });
    const err = await ask(kernel, 'storage.put', { store: 'packs', key: 'deep', value: { notes: nested(2000) } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'invalid-payload', message: TOO_DEEP });
    expect(await ask(kernel, 'storage.list', { store: 'packs' })).toEqual([]);
    expect((await ask(kernel, 'storage.export')).stores.packs).toEqual([]);
  });
});

describe('between tabs of the app', () => {
  // Kernels on one database stand for tabs (or an installed window and a tab) of one browser profile.
  // Node's BroadcastChannel carries messages between them as a browser's does between same-origin tabs.
  function tabs(dbName: string, extra: Parameters<typeof boot>[0] = {}) {
    const factory = new IDBFactory();
    return (own: Parameters<typeof boot>[0] = {}) =>
      boot({ factory: () => factory, dbName, channel: (name) => new BroadcastChannel(name), start: true, ...extra, ...own });
  }
  const changes = (tab: { of: <T>(type: string) => T[] }) => tab.of<StorageChanged>('storage.changed');
  /** Long enough for a message to cross over and back. */
  const quiet = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

  it("tells the other tabs what it saved, and never hears its own changes back", async () => {
    const open = tabs('tabs-relay');
    const a = await open();
    const b = await open();
    await ask(a.kernel, 'storage.put', { store: 'progress', key: 'lumos', value: 1 });
    await until(() => changes(b).length > 0);
    expect(changes(b)).toEqual([{ stores: ['progress'], reason: 'other-tab', keys: ['lumos'] }]);
    await ask(b.kernel, 'storage.clear', {});
    await until(() => changes(a).length > 1);
    await quiet();
    expect(changes(a)).toEqual([
      { stores: ['progress'], reason: 'put', keys: ['lumos'] },
      { stores: [...STORE_NAMES], reason: 'other-tab' },
    ]);
    expect(changes(b)).toEqual([
      { stores: ['progress'], reason: 'other-tab', keys: ['lumos'] },
      { stores: [...STORE_NAMES], reason: 'clear' },
    ]);
  });

  it('says nothing about writes kept in memory, and ignores the others while it runs from memory', async () => {
    const open = tabs('tabs-memory');
    const disk = await open();
    // A tab whose storage is blocked: it answers from memory.
    const blocked = await open({ factory: () => null });
    await ask(blocked.kernel, 'storage.put', { store: 'kv', key: 'mine', value: 1 });
    await ask(disk.kernel, 'storage.put', { store: 'kv', key: 'theirs', value: 2 });
    await quiet();
    expect(changes(disk)).toEqual([{ stores: ['kv'], reason: 'put', keys: ['theirs'] }]);
    expect(changes(blocked)).toEqual([{ stores: ['kv'], reason: 'put', keys: ['mine'] }]);
  });

  it('stops listening when it stops, and listens again when it starts', async () => {
    const open = tabs('tabs-lifecycle');
    const a = await open();
    const b = await open();
    await b.kernel.stop();
    await ask(a.kernel, 'storage.put', { store: 'kv', key: 'one', value: 1 });
    await quiet();
    expect(changes(b)).toEqual([]);
    await b.kernel.start();
    await ask(a.kernel, 'storage.put', { store: 'kv', key: 'two', value: 2 });
    await until(() => changes(b).length > 0);
    expect(changes(b)).toEqual([{ stores: ['kv'], reason: 'other-tab', keys: ['two'] }]);
  });

  it('ignores messages that are not a change of known stores', async () => {
    const open = tabs('tabs-odd');
    const a = await open();
    const stranger = new BroadcastChannel('tabs-odd:storage');
    try {
      stranger.postMessage({ from: 'x', stores: ['wands'] });
      stranger.postMessage({ from: 'x', stores: 'kv' });
      stranger.postMessage('hello');
      stranger.postMessage({ from: 'x', stores: ['wands', 'samples'], keys: ['s1', 7] });
      await until(() => changes(a).length > 0);
      await quiet();
    } finally {
      stranger.close();
    }
    expect(changes(a)).toEqual([{ stores: ['samples'], reason: 'other-tab' }]);
  });
});

describe('with the pack service', () => {
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
  const fileFetch: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    try {
      return new Response(readFileSync(`${ROOT}public${decodeURIComponent(url.pathname)}`), { status: 200 });
    } catch {
      return new Response('not found', { status: 404 });
    }
  };
  const effects: Module = {
    manifest: {
      id: 'effect.test', kind: 'effect', version: '1.0.0', contract: '^1.1',
      provides: [...new Set(Object.values(EFFECT_CAPABILITY))], effects: Object.keys(EFFECT_CAPABILITY),
    },
    async init() {},
    async start() {},
    async stop() {},
  };

  it('keeps progress across a restart', async () => {
    const factory = new IDBFactory();
    const first = await boot({ factory: () => factory, dbName: 'app', fetch: fileFetch, modules: [effects], start: true });
    await first.kernel.loadPacks('http://spellglass.test/packs/index.json');
    first.kernel.emit('spell.cast', { id: 'cast-1', spellId: 'lumos', t: 1, via: 'gesture', quality: 0.9, power: 0.5, aim: { x: 0.5, y: 0.5 } }, 'engine.rules');
    for (let i = 0; i < 20 && !(await ask(first.kernel, 'storage.get', { store: 'progress', key: 'lumos' })); i++) await settle();
    await first.kernel.stop();

    const second = await boot({ factory: () => factory, dbName: 'app', fetch: fileFetch, modules: [effects] });
    const book = await second.kernel.loadPacks('http://spellglass.test/packs/index.json');
    expect(book.spells.find((e) => e.spell.id === 'lumos')?.accepted).toBe(1);
  });

  it('shows another tab the casts counted in this one, so neither loses the other\'s', async () => {
    // The finding's case: tab B is open, then tab A. Casts in A must reach B before B counts its own.
    const factory = new IDBFactory();
    const open = async () => {
      const tab = await boot({ factory: () => factory, dbName: 'two-tabs', fetch: fileFetch, modules: [effects], start: true, channel: (name) => new BroadcastChannel(name) });
      await tab.kernel.loadPacks('http://spellglass.test/packs/index.json');
      return tab;
    };
    const lumos = async (k: KernelHost) => (await ask(k, 'spellbook.get')).spells.find((e) => e.spell.id === 'lumos');
    const castLumos = (k: KernelHost, id: string) =>
      k.emit('spell.cast', { id, spellId: 'lumos', t: 1, via: 'gesture', quality: 0.9, power: 0.5, aim: { x: 0.5, y: 0.5 } }, 'engine.rules');
    const b = await open();
    const a = await open();
    for (let i = 1; i <= 3; i++) castLumos(a.kernel, `a-${i}`);
    await until(async () => (await lumos(b.kernel))?.accepted === 3);
    expect(await lumos(b.kernel)).toMatchObject({ accepted: 3, status: 'learned' });
    castLumos(b.kernel, 'b-1');
    await until(async () => (await lumos(a.kernel))?.accepted === 4);
    expect(await lumos(a.kernel)).toMatchObject({ accepted: 4, status: 'learned' });
    expect(await ask(b.kernel, 'storage.get', { store: 'progress', key: 'lumos' })).toMatchObject({ casts: 4, learnedAt: expect.any(Number) });
  });
});
