// The two stores behind the module, on their own: what a write does when one of its values cannot be
// stored. Each test gets its own fake-indexeddb world.

import 'fake-indexeddb/auto';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryBackend, RefusedWrite, type WriteOp } from './backend';
import { IdbBackend, openDatabase } from './idb';

const put = (key: string, value: unknown): WriteOp => ({ kind: 'put', store: 'kv', key, value });
const realPut = IDBObjectStore.prototype.put;

afterEach(() => {
  IDBObjectStore.prototype.put = realPut;
});

/** put() throws `err` at once for `key`, as Chrome's does when cloning a value overflows the stack,
 *  without aborting the transaction (the spec leaves it active). */
function putThrowsFor(key: string, err: Error): void {
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, k?: IDBValidKey) {
    if (k === key) throw err;
    return realPut.call(this, value, k);
  } as typeof realPut;
}

async function idb(): Promise<IdbBackend> {
  const db = await openDatabase(new IDBFactory(), 'backend', { blocked() {}, versionchange() {}, terminated() {} });
  return new IdbBackend(db);
}

describe('IndexedDB store', () => {
  it('refuses a value put() throws on, and writes nothing of that transaction', async () => {
    const b = await idb();
    await b.write({ clear: [], ops: [put('kept', 1)] });
    const stack = new RangeError('Maximum call stack size exceeded');
    putThrowsFor('deep', stack);
    const ops = [put('kept', 2), put('first', 1), put('deep', [[[1]]]), put('after', 1)];
    const err = await b.write({ clear: ['profiles'], ops }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RefusedWrite);
    expect(err).toMatchObject({ op: ops[2], cause: stack });
    // All or nothing: the writes before it in the same transaction did not commit either.
    expect(await b.read(['kv'])).toEqual(new Map([['kv', [{ key: 'kept', value: 1 }]]]));
    // And the database is still usable.
    await b.write({ clear: [], ops: [put('next', 1)] });
    expect(await b.get('kv', 'next')).toBe(1);
  });

  it('refuses keys and values whatever put() calls the problem', async () => {
    const b = await idb();
    for (const err of [new TypeError('odd'), Object.assign(new Error('clone'), { name: 'DataCloneError' }), Object.assign(new Error('key'), { name: 'DataError' })]) {
      putThrowsFor('bad', err);
      await expect(b.write({ clear: [], ops: [put('bad', 1)] })).rejects.toBeInstanceOf(RefusedWrite);
    }
  });

  it('passes on what says the database itself is in trouble', async () => {
    const b = await idb();
    const closing = Object.assign(new Error('closing'), { name: 'InvalidStateError' });
    putThrowsFor('any', closing);
    await expect(b.write({ clear: [], ops: [put('any', 1)] })).rejects.toBe(closing);
  });
});

describe('memory store', () => {
  it('refuses a value it could not copy back out, leaving the store as it was', async () => {
    const m = new MemoryBackend();
    await m.write({ clear: [], ops: [put('kept', { n: 1 })] });
    const ops = [put('kept', { n: 2 }), put('fn', { f: () => 1 })];
    const err = await m.write({ clear: ['kv'], ops }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(RefusedWrite);
    expect((err as RefusedWrite).op).toBe(ops[1]);
    // Reads keep working, and see the store as it was before the refused write.
    expect(await m.list('kv', {})).toEqual([{ key: 'kept', value: { n: 1 } }]);
    expect(await m.read(['kv'])).toEqual(new Map([['kv', [{ key: 'kept', value: { n: 1 } }]]]));
  });

  it('keeps its own copy of what it is given', async () => {
    const m = new MemoryBackend();
    const value = { list: [1] };
    await m.write({ clear: [], ops: [put('k', value)] });
    value.list.push(2);
    expect(await m.get('kv', 'k')).toEqual({ list: [1] });
  });
});
