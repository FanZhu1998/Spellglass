// The storage service behind the module's requests (contracts/storage.ts header):
//  - IndexedDB is opened lazily, on the first request (the pack loader's, during boot).
//  - When IndexedDB is missing, blocked, full or closed, everything moves to an in-memory store for
//    the rest of the session, every request keeps resolving, and the status says so (Section 7.9:
//    "runs without saving and says so"). A full database is copied into memory first, since it can
//    still be read; a blocked or closed one cannot, so memory starts empty.
//  - Requests run one at a time, in the order they arrived, so a read always sees the writes asked
//    for before it, whichever store is current and even across the switch to memory.
//  - Puts and deletes asked for in the same task share one transaction, and their 'storage.changed'
//    goes out as one event per store and reason, carrying the keys ("coalesced per task"). Imports
//    and clears of several stores are one event for all of them, without keys.
//  - A value or key a store will not take is the caller's problem, never a reason to give up
//    IndexedDB: that request alone is rejected with 'invalid-payload', and the other writes of its
//    transaction are written again without it.
//
// No kernel here: the module passes callbacks for its two events, and the browser's IndexedDB factory
// and quota API, so tests can drive every failure.

import type { IDBPDatabase } from 'idb';
import type { StorageChanged, StorageStatus, StoreName, UserDataExport } from '../../contracts';
import { STORE_NAMES } from '../../contracts';
import { KernelError, logger, type Logger } from '../../kernel';
import { MemoryBackend, RefusedWrite, type Backend, type ListOptions, type Row, type WriteOp } from './backend';
import { IdbBackend, openDatabase } from './idb';
import { cloneForStorage } from './records';
import { STORAGE_MESSAGES, isCallerError, messageFor, reasonForOpenError, reasonForOperationError, withTimeout, type MemoryReason } from './status';
import { IMPORT_MESSAGES, planImport, storesIn, type ImportPlan } from './transfer';

/** The parts of navigator.storage the module uses; each is optional (Safari lacks some). */
export interface QuotaApi {
  estimate?(): Promise<{ usage?: number; quota?: number }>;
  persisted?(): Promise<boolean>;
  persist?(): Promise<boolean>;
}

export interface StorageCoreOptions {
  dbName: string;
  /** The IndexedDB factory, looked up on first use; null or undefined when the browser has none.
   *  It may throw (a SecurityError in sandboxed frames), which counts as blocked. */
  factory: () => IDBFactory | null | undefined;
  quota: () => QuotaApi | null | undefined;
  onStatus: (status: StorageStatus) => void;
  onChanged: (change: StorageChanged) => void;
  /** An open that neither succeeds nor fails by then counts as blocked. */
  openTimeoutMs?: number;
  /** An operation that has not settled by then counts as the database being closed. */
  opTimeoutMs?: number;
  /** How long close() waits for the requests in flight. */
  drainTimeoutMs?: number;
  log?: Logger;
}

/** Long enough for a slow disk on first creation, short enough not to stall the boot for long. */
const OPEN_TIMEOUT_MS = 3000;
const OP_TIMEOUT_MS = 10_000;
/** Imports write everything in one transaction, which can take a while for a large file. */
const IMPORT_TIMEOUT_MS = 30_000;
/** navigator.storage answers are nice to have; the status never waits long for them. */
const QUOTA_TIMEOUT_MS = 1000;
/** How long stop() waits for requests in flight before it closes the database. */
const DRAIN_TIMEOUT_MS = 2000;

interface PendingChange {
  reason: StorageChanged['reason'];
  stores: StoreName[];
  /** null once any write in the group had no key (a clear). */
  keys: string[] | null;
  /** Several stores at once (imports, clearing everything). */
  multi: boolean;
}

interface Batch {
  ops: WriteOp[];
  /** Settles once the batch is written, with the writes that were refused (see writeAllowed()). */
  done: Promise<Map<WriteOp, RefusedWrite>>;
}

