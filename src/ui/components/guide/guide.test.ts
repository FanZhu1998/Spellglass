import { describe, expect, it } from 'vitest';
import type { Spell, Spellbook, SpellbookEntry, SpellbookPack } from '../../../contracts';
import type { LogEntry } from '../../app-state.svelte';
import { HINT_MAX, gestureHint, guideGroups, lockedCount, markFor, moreLine, shortHint, statusWords } from './guide';

function spell(id: string, incantation: string, extra: Partial<Spell> = {}): Spell {
  return { id, incantation, gesture: { flick: 'up' }, effect: { steps: [] }, ...extra };
}

function entry(s: Spell, extra: Partial<SpellbookEntry> = {}): SpellbookEntry {
  return {
    spell: s, packId: 'core-charms', packTitle: 'Core charms', available: true, status: 'open', enabled: true,
    overridden: false, gestureSource: 'pack', gestureKey: 'k', mirrored: false, templates: [], lasts: null,
    skippedSteps: [], accepted: 0, ...extra,
  };
}

function pack(id: string, title: string, extra: Partial<SpellbookPack> = {}): SpellbookPack {
  return { id, kind: 'spellpack', title, version: '1.0.0', enabled: true, user: false, unmet: [], ...extra };
}

const lumos = entry(spell('lumos', 'Lumos', { gesture_text: 'Flick straight up.' }), { accepted: 1 });
const nox = entry(spell('nox', 'Nox', { gesture: { flick: 'down' }, gesture_text: 'Flick straight down.', needs_active: ['lumos'] }));
const leviosa = entry(
  spell('wingardium-leviosa', 'Wingardium Leviosa', {
    gesture: { path: [[0.1, 0.8], [0.5, 0.1], [0.9, 0.8]] },
    gesture_text: 'Arc over from left to right, then drop straight down: "swish and flick".',
  }),
  { status: 'learned', accepted: 3 },
);
const alohomora = entry(spell('alohomora', 'Alohomora', { tier: 2 }), { status: 'locked', enabled: false });
const accio = entry(spell('accio', 'Accio', { tier: 2 }), { status: 'locked', enabled: false });
const finite = entry(spell('finite-incantatem', 'Finite Incantatem', { gesture: { flick: 'left' } }), { packId: 'further-spells', packTitle: 'Further spells' });
const reducto = entry(spell('reducto', 'Reducto', { tier: 5 }), { packId: 'further-spells', packTitle: 'Further spells', status: 'locked', enabled: false });
// A pack that is off: its spells are listed by the Spellbook as unavailable, never as castable.
const crucio = entry(spell('crucio', 'Crucio', { tier: 7 }), { packId: 'restricted-section', packTitle: 'Restricted section', available: false, enabled: false });

function book(spells: SpellbookEntry[], packs?: SpellbookPack[]): Spellbook {
  return {
    revision: 1,
    packs: packs ?? [
      pack('core-charms', 'Core charms'),
      pack('further-spells', 'Further spells'),
      pack('restricted-section', 'Restricted section', { enabled: false }),
      pack('theme-candlelit', 'Candlelit', { kind: 'themepack' }),
    ],
    spells,
    theme: null,
    unlockedTier: 1,
    learnAfter: 3,
  };
}

const full = book([lumos, nox, leviosa, alohomora, accio, finite, reducto, crucio]);

describe('the spell guide: which spells it lists', () => {
  it('lists the spells that can be cast now, open and learned, in the book’s order and by pack', () => {
    const groups = guideGroups(full);
    expect(groups.map((g) => g.pack.id)).toEqual(['core-charms', 'further-spells']);
    expect(groups[0].entries.map((e) => e.spell.id)).toEqual(['lumos', 'nox', 'wingardium-leviosa']);
    expect(groups[1].entries.map((e) => e.spell.id)).toEqual(['finite-incantatem']);
  });

  it('leaves out locked spells, spells of a pack that is off, and packs with nothing to cast', () => {
    const ids = guideGroups(full).flatMap((g) => g.entries.map((e) => e.spell.id));
    expect(ids).not.toContain('alohomora');
    expect(ids).not.toContain('crucio');
    expect(guideGroups(book([lumos, alohomora])).map((g) => g.pack.id)).toEqual(['core-charms']);
    expect(guideGroups(null)).toEqual([]);
  });

  it('lists every available spell when every spell is open (nothing is locked then)', () => {
    // With 'spells.unlockAll' the pack service gives no spell the locked status.
    const open = book([lumos, { ...alohomora, status: 'open', enabled: true }, { ...accio, status: 'open', enabled: true }, crucio]);
    expect(guideGroups(open).flatMap((g) => g.entries.map((e) => e.spell.id))).toEqual(['lumos', 'alohomora', 'accio']);
    expect(lockedCount(open)).toBe(0);
  });

  it('says in one quiet line how many more open as the player learns these', () => {
    expect(lockedCount(full)).toBe(3);
    expect(moreLine(3)).toBe('3 more spells open as you learn these.');
    expect(moreLine(1)).toBe('1 more spell opens as you learn these.');
    expect(moreLine(0)).toBe('');
  });
});

