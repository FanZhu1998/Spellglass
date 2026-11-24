import { describe, expect, it } from 'vitest';
import type { StoreName } from '../../contracts';
import { RefusedWrite } from './backend';
import { MAX_DEPTH, TOO_DEEP, cloneForStorage, copyOut, incomingIsNewer, migrateRecord, nestingDepth, recordProblem, type RecordStep } from './records';
import { STORAGE_MESSAGES, isCallerError, messageFor, reasonForOpenError, reasonForOperationError } from './status';

/** A list holding a list holding ... `depth` levels deep. */
const nested = (depth: number): unknown => {
  let v: unknown = 1;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
};

/** A Proxy that has been revoked: every look inside it throws a TypeError. */
const revoked = (): object => {
  const { proxy, revoke } = Proxy.revocable({ n: 1 }, {});
  revoke();
  return proxy;
};

/** An object whose one field throws when read. */
const throwingGetter = (): object =>
  Object.defineProperty({ dataVersion: 1 }, 'value', {
    enumerable: true,
    get: () => {
      throw new Error('boom');
    },
  });

describe('nestingDepth', () => {
  it('counts how deeply lists and objects nest', () => {
    expect(nestingDepth(3, MAX_DEPTH)).toBe(0);
    expect(nestingDepth({}, MAX_DEPTH)).toBe(1);
    expect(nestingDepth({ a: [1, { b: [] }] }, MAX_DEPTH)).toBe(4);
    expect(nestingDepth(nested(MAX_DEPTH), MAX_DEPTH)).toBe(MAX_DEPTH);
  });

  it('stops just past the limit, without overflowing the stack on a hostile value', () => {
    expect(nestingDepth(nested(200_000), MAX_DEPTH)).toBe(MAX_DEPTH + 1);
  });

  it('counts a value that contains itself as too deep, and walks shared parts quickly', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(nestingDepth(loop, MAX_DEPTH)).toBeGreaterThan(MAX_DEPTH);
    // 60 levels, each holding the level below twice: 2^60 paths, 61 objects.
    let shared: unknown = {};
    for (let i = 0; i < 60; i++) shared = { a: shared, b: shared };
    expect(nestingDepth(shared, MAX_DEPTH)).toBe(61);
  });
});

const progress = (casts: number, extra: Record<string, unknown> = {}) => ({
  dataVersion: 1, spellId: 'lumos', casts, practiceAttempts: 0, best: 0.8, learnedAt: null, ...extra,
});

describe('cloneForStorage', () => {
  it('takes a structured clone, so later changes to the original do not reach the copy', () => {
    const original = { a: { b: [1, 2] } };
    const copy = cloneForStorage(original);
    expect(copy).toMatchObject({ ok: true, viaJson: false });
    original.a.b.push(3);
    expect((copy as { value: { a: { b: number[] } } }).value.a.b).toEqual([1, 2]);
  });

  it('copies a Proxy (a Svelte $state object) as JSON instead of failing', () => {
    const proxied = new Proxy({ spellId: 'lumos', points: [[0, 1]] }, {});
    expect(() => structuredClone(proxied)).toThrow();
    const copy = cloneForStorage(proxied);
    expect(copy).toEqual({ ok: true, viaJson: true, value: { spellId: 'lumos', points: [[0, 1]] } });
  });

  it('refuses values that are not data at all', () => {
    expect(cloneForStorage(() => 1)).toMatchObject({ ok: false });
    expect(cloneForStorage(new Proxy({ n: 1n }, {}))).toMatchObject({ ok: false });
  });

  it('refuses a value nested deeper than storage can copy back, with a plain sentence', () => {
    // A few hundred levels still clone here, so IndexedDB would be handed something its own copy
    // overflows on (put() throws a RangeError in Chrome at about 1,500).
    expect(cloneForStorage({ notes: nested(500) })).toEqual({ ok: false, reason: TOO_DEEP });
    expect(TOO_DEEP).toMatch(/^This value is nested too deeply to save: .* at most 64 levels deep\.$/);
    // Also a Svelte proxy, which would otherwise be copied through JSON.
    expect(cloneForStorage(new Proxy({ notes: nested(500) }, {}))).toEqual({ ok: false, reason: TOO_DEEP });
    expect(cloneForStorage(nested(MAX_DEPTH))).toMatchObject({ ok: true, viaJson: false });
  });

  it('refuses a value whose parts cannot be read, instead of throwing', () => {
    // Measuring the depth reads every part, as either copy would; what cannot be read cannot be saved.
    expect(cloneForStorage({ dataVersion: 1, value: revoked() })).toEqual({
      ok: false, reason: expect.stringMatching(/^This value cannot be saved \(.*revoked.*\)\.$/),
    });
    expect(cloneForStorage(revoked())).toMatchObject({ ok: false });
    expect(cloneForStorage(throwingGetter())).toEqual({ ok: false, reason: 'This value cannot be saved (boom).' });
  });

  it('copyOut returns a fresh copy of objects and passes primitives through', () => {
    const v = { x: 1 };
    expect(copyOut(v)).toEqual(v);
    expect(copyOut(v)).not.toBe(v);
    expect(copyOut(undefined)).toBeUndefined();
    expect(copyOut(3)).toBe(3);
  });
});