export class StorageCore {
  private readonly opts: StorageCoreOptions;
  private readonly log: Logger;
  private readonly openTimeoutMs: number;
  private readonly opTimeoutMs: number;

  private idb: IdbBackend | null = null;
  /** Set once IndexedDB has been given up; never cleared in this session. */
  private memory: MemoryBackend | null = null;
  private opening: Promise<void> | null = null;
  private openDone: (() => void) | null = null;
  /** Raised by close(), so an open that finishes after it does not install its connection. */
  private generation = 0;
  private chain: Promise<unknown> = Promise.resolve();
  /** Writes waiting for their shared transaction; closed when that transaction starts. */
  private batch: Batch | null = null;
  private current: StorageStatus | null = null;
  private pending: PendingChange[] = [];
  private flushQueued = false;

  constructor(opts: StorageCoreOptions) {
    this.opts = opts;
    this.log = opts.log ?? logger('storage');
    this.openTimeoutMs = opts.openTimeoutMs ?? OPEN_TIMEOUT_MS;
    this.opTimeoutMs = opts.opTimeoutMs ?? OP_TIMEOUT_MS;
  }

  /** The last status published, or null before the first open attempt has finished. */
  status(): StorageStatus | null {
    return this.current;
  }

  /** Which store answers now: 'indexeddb', 'memory', or null before the first open attempt. */
  mode(): Backend['kind'] | null {
    return this.memory ? 'memory' : this.idb ? 'indexeddb' : null;
  }

  /** Resolves once the first open attempt has ended, either way. Never rejects. */
  ready(): Promise<void> {
    if (this.memory || this.idb) return Promise.resolve();
    if (!this.opening) {
      this.opening = new Promise<void>((resolve) => {
        this.openDone = resolve;
      });
      void this.open();
    }
    return this.opening;
  }

  // ------------------------------------------------------------------------------- operations

  get(store: StoreName, key: string): Promise<unknown> {
    return this.exec('reading', (b) => b.get(store, key));
  }

  /** `value` must already be a private copy (records.ts cloneForStorage). Resolves once committed. */
  put(store: StoreName, key: string, value: unknown): Promise<void> {
    return this.enqueue({ kind: 'put', store, key, value });
  }

  delete(store: StoreName, key: string): Promise<void> {
    return this.enqueue({ kind: 'delete', store, key });
  }

  list(store: StoreName, options: ListOptions): Promise<Row[]> {
    return this.exec('listing', (b) => b.list(store, options));
  }

  async clear(stores: readonly StoreName[]): Promise<void> {
    if (!stores.length) return;
    await this.exec('clearing', (b) => b.write({ clear: stores, ops: [] }));
    this.changed('clear', [...stores]);
  }

  /** Every record of the stores, as stored (exports, tests). */
  read(stores: readonly StoreName[]): Promise<Map<StoreName, Row[]>> {
    return this.exec('reading', (b) => b.read(stores));
  }

  /** Plan an import against what this device holds and write it in one transaction (transfer.ts). */
  async importRecords(doc: UserDataExport, mode: 'merge' | 'replace'): Promise<ImportPlan> {
    const stores = storesIn(doc);
    const plan = await this.exec(
      'importing',
      async (b) => {
        const existing = mode === 'merge' && stores.length ? await b.read(stores) : new Map<StoreName, Row[]>();
        const planned = planImport(doc, existing, mode);
        // The file's objects may belong to the caller; the stores get copies of their own.
        const ops: WriteOp[] = [];
        for (const [store, rows] of planned.put) {
          for (const r of rows) {
            const op: WriteOp = { kind: 'put', store, key: r.key, value: r.value };
            const copy = cloneForStorage(r.value);
            if (!copy.ok) throw new RefusedWrite(op, copy.reason);
            ops.push({ ...op, value: copy.value });
          }
        }
        await b.write({ clear: planned.clear, ops });
        return planned;
      },
      IMPORT_TIMEOUT_MS,
      // One transaction: a record the store refuses leaves everything as it was.
      IMPORT_MESSAGES.refused,
    );
    const touched = [...new Set<StoreName>([...plan.clear, ...plan.put.keys()])];
    if (touched.length) this.changed('import', touched);
    return plan;
  }

