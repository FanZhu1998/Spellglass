// Where records live: IndexedDB (idb.ts) while it works, this in-memory store once it does not
// (Section 7.9). Both answer the same small interface, so the module runs every request the same way
// whichever one is current.

import type { StoreName } from '../../contracts';
import { STORE_NAMES } from '../../contracts';
import { copyOut } from './records';
import type { Row } from './transfer';

export type { Row } from './transfer';

export interface ListOptions {
  limit?: number;
  reverse?: boolean;
  prefix?: string;
}

/** One write. Values are already private copies (records.ts cloneForStorage). */
export type WriteOp =
  | { kind: 'put'; store: StoreName; key: string; value: unknown }
  | { kind: 'delete'; store: StoreName; key: string };

/** Writes made as one unit: the stores in `clear` are emptied first, then `ops` run in order. */
export interface WritePlan {
  clear: readonly StoreName[];
  ops: readonly WriteOp[];
}

/** A store refused one write of a plan because of its own value or key, not because the store
 *  failed. Nothing of the plan was written; `op` is the write that was refused. */
export class RefusedWrite extends Error {
  override readonly cause: unknown;
  constructor(
    readonly op: WriteOp,
    cause: unknown,
  ) {
    super(`The ${op.kind} of ${op.store}/${op.key} was refused: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'RefusedWrite';
    this.cause = cause;
  }
}

export interface Backend {
  readonly kind: 'indexeddb' | 'memory';
  get(store: StoreName, key: string): Promise<unknown>;
  /** In ascending key order unless reverse; string keys only. */
  list(store: StoreName, options: ListOptions): Promise<Row[]>;
  /** Every record of the given stores, in key order. */
  read(stores: readonly StoreName[]): Promise<Map<StoreName, Row[]>>;
  /** All of it happens or none of it does (one IndexedDB transaction). Rejects with RefusedWrite when
   *  one write's own value or key cannot be stored. */
  write(plan: WritePlan): Promise<void>;
  close(): void;
}

/** Keys in IndexedDB order: strings compare by UTF-16 code units, which is what < does. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The stores a plan touches, in a stable order. */
export function storesOf(plan: WritePlan): StoreName[] {
  return [...new Set<StoreName>([...plan.clear, ...plan.ops.map((o) => o.store)])];
}

export class MemoryBackend implements Backend {
  readonly kind = 'memory' as const;
  private data = new Map<StoreName, Map<string, unknown>>();

  constructor(seed?: ReadonlyMap<StoreName, readonly Row[]>) {
    for (const s of STORE_NAMES) this.data.set(s, new Map());
    if (seed) for (const [store, rows] of seed) for (const r of rows) this.map(store).set(r.key, r.value);
  }

  async get(store: StoreName, key: string): Promise<unknown> {
    return copyOut(this.map(store).get(key));
  }

  async list(store: StoreName, options: ListOptions): Promise<Row[]> {
    const prefix = options.prefix ?? '';
    const keys = [...this.map(store).keys()].filter((k) => k.startsWith(prefix)).sort(compareKeys);
    if (options.reverse) keys.reverse();
    const limited = options.limit === undefined ? keys : keys.slice(0, options.limit);
    return limited.map((key) => ({ key, value: copyOut(this.map(store).get(key)) }));
  }

  async read(stores: readonly StoreName[]): Promise<Map<StoreName, Row[]>> {
    const out = new Map<StoreName, Row[]>();
    for (const s of stores) out.set(s, await this.list(s, {}));
    return out;
  }

  async write(plan: WritePlan): Promise<void> {
    // Every read hands out a copy, so a value that cannot be copied now could never be read back, and
    // would break every list and export of its store. It is refused here, as IndexedDB refuses what
    // it cannot store, and before anything changes, so the plan stays all or nothing.
    const copies = plan.ops.map((op) => {
      if (op.kind !== 'put') return undefined;
      try {
        return copyOut(op.value);
      } catch (err) {
        throw new RefusedWrite(op, err);
      }
    });
    for (const s of plan.clear) this.map(s).clear();
    plan.ops.forEach((op, i) => {
      if (op.kind === 'put') this.map(op.store).set(op.key, copies[i]);
      else this.map(op.store).delete(op.key);
    });
  }

  close(): void {}

  private map(store: StoreName): Map<string, unknown> {
    let m = this.data.get(store);
    if (!m) this.data.set(store, (m = new Map()));
    return m;
  }
}