describe('record migrations', () => {
  it('leaves current records, records without a dataVersion and newer records alone', () => {
    const current = progress(2);
    expect(migrateRecord('progress', current)).toBe(current);
    const session = { schema: 'session/1', id: 's' };
    expect(migrateRecord('sessions', session)).toBe(session);
    const newer = { ...progress(1), dataVersion: 7 };
    expect(migrateRecord('progress', newer)).toBe(newer);
    expect(migrateRecord('kv', 3)).toBe(3);
  });

  it('runs a chain one step at a time up to the target version', () => {
    // A pretend version 3: progress gained a streak in 2 and renamed best in 3; samples did not change.
    const chain: Partial<Record<StoreName, Record<number, RecordStep>>> = {
      progress: { 1: (r) => ({ ...r, streak: 0 }), 2: ({ best, ...rest }) => ({ ...rest, bestQuality: best }) },
    };
    expect(migrateRecord('progress', progress(4), chain, 3)).toEqual({
      dataVersion: 3, spellId: 'lumos', casts: 4, practiceAttempts: 0, learnedAt: null, streak: 0, bestQuality: 0.8,
    });
    expect(migrateRecord('samples', { dataVersion: 1, id: 'x' }, chain, 3)).toEqual({ dataVersion: 3, id: 'x' });
  });
});

describe('recordProblem', () => {
  const keepsake = {
    dataVersion: 1, id: 'cast-1', spellName: 'Lumos', points: [[0.1, 0.2], [0.3, 0.4]], durationMs: 400, aspect: 16 / 9, savedAt: 5,
    cast: { id: 'cast-1', spellId: 'lumos', t: 1, via: 'gesture', quality: 0.9, power: 0.5, aim: { x: 0.3, y: 0.4 } },
  };

  it('accepts the records the modules write', () => {
    expect(recordProblem('progress', 'lumos', progress(3))).toBeNull();
    expect(recordProblem('keepsakes', 'cast-1', keepsake)).toBeNull();
    expect(recordProblem('keepsakes', 'cast-1', { ...keepsake, points: [] })).toBeNull();
    expect(recordProblem('samples', 'sample-1', { dataVersion: 1, id: 'sample-1', spellId: 'nox', points: [[0, 0], [1, 1]], score: 0.9, gestureKey: 'abc', savedAt: 1 })).toBeNull();
    expect(recordProblem('overrides', 'nox', { dataVersion: 1, spellId: 'nox', gesture: { flick: 'down' }, savedAt: 1 })).toBeNull();
    expect(recordProblem('profiles', 'cam-1', { dataVersion: 1, deviceId: 'cam-1', label: 'Cam', width: 1280, height: 720, fps: 30, exposureMode: 'manual', exposureTime: 100, savedAt: 1, k: 4 })).toBeNull();
    expect(recordProblem('packs', 'my-pack', { dataVersion: 1, id: 'my-pack', json: { schema: 'spellpack/1' }, importedAt: 1 })).toBeNull();
    expect(recordProblem('kv', 'progress.unlockedTier', { dataVersion: 1, value: 2 })).toBeNull();
    expect(recordProblem('kv', 'something.else', { dataVersion: 1, value: { any: 'thing' } })).toBeNull();
  });

  it('refuses records with missing or wrong fields, or stored under the wrong key', () => {
    expect(recordProblem('progress', 'lumos', { ...progress(3), casts: -1 })).toMatch(/progress/);
    expect(recordProblem('progress', 'nox', progress(3))).toMatch(/key/);
    expect(recordProblem('progress', 'lumos', { ...progress(3), dataVersion: undefined })).toMatch(/dataVersion/);
    expect(recordProblem('keepsakes', 'cast-1', { ...keepsake, cast: { ...keepsake.cast, via: 'telepathy' } })).toMatch(/keepsake/);
    expect(recordProblem('keepsakes', 'cast-2', keepsake)).toMatch(/key/);
    expect(recordProblem('overrides', 'nox', { dataVersion: 1, spellId: 'nox', gesture: { flick: 'sideways' }, savedAt: 1 })).toMatch(/gesture/);
    expect(recordProblem('kv', 'progress.unlockedTier', { dataVersion: 1, value: 0 })).toMatch(/tier/);
    expect(recordProblem('samples', '', { dataVersion: 1 })).toMatch(/key/);
    expect(recordProblem('packs', 'x', 'not a record')).toMatch(/record/);
    expect(recordProblem('sessions', 's1', { schema: 'session/1', id: 's1' })).not.toBeNull();
  });
});

