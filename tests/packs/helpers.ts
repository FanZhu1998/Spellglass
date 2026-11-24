// Test doubles for the pack service: the shipped pack files served from memory, an effect module that
// declares what it implements (to control knownEffects and capabilities), and an in-memory storage
// module that answers storage.* requests like the real one (and publishes storage.changed).

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Envelope, Kernel, Module, PackKind, StorageChanged, StoreName } from '../../src/contracts';
import { EFFECT_CAPABILITY, STORE_NAMES } from '../../src/contracts';
import { KernelError, createKernel, memoryPersistence, type KernelHost } from '../../src/kernel';

export const PACKS_DIR = fileURLToPath(new URL('../../public/packs/', import.meta.url));
export const BASE = 'https://spellglass.test/packs/';
export const INDEX_URL = `${BASE}index.json`;

export const ALL_EFFECTS = Object.keys(EFFECT_CAPABILITY);
export const ALL_CAPABILITIES = [...new Set(Object.values(EFFECT_CAPABILITY))];

/** Every file under public/packs, by path relative to it ('core-charms/pack.json'). Tests may
 *  replace entries with text. */
export function shippedFiles(): Map<string, Uint8Array | string> {
  const out = new Map<string, Uint8Array | string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(PACKS_DIR, p).replace(/\\/g, '/'), new Uint8Array(readFileSync(p)));
    }
  };
  walk(PACKS_DIR);
  return out;
}

/** A file of the map as text. */
export function fileText(files: Map<string, Uint8Array | string>, path: string): string {
  const body = files.get(path);
  if (body === undefined) throw new Error(`no file ${path}`);
  return typeof body === 'string' ? body : new TextDecoder().decode(body);
}

export function shippedJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(join(PACKS_DIR, path), 'utf8')) as T;
}

export function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(typeof data === 'string' ? bytes(data) : data).digest('hex');
}

export interface MemoryFetch {
  fetch: typeof fetch;
  requests: string[];
}

/** fetch that serves `files` (paths relative to BASE) and answers 404 for anything else. */
export function memoryFetch(files: Map<string, Uint8Array | string>): MemoryFetch {
  const requests: string[] = [];
  const fn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requests.push(url);
    if (!url.startsWith(BASE)) return new Response('not found', { status: 404, statusText: 'Not Found' });
    const body = files.get(decodeURIComponent(url.slice(BASE.length)));
    if (body === undefined) return new Response('not found', { status: 404, statusText: 'Not Found' });
    const data = typeof body === 'string' ? bytes(body) : body;
    // A copy as a plain ArrayBuffer (Response wants ArrayBuffer-backed views).
    return new Response(data.slice().buffer as ArrayBuffer, { status: 200 });
  };
  return { fetch: fn as typeof fetch, requests };
}

/** An index for the given files, with correct hashes unless an entry says otherwise. */
export function indexFor(entries: { id: string; kind: PackKind; version?: string; path: string; body: Uint8Array | string; sha256?: string }[]): string {
  return JSON.stringify({
    schema: 'packindex/1',
    packs: entries.map((e) => ({
      id: e.id, kind: e.kind, version: e.version ?? '1.0.0', path: e.path,
      sha256: e.sha256 ?? sha256(typeof e.body === 'string' ? bytes(e.body) : e.body),
    })),
  });
}

/** An effect module implementing `uses` and providing `provides` (default: every primitive). */
export function fakeEffects(uses: readonly string[] = ALL_EFFECTS, provides: readonly string[] = ALL_CAPABILITIES): Module {
  return {
    manifest: { id: 'effect.test', kind: 'effect', version: '1.0.0', contract: '^1.1', provides: [...provides], effects: [...uses] },
    async init() {},
    async start() {},
    async stop() {},
  };
}

export interface FakeStorage extends Module {
  data: Map<StoreName, Map<string, unknown>>;
  /** Make every request reject, like blocked storage. */
  failing: boolean;
  /** While set, storage.put refuses values with this message (invalid-payload), as the storage module
   *  refuses one it cannot keep while it goes on saving everything else. */
  refusePuts: string | null;
  /** Requests received, as 'name store/key'. */
  log: string[];
  /** While set, storage.get waits for it before reading (a slow read), so a test can act between the
   *  pack service's read of a record and its write. */
  slowGets: Promise<void> | null;
  /** Change a store as another writer would (storage.import), publishing storage.changed. */
  external(store: StoreName, key: string, value: unknown | undefined, reason?: StorageChanged['reason']): void;
}

/** Storage in memory, answering like the storage module: values are structured-cloned, lists come in
 *  key order, and storage.changed is published once per task after writes. `sharing` gives a second
 *  window the same records (one database, two tabs); its changes are not relayed to the first. */
