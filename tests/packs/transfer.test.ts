// Packs the player shares (Section 11.1): import and export round trips for spell, theme and gesture
// packs, refusals, precedence between bundled and imported packs, and gesture-pack layers.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GesturePack, PackLoaded, Spellbook, UserPack } from '../../src/contracts';
import { PACK_SIZE_LIMIT_BYTES } from '../../src/contracts';
import { ask, type KernelHost } from '../../src/kernel';
import { fakeEffects, fakeStorage, setup, settle, shippedJson } from './helpers';

afterEach(() => vi.restoreAllMocks());

const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
};

function entry(book: Spellbook, id: string) {
  const e = book.spells.find((s) => s.spell.id === id);
  if (!e) throw new Error(`no spell ${id}`);
  return e;
}

const W: [number, number][] = [[0.1, 0.2], [0.3, 0.8], [0.5, 0.4], [0.7, 0.8], [0.9, 0.2]];
const HOOK: [number, number][] = [[0.8, 0.1], [0.8, 0.7], [0.6, 0.9], [0.3, 0.9], [0.2, 0.7]];

function housePack(overrides: Record<string, unknown> = {}) {
  return {
    schema: 'spellpack/1',
    id: 'house-charms',
    version: '1.0.0',
    engine: '>=1.0 <2.0',
    title: 'House charms',
    needs: ['fx.light@1', 'audio@1'],
    house_colors: ['crimson', 'gold'],
    spells: [
      {
        id: 'glacius', incantation: 'Glacius', gesture: { path: W },
        effect: { steps: [{ use: 'light.flash', color: '#BFE6FF', intensity: 0.4 }, { use: 'audio.cue', cue: 'chime' }], fallback: 'sparkle' },
        tier: 1, frost: 'deep',
      },
      {
        id: 'lumos', incantation: 'Lumos', gesture: { path: HOOK },
        effect: { steps: [{ use: 'light.orb', hold: true }], fallback: 'sparkle' },
      },
    ],
    ...overrides,
  };
}

async function exportedJson(kernel: KernelHost, id: string): Promise<unknown> {
  return JSON.parse((await ask(kernel, 'packs.export', { id })).text);
}

