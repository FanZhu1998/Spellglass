// Legacy packs (Section 13): a pack from every old schema version still loads. The fixture is in the
// pre-release spellpack/0 format (contracts/packs.ts SpellPackV0); it must migrate to exactly the
// expected spellpack/1 shape and then load like any other pack, without its stored form changing.

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { PackLoaded, SpellPackV0, UserPack } from '../../src/contracts';
import { ask } from '../../src/kernel';
import { checkPack } from '../../src/kernel/packs/check';
import { migrateForward, migrateSpellPack0To1 } from '../../src/kernel/packs/migrate';
import { checkSchema } from '../../src/kernel/packs/validate';
import { fakeEffects, fakeStorage, indexFor, setup } from './helpers';

const FIXTURES = new URL('../fixtures/packs/legacy/', import.meta.url);
const text = (name: string) => readFileSync(new URL(name, FIXTURES), 'utf8');
const LEGACY = text('spellpack-0.json');
const EXPECTED = JSON.parse(text('spellpack-0.migrated.json'));

describe('spellpack/0', () => {
  it('is valid in its own schema and migrates to exactly the expected spellpack/1 shape', () => {
    const v0 = JSON.parse(LEGACY) as SpellPackV0;
    expect(checkSchema('spellpack/0', v0)).toEqual({ ok: true });
    const migrated = migrateSpellPack0To1(v0);
    expect(migrated).toEqual(EXPECTED);
    expect(checkSchema('spellpack/1', migrated)).toEqual({ ok: true });
    // Migration is pure: the input is untouched.
    expect(v0).toEqual(JSON.parse(LEGACY));
    expect(migrateForward(v0, 'spellpack/0')).toEqual({ pack: EXPECTED, schema: 'spellpack/1', path: ['spellpack/0', 'spellpack/1'] });
  });

  it('goes through checkPack and says where it came from', () => {
    const checked = checkPack(JSON.parse(LEGACY));
    expect(checked).toMatchObject({ ok: true, kind: 'spellpack', migratedFrom: 'spellpack/0' });
  });

  it('loads from the index like a current pack', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const files = new Map<string, string>([
      ['early/pack.json', LEGACY],
      ['index.json', indexFor([{ id: 'early-charms', kind: 'spellpack', version: '0.3.0', path: 'early/pack.json', body: LEGACY }])],
    ]);
    const { kernel, of } = await setup({ files });
    expect(of<PackLoaded>('pack.loaded')).toEqual([{ id: 'early-charms', kind: 'spellpack', version: '0.3.0', unmet: [], skippedSteps: 0, user: false }]);
    const book = kernel.packs.spellbook();
    expect(book.packs[0]).toMatchObject({ id: 'early-charms', title: 'Early charms', enabled: true });
    expect(book.spells.map((e) => [e.spell.id, e.spell.incantation, e.status])).toEqual([
      ['lumos', 'Lumos', 'open'],
      ['nox', 'Nox', 'open'],
      ['alohomora', 'Alohomora', 'locked'],
    ]);
    expect(book.spells[2].templates[0]).toHaveLength(64);
    expect(book.spells[2].spell.hint).toBe('Circle, then down through it.');
    expect(book.spells[0].lasts).toBe('until-ended');
  });

  it('imports, is stored exactly as imported, and exports in the current format', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const storage = fakeStorage();
    const { kernel } = await setup({ indexUrl: null, modules: [fakeEffects(), storage] });
    const result = await ask(kernel, 'packs.import', { text: LEGACY, filename: 'early.json' });
    expect(result).toEqual({ id: 'early-charms', kind: 'spellpack', warnings: [] });
    const stored = storage.data.get('packs')!.get('early-charms') as UserPack;
    expect(stored.json).toEqual(JSON.parse(LEGACY));
    expect(stored).toMatchObject({ dataVersion: 1, id: 'early-charms', importedAt: expect.any(Number) });
    const exported = await ask(kernel, 'packs.export', { id: 'early-charms' });
    expect(exported.filename).toBe('early-charms.json');
    expect(JSON.parse(exported.text)).toEqual(EXPECTED);

    // A fresh start migrates the stored v0 record again; the record itself never changes.
    const again = await setup({ indexUrl: null, modules: [fakeEffects(), fakeStorage({ packs: { 'early-charms': stored } })] });
    expect(again.kernel.packs.spellbook().spells.map((e) => e.spell.id)).toEqual(['lumos', 'nox', 'alohomora']);
    expect(again.kernel.packs.spellbook().packs[0]).toMatchObject({ user: true, version: '0.3.0' });
  });
});
