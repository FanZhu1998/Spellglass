// The spellbook the pack service publishes: staged unlocking, progress counting, the left-handed
// mirror, the player's drawings, gesture-pack layers, themes, and precedence between packs.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GestureOverride, ProgressChanged, SpellCast, Spellbook, SpellProgress, Stroke } from '../../src/contracts';
import { ask, newId, type KernelHost } from '../../src/kernel';
import { fakeEffects, fakeStorage, setup, settle, shippedJson } from './helpers';

afterEach(() => vi.restoreAllMocks());

const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
};

function cast(kernel: KernelHost, spellId: string, extra: Partial<SpellCast> = {}): void {
  kernel.emit('spell.cast', {
    id: newId('cast'), spellId, t: kernel.now(), via: 'gesture', quality: 0.8, power: 0.5, aim: { x: 0.5, y: 0.5 }, ...extra,
  }, 'engine.test');
}

function entry(book: Spellbook, id: string) {
  const e = book.spells.find((s) => s.spell.id === id);
  if (!e) throw new Error(`no spell ${id}`);
  return e;
}

const TIER_1 = ['lumos', 'nox', 'wingardium-leviosa', 'stupefy'];

describe('staged unlocking', () => {
  it('opens tier 1 first; later tiers are locked until unlockAll', async () => {
    quiet();
    const { kernel } = await setup();
    const book = kernel.packs.spellbook();
    expect(book.spells.filter((e) => e.enabled).map((e) => e.spell.id)).toEqual(TIER_1);
    expect(entry(book, 'petrificus-totalus').status).toBe('locked');

    await ask(kernel, 'settings.set', { key: 'spells.unlockAll', value: true });
    await settle();
    const all = kernel.packs.spellbook();
    expect(all.revision).toBe(book.revision + 1);
    expect(all.spells.every((e) => e.status !== 'locked')).toBe(true);
    expect(all.spells.filter((e) => e.enabled)).toHaveLength(24); // the restricted section is off
    expect(all.unlockedTier).toBe(1);
  });

  it('opens the next tier once every spell of the current one is learned, and says so', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel, of } = await setup({ modules: [fakeEffects(), storage] });
    for (const id of TIER_1) for (let i = 0; i < 3; i++) cast(kernel, id);
    await settle();
    const book = kernel.packs.spellbook();
    expect(book.unlockedTier).toBe(2);
    expect(entry(book, 'alohomora').status).toBe('open');
    expect(entry(book, 'lumos').status).toBe('learned');
    expect(entry(book, 'lumos').accepted).toBe(3);
    expect(entry(book, 'reparo').status).toBe('locked'); // tier 3

    const changes = of<ProgressChanged>('progress.changed');
    const unlocking = changes.filter((c) => c.unlockedTier !== undefined);
    expect(unlocking).toHaveLength(1);
    expect(unlocking[0]).toEqual({
      spellId: 'stupefy', accepted: 3, learned: true, unlockedTier: 2,
      unlockedSpells: ['alohomora', 'accio', 'expelliarmus', 'protego'],
    });
    // The spellbook that shows the new tier is published before the progress event that announces it.
    expect(kernel.last<Spellbook>('spellbook.changed')!.payload.unlockedTier).toBe(2);
    expect(storage.data.get('kv')!.get('progress.unlockedTier')).toEqual({ dataVersion: 1, value: 2 });
    const lumos = storage.data.get('progress')!.get('lumos') as SpellProgress;
    expect(lumos).toMatchObject({ spellId: 'lumos', casts: 3, best: 0.8 });
    expect(typeof lumos.learnedAt).toBe('number');
  });

  it('publishes the spellbook before the progress event, after the cast reached everyone', async () => {
    quiet();
    const { kernel, events } = await setup({ modules: [fakeEffects(), fakeStorage()] });
    const start = events.length;
    for (const id of TIER_1) for (let i = 0; i < 3; i++) cast(kernel, id);
    await settle();
    const order = events.slice(start).map((e) => e.type).filter((t) => t !== 'storage.changed');
    expect(order.slice(0, 12)).toEqual(Array(12).fill('spell.cast'));
    expect(order.indexOf('spellbook.changed')).toBeLessThan(order.indexOf('progress.changed'));
  });

  it('coalesces a burst of setting changes into one rebuild', async () => {
    quiet();
    const { kernel, of } = await setup();
    const before = of('spellbook.changed').length;
    kernel.settings.set('spells.unlockAll', true);
    kernel.settings.set('access.leftHanded', true);
    kernel.settings.set('theme.id', 'candlelit-2');
    await settle();
    expect(of('spellbook.changed').length).toBe(before + 1);
    // Settings the spellbook does not depend on cause no rebuild at all.
    kernel.settings.set('audio.volume', 0.3);
    await settle();
    expect(of('spellbook.changed').length).toBe(before + 1);
  });

  it('passes through tiers that have no available spells', async () => {
    quiet();
    const { kernel } = await setup({ settings: { 'packs.enabled': { 'core-charms': false } } });
    const book = kernel.packs.spellbook();
    expect(book.unlockedTier).toBe(4);
    expect(entry(book, 'petrificus-totalus').status).toBe('open');
    expect(entry(book, 'finite-incantatem').status).toBe('locked');
  });

  it('never lowers the unlocked tier, except through progress.reset', async () => {
    quiet();
    const storage = fakeStorage({ kv: { 'progress.unlockedTier': { dataVersion: 1, value: 3 } } });
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    expect(kernel.packs.spellbook().unlockedTier).toBe(3);
    expect(entry(kernel.packs.spellbook(), 'reparo').status).toBe('open');
    await ask(kernel, 'progress.reset', {});
    expect(kernel.packs.spellbook().unlockedTier).toBe(1);
    expect(storage.data.get('kv')!.has('progress.unlockedTier')).toBe(false);
  });
});