describe('spell packs', () => {
  it('round-trips an imported pack: stored as imported, exported unchanged, unknown fields kept', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel, of } = await setup({ modules: [fakeEffects(), storage] });
    const pack = housePack();
    const result = await ask(kernel, 'packs.import', { text: JSON.stringify(pack), filename: 'house.json' });
    expect(result.id).toBe('house-charms');
    expect(result.kind).toBe('spellpack');
    expect(result.warnings).toEqual(['Spell "lumos" is not used, because Core charms also has it and comes first.']);
    expect(of<PackLoaded>('pack.loaded').at(-1)).toEqual({ id: 'house-charms', kind: 'spellpack', version: '1.0.0', unmet: [], skippedSteps: 0, user: true });

    const book = kernel.packs.spellbook();
    expect(book.packs.at(-1)).toMatchObject({ id: 'house-charms', user: true, enabled: true, title: 'House charms' });
    expect(entry(book, 'glacius')).toMatchObject({ packId: 'house-charms', status: 'open', enabled: true });
    expect(entry(book, 'glacius').spell.frost).toBe('deep');
    expect(entry(book, 'lumos').packId).toBe('core-charms');

    expect((storage.data.get('packs')!.get('house-charms') as UserPack).json).toEqual(pack);
    expect(await exportedJson(kernel, 'house-charms')).toEqual(pack);
  });

  it('exports a bundled pack exactly as it ships', async () => {
    quiet();
    const { kernel } = await setup();
    const out = await ask(kernel, 'packs.export', { id: 'core-charms' });
    expect(out.filename).toBe('core-charms.json');
    expect(JSON.parse(out.text)).toEqual(shippedJson('core-charms/pack.json'));
  });

  it('lets the first enabled pack keep a spell id, so turning one pack off hands it to the other', async () => {
    quiet();
    const { kernel } = await setup({ modules: [fakeEffects(), fakeStorage()] });
    await ask(kernel, 'packs.import', { text: JSON.stringify(housePack()) });
    await ask(kernel, 'packs.enable', { id: 'core-charms', enabled: false });
    const book = kernel.packs.spellbook();
    expect(entry(book, 'lumos').packId).toBe('house-charms');
    expect(entry(book, 'lumos').templates).toHaveLength(1);
    expect(book.packs.find((p) => p.id === 'core-charms')?.warnings).toEqual(['Spell "lumos" is not used, because House charms also has it and comes first.']);
    expect(book.spells.filter((e) => e.spell.id === 'lumos')).toHaveLength(1);
  });

  it('replaces an earlier import of the same pack, and removes it', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    await ask(kernel, 'packs.import', { text: JSON.stringify(housePack()) });
    const second = await ask(kernel, 'packs.import', { text: JSON.stringify(housePack({ version: '1.1.0', title: 'House charms, revised' })) });
    expect(second.warnings).toContain('This replaces the copy you imported earlier (version 1.0.0).');
    expect(kernel.packs.spellbook().packs.filter((p) => p.id === 'house-charms')).toHaveLength(1);
    expect(kernel.packs.spellbook().packs.at(-1)?.version).toBe('1.1.0');

    await ask(kernel, 'packs.remove', { id: 'house-charms' });
    expect(kernel.packs.spellbook().packs.some((p) => p.id === 'house-charms')).toBe(false);
    expect(storage.data.get('packs')!.size).toBe(0);
    await expect(ask(kernel, 'packs.remove', { id: 'core-charms' })).rejects.toMatchObject({
      code: 'invalid-payload', message: 'Packs that ship with Spellglass cannot be removed. Turn the pack off instead.',
    });
  });

  it('refuses a bundled id unless the version is higher, which then replaces the bundled pack in its place', async () => {
    quiet();
    const { kernel } = await setup({ modules: [fakeEffects(), fakeStorage()] });
    const core = shippedJson<Record<string, unknown>>('core-charms/pack.json');
    await expect(ask(kernel, 'packs.import', { text: JSON.stringify(core) })).rejects.toMatchObject({
      message: 'A pack with the id "core-charms" ships with Spellglass (version 1.0.0). Give this pack an id of its own, or a higher version to replace it.',
    });
    const newer = { ...core, version: '1.1.0', title: 'Core charms, extended' };
    const result = await ask(kernel, 'packs.import', { text: JSON.stringify(newer) });
    expect(result.warnings).toContain('Replaces version 1.0.0, which ships with Spellglass.');
    const book = kernel.packs.spellbook();
    expect(book.packs[0]).toMatchObject({ id: 'core-charms', user: true, version: '1.1.0', shadows: 'core-charms' });
    expect(book.packs.filter((p) => p.id === 'core-charms')).toHaveLength(1);
    expect(entry(book, 'lumos').packTitle).toBe('Core charms, extended');
    // Removing the import brings the bundled pack back.
    await ask(kernel, 'packs.remove', { id: 'core-charms' });
    expect(kernel.packs.spellbook().packs[0]).toMatchObject({ id: 'core-charms', user: false, version: '1.0.0' });
  });

  it('refuses files that are too large, not JSON, not packs, or in a newer format', async () => {
    quiet();
    const { kernel } = await setup({ modules: [fakeEffects(), fakeStorage()] });
    const reject = (text: string) => ask(kernel, 'packs.import', { text });
    await expect(reject('x'.repeat(PACK_SIZE_LIMIT_BYTES + 1))).rejects.toMatchObject({ message: expect.stringMatching(/^The file is too large: it is 513 KB/) });
    await expect(reject('{ nope')).rejects.toMatchObject({ message: expect.stringMatching(/^The file is not valid JSON/) });
    await expect(reject('[]')).rejects.toMatchObject({ message: 'The file does not hold a pack: a pack is a JSON object.' });
    await expect(reject('{"title": "x"}')).rejects.toMatchObject({ message: 'The file has no "schema" field, so it is not a Spellglass pack.' });
    await expect(reject(JSON.stringify({ ...housePack(), schema: 'spellpack/2' }))).rejects.toMatchObject({
      message: 'This spell pack uses a newer format (spellpack/2) than this version of Spellglass reads.',
    });
    await expect(reject(JSON.stringify(housePack({ id: 'House Charms' })))).rejects.toMatchObject({
      message: 'The spell pack does not match the spellpack/1 format: id must be lower-case letters and digits in words joined by hyphens, like core-charms.',
    });
    await expect(reject(JSON.stringify({ ...shippedJson('theme-candlelit/pack.json'), id: 'core-charms' }))).rejects.toMatchObject({
      message: 'A spell pack with the id "core-charms" ships with Spellglass. Give this theme pack an id of its own.',
    });
  });

  it('keeps an import for the session when there is no storage, and says so', async () => {
    quiet();
    const { kernel } = await setup();
    const result = await ask(kernel, 'packs.import', { text: JSON.stringify(housePack()) });
    expect(result.warnings).toContain('Storage is not available, so this pack lasts only until Spellglass is closed.');
    expect(entry(kernel.packs.spellbook(), 'glacius').available).toBe(true);
  });

  it('says the pack could not be saved, not that storage is missing, when storage refuses it', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    storage.refusePuts = 'This value is nested too deeply to save.';
    const result = await ask(kernel, 'packs.import', { text: JSON.stringify(housePack()) });
    expect(result.warnings).toContain('Spellglass could not save this spell pack, so it lasts only until Spellglass is closed. This value is nested too deeply to save.');
    expect(result.warnings).not.toContain('Storage is not available, so this pack lasts only until Spellglass is closed.');
    expect(entry(kernel.packs.spellbook(), 'glacius').available).toBe(true);
    // Storage still works for everything else.
    storage.refusePuts = null;
    kernel.emit('spell.cast', { id: 'c1', spellId: 'lumos', t: 1, via: 'gesture', quality: 0.9, power: 0.5, aim: { x: 0.5, y: 0.5 } }, 'engine.rules');
    await settle();
    expect(storage.data.get('progress')!.get('lumos')).toMatchObject({ casts: 1 });
  });

  it('warns about what it cannot use: unknown steps and missing capabilities', async () => {
    quiet();
    const { kernel } = await setup({ modules: [fakeEffects(['light.flash', 'audio.cue', 'light.orb'], ['fx.light@1', 'audio@1']), fakeStorage()] });
    const pack = housePack({ needs: ['fx.light@1', 'audio@1', 'fx.scene@1'] });
    (pack.spells[0].effect.steps as unknown[]).push({ use: 'prop.dance', tempo: 3 });
    const result = await ask(kernel, 'packs.import', { text: JSON.stringify(pack) });
    expect(result.warnings).toEqual(expect.arrayContaining([
      'Some effect steps are skipped because nothing here plays them: prop.dance.',
      'Needs scene effects, which are not available here.',
    ]));
    expect(entry(kernel.packs.spellbook(), 'glacius').unavailableReason).toBe('Needs scene effects, which are not available here.');
  });
});

