// IndexedDB through idb: one object store per StoreName, explicit string keys (contracts/storage.ts).
//
// Opening. The database is opened at whatever version it already has, never at a fixed number: an
// older build opening a database that a newer build extended keeps working instead of failing with
// VersionError. When a store this build needs is missing (a new database, or one made by an older
// build with fewer stores), it is reopened one version higher and the upgrade creates the missing
// stores. Nothing else about the layout changes between versions: records migrate one by one
// (records.ts), so a version bump never has to rewrite data.
//
// The factory is passed in so tests can give each case its own database world (fake-indexeddb).

import type { IDBPDatabase } from 'idb';
import { unwrap, wrap } from 'idb';
import type { StoreName } from '../../contracts';
import { STORE_NAMES } from '../../contracts';
import { RefusedWrite, storesOf, type Backend, type ListOptions, type Row, type WriteOp, type WritePlan } from './backend';
import { errorName } from './status';

/** What a write request throws at once when its own value or key cannot be stored (see write()). */
const REFUSED = new Set(['DataCloneError', 'DataError', 'RangeError', 'TypeError']);

export interface OpenHooks {
  /** Our upgrade is waiting for another tab to let go of the database. */
  blocked(): void;
  /** Another tab wants a newer layout (or to delete the database); `db` must close now. */
  versionchange(db: IDBPDatabase): void;
  /** The browser closed the connection on its own (site data cleared, eviction, disk error). */
  terminated(db: IDBPDatabase): void;
}

/** Open (creating or extending as needed) the database with every store in STORE_NAMES. */
export async function openDatabase(factory: IDBFactory, name: string, hooks: OpenHooks): Promise<IDBPDatabase> {
  const db = await openOnce(factory, name, undefined, hooks);
  if (STORE_NAMES.every((s) => db.objectStoreNames.contains(s))) return db;
  const next = db.version + 1;
  db.close();
  return openOnce(factory, name, next, hooks);
}

/** idb's openDB, with the factory given rather than the global one. */
function openOnce(factory: IDBFactory, name: string, version: number | undefined, hooks: OpenHooks): Promise<IDBPDatabase> {
  const request = factory.open(name, version);
  request.addEventListener('upgradeneeded', () => {
    const raw = request.result;
    for (const s of STORE_NAMES) if (!raw.objectStoreNames.contains(s)) raw.createObjectStore(s);
  });
  request.addEventListener('blocked', () => hooks.blocked());
  const opened = wrap(request) as Promise<IDBPDatabase>;
  opened.then(
    (db) => {
      const raw = unwrap(db);
      raw.addEventListener('close', () => hooks.terminated(db));
      raw.addEventListener('versionchange', () => hooks.versionchange(db));
    },
    () => undefined,
  );
  return opened;
}

/** The smallest string greater than every string that starts with `prefix`, or null if none exists. */
export function prefixEnd(prefix: string): string | null {
  for (let i = prefix.length - 1; i >= 0; i--) {
    const c = prefix.charCodeAt(i);
    if (c < 0xffff) return prefix.slice(0, i) + String.fromCharCode(c + 1);
  }
  return null;
}

function prefixRange(prefix: string): IDBKeyRange {
  const end = prefixEnd(prefix);
  return end === null ? IDBKeyRange.lowerBound(prefix) : IDBKeyRange.bound(prefix, end, false, true);
}

/** idb creates `tx.done` with the transaction. When a request throws before anything awaits it, the
 *  abort that follows would reject `done` with nobody listening; this keeps that rejection observed
 *  (the operation reports the failure itself). */
function observed<T extends { done: Promise<void> }>(tx: T): T {
  tx.done.catch(() => undefined);
  return tx;
}

export class IdbBackend implements Backend {
  readonly kind = 'indexeddb' as const;

  constructor(readonly db: IDBPDatabase) {}

  // Every operation opens its own transaction and reports the transaction's error when it fails, so a
  // failure can be classified (a quota failure shows only there, when the commit is refused).

  async get(store: StoreName, key: string): Promise<unknown> {
    const tx = observed(this.db.transaction(store, 'readonly'));
    try {
      const [value] = await Promise.all([tx.store.get(key), tx.done]);
      return value;
    } catch (err) {
      throw tx.error ?? err;
    }
  }

  async list(store: StoreName, options: ListOptions): Promise<Row[]> {
    const tx = observed(this.db.transaction(store, 'readonly'));
    const out: Row[] = [];
    try {
      const range = options.prefix ? prefixRange(options.prefix) : null;
      let cursor = await tx.store.openCursor(range, options.reverse ? 'prev' : 'next');
      while (cursor && (options.limit === undefined || out.length < options.limit)) {
        if (typeof cursor.key === 'string') out.push({ key: cursor.key, value: cursor.value });
        cursor = await cursor.continue();
      }
      await tx.done;
    } catch (err) {
      throw tx.error ?? err;
    }
    return out;
  }

  async read(stores: readonly StoreName[]): Promise<Map<StoreName, Row[]>> {
    const out = new Map<StoreName, Row[]>();
    if (!stores.length) return out;
    const tx = observed(this.db.transaction([...stores], 'readonly'));
    try {
      await Promise.all([
        ...stores.map(async (s) => {
          const store = tx.objectStore(s);
          const [keys, values] = await Promise.all([store.getAllKeys(), store.getAll()]);
          const rows: Row[] = [];
          keys.forEach((k, i) => {
            if (typeof k === 'string') rows.push({ key: k, value: values[i] });
          });
          out.set(s, rows);
        }),
        tx.done,
      ]);
    } catch (err) {
      throw tx.error ?? err;
    }
    return out;
  }

  async write(plan: WritePlan): Promise<void> {
    const stores = storesOf(plan);
    if (!stores.length) return;
    const tx = observed(this.db.transaction(stores, 'readwrite'));
    const requests: Promise<unknown>[] = [];
    let current: WriteOp | undefined;
    try {
      for (const s of plan.clear) requests.push(tx.objectStore(s).clear());
      for (current of plan.ops) {
        const store = tx.objectStore(current.store);
        requests.push(current.kind === 'put' ? store.put(current.value, current.key) : store.delete(current.key));
      }
    } catch (err) {
      // A request that throws at once is never made, and the transaction stays active: left alone, it
      // would commit the writes before this one. Abort it, so the plan stays all or nothing.
      for (const r of requests) r.catch(() => undefined);
      try {
        tx.abort();
      } catch {
        /* already finished */
      }
      // put() throws this way when it cannot clone the value or use the key: a DataCloneError or a
      // DataError, or a RangeError (Chrome, when cloning a deeply nested value overflows the stack) or
      // a TypeError. That is the caller's value, not a failing database, so the module keeps using it.
      // Anything else (InvalidStateError while the connection closes) is passed on as it came.
      if (current && REFUSED.has(errorName(err))) throw new RefusedWrite(current, err);
      throw err;
    }
    try {
      requests.push(tx.done);
      await Promise.all(requests);
    } catch (err) {
      // The transaction's own error names the cause (QuotaExceededError at commit); the requests
      // only report that they were aborted.
      throw tx.error ?? err;
    }
  }

  close(): void {
    this.db.close();
  }
}