  // ------------------------------------------------------------------------------- status

  /** Publish the current status again (the module does this from start(), for the shell). */
  republish(): void {
    if (this.current) this.opts.onStatus(this.current);
  }

  /** The status after the open attempt, with fresh usage figures while IndexedDB is in use. */
  async refreshStatus(): Promise<StorageStatus> {
    await this.ready();
    if (!this.memory && this.idb) {
      const next = await this.healthyStatus();
      if (!this.memory && JSON.stringify(next) !== JSON.stringify(this.current)) this.setStatus(next);
    }
    return this.current ?? { persistent: false, reason: 'unsupported', message: STORAGE_MESSAGES.unsupported };
  }

  /** Ask the browser to keep the data (navigator.storage.persist()). */
  async persist(): Promise<{ durable: boolean }> {
    const q = this.quota();
    let durable = false;
    if (q?.persist) {
      try {
        durable = (await withTimeout(q.persist(), 10_000, 'persist')) === true;
      } catch (err) {
        this.log.info('the browser did not answer the request to keep data', err);
      }
    }
    await this.ready();
    // Durability is a property of saved data; in memory nothing is saved, so the status stays as it is.
    if (this.current?.persistent && this.current.durable !== durable) this.setStatus({ ...this.current, durable });
    return { durable };
  }

  /** Close the database after the requests in flight (module stop). The next request reopens it. */
  async close(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const settled = Promise.all([this.chain, this.opening ?? Promise.resolve()]).then(() => undefined);
    await Promise.race([settled, new Promise<void>((resolve) => (timer = setTimeout(resolve, this.opts.drainTimeoutMs ?? DRAIN_TIMEOUT_MS)))]);
    if (timer !== null) clearTimeout(timer);
    // An open still running now belongs to the stopped module: it closes what it gets (see open()).
    this.generation++;
    this.finishOpening();
    const idb = this.idb;
    this.idb = null;
    this.opening = null;
    if (idb) {
      try {
        idb.close();
      } catch {
        /* already closed */
      }
    }
  }

  // ------------------------------------------------------------------------------- internals

