import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GestureSample, Module, Point, Recognition, SpellCast, SpellPack, Spellbook, SpellbookEntry, Stroke } from '../../../contracts';
import { createKernel, emit, memoryPersistence, on, type KernelHost } from '../../../kernel';
import { resample } from '../../../kernel/geometry';
import { gestureKey } from '../../../kernel/gestures';
import { MANIFEST, createTemplateRecognizer } from './index';
import { storedTemplates } from './templates';

const ASPECT = 16 / 9;
const PACKS = ['core-charms', 'further-spells', 'restricted-section'].map(
  (id) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../public/packs/${id}/pack.json`, import.meta.url)), 'utf8')) as SpellPack,
);
const pathOf = (id: string): Point[] => {
  const g = PACKS.flatMap((p) => p.spells).find((s) => s.id === id)!.gesture;
  return 'path' in g ? g.path : [];
};

/** The spellbook the pack loader would publish: default packs enabled, the restricted section
 *  available only when asked, some spells locked. */
function book(opts: { locked?: string[]; restricted?: boolean; keys?: Record<string, string> } = {}): Spellbook {
  const spells: SpellbookEntry[] = [];
  for (const pack of PACKS) {
    const packOn = pack.default_enabled !== false || !!opts.restricted;
    for (const spell of pack.spells) {
      const locked = opts.locked?.includes(spell.id) ?? false;
      spells.push({
        spell, packId: pack.id, packTitle: pack.title, available: packOn, status: locked ? 'locked' : 'open', enabled: packOn && !locked,
        overridden: false, gestureSource: 'pack', gestureKey: opts.keys?.[spell.id] ?? gestureKey(spell.gesture), mirrored: false,
        templates: storedTemplates(spell.gesture), lasts: null, skippedSteps: [], accepted: 0,
      });
    }
  }
  return { revision: 1, packs: [], spells, theme: null, unlockedTier: 7, learnAfter: 3 };
}

/** A stand-in for the storage module: a Map, the three requests the recognizer uses, and
 *  storage.changed after each write, as the real one publishes. */
function fakeStorage(store: Map<string, unknown>, log: string[], opts: { hang?: boolean } = {}): Module {
  return {
    manifest: { id: 'storage.test', kind: 'storage', version: '1.0.0', contract: '^1.1', provides: ['storage@1'] },
    async init(k) {
      k.handle('storage.list', (p: { store: string }) => {
        log.push(`list:${p.store}`);
        if (opts.hang) return new Promise(() => {});
        return [...store.entries()].map(([key, value]) => ({ key, value }));
      });
      k.handle('storage.put', (p: { store: string; key: string; value: unknown }) => {
        log.push(`put:${p.store}`);
        store.set(p.key, structuredClone(p.value));
        emit(k, 'storage.test', 'storage.changed', { stores: ['samples'], reason: 'put', keys: [p.key] });
      });
      k.handle('storage.delete', (p: { store: string; key: string }) => {
        log.push(`delete:${p.store}`);
        store.delete(p.key);
        emit(k, 'storage.test', 'storage.changed', { stores: ['samples'], reason: 'delete', keys: [p.key] });
      });
    },
    async start() {},
    async stop() {},
  };
}

interface Rig {
  kernel: KernelHost;
  store: Map<string, unknown>;
  log: string[];
  results: Recognition[];
}

const rigs: KernelHost[] = [];
afterEach(async () => {
  while (rigs.length) await rigs.pop()!.stop();
});

async function rig(opts: { storage?: boolean; hang?: boolean; settings?: Record<string, unknown>; spellbook?: Spellbook; samples?: GestureSample[] } = {}): Promise<Rig> {
  const kernel = createKernel({ persistence: memoryPersistence(opts.settings ?? {}), features: [] });
  const store = new Map<string, unknown>((opts.samples ?? []).map((s) => [s.id, s]));
  const log: string[] = [];
  const results: Recognition[] = [];
  if (opts.storage) kernel.register(fakeStorage(store, log, { hang: opts.hang }));
  kernel.register(createTemplateRecognizer());
  await kernel.init();
  kernel.emit('spellbook.changed', opts.spellbook ?? book());
  on(kernel, 'recognition.result', (r) => results.push(r));
  await kernel.start();
  rigs.push(kernel);
  await flush();
  return { kernel, store, log, results };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let strokeCount = 0;
/** A stroke.end from the segmenter, drawn from an isotropic unit-square path. */
function stroke(k: KernelHost, iso: readonly Point[], src = 'tracker.pointer'): Stroke {
  const points = resample(iso, 40).map(([x, y], i) => ({ t: i * 33, x: 0.5 + ((x - 0.5) * 0.4) / ASPECT, y: 0.5 + (y - 0.5) * 0.4, conf: 1, src }));
  const s: Stroke = { id: `stroke-${++strokeCount}`, points, t0: 0, t1: points[points.length - 1].t, quality: 1, aspect: ASPECT, src, endReason: 'pause' };
  k.emit('stroke.end', s, 'segmenter.test');
  return s;
}

function cast(k: KernelHost, s: Stroke, spellId: string, over: Partial<SpellCast> = {}): void {
  k.emit('spell.cast', { id: `cast-${s.id}`, spellId, t: s.t1, via: 'gesture', quality: 0.8, power: 0.5, aim: { x: 0.5, y: 0.5 }, strokeId: s.id, score: 0.85, ...over }, 'engine.test');
}

/** Accio drawn flatter than the pack's: accepted (about 0.88), and clearly not another spell. */
const FLAT_ACCIO = (squash = 0.7): Point[] => pathOf('accio').map(([x, y]) => [x, 0.5 + (y - 0.5) * squash] as Point);

describe('recognition', () => {
  it('answers every stroke with one candidate per enabled spell, joined by stroke id', async () => {
    const { kernel, results } = await rig();
    const s = stroke(kernel, pathOf('alohomora'));
    expect(results).toHaveLength(1);
    const r = results[0];
    expect(r.strokeId).toBe(s.id);
    expect(r.recognizer).toBe(MANIFEST.id);
    expect(r.candidates).toHaveLength(24);
    expect(r.candidates[0].spellId).toBe('alohomora');
    expect(r.stage).toBe('template');
    expect(r.linearity).toBeGreaterThan(0.3);
    expect(r.details!.slice(0, 3).map((d) => d.spellId)).toEqual(r.candidates.slice(0, 3).map((c) => c.spellId));
    expect(r.shadow).toBeUndefined();
  });

  it('publishes after stroke.end has reached every subscriber', async () => {
    const { kernel } = await rig();
    const order: string[] = [];
    on(kernel, 'stroke.end', () => order.push('stroke.end'));
    on(kernel, 'recognition.result', () => order.push('recognition.result'));
    stroke(kernel, pathOf('accio'));
    expect(order).toEqual(['stroke.end', 'recognition.result']);
  });

  it('only considers enabled spells', async () => {
    const { kernel, results } = await rig({ spellbook: book({ locked: ['protego', 'accio'] }) });
    stroke(kernel, pathOf('protego'));
    const ids = results[0].candidates.map((c) => c.spellId);
    expect(ids).toHaveLength(22);
    expect(ids).not.toContain('protego');
    expect(ids).not.toContain('imperio');
  });

  it('names locked spells separately, best first, so a fizzle can say which one was drawn', async () => {
    const { kernel, results } = await rig({ spellbook: book({ locked: ['protego', 'accio'] }) });
    stroke(kernel, pathOf('protego'));
    const locked = results[0].locked ?? [];
    expect(locked.length).toBeGreaterThan(0);
    expect(locked.length).toBeLessThanOrEqual(3);
    expect(locked[0].spellId).toBe('protego');
    expect(locked[0].score).toBeGreaterThan(0.9);
    expect(locked.map((c) => c.spellId).every((id) => id === 'protego' || id === 'accio')).toBe(true);
  });

  it('leaves locked out when nothing is locked', async () => {
    const { kernel, results } = await rig();
    stroke(kernel, pathOf('protego'));
    expect(results[0].locked).toBeUndefined();
  });

  it('follows spellbook changes', async () => {
    const { kernel, results } = await rig();
    kernel.emit('spellbook.changed', book({ restricted: true }));
    stroke(kernel, pathOf('crucio'));
    expect(results[0].candidates).toHaveLength(27);
    expect(results[0].candidates[0].spellId).toBe('crucio');
  });

  it('explains the practice focus spell too', async () => {
    const { kernel, results } = await rig();
    kernel.emit('practice.focus', { spellId: 'reducio' }, 'shell');
    stroke(kernel, pathOf('protego'));
    expect(results[0].details!.map((d) => d.spellId)).toContain('reducio');
  });

  it('answers even a stroke it cannot read', async () => {
    const { kernel, results } = await rig();
    kernel.emit('stroke.end', { id: 'bad', points: [], t0: 0, t1: 0, quality: 0 } as Stroke, 'segmenter.test');
    expect(results[0].strokeId).toBe('bad');
    expect(results[0].candidates.every((c) => c.score === 0)).toBe(true);
  });

  it('defaults the aspect to 16:9 and recognizes recorded sessions like live strokes', async () => {
    const { kernel, results } = await rig();
    const s = stroke(kernel, pathOf('incendio'), 'tracker.replay');
    expect(results[0].strokeId).toBe(s.id);
    expect(results[0].candidates[0].spellId).toBe('incendio');
    const { aspect: _drop, ...noAspect } = s;
    kernel.emit('stroke.end', { ...noAspect, id: 'no-aspect' }, 'segmenter.test');
    expect(results[1].candidates[0]).toEqual(results[0].candidates[0]);
  });

  it('is silent while stopped', async () => {
    const { kernel, results } = await rig();
    await kernel.stop();
    rigs.pop();
    stroke(kernel, pathOf('accio'));
    expect(results).toHaveLength(0);
  });
});

describe('recognizer.score (dry run)', () => {
  it('scores every available spell, locked ones included, and publishes nothing', async () => {
    const { kernel, results } = await rig({ spellbook: book({ locked: ['protego'] }) });
    const points = resample(pathOf('protego'), 40).map(([x, y]) => [0.5 + ((x - 0.5) * 0.4) / ASPECT, 0.5 + (y - 0.5) * 0.4] as Point);
    const r = await kernel.request<Recognition>('recognizer.score', { points });
    expect(r.candidates[0].spellId).toBe('protego');
    expect(r.candidates).toHaveLength(24);
    expect(r.details!.length).toBeGreaterThan(0);
    const some = await kernel.request<Recognition>('recognizer.score', { points, spellIds: ['accio', 'nox'], aspect: ASPECT });
    expect(some.candidates.map((c) => c.spellId).sort()).toEqual(['accio', 'nox']);
    expect(results).toHaveLength(0);
  });

  it('refuses a payload without points', async () => {
    const { kernel } = await rig();
    await expect(kernel.request('recognizer.score', {})).rejects.toMatchObject({ code: 'invalid-payload' });
    await expect(kernel.request('recognizer.score', { points: [[0.5, 0.5]] })).rejects.toMatchObject({ code: 'invalid-payload' });
  });
});

describe('learning your hand (Section 7.5)', () => {
  const userTemplate = (r: Recognition, spellId: string) => r.details!.find((d) => d.spellId === spellId)?.template ?? '';

  it('keeps the strokes of three accepted casts and then matches against them', async () => {
    const { kernel, store, results } = await rig({ storage: true });
    const before = (stroke(kernel, FLAT_ACCIO()), results[0].candidates[0]);
    expect(before.spellId).toBe('accio');
    for (const squash of [0.68, 0.72, 0.7]) {
      const s = stroke(kernel, FLAT_ACCIO(squash));
      cast(kernel, s, 'accio');
      await flush();
    }
    const saved = [...store.values()] as GestureSample[];
    expect(saved).toHaveLength(3);
    for (const sample of saved) {
      expect(sample).toMatchObject({ dataVersion: 1, spellId: 'accio', gestureKey: gestureKey(PACKS[0].spells.find((s) => s.id === 'accio')!.gesture) });
      expect(sample.points).toHaveLength(64);
      expect(sample.score).toBeGreaterThan(0.8);
    }
    stroke(kernel, FLAT_ACCIO());
    const after = results[results.length - 1];
    expect(after.candidates[0].spellId).toBe('accio');
    expect(after.candidates[0].score).toBeGreaterThan(before.score + 0.05);
    expect(userTemplate(after, 'accio')).toMatch(/^user:\d$/);
    // Details still refer to the stored path.
    expect(after.details!.find((d) => d.spellId === 'accio')!.pathIndex).toBe(0);
  });

  it('waits for spells.learnAfter samples before using them', async () => {
    const { kernel, store, results } = await rig({ storage: true });
    for (let i = 0; i < 2; i++) {
      cast(kernel, stroke(kernel, FLAT_ACCIO()), 'accio');
      await flush();
    }
    expect(store.size).toBe(2);
    stroke(kernel, FLAT_ACCIO());
    expect(userTemplate(results[results.length - 1], 'accio')).toBe('seed:0');
  });

  it('never learns from replays, voice casts, weak matches or strokes it did not see', async () => {
    const { kernel, store } = await rig({ storage: true });
    cast(kernel, stroke(kernel, FLAT_ACCIO()), 'accio', { replay: true });
    cast(kernel, stroke(kernel, FLAT_ACCIO(), 'tracker.replay'), 'accio');
    cast(kernel, stroke(kernel, FLAT_ACCIO()), 'accio', { via: 'voice' });
    cast(kernel, stroke(kernel, FLAT_ACCIO()), 'accio', { via: 'both', score: 0.65 });
    kernel.emit('spell.cast', { id: 'x', spellId: 'accio', t: 0, via: 'gesture', quality: 1, power: 1, aim: { x: 0, y: 0 }, strokeId: 'unknown', score: 0.9 }, 'engine.test');
    await flush();
    expect(store.size).toBe(0);
  });

  it('refuses a stroke that also looks like another spell', async () => {
    const { kernel, store } = await rig({ storage: true });
    const a = resample(pathOf('wingardium-leviosa'), 64), b = resample(pathOf('engorgio'), 64);
    const blend = a.map((p, i) => [(p[0] + b[i][0]) / 2, (p[1] + b[i][1]) / 2] as Point);
    cast(kernel, stroke(kernel, blend), 'wingardium-leviosa', { score: 0.91 });
    await flush();
    expect(store.size).toBe(0);
  });

  it('keeps at most userTemplatesPerSpell, preferring the higher scores', async () => {
    const { kernel, store, log } = await rig({ storage: true, settings: { 'recognizer.userTemplatesPerSpell': 2 } });
    // The pack's own shape scores highest against the pack's template, so it displaces the weakest.
    for (const iso of [FLAT_ACCIO(0.65), FLAT_ACCIO(0.75), pathOf('accio')]) {
      cast(kernel, stroke(kernel, iso), 'accio');
      await flush();
    }
    const kept = [...store.values()] as GestureSample[];
    expect(kept).toHaveLength(2);
    expect(log.filter((l) => l === 'delete:samples')).toHaveLength(1);
    expect(Math.max(...kept.map((s) => s.score))).toBeGreaterThan(0.97);
  });

  it('ignores samples learned under another gesture', async () => {
    const stale: GestureSample[] = [0, 1, 2].map((i) => ({ dataVersion: 1, id: `old${i}`, spellId: 'accio', points: storedTemplates({ path: FLAT_ACCIO() })[0], score: 0.9, gestureKey: 'redrawn-long-ago', savedAt: i }));
    const { kernel, results } = await rig({ storage: true, samples: stale });
    stroke(kernel, FLAT_ACCIO());
    expect(userTemplate(results[0], 'accio')).toBe('seed:0');
  });

  it('loads samples at start and reloads them when storage changes', async () => {
    const key = gestureKey(PACKS[0].spells.find((s) => s.id === 'accio')!.gesture);
    const fresh: GestureSample[] = [0, 1, 2].map((i) => ({ dataVersion: 1, id: `imp${i}`, spellId: 'accio', points: storedTemplates({ path: FLAT_ACCIO() })[0], score: 0.88, gestureKey: key, savedAt: i }));
    const { kernel, store, log, results } = await rig({ storage: true });
    expect(log).toContain('list:samples');
    stroke(kernel, FLAT_ACCIO());
    expect(userTemplate(results[0], 'accio')).toBe('seed:0');
    for (const s of fresh) store.set(s.id, s);
    kernel.emit('storage.changed', { stores: ['samples'], reason: 'import' }, 'storage.test');
    await flush();
    stroke(kernel, FLAT_ACCIO());
    expect(userTemplate(results[1], 'accio')).toMatch(/^user:/);
  });

  it('keeps learning for the session when there is no storage module', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { kernel, results } = await rig();
    for (let i = 0; i < 3; i++) {
      cast(kernel, stroke(kernel, FLAT_ACCIO()), 'accio');
      await flush();
    }
    stroke(kernel, FLAT_ACCIO());
    expect(userTemplate(results[results.length - 1], 'accio')).toMatch(/^user:/);
    warn.mockRestore();
  });

  it('starts promptly even when storage never answers', async () => {
    const { kernel, results } = await rig({ storage: true, hang: true });
    stroke(kernel, pathOf('reparo'));
    expect(results[0].candidates[0].spellId).toBe('reparo');
  });
});
