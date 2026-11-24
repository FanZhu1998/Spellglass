// Storage on this device (storage.indexeddb): camera profiles, gesture samples, redrawn gestures,
// progress, keepsakes, imported packs, recorded sessions and small values, in IndexedDB through idb
// (Section 5 table, Section 9.4). The behaviour is set by the header of contracts/storage.ts and the
// storage requests in contracts/requests.ts:
//  - it never requires platform.indexeddb: without IndexedDB, or when it is blocked, full or closed,
//    it keeps every request working from memory and says so in the sticky 'storage.status'
//    (Section 7.9 "Storage is blocked or full: runs without saving and says so");
//  - it serves every 'storage.*' request from the end of init(), and opens the database lazily;
//  - requests reject only with KernelError 'invalid-payload' (a bad store name, key or value);
//  - values are structured-cloned on the way in, also into memory;
//  - records are migrated forward when read and when imported, never rewritten on read
//    (Section 9.1 rule 4);
//  - committed writes are announced as 'storage.changed', coalesced per task, and to the app's other
//    tabs on this device, where they arrive as 'storage.changed' with reason 'other-tab'.
//
// The work is split: core.ts (opening, the switch to memory, ordering, events), idb.ts (IndexedDB),
// backend.ts (the memory store), records.ts (copies, migrations, record shapes), transfer.ts
// ("Export my data" and "Import"), status.ts (messages and error classes), tabs.ts (the other tabs).

import type { Kernel, Module, ModuleManifest, RequestPayload, StoreName, UserDataExport } from '../../contracts';
import { STORE_NAMES } from '../../contracts';
import { KernelError, ask, describeError, emit, logger, serve } from '../../kernel';
import { StorageCore, type QuotaApi } from './core';
import { MAX_KEY_LENGTH, cloneForStorage, isRecord, isStoreName, migrateRecord } from './records';
import { TabRelay, type TabChannel } from './tabs';
import { DEFAULT_EXPORT_STORES, buildExport, planSettings, readExport } from './transfer';

export const MANIFEST: ModuleManifest = {
  id: 'storage.indexeddb',
  kind: 'storage',
  title: 'Storage on this device',
  version: '1.0.0',
  contract: '^1.1',
  provides: ['storage@1'],
  // Deliberately empty: without IndexedDB this module still answers, from memory.
  requires: [],
};

const log = logger('storage');

export interface StorageOptions {
  /** Database name (default 'spellglass'). */
  dbName?: string;
  /** IndexedDB factory; default: the browser's, looked up when storage first opens. */
  factory?: () => IDBFactory | null | undefined;
  /** navigator.storage, or a stand-in; default: the browser's. */
  quota?: () => QuotaApi | null | undefined;
  /** Opens the BroadcastChannel to the app's other tabs (tabs.ts). Default: none, so no other tab is
   *  told. The app's createStorageModule passes the browser's; tests ask for one, since a channel
   *  reaches every kernel of the process and keeps Node running until it is closed. */
  channel?: (name: string) => TabChannel | null;
  openTimeoutMs?: number;
  opTimeoutMs?: number;
  drainTimeoutMs?: number;
}

export function createStorageModule(opts: { dbName?: string } = {}): Module {
  return createStorage({ dbName: opts.dbName, channel: browserChannel });
}

/** The module with its browser dependencies replaceable (tests use fake-indexeddb and short timeouts). */
export function createStorage(options: StorageOptions = {}): Module {
  let core: StorageCore | null = null;
  let tabs: TabRelay | null = null;

  return {
    manifest: MANIFEST,

    async init(k) {
      const dbName = options.dbName ?? 'spellglass';
      const c = new StorageCore({
        dbName,
        factory: options.factory ?? browserIndexedDb,
        quota: options.quota ?? browserQuota,
        onStatus: (status) => emit(k, MANIFEST.id, 'storage.status', status),
        onChanged: (change) => {
          emit(k, MANIFEST.id, 'storage.changed', change);
          tabs?.post(change);
        },
        openTimeoutMs: options.openTimeoutMs,
        opTimeoutMs: options.opTimeoutMs,
        drainTimeoutMs: options.drainTimeoutMs,
        log,
      });
      core = c;
      registerRequests(k, c);
      if (options.channel) {
        tabs = new TabRelay({
          open: options.channel,
          dbName,
          mode: () => c.mode(),
          heard: (change) => emit(k, MANIFEST.id, 'storage.changed', change),
          onError: (what, err) => log.info(what, err),
        });
        // From init on, like the requests: the pack loader reads and writes during boot, before start().
        tabs.open();
      }
    },

    async start() {
      // Again after a stop().
      tabs?.open();
      // The first open usually happened already (the pack loader lists its stores during boot).
      // Publishing the status again once it is known reaches the shell, which subscribes later.
      const c = core;
      if (c) void c.ready().then(() => c.republish());
    },

    async stop() {
      await core?.close();
      // After the writes in flight, so the other tabs hear of those too.
      tabs?.close();
    },
  };
}

// ---------------------------------------------------------------------------------------- requests