describe('progress', () => {
  it('counts practice casts but not replays, and voice casts only in voice mode', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    cast(kernel, 'lumos', { practice: true });
    cast(kernel, 'lumos', { replay: true });
    cast(kernel, 'lumos', { via: 'voice' });
    cast(kernel, 'lumos', { via: 'both' });
    await settle();
    expect(entry(kernel.packs.spellbook(), 'lumos').accepted).toBe(2);
    await ask(kernel, 'settings.set', { key: 'engine.mode', value: 'voice' });
    cast(kernel, 'lumos', { via: 'voice' });
    await settle();
    expect(entry(kernel.packs.spellbook(), 'lumos').accepted).toBe(3);
    expect(entry(kernel.packs.spellbook(), 'lumos').status).toBe('learned');
  });

  it('counts practice attempts and keeps the best quality', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    kernel.emit('practice.attempt', { spellId: 'nox', attempt: 1, success: false, score: 0.4, quality: 0.3 }, 'engine.test');
    kernel.emit('practice.attempt', { spellId: 'nox', attempt: 2, success: true, score: 0.8, quality: 0.7 }, 'engine.test');
    cast(kernel, 'nox', { quality: 0.95, practice: true });
    cast(kernel, 'nox', { quality: 0.6, practice: true });
    await settle();
    expect(storage.data.get('progress')!.get('nox')).toMatchObject({ casts: 2, practiceAttempts: 2, best: 0.95, learnedAt: null });
  });

  it('loads stored progress, and a spell stays learned once learnedAt is set', async () => {
    quiet();
    const storage = fakeStorage({
      progress: {
        lumos: { dataVersion: 1, spellId: 'lumos', casts: 1, practiceAttempts: 0, best: 0.5, learnedAt: 1234 },
        nox: { dataVersion: 1, spellId: 'nox', casts: 2, practiceAttempts: 4, best: 0.6, learnedAt: null },
      },
    });
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    const book = kernel.packs.spellbook();
    expect(entry(book, 'lumos')).toMatchObject({ status: 'learned', accepted: 1 });
    expect(entry(book, 'nox')).toMatchObject({ status: 'open', accepted: 2 });
    // Lowering the threshold makes nox learned, and records when.
    await ask(kernel, 'settings.set', { key: 'spells.learnAfter', value: 2 });
    await settle();
    expect(entry(kernel.packs.spellbook(), 'nox').status).toBe('learned');
    expect(kernel.packs.spellbook().learnAfter).toBe(2);
    expect((storage.data.get('progress')!.get('nox') as SpellProgress).learnedAt).toEqual(expect.any(Number));
  });

  it('writes no progress before the stored progress has been read, and loses no early cast', async () => {
    quiet();
    const storage = fakeStorage({ progress: { lumos: { dataVersion: 1, spellId: 'lumos', casts: 2, practiceAttempts: 0, best: 0.5, learnedAt: null } } });
    const { kernel } = await setup({ modules: [fakeEffects(), storage], load: false });
    cast(kernel, 'lumos');
    expect(storage.log.filter((l) => l.startsWith('put'))).toEqual([]);
    await kernel.loadPacks('https://spellglass.test/packs/index.json');
    await settle();
    expect(storage.data.get('progress')!.get('lumos')).toMatchObject({ casts: 3 });
    expect(entry(kernel.packs.spellbook(), 'lumos').status).toBe('learned');
  });

  it('resets one spell or everything', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel, of } = await setup({ modules: [fakeEffects(), storage] });
    cast(kernel, 'lumos');
    cast(kernel, 'nox');
    await settle();
    await ask(kernel, 'progress.reset', { spellId: 'lumos' });
    expect(entry(kernel.packs.spellbook(), 'lumos').accepted).toBe(0);
    expect(entry(kernel.packs.spellbook(), 'nox').accepted).toBe(1);
    expect(storage.data.get('progress')!.has('lumos')).toBe(false);
    expect(of<ProgressChanged>('progress.changed').at(-1)).toEqual({ spellId: 'lumos', accepted: 0, learned: false });
    await ask(kernel, 'progress.reset', {});
    expect(storage.data.get('progress')!.size).toBe(0);
    expect(entry(kernel.packs.spellbook(), 'nox').accepted).toBe(0);
  });

  it('works without any storage module', async () => {
    quiet();
    const { kernel } = await setup();
    cast(kernel, 'lumos');
    await settle();
    expect(entry(kernel.packs.spellbook(), 'lumos').accepted).toBe(1);
  });

  it('reloads progress another writer changed (a data import)', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    const revision = kernel.packs.spellbook().revision;
    storage.external('progress', 'stupefy', { dataVersion: 1, spellId: 'stupefy', casts: 7, practiceAttempts: 0, best: 0.9, learnedAt: 5 });
    await settle();
    expect(entry(kernel.packs.spellbook(), 'stupefy')).toMatchObject({ accepted: 7, status: 'learned' });
    expect(kernel.packs.spellbook().revision).toBe(revision + 1);
  });

  it('does not reload for the echo of its own writes', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    cast(kernel, 'lumos');
    await settle();
    const lists = storage.log.filter((l) => l.startsWith('list')).length;
    cast(kernel, 'nox');
    await settle();
    expect(storage.log.filter((l) => l.startsWith('list')).length).toBe(lists);
  });
});