describe('theme packs', () => {
  it('round-trips a theme pack', async () => {
    quiet();
    const { kernel } = await setup({ modules: [fakeEffects(), fakeStorage()] });
    const dusk = { ...shippedJson('theme-candlelit/pack.json'), id: 'dusk', title: 'Dusk', moon: 'waning' };
    const result = await ask(kernel, 'packs.import', { text: JSON.stringify(dusk) });
    expect(result).toEqual({ id: 'dusk', kind: 'themepack', warnings: [] });
    expect(await exportedJson(kernel, 'dusk')).toEqual(dusk);
    expect(kernel.packs.spellbook().packs.at(-1)).toMatchObject({ id: 'dusk', kind: 'themepack', user: true, unmet: [] });
  });
});

describe('gesture packs', () => {
  const S: [number, number][] = [[0.8, 0.1], [0.2, 0.3], [0.8, 0.6], [0.2, 0.9]];

  it('exports the redrawn gestures and imports them elsewhere as a layer', async () => {
    quiet();
    const mine = await setup({ modules: [fakeEffects(), fakeStorage()] });
    await expect(ask(mine.kernel, 'packs.export', { gestures: true })).rejects.toMatchObject({ code: 'invalid-payload' });
    await ask(mine.kernel, 'spellbook.override.set', { spellId: 'accio', gesture: { path: S } });
    await ask(mine.kernel, 'spellbook.override.set', { spellId: 'stupefy', gesture: { flick: 'up' } });
    const file = await ask(mine.kernel, 'packs.export', { gestures: true });
    const pack = JSON.parse(file.text) as GesturePack;
    expect(file.filename).toBe(`${pack.id}.json`);
    expect(pack).toMatchObject({ schema: 'gesturepack/1', version: '1.0.0' });
    expect(pack.id).toMatch(/^gestures-\d{8}-[a-z0-9]{4}$/);
    expect(Object.keys(pack.gestures)).toEqual(['accio', 'stupefy']);
    expect(pack.gestures.stupefy).toEqual({ flick: 'up' });

    const friend = await setup({ modules: [fakeEffects(), fakeStorage()] });
    const result = await ask(friend.kernel, 'packs.import', { text: file.text });
    expect(result).toEqual({ id: pack.id, kind: 'gesturepack', warnings: [] });
    const book = friend.kernel.packs.spellbook();
    expect(entry(book, 'accio')).toMatchObject({ gestureSource: pack.id, overridden: false });
    expect(entry(book, 'accio').templates[0][0]).toEqual(S[0]);
    expect(entry(book, 'stupefy').spell.gesture).toEqual({ flick: 'up' });
    expect(await exportedJson(friend.kernel, pack.id)).toEqual(pack);

    // The friend's own drawing wins over the layer; turning the layer off restores the pack gesture.
    await ask(friend.kernel, 'spellbook.override.set', { spellId: 'accio', gesture: { path: W } });
    expect(entry(friend.kernel.packs.spellbook(), 'accio').gestureSource).toBe('override');
    await ask(friend.kernel, 'spellbook.override.clear', { spellId: 'accio' });
    await ask(friend.kernel, 'packs.enable', { id: pack.id, enabled: false });
    expect(entry(friend.kernel.packs.spellbook(), 'accio').gestureSource).toBe('pack');
    expect(entry(friend.kernel.packs.spellbook(), 'stupefy').spell.gesture).toEqual({ flick: 'right' });
  });

  it('puts the newest enabled layer first, and warns about gestures for spells it does not know', async () => {
    quiet();
    const { kernel } = await setup({ modules: [fakeEffects(), fakeStorage()] });
    const layer = (id: string, gestures: GesturePack['gestures']): string => JSON.stringify({ schema: 'gesturepack/1', id, version: '1.0.0', title: id, gestures });
    await ask(kernel, 'packs.import', { text: layer('older', { accio: { path: S }, nox: { flick: 'left' } }) });
    await new Promise((r) => setTimeout(r, 5));
    const result = await ask(kernel, 'packs.import', { text: layer('newer', { accio: { path: W }, 'no-such-spell': { flick: 'up' } }) });
    expect(result.warnings).toEqual(['Some gestures are for spells that are not loaded: no-such-spell.']);
    const book = kernel.packs.spellbook();
    expect(entry(book, 'accio').gestureSource).toBe('newer');
    expect(entry(book, 'nox').gestureSource).toBe('older');
    // Path gestures from a layer keep the pack gesture's hint parts.
    expect((entry(book, 'accio').spell.gesture as { parts?: unknown[] }).parts).toHaveLength(1);
    await ask(kernel, 'packs.remove', { id: 'newer' });
    expect(entry(kernel.packs.spellbook(), 'accio').gestureSource).toBe('older');
  });

  it('applies the left-handed mirror to layers too', async () => {
    quiet();
    const { kernel } = await setup({ modules: [fakeEffects(), fakeStorage()], settings: { 'access.leftHanded': true } });
    await ask(kernel, 'packs.import', { text: JSON.stringify({ schema: 'gesturepack/1', id: 'mine', version: '1.0.0', title: 'Mine', gestures: { accio: { path: S }, nox: { flick: 'left' } } }) });
    const book = kernel.packs.spellbook();
    expect(entry(book, 'accio').templates[0][0][0]).toBeCloseTo(1 - S[0][0], 10);
    expect(entry(book, 'nox').spell.gesture).toEqual({ flick: 'right' });
  });
});

