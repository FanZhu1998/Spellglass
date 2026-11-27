// The pack service through a real kernel (tests/packs/helpers.ts has the doubles): staged unlocking
// when a pack is turned off and on, progress counted by two windows at once, requests that cannot
// build a spellbook, and packs and drawings that are too deep or too complex to load.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GesturePack, PackFailed, SpellCast, Spellbook, SpellProgress } from '../../contracts';
import { newId } from '../ids';
import type { KernelHost } from '../kernel';
import { ask } from '../typed';
import { fakeEffects, fakeStorage, indexFor, setup, settle, shippedFiles } from '../../../tests/packs/helpers';
import { PACK_DEPTH_LIMIT } from './limits';

afterEach(() => vi.restoreAllMocks());

const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
};

function cast(kernel: KernelHost, spellId: string, extra: Partial<SpellCast> = {}): void {
  kernel.emit('spell.cast', { id: newId('cast'), spellId, t: kernel.now(), via: 'gesture', quality: 0.8, power: 0.5, aim: { x: 0.5, y: 0.5 }, ...extra }, 'engine.test');
}

function entry(book: Spellbook, id: string) {
  const e = book.spells.find((s) => s.spell.id === id);
  if (!e) throw new Error(`no spell ${id}`);
  return e;
}

const enabledIds = (book: Spellbook) => book.spells.filter((e) => e.enabled).map((e) => e.spell.id);
const TIER_1 = ['lumos', 'nox', 'wingardium-leviosa', 'stupefy'];

const progressRecord = (spellId: string, extra: Partial<SpellProgress>): SpellProgress => ({
  dataVersion: 1, spellId, casts: 0, practiceAttempts: 0, best: 0, learnedAt: null, ...extra,
});

/** A spell pack of the player's, as JSON text. `deep` replaces the string "DEEP" with lists nested
 *  that many levels (built as text: a value that deep cannot be stringified). */
function friendPack(spell: Record<string, unknown> = {}, pack: Record<string, unknown> = {}, deep = 0): string {
  const json = JSON.stringify({
    schema: 'spellpack/1', id: 'friend-charms', version: '1.0.0', engine: '>=1.0 <2.0', title: 'Friend charms', needs: ['fx.light@1'],
    spells: [{ id: 'glacius', incantation: 'Glacius', gesture: { flick: 'up' }, effect: { steps: [{ use: 'light.flash' }], fallback: 'sparkle' }, ...spell }],
    ...pack,
  });
  return deep ? json.replace('"DEEP"', `${'['.repeat(deep)}0${']'.repeat(deep)}`) : json;
}

describe('turning a pack off and on again', () => {
  it('does not skip its stages, and saves no tier for passing through', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    await ask(kernel, 'packs.enable', { id: 'core-charms', enabled: false });
    // Nothing is available below tier 4, so this spellbook passes straight through to it.
    expect(kernel.packs.spellbook().unlockedTier).toBe(4);
    await ask(kernel, 'packs.enable', { id: 'core-charms', enabled: true });
    await settle();
    const book = kernel.packs.spellbook();
    expect(book.unlockedTier).toBe(1);
    expect(enabledIds(book)).toEqual(TIER_1);
    expect(storage.data.get('kv')!.has('progress.unlockedTier')).toBe(false);
  });

  it('keeps a spell learned while the pack was off castable, and locks the rest of its tier again', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    await ask(kernel, 'packs.enable', { id: 'core-charms', enabled: false });
    for (let i = 0; i < 3; i++) cast(kernel, 'petrificus-totalus');
    await settle();
    expect(entry(kernel.packs.spellbook(), 'petrificus-totalus').status).toBe('learned');
    await ask(kernel, 'packs.enable', { id: 'core-charms', enabled: true });
    await settle();
    const book = kernel.packs.spellbook();
    expect(book.unlockedTier).toBe(1);
    expect(entry(book, 'petrificus-totalus')).toMatchObject({ status: 'learned', enabled: true });
    expect(entry(book, 'impedimenta')).toMatchObject({ status: 'locked', enabled: false });
    expect(enabledIds(book)).toEqual([...TIER_1, 'petrificus-totalus']);
    expect(storage.data.get('kv')!.has('progress.unlockedTier')).toBe(false);
  });
});