describe('the left-handed mirror', () => {
  it('mirrors every path and swaps left and right flicks, in spell.gesture and templates alike', async () => {
    quiet();
    const { kernel } = await setup();
    const right = kernel.packs.spellbook();
    await ask(kernel, 'settings.set', { key: 'access.leftHanded', value: true });
    await settle();
    const left = kernel.packs.spellbook();

    const r = entry(right, 'accio'), l = entry(left, 'accio');
    expect(l.mirrored).toBe(true);
    expect(r.mirrored).toBe(false);
    expect(l.templates[0][0][0]).toBeCloseTo(1 - r.templates[0][0][0], 10);
    expect(l.templates[0][0][1]).toBe(r.templates[0][0][1]);
    const path = (g: unknown) => (g as { path: [number, number][] }).path;
    expect(path(l.spell.gesture)[0]).toEqual([0.25, 0.14]);
    expect(path(r.spell.gesture)[0]).toEqual([0.75, 0.14]);
    expect(l.gestureKey).not.toBe(r.gestureKey);

    expect(entry(left, 'stupefy').spell.gesture).toEqual({ flick: 'left' });
    expect(entry(left, 'finite-incantatem').spell.gesture).toEqual({ flick: 'right' });
    expect(entry(left, 'lumos').spell.gesture).toEqual({ flick: 'up' });
  });
});

