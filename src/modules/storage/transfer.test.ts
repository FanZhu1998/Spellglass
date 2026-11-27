import { describe, expect, it } from 'vitest';
import type { StoreName, UserDataExport } from '../../contracts';
import { DATA_VERSION, SETTINGS_VERSION } from '../../contracts';
import { checkUserData } from '../../kernel';
import { MAX_DEPTH, nestingDepth } from './records';
import {
  DEFAULT_EXPORT_STORES, IMPORT_MESSAGES, buildExport, migrateExport, planImport, planSettings, readExport, type ExportStep, type Row,
} from './transfer';

const progress = (spellId: string, casts: number) => ({ dataVersion: 1, spellId, casts, practiceAttempts: 0, best: 0.9, learnedAt: null });
const sample = (id: string, savedAt: number) => ({ dataVersion: 1, id, spellId: 'nox', points: [[0, 0], [0.5, 1]], score: 0.9, savedAt });
/** An imported pack whose record nests `depth` levels deep: the pack is valid but for an unknown field. */
const deepPack = (depth: number) => {
  let notes: unknown = 'x';
  // The record and its json are two of the levels.
  for (let i = 0; i < depth - 2; i++) notes = [notes];
  return { dataVersion: 1, id: 'my-pack', json: { schema: 'spellpack/1', notes }, importedAt: 1 };
};

function file(stores: UserDataExport['stores'], extra: Partial<UserDataExport> = {}): UserDataExport {
  return { schema: 'spellglass-data/1', dataVersion: 1, settingsVersion: 1, exportedAt: '2026-11-21T10:00:00.000Z', settings: {}, stores, ...extra };
}

describe('buildExport', () => {
  it('writes the spellglass-data/1 envelope, which passes its schema', () => {
    const doc = buildExport({
      settings: { 'audio.volume': 0.5 },
      stores: new Map<StoreName, Row[]>([['progress', [{ key: 'lumos', value: progress('lumos', 2) }]], ['kv', []]]),
      now: new Date('2026-11-21T10:00:00Z'),
    });
    expect(doc).toEqual({
      schema: 'spellglass-data/1', dataVersion: DATA_VERSION, settingsVersion: SETTINGS_VERSION, exportedAt: '2026-11-21T10:00:00.000Z',
      settings: { 'audio.volume': 0.5 },
      stores: { progress: [{ key: 'lumos', value: progress('lumos', 2) }], kv: [] },
    });
    expect(checkUserData(doc)).toEqual({ ok: true });
  });

  it('leaves out the chosen camera, which is bound to this browser', () => {
    const doc = buildExport({ settings: { 'capture.deviceId': 'a1b2c3', 'audio.volume': 0.5 }, stores: new Map(), now: new Date(0) });
    expect(doc.settings).toEqual({ 'audio.volume': 0.5 });
  });

  it('leaves recorded sessions out by default', () => {
    expect(DEFAULT_EXPORT_STORES).not.toContain('sessions');
    expect(DEFAULT_EXPORT_STORES).toContain('keepsakes');
  });
});

describe('readExport', () => {
  it('reads the object or its text, with or without a byte-order mark', () => {
    const doc = file({ progress: [] });
    expect(readExport(doc)).toEqual({ ok: true, doc });
    expect(readExport(JSON.stringify(doc))).toEqual({ ok: true, doc });
    expect(readExport(`﻿${JSON.stringify(doc)}`)).toEqual({ ok: true, doc });
  });

  it('refuses what is not a data file, with a plain reason', () => {
    expect(readExport('{oops')).toEqual({ ok: false, reason: IMPORT_MESSAGES.notJson });
    expect(readExport({ schema: 'spellpack/1' })).toEqual({ ok: false, reason: IMPORT_MESSAGES.notData });
    expect(readExport([1, 2])).toEqual({ ok: false, reason: IMPORT_MESSAGES.notData });
    const broken = readExport({ schema: 'spellglass-data/1', dataVersion: 1 });
    expect(broken.ok).toBe(false);
    expect((broken as { reason: string }).reason).toMatch(/missing/);
  });

  it('refuses a file nested more deeply than its records may be, before anything copies it', () => {
    const deepest = file({ packs: [{ key: 'my-pack', value: deepPack(MAX_DEPTH) }] });
    expect(nestingDepth(deepPack(MAX_DEPTH), Infinity)).toBe(MAX_DEPTH);
    expect(readExport(deepest)).toEqual({ ok: true, doc: deepest });
    const hostile = file({ packs: [{ key: 'my-pack', value: deepPack(2000) }] });
    expect(readExport(hostile)).toEqual({ ok: false, reason: IMPORT_MESSAGES.tooDeep });
    expect(readExport(JSON.stringify(hostile))).toEqual({ ok: false, reason: IMPORT_MESSAGES.tooDeep });
    expect(readExport(file({ packs: [{ key: 'my-pack', value: deepPack(MAX_DEPTH + 1) }] }))).toEqual({ ok: false, reason: IMPORT_MESSAGES.tooDeep });
    expect(IMPORT_MESSAGES.tooDeep).toBe('This file is nested too deeply to be a Spellglass data file.');
  });

  it('refuses an object it cannot read as not a data file, instead of throwing', () => {
    // Only an object handed over in the page can be like this; a file's text never is.
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    expect(readExport(file({ kv: [{ key: 'k', value: proxy }] }))).toEqual({ ok: false, reason: IMPORT_MESSAGES.notData });
    expect(readExport(proxy)).toEqual({ ok: false, reason: IMPORT_MESSAGES.notData });
    const getter = Object.defineProperty({ dataVersion: 1 }, 'value', { enumerable: true, get: () => { throw new Error('boom'); } });
    expect(readExport(file({ kv: [{ key: 'k', value: getter }] }))).toEqual({ ok: false, reason: IMPORT_MESSAGES.notData });
  });

  it('refuses files from a newer edition instead of half-reading them', () => {
    expect(readExport(file({}, { dataVersion: DATA_VERSION + 1 }))).toEqual({ ok: false, reason: IMPORT_MESSAGES.newer });
    expect(readExport({ ...file({}), schema: 'spellglass-data/2' })).toEqual({ ok: false, reason: IMPORT_MESSAGES.newer });
  });

  it('migrates a file through the chain one version at a time', () => {
    // A pretend version 3 that renamed a store in 2 and stamped a field in 3.
    const chain: Record<number, ExportStep> = {
      1: (doc) => ({ ...doc, stores: { learned: (doc.stores as Record<string, unknown>).samples } }),
      2: (doc) => ({ ...doc, migrated: true }),
    };
    const out = migrateExport(file({ samples: [] }) as unknown as Record<string, unknown>, chain, 3);
    expect(out).toMatchObject({ dataVersion: 3, stores: { learned: [] }, migrated: true });
  });
});

