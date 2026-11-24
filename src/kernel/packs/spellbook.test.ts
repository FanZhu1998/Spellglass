import { describe, expect, it } from 'vitest';
import type { GestureOverride, Spell, SpellPack } from '../../contracts';
import { buildSpellbook, isHigherVersion, needsSentence, packEnabled, resolvePacks, spellLasts, type BuildInput } from './spellbook';
import type { LoadedPack } from './types';

const spell = (id: string, extra: Partial<Spell> = {}): Spell => ({
  id, incantation: id[0].toUpperCase() + id.slice(1), gesture: { path: [[0, 0], [1, 1]] }, effect: { steps: [{ use: 'light.orb' }], fallback: 'sparkle' }, ...extra,
});

function pack(id: string, spells: Spell[], extra: Partial<LoadedPack> = {}): LoadedPack {
  const json: SpellPack = { schema: 'spellpack/1', id, version: extra.version ?? '1.0.0', engine: '>=1.0', title: id, needs: [], spells };
  return { id, kind: 'spellpack', version: json.version, title: id, user: false, importedAt: 0, pack: json, warnings: [], defaultEnabled: true, ...extra };
}

function input(extra: Partial<BuildInput> = {}): BuildInput {
  return {
    bundled: [], user: [], overrides: new Map(), progress: new Map(), packsEnabled: {}, unlockAll: false, learnAfter: 3, leftHanded: false,
    themeId: 'candlelit', unmet: () => [], knownEffects: new Set(['light.orb']), unlockedTier: 1, revision: 1, ...extra,
  };
}

describe('spellLasts', () => {
  it('prefers duration_ms, then a held step, else instant', () => {
    expect(spellLasts(spell('a', { duration_ms: 5000, effect: { steps: [{ use: 'light.orb', hold: true }] } }))).toBe(5000);
    expect(spellLasts(spell('a', { effect: { steps: [{ use: 'x.y' }, { use: 'light.orb', hold: true }] } }))).toBe('until-ended');
    expect(spellLasts(spell('a'))).toBeNull();
    expect(spellLasts(spell('a', { duration_ms: 0 }))).toBeNull();
  });
});

describe('precedence', () => {
  it('lets a newer user pack of the same kind shadow a bundled one in its place', () => {
    const bundled = [pack('one', [spell('a')]), pack('two', [spell('b')])];
    const newer = pack('one', [spell('a2')], { user: true, version: '1.2.0', importedAt: 5 });
    const r = resolvePacks(bundled, [newer]);
    expect(r.map((x) => [x.loaded.id, x.loaded.user, x.shadows])).toEqual([['one', true, 'one'], ['two', false, undefined]]);
    const older = pack('one', [spell('a2')], { user: true, version: '0.9.0' });
    const kept = resolvePacks(bundled, [older]);
    expect(kept[0].loaded.user).toBe(false);
    expect(kept[0].warnings[0]).toMatch(/is not used, because the version that ships/);
  });
  it('compares versions numerically', () => {
    expect(isHigherVersion('1.10.0', '1.9.0')).toBe(true);
    expect(isHigherVersion('1.0.0', '1.0.0')).toBe(false);
    expect(isHigherVersion('nonsense', '1.0.0')).toBe(false);
  });
  it('reads packs.enabled by own keys only (a pack may be called constructor)', () => {
    expect(packEnabled(pack('constructor', []), {})).toBe(true);
    expect(packEnabled(pack('x', [], { defaultEnabled: false }), {})).toBe(false);
    expect(packEnabled(pack('x', [], { defaultEnabled: false }), { x: true })).toBe(true);
  });
});