export function fakeStorage(initial: Partial<Record<StoreName, Record<string, unknown>>> = {}, sharing?: FakeStorage): FakeStorage {
  const data = sharing ? sharing.data : new Map<StoreName, Map<string, unknown>>();
  if (!sharing) for (const s of STORE_NAMES) data.set(s, new Map(Object.entries(initial[s] ?? {}).map(([k, v]) => [k, structuredClone(v)])));
  let kernel: Kernel | null = null;
  let pending: { stores: Set<StoreName>; keys: Set<string>; reason: StorageChanged['reason'] } | null = null;
  const changed = (store: StoreName, reason: StorageChanged['reason'], key?: string) => {
    if (!pending) {
      pending = { stores: new Set(), keys: new Set(), reason };
      queueMicrotask(() => {
        const p = pending!;
        pending = null;
        kernel?.publish<StorageChanged>({ type: 'storage.changed', v: 1, t: kernel.now(), source: 'storage.test', payload: { stores: [...p.stores], reason: p.reason, ...(p.keys.size ? { keys: [...p.keys] } : {}) } });
      });
    }
    pending.stores.add(store);
    if (key !== undefined) pending.keys.add(key);
  };
  const store: FakeStorage = {
    manifest: { id: 'storage.test', kind: 'storage', version: '1.0.0', contract: '^1.1', provides: ['storage@1'] },
    data,
    failing: false,
    refusePuts: null,
    log: [],
    slowGets: null,
    external(s, key, value, reason = 'import') {
      if (value === undefined) data.get(s)!.delete(key);
      else data.get(s)!.set(key, structuredClone(value));
      changed(s, reason, key);
    },
    async init(k) {
      kernel = k;
      const guard = (name: string, p: { store?: StoreName; key?: string }) => {
        store.log.push(`${name} ${p?.store ?? '*'}${p?.key !== undefined ? `/${p.key}` : ''}`);
        if (store.failing) throw Object.assign(new Error('Storage is blocked'), { name: 'InvalidStateError' });
      };
      k.handle('storage.get', (p: { store: StoreName; key: string }) => {
        guard('get', p);
        const read = () => {
          const v = data.get(p.store)?.get(p.key);
          return v === undefined ? undefined : structuredClone(v);
        };
        return store.slowGets ? store.slowGets.then(read) : read();
      });
      k.handle('storage.put', (p: { store: StoreName; key: string; value: unknown }) => {
        guard('put', p);
        if (store.refusePuts !== null) throw new KernelError('invalid-payload', store.refusePuts);
        data.get(p.store)!.set(p.key, structuredClone(p.value));
        changed(p.store, 'put', p.key);
      });
      k.handle('storage.delete', (p: { store: StoreName; key: string }) => {
        guard('delete', p);
        data.get(p.store)!.delete(p.key);
        changed(p.store, 'delete', p.key);
      });
      k.handle('storage.list', (p: { store: StoreName; prefix?: string }) => {
        guard('list', p);
        return [...(data.get(p.store) ?? new Map()).entries()]
          .filter(([key]) => !p.prefix || key.startsWith(p.prefix))
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, value]) => ({ key, value: structuredClone(value) }));
      });
      k.handle('storage.clear', (p: { store?: StoreName }) => {
        guard('clear', p);
        for (const s of p?.store ? [p.store] : STORE_NAMES) {
          data.get(s)!.clear();
          changed(s, 'clear');
        }
      });
    },
    async start() {},
    async stop() {},
  };
  return store;
}

export interface Setup {
  kernel: KernelHost;
  fetch: MemoryFetch;
  /** Every envelope published, in order. */
  events: Envelope<unknown>[];
  of<T = unknown>(type: string): T[];
}

/** A kernel with the given modules, packs loaded from `files` (default: the shipped ones). */
export async function setup(options: {
  files?: Map<string, Uint8Array | string>;
  settings?: Record<string, unknown>;
  modules?: Module[];
  features?: string[];
  indexUrl?: string | null;
  load?: boolean;
} = {}): Promise<Setup> {
  const fetch = memoryFetch(options.files ?? shippedFiles());
  const kernel = createKernel({ persistence: memoryPersistence(options.settings), features: options.features ?? ['platform.dom'], fetch: fetch.fetch });
  const events: Envelope<unknown>[] = [];
  kernel.subscribe('*', (e) => events.push(e));
  kernel.register(...(options.modules ?? [fakeEffects()]));
  await kernel.init();
  if (options.load !== false) await kernel.loadPacks(options.indexUrl === undefined ? INDEX_URL : options.indexUrl);
  return { kernel, fetch, events, of: <T>(type: string) => events.filter((e) => e.type === type).map((e) => e.payload as T) };
}

/** Let queued microtasks (deferred rebuilds, storage.changed) run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