describe('two windows counting at once', () => {
  // The other window writes straight into storage, and this one never hears of it: the worst case,
  // when no 'storage.changed' reaches it in time.
  it('adds a cast to what the other window stored, and keeps a spell learned there', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    storage.data.get('progress')!.set('lumos', progressRecord('lumos', { casts: 3, practiceAttempts: 2, best: 0.9, learnedAt: 1234 }));
    cast(kernel, 'lumos', { quality: 0.5 });
    await settle();
    expect(storage.data.get('progress')!.get('lumos')).toEqual(progressRecord('lumos', { casts: 4, practiceAttempts: 2, best: 0.9, learnedAt: 1234 }));
    // This window now shows what storage holds.
    expect(entry(kernel.packs.spellbook(), 'lumos')).toMatchObject({ accepted: 4, status: 'learned' });
  });

  it('adds practice attempts and casts to the stored counts, one at a time', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    storage.data.get('progress')!.set('nox', progressRecord('nox', { casts: 1, practiceAttempts: 5, best: 0.4 }));
    kernel.emit('practice.attempt', { spellId: 'nox', attempt: 1, success: false, score: 0.3, quality: 0.2 }, 'engine.test');
    cast(kernel, 'nox', { quality: 0.6, practice: true });
    cast(kernel, 'nox', { quality: 0.3, practice: true });
    await settle();
    expect(storage.data.get('progress')!.get('nox')).toMatchObject({ casts: 3, practiceAttempts: 6, best: 0.6 });
    expect(typeof (storage.data.get('progress')!.get('nox') as SpellProgress).learnedAt).toBe('number');
    expect(entry(kernel.packs.spellbook(), 'nox')).toMatchObject({ accepted: 3, status: 'learned' });
  });

  it('counts both casts when two windows save the same spell at the same moment (Web Locks)', async () => {
    quiet();
    // A stand-in for navigator.locks, shared by both windows as the browser's is by a site's tabs.
    const tails = new Map<string, Promise<unknown>>();
    const locks = {
      request<T>(name: string, task: () => Promise<T>): Promise<T> {
        const run = (tails.get(name) ?? Promise.resolve()).then(() => task());
        tails.set(name, run.catch(() => undefined));
        return run;
      },
    };
    vi.stubGlobal('navigator', { ...globalThis.navigator, locks });
    try {
      const shared = fakeStorage();
      const a = await setup({ modules: [fakeEffects(), shared] });
      const otherTab = fakeStorage({}, shared);
      const b = await setup({ modules: [fakeEffects(), otherTab] });
      // Both windows read the record before either writes, unless something keeps them apart.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      shared.slowGets = gate;
      otherTab.slowGets = gate;
      cast(a.kernel, 'lumos');
      cast(b.kernel, 'lumos');
      await settle();
      release();
      await settle();
      expect(shared.data.get('progress')!.get('lumos')).toMatchObject({ casts: 2 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('never writes the tier below the stored one, and takes a higher one', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    // The other window opened tier 3 meanwhile.
    storage.data.get('kv')!.set('progress.unlockedTier', { dataVersion: 1, value: 3 });
    for (const id of TIER_1) for (let i = 0; i < 3; i++) cast(kernel, id);
    await settle();
    expect(storage.data.get('kv')!.get('progress.unlockedTier')).toEqual({ dataVersion: 1, value: 3 });
    expect(kernel.packs.spellbook().unlockedTier).toBe(3);
    expect(entry(kernel.packs.spellbook(), 'reparo').status).toBe('open');
  });

  it('shows what another window saved as soon as it hears of it, also for a spell it wrote a moment ago', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    cast(kernel, 'lumos');
    await settle();
    // The other window counted three more; the storage module relays its change ('other-tab').
    storage.external('progress', 'lumos', progressRecord('lumos', { casts: 4, best: 0.9, learnedAt: 1234 }), 'other-tab');
    await settle();
    expect(entry(kernel.packs.spellbook(), 'lumos')).toMatchObject({ accepted: 4, status: 'learned' });
  });

  it('keeps what this window counted when storage starts again empty', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    for (let i = 0; i < 3; i++) cast(kernel, 'lumos');
    await settle();
    const { learnedAt } = storage.data.get('progress')!.get('lumos') as SpellProgress;
    expect(learnedAt).not.toBeNull();
    // IndexedDB was closed mid-session: storage carries on in memory, which starts empty
    // (contracts/storage.ts), and says so.
    for (const rows of storage.data.values()) rows.clear();
    kernel.emit('storage.status', { persistent: false, reason: 'closed', message: 'Storage was closed, so Spellglass runs without saving until you reload.' }, 'storage.test');
    cast(kernel, 'lumos', { quality: 0.4 });
    await settle();
    expect(storage.data.get('progress')!.get('lumos')).toMatchObject({ casts: 4, best: 0.8, learnedAt });
    expect(entry(kernel.packs.spellbook(), 'lumos')).toMatchObject({ accepted: 4, status: 'learned' });
  });

  it('lets a reset in another window stand against a cast whose write was still waiting', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    cast(kernel, 'lumos');
    cast(kernel, 'lumos');
    await settle();
    // This cast's read of the stored record is slow. Meanwhile the other window resets progress, and
    // its 'storage.changed' reaches this one.
    let release = () => {};
    storage.slowGets = new Promise<void>((resolve) => (release = resolve));
    cast(kernel, 'lumos');
    await settle();
    storage.external('progress', 'lumos', undefined, 'clear');
    await settle();
    // Before the waiting write lands, this window already shows the reset with its own cast on top.
    expect(entry(kernel.packs.spellbook(), 'lumos').accepted).toBe(1);
    storage.slowGets = null;
    release();
    await settle();
    // Storage had the reset first, so the waiting cast is added to the reset record, not to the two
    // casts memory had before it.
    expect(storage.data.get('progress')!.get('lumos')).toMatchObject({ casts: 1 });
    expect(entry(kernel.packs.spellbook(), 'lumos').accepted).toBe(1);
  });

  it('still resets everything, also what is waiting to be written', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    cast(kernel, 'lumos');
    cast(kernel, 'nox');
    const reset = ask(kernel, 'progress.reset', {});
    await reset;
    await settle();
    expect(storage.data.get('progress')!.size).toBe(0);
    expect(entry(kernel.packs.spellbook(), 'lumos').accepted).toBe(0);
    cast(kernel, 'lumos');
    await settle();
    expect(storage.data.get('progress')!.get('lumos')).toMatchObject({ casts: 1 });
  });
});