describe('buildSpellbook', () => {
  it('keeps one spell per id, dropping later duplicates within and across packs with warnings', () => {
    const { book } = buildSpellbook(input({ bundled: [pack('one', [spell('a'), spell('a'), spell('b')]), pack('two', [spell('b'), spell('c')])] }));
    expect(book.spells.map((e) => `${e.packId}:${e.spell.id}`)).toEqual(['one:a', 'one:b', 'two:c']);
    expect(book.packs[0].warnings).toEqual(['Spell "a" appears twice in this pack; the second one is not used.']);
    expect(book.packs[1].warnings).toEqual(['Spell "b" is not used, because one also has it and comes first.']);
  });

  it('layers gestures: own drawing, then gesture packs newest first, then the pack', () => {
    const layer = (id: string, at: number, flick: 'left' | 'right'): LoadedPack => ({
      id, kind: 'gesturepack', version: '1.0.0', title: id, user: true, importedAt: at, warnings: [], defaultEnabled: true,
      pack: { schema: 'gesturepack/1', id, version: '1.0.0', title: id, gestures: { a: { flick }, b: { flick } } },
    });
    const own: GestureOverride = { dataVersion: 1, spellId: 'b', gesture: { flick: 'down' }, savedAt: 1 };
    const { book } = buildSpellbook(input({
      bundled: [pack('one', [spell('a'), spell('b'), spell('c')])],
      user: [layer('new', 20, 'right'), layer('old', 10, 'left')],
      overrides: new Map([['b', own]]),
    }));
    expect(book.spells.map((e) => [e.spell.id, e.gestureSource, e.spell.gesture])).toEqual([
      ['a', 'new', { flick: 'right' }],
      ['b', 'override', { flick: 'down' }],
      ['c', 'pack', { path: [[0, 0], [1, 1]] }],
    ]);
  });

  it('computes availability, status and enabled together', () => {
    const { book } = buildSpellbook(input({
      bundled: [pack('one', [spell('a'), spell('b', { tier: 2, needs: ['voice@1'] }), spell('c', { tier: 2 })]), pack('off', [spell('d')], { defaultEnabled: false })],
      unmet: (needs) => needs.filter((n) => n === 'voice@1'),
    }));
    const byId = Object.fromEntries(book.spells.map((e) => [e.spell.id, e]));
    expect(byId.a).toMatchObject({ available: true, status: 'open', enabled: true });
    expect(byId.b).toMatchObject({ available: false, status: 'locked', enabled: false, unavailableReason: 'Needs voice recognition, which is not available here.' });
    expect(byId.c).toMatchObject({ available: true, status: 'locked', enabled: false });
    expect(byId.d).toMatchObject({ available: false, enabled: false, unavailableReason: 'off is turned off.' });
  });

  it('phrases missing capabilities plainly', () => {
    expect(needsSentence(['audio@1'])).toBe('Needs sound, which is not available here.');
    expect(needsSentence(['fx.props@1', 'fx.scene@1', 'audio@1'])).toBe('Needs the prop shelf, scene effects and sound, which are not available here.');
    // One name that is plural takes "are" too.
    expect(needsSentence(['fx.scene@1'])).toBe('Needs scene effects, which are not available here.');
    expect(needsSentence(['fx.light@2'])).toBe('Needs light effects (version 2), which are not available here.');
    // Capabilities Spellglass has no name for are put into words, not shown as ids.
    expect(needsSentence(['fx.weather@1'])).toBe('Needs weather effects, which are not available here.');
    expect(needsSentence(['quantum.glow@3'])).toBe('Needs the quantum glow feature (version 3), which is not available here.');
    expect(needsSentence(['camera.frames@1', 'audio@1'])).toBe('Needs the camera frames feature and sound, which are not available here.');
  });
});

describe('staged unlocking in the spellbook', () => {
  const learned = (spellId: string) => [spellId, { dataVersion: 1, spellId, casts: 3, practiceAttempts: 0, best: 0.8, learnedAt: 5 }] as const;
  const enabledIds = (b: { spells: { enabled: boolean; spell: { id: string } }[] }) => b.spells.filter((e) => e.enabled).map((e) => e.spell.id);

  it('never shows a learned spell as locked, wherever the tier stands', () => {
    // Learned while 'spells.unlockAll' was on, or while its tier was open because another pack was off.
    const { book } = buildSpellbook(input({
      bundled: [pack('one', [spell('a'), spell('b', { tier: 2 }), spell('c', { tier: 2 })])],
      progress: new Map([learned('b')]),
    }));
    const byId = Object.fromEntries(book.spells.map((e) => [e.spell.id, e]));
    expect(book.unlockedTier).toBe(1);
    expect(byId.b).toMatchObject({ status: 'learned', enabled: true });
    expect(byId.c).toMatchObject({ status: 'locked', enabled: false });
  });

  it('passes through tiers with nothing available for this spellbook only, and saves completed tiers', () => {
    const one = pack('one', [spell('a'), spell('b', { tier: 2 })]);
    const two = pack('two', [spell('c', { tier: 3 }), spell('d', { tier: 4 })]);
    // 'one' off: tiers 1 and 2 have nothing available, so this spellbook opens tier 3, but the tier to
    // save stays where it was.
    const off = buildSpellbook(input({ bundled: [one, two], packsEnabled: { one: false } }));
    expect(off.book.unlockedTier).toBe(3);
    expect(enabledIds(off.book)).toEqual(['c']);
    expect(off.storedTier).toBe(1);
    // Turned on again: its stages come back.
    const on = buildSpellbook(input({ bundled: [one, two], unlockedTier: off.storedTier }));
    expect(on.book.unlockedTier).toBe(1);
    expect(enabledIds(on.book)).toEqual(['a']);
    // Learning tier 1 opens and saves tier 2; a tier completed while 'one' is off is shown, not saved.
    expect(buildSpellbook(input({ bundled: [one, two], progress: new Map([learned('a')]) })).storedTier).toBe(2);
    const later = buildSpellbook(input({ bundled: [one, two], packsEnabled: { one: false }, progress: new Map([learned('c')]) }));
    expect(later.book.unlockedTier).toBe(4);
    expect(later.storedTier).toBe(1);
  });
});