describe('incomingIsNewer (merge import)', () => {
  it('compares savedAt where records have it', () => {
    expect(incomingIsNewer('samples', { savedAt: 1 }, { savedAt: 2 })).toBe(true);
    expect(incomingIsNewer('samples', { savedAt: 2 }, { savedAt: 1 })).toBe(false);
    expect(incomingIsNewer('samples', { savedAt: 2 }, { savedAt: 2 })).toBe(false);
  });

  it('compares progress by how far it has got, and the unlocked tier by its value', () => {
    expect(incomingIsNewer('progress', progress(2), progress(5))).toBe(true);
    expect(incomingIsNewer('progress', progress(5), progress(2))).toBe(false);
    expect(incomingIsNewer('progress', progress(5), progress(5, { practiceAttempts: 1 }))).toBe(true);
    expect(incomingIsNewer('kv', { dataVersion: 1, value: 1 }, { dataVersion: 1, value: 3 })).toBe(true);
    expect(incomingIsNewer('kv', { dataVersion: 1, value: 3 }, { dataVersion: 1, value: 1 })).toBe(false);
  });

  it('keeps this device copy when nothing tells the two apart', () => {
    expect(incomingIsNewer('kv', { dataVersion: 1, value: 'a' }, { dataVersion: 1, value: 'b' })).toBe(false);
    expect(incomingIsNewer('samples', undefined, { savedAt: 1 })).toBe(true);
  });
});

describe('status helpers', () => {
  const err = (name: string) => Object.assign(new Error(name), { name });

  it('classifies failures', () => {
    expect(reasonForOperationError(err('QuotaExceededError'))).toBe('full');
    expect(reasonForOperationError(err('InvalidStateError'))).toBe('closed');
    expect(reasonForOperationError(err('UnknownError'))).toBe('closed');
    expect(reasonForOpenError(err('SecurityError'))).toBe('blocked');
    expect(reasonForOpenError(err('QuotaExceededError'))).toBe('full');
    expect(isCallerError(err('DataCloneError'))).toBe(true);
    expect(isCallerError(err('QuotaExceededError'))).toBe(false);
    // A write a store refused because of its own value, whatever IndexedDB called the problem.
    expect(isCallerError(new RefusedWrite({ kind: 'put', store: 'kv', key: 'k', value: 1 }, new RangeError('Maximum call stack size exceeded')))).toBe(true);
    expect(isCallerError(new RangeError('Maximum call stack size exceeded'))).toBe(false);
  });

  it('says plainly that the app runs without saving', () => {
    for (const reason of ['blocked', 'full', 'closed', 'unsupported'] as const) expect(messageFor(reason)).toMatch(/runs without saving/);
    expect(STORAGE_MESSAGES.blocked).toBe('Storage is blocked, so Spellglass runs without saving.');
  });
});
