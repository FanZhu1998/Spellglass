// Loading packs from the index (Section 9.3): hashes, size limit, schema checks, engine range,
// unknown steps, unmet needs, and failures that skip one pack while the rest load (Section 7.9).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PackFailed, PackLoaded, Spellbook } from '../../src/contracts';
import { ENGINE_VERSION, PACK_SIZE_LIMIT_BYTES } from '../../src/contracts';
import { ask } from '../../src/kernel';
import { ALL_CAPABILITIES, ALL_EFFECTS, BASE, bytes, fakeEffects, fileText, indexFor, INDEX_URL, setup, shippedFiles, shippedJson } from './helpers';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
};

function spell(book: Spellbook, id: string) {
  const e = book.spells.find((s) => s.spell.id === id);
  if (!e) throw new Error(`no spell ${id}`);
  return e;
}

describe('loading the shipped packs', () => {
  it('loads every pack in the index and publishes pack.loaded in index order, then the spellbook', async () => {
    quiet();
    const { kernel, events, of } = await setup();
    const loadedIds = of<PackLoaded>('pack.loaded').map((p) => p.id);
    expect(loadedIds).toEqual(['core-charms', 'further-spells', 'restricted-section', 'candlelit']);
    expect(of<PackFailed>('pack.failed')).toEqual([]);
    const types = events.map((e) => e.type);
    expect(types.lastIndexOf('pack.loaded')).toBeLessThan(types.indexOf('spellbook.changed'));

    const book = kernel.packs.spellbook();
    expect(book).toBe(kernel.last<Spellbook>('spellbook.changed')?.payload);
    expect(book.spells).toHaveLength(27);
    expect(book.packs.map((p) => [p.id, p.kind, p.enabled])).toEqual([
      ['core-charms', 'spellpack', true],
      ['further-spells', 'spellpack', true],
      ['restricted-section', 'spellpack', false],
      ['candlelit', 'themepack', true],
    ]);
    expect(book.theme?.id).toBe('candlelit');
    expect(book.indexError).toBeUndefined();
    expect(await ask(kernel, 'spellbook.get')).toBe(book);
    // The shipped packs are clean: nothing failed, nothing was dropped or skipped.
    expect(book.packs.filter((p) => p.error || p.warnings || p.unmet.length)).toEqual([]);
    expect(book.spells.filter((e) => e.skippedSteps.length)).toEqual([]);
    expect(new Set(book.spells.map((e) => e.spell.id)).size).toBe(27);
  });

  it('builds entries: templates, lasts, availability, tiers', async () => {
    quiet();
    const { kernel } = await setup();
    const book = kernel.packs.spellbook();

    const lumos = spell(book, 'lumos');
    expect(lumos.templates).toEqual([]); // flicks have no templates
    expect(lumos.lasts).toBe('until-ended');
    expect(lumos.status).toBe('open');
    expect(lumos.enabled).toBe(true);
    expect(lumos.gestureSource).toBe('pack');
    expect(lumos.overridden).toBe(false);
    expect(lumos.mirrored).toBe(false);

    const alohomora = spell(book, 'alohomora');
    expect(alohomora.templates).toHaveLength(1);
    expect(alohomora.templates[0]).toHaveLength(64);
    // Unit-square coordinates, not centred: the path starts at the top of the circle.
    expect(alohomora.templates[0][0]).toEqual([0.5, 0.05]);
    expect(alohomora.templates[0][63]).toEqual([0.5, 1]);
    expect(alohomora.status).toBe('locked'); // tier 2, and only tier 1 is open
    expect(alohomora.enabled).toBe(false);
    expect(alohomora.available).toBe(true);

    expect(spell(book, 'protego').lasts).toBe(5000);
    expect(spell(book, 'stupefy').lasts).toBeNull();
    expect(spell(book, 'incendio').lasts).toBe('until-ended');

    const imperio = spell(book, 'imperio');
    expect(imperio.available).toBe(false);
    expect(imperio.unavailableReason).toBe('Restricted section is turned off.');
    expect(book.unlockedTier).toBe(1);
    expect(book.learnAfter).toBe(3);
  });
});