function registerRequests(k: Kernel, c: StorageCore): void {
  serve(k, 'storage.get', async (p) => {
    const { store, key } = storeAndKey(p, 'storage.get');
    return migrateRecord(store, await c.get(store, key));
  });

  serve(k, 'storage.put', async (p) => {
    const { store, key } = storeAndKey(p, 'storage.put');
    if (key.length === 0 || key.length > MAX_KEY_LENGTH) throw invalid(`storage.put needs a key of 1 to ${MAX_KEY_LENGTH} characters.`);
    const value = (p as { value?: unknown }).value;
    if (value === undefined) throw invalid('storage.put needs a value. Use storage.delete to remove a record.');
    const copy = cloneForStorage(value);
    if (!copy.ok) throw invalid(copy.reason);
    if (copy.viaJson) log.once('storage.json-copy', `storage.put (${store}/${key}) was given a value that cannot be structured-cloned, such as a Svelte proxy; a JSON copy was saved. Pass $state.snapshot() instead.`);
    await c.put(store, key, copy.value);
  });

  serve(k, 'storage.delete', async (p) => {
    const { store, key } = storeAndKey(p, 'storage.delete');
    await c.delete(store, key);
  });

  serve(k, 'storage.list', async (p) => {
    if (!isRecord(p) || !isStoreName(p.store)) throw invalid('storage.list needs { store } naming a known store.');
    const { limit, reverse, prefix } = p as RequestPayload<'storage.list'>;
    if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) throw invalid('storage.list limit must be a whole number, 0 or more.');
    if (reverse !== undefined && typeof reverse !== 'boolean') throw invalid('storage.list reverse must be true or false.');
    if (prefix !== undefined && typeof prefix !== 'string') throw invalid('storage.list prefix must be text.');
    const store = p.store;
    const rows = await c.list(store, { limit, reverse, prefix });
    return rows.map((r) => ({ key: r.key, value: migrateRecord(store, r.value) }));
  });

  serve(k, 'storage.clear', async (p) => {
    const store = isRecord(p) ? p.store : undefined;
    if (store !== undefined && !isStoreName(store)) throw invalid('storage.clear names an unknown store.');
    await c.clear(store === undefined ? STORE_NAMES : [store]);
  });

  serve(k, 'storage.export', async (p) => {
    const asked = isRecord(p) ? p.stores : undefined;
    let stores: readonly StoreName[] = DEFAULT_EXPORT_STORES;
    if (asked !== undefined) {
      if (!Array.isArray(asked) || !asked.every(isStoreName)) throw invalid('storage.export stores must list known store names.');
      stores = [...new Set(asked)];
    }
    const settings = await userSettings(k);
    const rows = await c.read(stores);
    return buildExport({ settings, stores: rows, now: new Date() });
  });

  serve(k, 'storage.import', async (p) => {
    if (!isRecord(p) || !('data' in p)) throw invalid('storage.import needs { data }: the exported file or its text.');
    const mode = p.mode ?? 'merge';
    if (mode !== 'merge' && mode !== 'replace') throw invalid("storage.import mode must be 'merge' or 'replace'.");
    const read = readExport(p.data);
    if (!read.ok) throw invalid(read.reason);
    const plan = await c.importRecords(read.doc, mode);
    if (plan.invalid.length) log.warn(`import: ${plan.invalid.length} record(s) failed their checks and were left out`, plan.invalid.slice(0, 10));
    if (plan.kept) log.info(`import: ${plan.kept} record(s) on this device were newer and were kept`);
    if (plan.unknownStores.length) log.info(`import: stores this edition does not know were ignored: ${plan.unknownStores.join(', ')}`);
    const settings = await applySettings(k, read.doc);
    return { imported: plan.imported, settings };
  });

  serve(k, 'storage.status', () => c.refreshStatus());

  serve(k, 'storage.persist', () => c.persist());
}

function storeAndKey(p: unknown, name: string): { store: StoreName; key: string } {
  if (!isRecord(p) || !isStoreName(p.store)) throw invalid(`${name} needs { store, key } naming a known store.`);
  if (typeof p.key !== 'string') throw invalid(`${name} needs a key, as text.`);
  return { store: p.store, key: p.key };
}

function invalid(message: string): KernelError {
  return new KernelError('invalid-payload', message);
}

/** Only the player's own values, so defaults are never pinned (contracts/storage.ts). */
async function userSettings(k: Kernel): Promise<Record<string, unknown>> {
  try {
    const values = await ask(k, 'settings.user');
    return isRecord(values) ? values : {};
  } catch (err) {
    log.warn('could not read the settings for the export', err);
    return {};
  }
}

/** Settings go through 'settings.set' one by one; unknown keys, session-only keys and values the
 *  kernel refuses are skipped. Returns how many were applied. */
async function applySettings(k: Kernel, doc: UserDataExport): Promise<number> {
  const plan = planSettings(doc);
  if (plan.skipped.length) log.info('import: settings skipped', plan.skipped);
  let applied = 0;
  for (const { key, value } of plan.apply) {
    try {
      await ask(k, 'settings.set', { key, value });
      applied++;
    } catch (err) {
      log.info(`import: setting ${key} skipped: ${describeError(err).message}`);
    }
  }
  return applied;
}

// ------------------------------------------------------------------------------- browser lookups

/** Looked up only when storage first opens, never at import time (tests import this in Node). */
function browserIndexedDb(): IDBFactory | null {
  const g = globalThis as { indexedDB?: IDBFactory | null };
  return g.indexedDB ?? null;
}

function browserQuota(): QuotaApi | null {
  const nav = (globalThis as { navigator?: { storage?: QuotaApi } }).navigator;
  return nav?.storage ?? null;
}

function browserChannel(name: string): TabChannel | null {
  const Channel = (globalThis as { BroadcastChannel?: new (name: string) => TabChannel }).BroadcastChannel;
  return typeof Channel === 'function' ? new Channel(name) : null;
}