  /** Run `fn` in turn. A caller's error (isCallerError) rejects with 'invalid-payload' and `refusal`. */
  private exec<T>(what: string, fn: (b: Backend) => Promise<T>, timeoutMs: number = this.opTimeoutMs, refusal: string = STORAGE_MESSAGES.refused): Promise<T> {
    const run = this.chain.then(() => this.run(what, fn, timeoutMs, refusal));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async run<T>(what: string, fn: (b: Backend) => Promise<T>, timeoutMs: number, refusal: string): Promise<T> {
    const backend = await this.backend();
    if (backend instanceof IdbBackend) {
      try {
        return await withTimeout(fn(backend), timeoutMs, `IndexedDB ${what}`);
      } catch (err) {
        if (isCallerError(err)) throw new KernelError('invalid-payload', refusal, err);
        await this.giveUp(backend, reasonForOperationError(err), err);
      }
    }
    // Memory: also the second try of an operation IndexedDB failed (it wrote nothing: transactions are
    // all or nothing, also when a request throws at once, idb.ts).
    try {
      return await fn(this.memory ?? this.useMemory('closed', STORAGE_MESSAGES.closed));
    } catch (err) {
      if (isCallerError(err)) throw new KernelError('invalid-payload', refusal, err);
      throw err;
    }
  }

  /** Join the batch of writes for the current task, starting one if needed. The batch shares one
   *  transaction, but each request has its own outcome: one refused write fails only its request. */
  private enqueue(op: WriteOp): Promise<void> {
    let batch = this.batch;
    if (!batch) {
      const ops: WriteOp[] = [];
      const done = this.exec('saving', async (b) => {
        // From here on, new writes start the next batch (queued behind this one).
        if (this.batch?.ops === ops) this.batch = null;
        return writeAllowed(b, ops);
      }).then((refused) => {
        for (const o of ops) if (!refused.has(o)) this.changed(o.kind, [o.store], o.key);
        return refused;
      });
      batch = { ops, done };
      this.batch = batch;
    }
    batch.ops.push(op);
    return batch.done.then((refused) => {
      const err = refused.get(op);
      if (err) throw new KernelError('invalid-payload', STORAGE_MESSAGES.refused, err);
    });
  }

  /** The store to use now, opening IndexedDB first if needed (again, if stop() closed it meanwhile). */
  private async backend(): Promise<Backend> {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.memory) return this.memory;
      if (this.idb) return this.idb;
      await this.ready();
    }
    return this.memory ?? this.idb ?? this.useMemory('closed', STORAGE_MESSAGES.closed);
  }

  private async open(): Promise<void> {
    let factory: IDBFactory | null | undefined;
    try {
      factory = this.opts.factory();
    } catch (err) {
      this.log.info('IndexedDB is not accessible', err);
      this.useMemory('blocked', STORAGE_MESSAGES.blocked);
      return;
    }
    if (!factory || typeof factory.open !== 'function') {
      this.useMemory('unsupported', STORAGE_MESSAGES.unsupported);
      return;
    }
    const generation = this.generation;
    const opening = openDatabase(factory, this.opts.dbName, {
      blocked: () => {
        if (generation === this.generation && !this.idb) this.useMemory('blocked', STORAGE_MESSAGES.blocked);
      },
      versionchange: (db) => this.lost(db, STORAGE_MESSAGES.otherTab, true),
      terminated: (db) => this.lost(db, STORAGE_MESSAGES.closed, false),
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const outcome = await Promise.race([
      opening.then((db) => ({ db }), (error: unknown) => ({ error })),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), this.openTimeoutMs);
      }),
    ]);
    if (timer !== null) clearTimeout(timer);
    if (generation !== this.generation) {
      // stop() ran meanwhile: whatever this open produced is not wanted any more.
      opening.then((db) => db.close(), () => undefined);
      return;
    }
    if (outcome === 'timeout') {
      // A late success is closed at once: the session has moved on to memory.
      opening.then((db) => db.close(), () => undefined);
      this.useMemory('blocked', STORAGE_MESSAGES.noAnswer);
      return;
    }
    if ('error' in outcome) {
      this.log.info('IndexedDB could not be opened', outcome.error);
      const reason = reasonForOpenError(outcome.error);
      this.useMemory(reason, messageFor(reason));
      return;
    }
    if (this.memory) {
      // Blocked while opening: the session already runs from memory.
      outcome.db.close();
      return;
    }
    this.idb = new IdbBackend(outcome.db);
    this.finishOpening();
    const status = await this.healthyStatus();
    if (!this.memory && this.idb) this.setStatus(status);
  }

  /** The browser or another tab took the connection away. */
  private lost(db: IDBPDatabase, message: string, close: boolean): void {
    if (close) {
      // Let the other tab go ahead at once; waiting would block its upgrade.
      try {
        db.close();
      } catch {
        /* already closed */
      }
    }
    if (this.idb?.db !== db) return;
    this.idb = null;
    this.useMemory('closed', message);
  }

  /** An operation failed: move to memory, copying what IndexedDB still holds when it is only full. */
  private async giveUp(idb: IdbBackend, reason: MemoryReason, err: unknown): Promise<void> {
    if (this.memory) return;
    this.log.info(`an IndexedDB operation failed (${reason})`, err);
    let seed: Map<StoreName, Row[]> | undefined;
    if (reason === 'full') {
      try {
        seed = await withTimeout(idb.read(STORE_NAMES), this.opTimeoutMs, 'IndexedDB reading');
      } catch (readErr) {
        this.log.info('could not copy the stored data into memory', readErr);
      }
    }
    if (this.memory) return;
    this.useMemory(reason, messageFor(reason), seed);
  }

  private useMemory(reason: MemoryReason, message: string, seed?: ReadonlyMap<StoreName, readonly Row[]>): MemoryBackend {
    if (this.memory) return this.memory;
    const memory = new MemoryBackend(seed);
    this.memory = memory;
    const idb = this.idb;
    this.idb = null;
    if (idb) {
      try {
        idb.close();
      } catch {
        /* already closed */
      }
    }
    if (reason === 'unsupported') this.log.info(message);
    else this.log.warn(message);
    this.setStatus({ persistent: false, reason, message });
    this.finishOpening();
    return memory;
  }

  private finishOpening(): void {
    const done = this.openDone;
    this.openDone = null;
    done?.();
  }

  private quota(): QuotaApi | null {
    try {
      return this.opts.quota() ?? null;
    } catch {
      return null;
    }
  }

  private async healthyStatus(): Promise<StorageStatus> {
    const q = this.quota();
    const answer = <T>(call: (() => Promise<T>) | null): Promise<T | null> => {
      if (!call) return Promise.resolve(null);
      try {
        return withTimeout(call(), QUOTA_TIMEOUT_MS, 'navigator.storage').catch(() => null);
      } catch {
        return Promise.resolve(null);
      }
    };
    // Called as methods: navigator.storage's functions need their object.
    const [estimate, persisted] = await Promise.all([
      answer(q?.estimate ? () => q.estimate!() : null),
      answer(q?.persisted ? () => q.persisted!() : null),
    ]);
    const status: StorageStatus = { persistent: true };
    if (typeof persisted === 'boolean') status.durable = persisted;
    if (estimate && typeof estimate.usage === 'number') status.usage = estimate.usage;
    if (estimate && typeof estimate.quota === 'number') status.quota = estimate.quota;
    return status;
  }

  private setStatus(status: StorageStatus): void {
    this.current = status;
    this.opts.onStatus(status);
  }

  /** Note a committed write; the event goes out once the current task's other writes are in. */
  private changed(reason: StorageChanged['reason'], stores: StoreName[], key?: string): void {
    const multi = stores.length !== 1;
    let group = this.pending.find((g) => g.reason === reason && g.multi === multi && (multi || g.stores[0] === stores[0]));
    if (!group) {
      group = { reason, stores: [], keys: key === undefined ? null : [], multi };
      this.pending.push(group);
    }
    for (const s of stores) if (!group.stores.includes(s)) group.stores.push(s);
    if (key === undefined) group.keys = null;
    else if (group.keys && !group.keys.includes(key)) group.keys.push(key);
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      for (const g of this.pending.splice(0)) {
        this.opts.onChanged({ stores: g.stores, reason: g.reason, ...(g.keys && g.keys.length ? { keys: g.keys } : {}) });
      }
    });
  }
}

/** Write `ops` as one transaction. When the store refuses one of them because of its own value or
 *  key (RefusedWrite; nothing of that transaction was written), the others are written again in a
 *  new one, so a batch that happened to share a task with a bad value loses nothing. Returns the
 *  refused writes. */
async function writeAllowed(b: Backend, ops: readonly WriteOp[]): Promise<Map<WriteOp, RefusedWrite>> {
  const refused = new Map<WriteOp, RefusedWrite>();
  let rest = ops;
  for (;;) {
    try {
      await b.write({ clear: [], ops: rest });
      return refused;
    } catch (err) {
      if (!(err instanceof RefusedWrite) || !rest.includes(err.op)) throw err;
      refused.set(err.op, err);
      rest = rest.filter((o) => o !== err.op);
    }
  }
}