describe("the player's own drawings", () => {
  const ARC: [number, number][] = Array.from({ length: 20 }, (_, i) => [0.1 + 0.04 * i, 0.5 - 0.4 * Math.sin((Math.PI * i) / 19)]);

  it('replaces the pack gesture, keeps its parts, and is stored right-handed', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    const before = entry(kernel.packs.spellbook(), 'alohomora');
    await ask(kernel, 'spellbook.override.set', { spellId: 'alohomora', gesture: { path: ARC } });
    const after = entry(kernel.packs.spellbook(), 'alohomora');
    expect(after.overridden).toBe(true);
    expect(after.gestureSource).toBe('override');
    expect(after.templates[0]).toHaveLength(64);
    expect(after.templates[0][0]).toEqual(ARC[0]);
    expect(after.gestureKey).not.toBe(before.gestureKey);
    const stored = storage.data.get('overrides')!.get('alohomora') as GestureOverride;
    expect(stored.gesture).toEqual({ path: ARC, any_start: false, parts: (before.spell.gesture as { parts: unknown }).parts });
    expect(stored.drawnLeftHanded).toBeUndefined();

    await ask(kernel, 'spellbook.override.clear', { spellId: 'alohomora' });
    expect(entry(kernel.packs.spellbook(), 'alohomora').gestureSource).toBe('pack');
    expect(storage.data.get('overrides')!.has('alohomora')).toBe(false);
  });

  it('mirrors a left-handed drawing back before storing it, and shows it mirrored', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage], settings: { 'access.leftHanded': true } });
    await ask(kernel, 'spellbook.override.set', { spellId: 'accio', gesture: { path: ARC } });
    const stored = storage.data.get('overrides')!.get('accio') as GestureOverride;
    expect(stored.drawnLeftHanded).toBe(true);
    expect((stored.gesture as { path: [number, number][] }).path[0][0]).toBeCloseTo(1 - ARC[0][0], 10);
    // Shown in the mirrored view exactly as drawn.
    expect(entry(kernel.packs.spellbook(), 'accio').templates[0][0][0]).toBeCloseTo(ARC[0][0], 10);
  });

  it('converts a captured stroke with its aspect, and stores a straight one as a flick', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    const stroke = (pts: [number, number][]): Stroke => ({
      id: 's1', t0: 0, t1: 500, quality: 1, aspect: 16 / 9, src: 'tracker.pointer',
      points: pts.map(([x, y], i) => ({ t: i * 20, x, y, conf: 1, src: 'tracker.pointer' })),
    });
    const circle = Array.from({ length: 40 }, (_, i) => [0.5 + 0.15 * Math.sin((2 * Math.PI * i) / 39), 0.5 - 0.27 * Math.cos((2 * Math.PI * i) / 39)] as [number, number]);
    await ask(kernel, 'spellbook.override.set', { spellId: 'protego', stroke: stroke(circle) });
    const protego = storage.data.get('overrides')!.get('protego') as GestureOverride;
    const path = (protego.gesture as { path: [number, number][] }).path;
    expect(path).toHaveLength(64);
    // Isotropic: the circle is round again in the unit square (0.15 × 16/9 ≈ 0.27).
    const xs = path.map((p) => p[0]), ys = path.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(Math.max(...ys) - Math.min(...ys), 1);
    // The drawing inherits the pack gesture's start-point expansion.
    const packProtego = shippedJson<{ spells: { id: string; gesture: { start_points?: number } }[] }>('core-charms/pack.json').spells.find((sp) => sp.id === 'protego')!;
    expect(protego.gesture).toMatchObject({ any_start: true, start_points: packProtego.gesture.start_points });

    await ask(kernel, 'spellbook.override.set', { spellId: 'nox', stroke: stroke([[0.5, 0.2], [0.501, 0.4], [0.5, 0.6], [0.499, 0.8]]) });
    expect((storage.data.get('overrides')!.get('nox') as GestureOverride).gesture).toEqual({ flick: 'down' });
  });

  it('refuses an unknown spell and an invalid gesture', async () => {
    quiet();
    const { kernel } = await setup({ modules: [fakeEffects(), fakeStorage()] });
    await expect(ask(kernel, 'spellbook.override.set', { spellId: 'nope', gesture: { flick: 'up' } })).rejects.toMatchObject({ code: 'invalid-payload', message: 'No loaded spell has the id "nope".' });
    await expect(ask(kernel, 'spellbook.override.set', { spellId: 'lumos', gesture: { flick: 'up', path: ARC } as never })).rejects.toMatchObject({
      message: 'gesture must have exactly one of "flick", "path" or "paths".'.replace(/^gesture/, 'The gesture'),
    });
  });

  it('loads stored drawings and ignores damaged ones', async () => {
    quiet();
    const storage = fakeStorage({
      overrides: {
        lumos: { dataVersion: 1, spellId: 'lumos', gesture: { flick: 'left' }, savedAt: 1 },
        nox: { dataVersion: 1, spellId: 'nox', gesture: { path: [[0, 0]] }, savedAt: 1 },
      },
    });
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    expect(entry(kernel.packs.spellbook(), 'lumos').spell.gesture).toEqual({ flick: 'left' });
    expect(entry(kernel.packs.spellbook(), 'nox').gestureSource).toBe('pack');
  });
});