describe('the spell guide: how it describes a spell', () => {
  it('gives the gesture in the pack’s words, set like the book', () => {
    expect(gestureHint(lumos)).toBe('Flick straight up.');
    expect(gestureHint(leviosa)).toBe('Arc over from left to right, then drop straight down: “swish and flick”.');
  });

  it('words a mirrored gesture for the left hand', () => {
    // A mirrored flick is described by its direction; a path by the pack's mirrored words.
    const left = entry(spell('stupefy', 'Stupefy', { gesture: { flick: 'left' }, gesture_text: 'Flick left to right.' }), { mirrored: true });
    expect(gestureHint(left)).toBe('Flick right to left.');
    const path = entry(spell('accio', 'Accio', { gesture: { path: [[0, 0], [1, 1]] }, gesture_text: 'A "C".', gesture_text_mirrored: 'A backward "C".' }), { mirrored: true });
    expect(gestureHint(path)).toBe('A backward “C”.');
    expect(gestureHint(entry(spell('x', 'X', { gesture: { flick: 'right' } })))).toBe('Flick left to right.');
  });

  it('shortens a long hint at a word', () => {
    const long = 'Trace a long loop around the left side, come back over the top, then sweep down and across to finish low on the right.';
    const short = shortHint(long);
    expect(short.length).toBeLessThanOrEqual(HINT_MAX);
    expect(short.endsWith('…')).toBe(true);
    expect(long.startsWith(short.slice(0, -1))).toBe(true);
    expect(short).not.toMatch(/[\s,]…$/);
    expect(shortHint('  Flick   straight up.  ')).toBe('Flick straight up.');
    // The seed packs' longest gesture text fits whole.
    expect(shortHint('A triangle from the lower right: up to the point, down, then back along the base.')).not.toContain('…');
  });

  it('shows progress toward learning, or that it is learned', () => {
    expect(statusWords(lumos, 3)).toBe('1 of 3');
    expect(statusWords(leviosa, 3)).toBe('Learned');
  });
});

describe('the spell guide: what a result marks', () => {
  const log = (e: Partial<LogEntry>): LogEntry => ({ id: 'e1', kind: 'cast', t: 0, name: 'Lumos', grade: 'Outstanding', quality: 0.9, ...e });

  it('lights the card of the spell cast', () => {
    expect(markFor(log({ spellId: 'lumos' }))).toEqual({ id: 'e1', spellId: 'lumos', kind: 'cast', text: 'Cast' });
  });

  it('marks the spell a fizzle came close to, and a right shape that a rule stopped', () => {
    expect(markFor(log({ kind: 'fizzle', spellId: 'alohomora', grade: 'Poor' }))).toMatchObject({ spellId: 'alohomora', kind: 'close', text: 'Close' });
    // The shell gives fizzles a rule caused no grade (Nox without Lumos, a cooldown).
    expect(markFor(log({ kind: 'fizzle', spellId: 'nox', grade: '' }))).toMatchObject({ spellId: 'nox', kind: 'blocked', text: 'Right shape' });
  });

  it('marks nothing for a replay or a fizzle close to no spell', () => {
    expect(markFor(log({ spellId: 'lumos', replay: true }))).toBeNull();
    expect(markFor(log({ kind: 'fizzle', grade: 'Troll' }))).toBeNull();
    expect(markFor(null)).toBeNull();
  });
});