describe('planImport', () => {
  const existing = new Map<StoreName, Row[]>([
    ['progress', [{ key: 'lumos', value: progress('lumos', 9) }, { key: 'nox', value: progress('nox', 1) }]],
    ['samples', [{ key: 's1', value: sample('s1', 100) }]],
  ]);

  it('merge: adds what is missing, replaces only older copies, keeps newer ones', () => {
    const plan = planImport(file({
      progress: [{ key: 'lumos', value: progress('lumos', 2) }, { key: 'nox', value: progress('nox', 4) }, { key: 'accio', value: progress('accio', 1) }],
      samples: [{ key: 's1', value: sample('s1', 200) }, { key: 's2', value: sample('s2', 1) }],
    }), existing, 'merge');
    expect(plan.clear).toEqual([]);
    expect(plan.put.get('progress')!.map((r) => r.key)).toEqual(['nox', 'accio']);
    expect(plan.put.get('samples')!.map((r) => r.key)).toEqual(['s1', 's2']);
    expect(plan.imported).toEqual({ progress: 2, samples: 2 });
    expect(plan.kept).toBe(1);
  });

  it('replace: empties the stores in the file and leaves the others alone', () => {
    const plan = planImport(file({ progress: [{ key: 'accio', value: progress('accio', 1) }], keepsakes: [] }), existing, 'replace');
    expect(plan.clear).toEqual(['progress', 'keepsakes']);
    expect(plan.put.get('progress')).toEqual([{ key: 'accio', value: progress('accio', 1) }]);
    expect(plan.put.has('samples')).toBe(false);
    expect(plan.imported).toEqual({ progress: 1, keepsakes: 0 });
  });

  it('leaves out invalid records and unknown stores, and never patches a record up', () => {
    const plan = planImport(file({
      progress: [{ key: 'lumos', value: { ...progress('lumos', 1), casts: 'many' } }, { key: 'nox', value: progress('nox', 3) }],
      ['wands' as StoreName]: [{ key: 'elder', value: {} }],
    }), new Map(), 'merge');
    expect(plan.put.get('progress')!.map((r) => r.key)).toEqual(['nox']);
    expect(plan.invalid).toEqual([{ store: 'progress', key: 'lumos', why: 'not spell progress' }]);
    expect(plan.unknownStores).toEqual(['wands']);
  });
});

describe('planSettings', () => {
  it('applies known settings and skips unknown and session-only ones', () => {
    const plan = planSettings(file({}, { settings: { 'audio.volume': 0.3, 'tracker.debug': true, 'wand.length': 11 } }));
    expect(plan.apply).toEqual([{ key: 'audio.volume', value: 0.3 }]);
    expect(plan.skipped).toEqual([{ key: 'tracker.debug', why: 'session-only' }, { key: 'wand.length', why: 'unknown' }]);
  });

  it('skips the chosen camera, whose id means nothing in another browser', () => {
    const plan = planSettings(file({}, { settings: { 'capture.deviceId': 'a1b2c3', 'capture.fps': 30 } }));
    expect(plan.apply).toEqual([{ key: 'capture.fps', value: 30 }]);
    expect(plan.skipped).toEqual([{ key: 'capture.deviceId', why: 'device-bound' }]);
  });

  it('skips every setting from a newer settings format', () => {
    const plan = planSettings(file({}, { settingsVersion: SETTINGS_VERSION + 1, settings: { 'audio.volume': 0.3 } }));
    expect(plan.apply).toEqual([]);
    expect(plan.skipped).toEqual([{ key: 'audio.volume', why: 'newer-format' }]);
  });
});