describe('themes', () => {
  it("chooses the theme 'theme.id' names, else the first enabled theme", async () => {
    quiet();
    const { kernel } = await setup({ modules: [fakeEffects(), fakeStorage()] });
    const dusk = { ...shippedJson('theme-candlelit/pack.json'), id: 'dusk', title: 'Dusk' };
    await ask(kernel, 'packs.import', { text: JSON.stringify(dusk) });
    expect(kernel.packs.spellbook().theme?.id).toBe('candlelit');
    await ask(kernel, 'settings.set', { key: 'theme.id', value: 'dusk' });
    await settle();
    expect(kernel.packs.spellbook().theme?.id).toBe('dusk');
    await ask(kernel, 'settings.set', { key: 'theme.id', value: 'no-such-theme' });
    await settle();
    expect(kernel.packs.spellbook().theme?.id).toBe('candlelit');
    await ask(kernel, 'packs.enable', { id: 'candlelit', enabled: false });
    expect(kernel.packs.spellbook().theme?.id).toBe('dusk');
  });
});

describe('packs on and off', () => {
  it('turns the restricted section on through packs.enable', async () => {
    quiet();
    const { kernel } = await setup({ settings: { 'spells.unlockAll': true } });
    expect(entry(kernel.packs.spellbook(), 'crucio').available).toBe(false);
    await ask(kernel, 'packs.enable', { id: 'restricted-section', enabled: true });
    expect(entry(kernel.packs.spellbook(), 'crucio')).toMatchObject({ available: true, enabled: true });
    expect(kernel.settings.get('packs.enabled', {})).toEqual({ 'restricted-section': true });
    await expect(ask(kernel, 'packs.enable', { id: 'nope', enabled: true })).rejects.toMatchObject({ code: 'invalid-payload' });
  });
});