describe('reload', () => {
  it('reloads everything on packs.reload and never rejects', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    storage.data.get('packs')!.set('house-charms', { dataVersion: 1, id: 'house-charms', json: housePack(), importedAt: 1 });
    const book = await ask(kernel, 'packs.reload');
    expect(book.packs.at(-1)?.id).toBe('house-charms');
    storage.failing = true;
    const still = await ask(kernel, 'packs.reload');
    expect(still.spells.length).toBeGreaterThan(0);
  });

  it('lists a stored pack that no longer loads, with the reason, so it can be removed', async () => {
    quiet();
    const storage = fakeStorage({ packs: { broken: { dataVersion: 1, id: 'broken', json: { schema: 'spellpack/1', id: 'broken' }, importedAt: 1 } } });
    const { kernel } = await setup({ modules: [fakeEffects(), storage] });
    const broken = kernel.packs.spellbook().packs.find((p) => p.id === 'broken');
    expect(broken).toMatchObject({ user: true, error: expect.stringMatching(/is missing "version"/) });
    await ask(kernel, 'packs.remove', { id: 'broken' });
    expect(storage.data.get('packs')!.size).toBe(0);
  });

  it('picks up packs another writer stored (a data import)', async () => {
    quiet();
    const storage = fakeStorage();
    const { kernel, of } = await setup({ modules: [fakeEffects(), storage] });
    storage.external('packs', 'house-charms', { dataVersion: 1, id: 'house-charms', json: housePack(), importedAt: 2 });
    await settle();
    expect(kernel.packs.spellbook().packs.at(-1)?.id).toBe('house-charms');
    expect(of<PackLoaded>('pack.loaded').at(-1)).toMatchObject({ id: 'house-charms', user: true });
  });
});