describe('a pack that fails is skipped and the others load', () => {
  it('refuses a pack whose bytes do not match the hash in the index', async () => {
    quiet();
    const files = shippedFiles();
    const original = fileText(files, 'further-spells/pack.json');
    files.set('further-spells/pack.json', original.replace('"Reducto"', '"Reductoo"'));
    const { kernel, of } = await setup({ files });
    const failed = of<PackFailed>('pack.failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ id: 'further-spells', path: 'further-spells/pack.json' });
    expect(failed[0].reason).toMatch(/hash/);
    expect(of<PackLoaded>('pack.loaded').map((p) => p.id)).toEqual(['core-charms', 'restricted-section', 'candlelit']);
    const book = kernel.packs.spellbook();
    expect(book.packs.find((p) => p.id === 'further-spells')?.error).toMatch(/hash/);
    expect(book.spells.some((e) => e.packId === 'further-spells')).toBe(false);
    expect(book.spells.filter((e) => e.packId === 'core-charms')).toHaveLength(12);
  });

  it('refuses a pack over the size limit, even when its hash matches', async () => {
    quiet();
    const files = shippedFiles();
    const pack = shippedJson('core-charms/pack.json');
    const big = JSON.stringify({ ...pack, padding: 'x'.repeat(PACK_SIZE_LIMIT_BYTES) });
    files.set('core-charms/pack.json', big);
    files.set('index.json', indexFor([
      { id: 'core-charms', kind: 'spellpack', path: 'core-charms/pack.json', body: big },
      { id: 'candlelit', kind: 'themepack', path: 'theme-candlelit/pack.json', body: files.get('theme-candlelit/pack.json')! },
    ]));
    const { kernel, of } = await setup({ files });
    expect(of<PackFailed>('pack.failed')[0]).toMatchObject({ id: 'core-charms' });
    expect(of<PackFailed>('pack.failed')[0].reason).toMatch(/at most 512 KB/);
    expect(kernel.packs.spellbook().theme?.id).toBe('candlelit');
  });

  it('turns an unreadable index into pack.failed "index" and Spellbook.indexError, and still resolves', async () => {
    quiet();
    const files = shippedFiles();
    files.delete('index.json');
    const { kernel, of } = await setup({ files });
    expect(of<PackFailed>('pack.failed')).toEqual([{ id: 'index', path: INDEX_URL, reason: expect.stringMatching(/pack index could not be read/) }]);
    const book = kernel.packs.spellbook();
    expect(book.indexError).toMatch(/404/);
    expect(book.spells).toEqual([]);
    expect(book.revision).toBe(1);
  });

  it('turns an index that is not JSON, or in another format, into an index error', async () => {
    quiet();
    const files = shippedFiles();
    files.set('index.json', '{ not json');
    expect((await setup({ files })).kernel.packs.spellbook().indexError).toMatch(/not valid JSON/);
    files.set('index.json', JSON.stringify({ schema: 'packindex/2', packs: [] }));
    expect((await setup({ files })).kernel.packs.spellbook().indexError).toMatch(/packindex\/1 format \(packindex\/2\)/);
  });

  it('checks index entries one by one', async () => {
    quiet();
    const files = shippedFiles();
    const index = JSON.parse(fileText(files, 'index.json'));
    index.packs[1].sha256 = 'not-a-hash';
    index.packs[2].path = '../outside.json';
    files.set('index.json', JSON.stringify(index));
    const { kernel, of } = await setup({ files });
    const failed = of<PackFailed>('pack.failed');
    expect(failed.map((f) => f.id)).toEqual(['further-spells', 'restricted-section']);
    expect(failed[0].reason).toMatch(/index entry .* sha256 must be a SHA-256 digest/);
    expect(failed[1].reason).toMatch(/path must be a relative path/);
    expect(kernel.packs.spellbook().spells.filter((e) => e.packId === 'core-charms')).toHaveLength(12);
  });

  it('refuses a pack whose engine range this engine does not satisfy', async () => {
    quiet();
    const files = shippedFiles();
    const pack = { ...shippedJson('core-charms/pack.json'), engine: '>=2.0 <3.0' };
    const text = JSON.stringify(pack);
    files.set('core-charms/pack.json', text);
    files.set('index.json', indexFor([{ id: 'core-charms', kind: 'spellpack', path: 'core-charms/pack.json', body: text }]));
    const { kernel, of } = await setup({ files });
    expect(of<PackFailed>('pack.failed')[0].reason).toBe(`This spell pack needs Spellglass engine >=2.0 <3.0; this is ${ENGINE_VERSION}.`);
    expect(kernel.packs.spellbook().spells).toEqual([]);
  });

  it('refuses a file of the wrong kind, or with another id, or invalid for its schema', async () => {
    quiet();
    const files = shippedFiles();
    const bad = JSON.stringify({ ...shippedJson('core-charms/pack.json'), title: '' });
    files.set('bad/pack.json', bad);
    files.set('index.json', indexFor([
      { id: 'candlelit', kind: 'spellpack', path: 'theme-candlelit/pack.json', body: files.get('theme-candlelit/pack.json')! },
      { id: 'other-id', kind: 'spellpack', path: 'further-spells/pack.json', body: files.get('further-spells/pack.json')! },
      { id: 'core-charms', kind: 'spellpack', path: 'bad/pack.json', body: bad },
    ]));
    const { of } = await setup({ files });
    const reasons = of<PackFailed>('pack.failed').map((f) => f.reason);
    expect(reasons[0]).toBe('The index lists it as a spell pack, but the file is a theme pack.');
    expect(reasons[1]).toBe('The index lists it as "other-id", but the file\'s id is "further-spells".');
    expect(reasons[2]).toBe('The spell pack does not match the spellpack/1 format: title must not be empty.');
  });

  it('says why when pack hashes cannot be checked on plain http', async () => {
    quiet();
    vi.stubGlobal('crypto', {});
    const { kernel } = await setup();
    const error = kernel.packs.spellbook().packs[0].error;
    expect(error).toMatch(/not served over https/);
  });
});

describe('effect steps and capabilities', () => {
  it('skips steps no module implements, keeps the fallback, and computes lasts from the original steps', async () => {
    quiet();
    const { kernel, of } = await setup({ modules: [fakeEffects(ALL_EFFECTS.filter((u) => u !== 'scene.dim' && u !== 'light.orb'))] });
    const book = kernel.packs.spellbook();
    const lumos = spell(book, 'lumos');
    expect(lumos.spell.effect.steps.map((s) => s.use)).toEqual(['audio.cue']);
    expect(lumos.skippedSteps).toEqual(['light.orb', 'scene.dim']);
    expect(lumos.spell.effect.fallback).toBe('sparkle');
    // Lumos still lasts until ended: the engine's rules never depend on installed effects.
    expect(lumos.lasts).toBe('until-ended');
    // Unknown fields on kept steps survive.
    expect(spell(book, 'nox').spell.effect.steps[0]).toEqual({ use: 'light.snuff', spell: 'lumos', smoke: true });
    const core = of<PackLoaded>('pack.loaded').find((p) => p.id === 'core-charms')!;
    expect(core.skippedSteps).toBeGreaterThanOrEqual(2);
    expect(book.packs[0].warnings?.join(' ')).toMatch(/skipped because nothing here plays them: .*scene\.dim/);
  });

  it('marks spells unavailable, with the reason, when a capability is missing', async () => {
    quiet();
    const { kernel, of } = await setup({ modules: [fakeEffects(ALL_EFFECTS, ALL_CAPABILITIES.filter((c) => c !== 'audio@1'))] });
    const book = kernel.packs.spellbook();
    const lumos = spell(book, 'lumos');
    expect(lumos.available).toBe(false);
    expect(lumos.enabled).toBe(false);
    expect(lumos.unavailableReason).toBe('Needs sound, which is not available here.');
    expect(book.packs[0].unmet).toEqual(['audio@1']);
    expect(of<PackLoaded>('pack.loaded')[0].unmet).toEqual(['audio@1']);
  });

  it('checks spell-level needs too', async () => {
    quiet();
    const files = shippedFiles();
    const pack = shippedJson<{ spells: Record<string, unknown>[] }>('core-charms/pack.json');
    pack.spells[0] = { ...pack.spells[0], needs: ['voice@1', 'fx.light@2'] };
    const text = JSON.stringify(pack);
    files.set('core-charms/pack.json', text);
    files.set('index.json', indexFor([{ id: 'core-charms', kind: 'spellpack', path: 'core-charms/pack.json', body: text }]));
    const { kernel } = await setup({ files });
    const book = kernel.packs.spellbook();
    expect(spell(book, 'lumos').unavailableReason).toBe('Needs voice recognition and light effects (version 2), which are not available here.');
    expect(spell(book, 'nox').available).toBe(true);
  });
});

describe('loading without an index', () => {
  it('loads only the player\'s own packs when indexUrl is null', async () => {
    quiet();
    const { kernel, fetch } = await setup({ indexUrl: null });
    expect(fetch.requests).toEqual([]);
    expect(kernel.packs.spellbook().packs).toEqual([]);
    expect(kernel.packs.spellbook().indexError).toBeUndefined();
  });

  it('resolves pack paths against the index URL', async () => {
    quiet();
    const { fetch } = await setup();
    expect(fetch.requests).toContain(`${BASE}core-charms/pack.json`);
    expect(fetch.requests).toContain(`${BASE}theme-candlelit/pack.json`);
  });

  it('decodes text strictly and reports bytes that are not UTF-8', async () => {
    quiet();
    const files = shippedFiles();
    const broken = new Uint8Array([...bytes('{"schema":"spellpack/1","title":"'), 0xff, 0xfe, ...bytes('"}')]);
    files.set('core-charms/pack.json', broken);
    files.set('index.json', indexFor([{ id: 'core-charms', kind: 'spellpack', path: 'core-charms/pack.json', body: broken }]));
    const { of } = await setup({ files });
    expect(of<PackFailed>('pack.failed')[0].reason).toBe('The pack file is not UTF-8 text.');
  });
});