describe('a request that cannot build a spellbook', () => {
  /** Stands for any error nobody foresaw while building the spellbook. */
  function breakBuilds(kernel: KernelHost, when: (needs: readonly string[]) => boolean): void {
    const unmet = kernel.capabilities.unmet.bind(kernel.capabilities);
    vi.spyOn(kernel.capabilities, 'unmet').mockImplementation((needs) => {
      if (when(needs ?? [])) throw new RangeError('Maximum call stack size exceeded');
      return unmet(needs);
    });
  }

  it('refuses a pack nested too deeply with a plain reason, and the service carries on', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    const revision = kernel.packs.spellbook().revision;
    // An unknown field deep inside a gesture, as in a crafted friend's pack.
    const text = friendPack({ gesture: { flick: 'up', wobble: 'DEEP' } }, {}, 3000);
    await expect(ask(kernel, 'packs.import', { text, filename: 'friend-charms.json' })).rejects.toMatchObject({
      code: 'invalid-payload', message: `The file is nested too deeply: a pack may nest lists and objects at most ${PACK_DEPTH_LIMIT} levels deep.`,
    });
    await ask(kernel, 'packs.enable', { id: 'restricted-section', enabled: true });
    const book = kernel.packs.spellbook();
    expect(book.revision).toBe(revision + 1);
    expect(entry(book, 'crucio').available).toBe(true);
    expect(book.packs.some((p) => p.id === 'friend-charms')).toBe(false);
    expect(storage.data.get('packs')!.size).toBe(0);
  });

  it('refuses a pack the spellbook cannot be built with, and leaves everything as it was', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    breakBuilds(kernel, (needs) => needs.includes('fx.weather@1'));
    const before = kernel.packs.spellbook();
    await expect(ask(kernel, 'packs.import', { text: friendPack({}, { needs: ['fx.weather@1'] }) })).rejects.toMatchObject({
      code: 'invalid-payload', message: 'This spell pack could not be loaded.',
    });
    expect(kernel.packs.spellbook()).toBe(before);
    expect(storage.data.get('packs')!.size).toBe(0);
    // The pack is not half there: later changes build without it, and a good copy imports.
    await ask(kernel, 'packs.enable', { id: 'restricted-section', enabled: true });
    expect(kernel.packs.spellbook().revision).toBe(before.revision + 1);
    expect(kernel.packs.spellbook().packs.some((p) => p.id === 'friend-charms')).toBe(false);
    const ok = await ask(kernel, 'packs.import', { text: friendPack() });
    expect(ok).toMatchObject({ id: 'friend-charms', kind: 'spellpack' });
    expect(ok.warnings).not.toContain('This replaces a damaged copy you imported earlier.');
  });

  it('leaves a drawing unsaved when the spellbook cannot be built with it', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    breakBuilds(kernel, () => true);
    await expect(ask(kernel, 'spellbook.override.set', { spellId: 'nox', gesture: { flick: 'left' } })).rejects.toMatchObject({
      code: 'invalid-payload', message: 'Spellglass could not use this drawing, so it was not saved.',
    });
    vi.mocked(kernel.capabilities.unmet).mockRestore();
    await ask(kernel, 'settings.set', { key: 'spells.unlockAll', value: true });
    await settle();
    expect(entry(kernel.packs.spellbook(), 'nox')).toMatchObject({ overridden: false, gestureSource: 'pack' });
    expect(storage.data.get('overrides')!.size).toBe(0);
  });

  it('leaves a pack switch as it was when the spellbook cannot be built', async () => {
    quiet();
    const { kernel } = await setup({ modules: [fakeEffects(), fakeStorage()] });
    breakBuilds(kernel, () => true);
    await expect(ask(kernel, 'packs.enable', { id: 'restricted-section', enabled: true })).rejects.toMatchObject({
      code: 'invalid-payload', message: 'Restricted section could not be turned on.',
    });
    await settle();
    expect(kernel.settings.get('packs.enabled', {})).toEqual({});
    expect(kernel.packs.spellbook().packs.find((p) => p.id === 'restricted-section')?.enabled).toBe(false);
  });
});

describe('packs too complex to match quickly', () => {
  const loop: [number, number][] = [[0.5, 0.1], [0.8, 0.3], [0.8, 0.7], [0.5, 0.9], [0.2, 0.7], [0.2, 0.3], [0.5, 0.1]];

  it('refuses one on import, with the reason', async () => {
    quiet();
    const { kernel } = await setup({ modules: [fakeEffects(), fakeStorage()] });
    const gesture = { paths: Array.from({ length: 16 }, () => loop), any_start: true, start_points: 32 };
    await expect(ask(kernel, 'packs.import', { text: friendPack({ gesture }) })).rejects.toMatchObject({
      code: 'invalid-payload',
      message: 'This spell pack is too complex to match quickly: spell "glacius" has 256 gesture templates, and a spell may have at most 64.',
    });
    expect(kernel.packs.spellbook().packs.some((p) => p.id === 'friend-charms')).toBe(false);
  });

  it('refuses a gesture pack whose paths would take a spell\'s start points past the budget', async () => {
    quiet();
    const { kernel } = await setup({ modules: [fakeEffects(), fakeStorage()] });
    // Within the budget on its own: one loop with sixteen start points.
    await ask(kernel, 'packs.import', { text: friendPack({ gesture: { path: loop, any_start: true, start_points: 16 } }) });
    // Sixteen paths that set no start points of their own would take the spell's: 256 templates.
    const layer = { schema: 'gesturepack/1', id: 'friend-gestures', version: '1.0.0', title: 'Friend gestures', gestures: { glacius: { paths: Array.from({ length: 16 }, () => loop) } } };
    await expect(ask(kernel, 'packs.import', { text: JSON.stringify(layer) })).rejects.toMatchObject({
      code: 'invalid-payload',
      message: 'This gesture pack is too complex to match quickly: the gesture for "glacius" can have up to 256 gesture templates, and a spell may have at most 64.',
    });
    expect(entry(kernel.packs.spellbook(), 'glacius')).toMatchObject({ gestureSource: 'pack', templates: [expect.any(Array)] });
  });

  it('skips a bundled one with the reason, and loads the others', async () => {
    quiet();
    const files = shippedFiles();
    const deep = friendPack({ notes: 'DEEP' }, {}, 100);
    const heavy = friendPack({ gesture: { paths: Array.from({ length: 16 }, () => loop), any_start: true, start_points: 5 } }, { id: 'heavy-charms' });
    files.set('deep/pack.json', deep);
    files.set('heavy/pack.json', heavy);
    files.set('index.json', indexFor([
      { id: 'core-charms', kind: 'spellpack', path: 'core-charms/pack.json', body: files.get('core-charms/pack.json')! },
      { id: 'friend-charms', kind: 'spellpack', path: 'deep/pack.json', body: deep },
      { id: 'heavy-charms', kind: 'spellpack', path: 'heavy/pack.json', body: heavy },
    ]));
    const { kernel, of } = await setup({ files });
    expect(of<PackFailed>('pack.failed').map((f) => [f.id, f.reason])).toEqual([
      ['friend-charms', `The file is nested too deeply: a pack may nest lists and objects at most ${PACK_DEPTH_LIMIT} levels deep.`],
      ['heavy-charms', 'This spell pack is too complex to match quickly: spell "glacius" has 80 gesture templates, and a spell may have at most 64.'],
    ]);
    const book = kernel.packs.spellbook();
    expect(book.packs.find((p) => p.id === 'heavy-charms')?.error).toMatch(/too complex/);
    expect(book.spells.filter((e) => e.packId === 'core-charms')).toHaveLength(12);
  });

  // The player's drawings take their spells' places, and a data file (Import) can hold any number.
  const heavyDrawing = (spellId: string) => ({
    dataVersion: 1, spellId, gesture: { paths: Array.from({ length: 16 }, () => loop), any_start: true, start_points: 16 }, savedAt: 1,
  });

  it('ignores a stored drawing with more templates than one stroke makes, at launch and from a data file', async () => {
    quiet();
    const storage = fakeStorage({ overrides: { protego: heavyDrawing('protego') } });
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    expect(entry(kernel.packs.spellbook(), 'protego')).toMatchObject({ gestureSource: 'pack', overridden: false, templates: [expect.any(Array)] });
    storage.external('overrides', 'lumos', heavyDrawing('lumos'), 'import');
    storage.external('overrides', 'nox', { dataVersion: 1, spellId: 'nox', gesture: { path: loop }, savedAt: 1 }, 'import');
    await settle();
    const book = kernel.packs.spellbook();
    expect(entry(book, 'lumos')).toMatchObject({ gestureSource: 'pack', overridden: false, templates: [] });
    // A drawing that fits, brought in by the same file, is used.
    expect(entry(book, 'nox')).toMatchObject({ gestureSource: 'override', templates: [expect.any(Array)] });
    // Only that one leaves with the redrawn gestures.
    const file = await ask(kernel, 'packs.export', { gestures: true });
    expect(Object.keys((JSON.parse(file.text) as GesturePack).gestures)).toEqual(['nox']);
  });

  it('refuses such a drawing when it is saved, and saves one stroke\'s worth', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    // Two loops that take Protego's twelve start points: 24 templates.
    await expect(ask(kernel, 'spellbook.override.set', { spellId: 'protego', gesture: { paths: [loop, loop] } })).rejects.toMatchObject({
      code: 'invalid-payload',
      message: 'This drawing is too complex to match quickly: it can have up to 24 gesture templates, and a drawing, which is one stroke, may have at most 16.',
    });
    expect(storage.data.get('overrides')!.size).toBe(0);
    expect(entry(kernel.packs.spellbook(), 'protego').gestureSource).toBe('pack');
    await ask(kernel, 'spellbook.override.set', { spellId: 'protego', gesture: { path: loop } });
    expect(entry(kernel.packs.spellbook(), 'protego').gestureSource).toBe('override');
    expect(storage.data.get('overrides')!.get('protego')).toMatchObject({ gesture: { path: loop, any_start: true, start_points: 12 } });
  });
});
