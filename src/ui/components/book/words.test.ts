import { describe, expect, it } from 'vitest';
import type { PracticeAttempt, Spell, Spellbook, SpellbookEntry } from '../../../contracts';
import {
  activeWord, basisText, describeAttempt, endsLine, interactionLines, joinNames, lastsLine, lockedReason, needsLine,
  practiceBlock, progressText, secondsText, stillToLearn, tierWords, typeset,
} from './words';

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

const lumos = entry(
  spell('lumos', 'Lumos', {
    effect: { steps: [{ use: 'light.orb', hold: true }, { use: 'scene.dim', hold: true }, { use: 'audio.cue' }] },
    ended_by: ['nox', 'finite-incantatem'], tier: 1,
  }),
  { lasts: 'until-ended', status: 'learned', accepted: 3 },
);
const nox = entry(spell('nox', 'Nox', { needs_active: ['lumos'], ends: ['lumos'], effect: { steps: [{ use: 'light.snuff' }] }, tier: 1 }));
const incendio = entry(
  spell('incendio', 'Incendio', { effect: { steps: [{ use: 'prop.ignite', hold: true }] }, ended_by: ['aguamenti', 'finite-incantatem'], tier: 3 }),
  { lasts: 'until-ended', status: 'locked', enabled: false },
);
const aguamenti = entry(spell('aguamenti', 'Aguamenti', { ends: ['incendio'], tier: 3 }), { status: 'locked', enabled: false });
const protego = entry(spell('protego', 'Protego', { ended_by: ['finite-incantatem'], duration_ms: 5000, tier: 2 }), { lasts: 5000, status: 'locked', enabled: false });
const finite = entry(spell('finite-incantatem', 'Finite Incantatem', { ends: ['*'], tier: 5 }), { packId: 'further-spells', status: 'locked', enabled: false });
const leviosa = entry(spell('wingardium-leviosa', 'Wingardium Leviosa', { tier: 1 }), { accepted: 1 });

const all = [lumos, nox, leviosa, protego, incendio, aguamenti, finite];
const byId = new Map(all.map((e) => [e.spell.id, e]));
const entryOf = (id: string) => byId.get(id) ?? null;
const nameOf = (id: string) => byId.get(id)?.spell.incantation ?? id;

const book: Spellbook = { revision: 1, packs: [], spells: all, theme: null, unlockedTier: 1, learnAfter: 3 };

describe('spellbook words', () => {
  it('counts progress toward learning', () => {
    expect(progressText(2, 3)).toBe('2 of 3');
    expect(progressText(7, 3)).toBe('3 of 3');
    expect(progressText(0, 0)).toBe('0 of 1');
  });

  it('sets quotes like a book', () => {
    expect(typeset('Then drop straight down: "swish and flick".')).toBe('Then drop straight down: “swish and flick”.');
    expect(typeset("The dummy's wand spins away.")).toBe('The dummy’s wand spins away.');
    expect(typeset('A "C": from upper right')).toBe('A “C”: from upper right');
    expect(typeset(undefined)).toBe('');
  });

  it('joins names', () => {
    expect(joinNames(['Lumos'])).toBe('Lumos');
    expect(joinNames(['Nox', 'Finite Incantatem'], 'or')).toBe('Nox or Finite Incantatem');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
  });

  it('names the basis plainly', () => {
    expect(basisText('park')).toEqual({ label: 'Park', text: 'follows a shape used at a Universal park.' });
    expect(basisText(undefined)).toBeNull();
  });

  it('describes how spells work together', () => {
    expect(activeWord(lumos)).toBe('lit');
    expect(activeWord(incendio)).toBe('burning');
    expect(activeWord(protego)).toBe('active');
    expect(needsLine(nox.spell, nameOf, entryOf)).toBe('Needs Lumos lit first.');
    expect(endsLine(nox.spell, nameOf, entryOf)).toBe('Puts out Lumos.');
    expect(endsLine(aguamenti.spell, nameOf, entryOf)).toBe('Puts out Incendio.');
    expect(endsLine(finite.spell, nameOf, entryOf)).toBe('Ends every spell that is active.');
    expect(lastsLine(lumos, nameOf)).toBe('Stays lit until Nox or Finite Incantatem puts it out.');
    expect(lastsLine(incendio, nameOf)).toBe('Burns until Aguamenti or Finite Incantatem puts it out.');
    expect(lastsLine(protego, nameOf)).toBe('Lasts five seconds, or until Finite Incantatem ends it.');
    expect(lastsLine(leviosa, nameOf)).toBeNull();
    expect(interactionLines(nox, nameOf, entryOf)).toEqual(['Needs Lumos lit first.', 'Puts out Lumos.']);
  });

  it('writes durations in words', () => {
    expect(secondsText(1000)).toBe('one second');
    expect(secondsText(8000)).toBe('eight seconds');
    expect(secondsText(2500)).toBe('2.5 seconds');
    expect(secondsText(30000)).toBe('30 seconds');
  });

  it('says what opens a locked spell', () => {
    expect(tierWords([1])).toBe('tier 1');
    expect(tierWords([2, 1])).toBe('tiers 1 and 2');
    expect(tierWords([1, 2, 3, 4])).toBe('tiers 1 to 4');
    expect(lockedReason(protego, book)).toBe('Learn the spells of tier 1 first, or open every spell in the Workshop.');
    expect(lockedReason(incendio, book)).toBe('Learn the spells of tiers 1 and 2 first, or open every spell in the Workshop.');
    expect(practiceBlock(nox, book)).toBeNull();
    expect(practiceBlock(protego, book)).toMatch(/^Learn the spells of tier 1/);
    expect(practiceBlock(entry(spell('x', 'X'), { available: false, unavailableReason: 'Needs sound, which is not available here.' }), book)).toBe(
      'Needs sound, which is not available here.',
    );
    expect(stillToLearn(book).map((e) => e.spell.id)).toEqual(['nox', 'wingardium-leviosa']);
  });
});

describe('practice words', () => {
  const ctx = {
    grade: (q: number, kind: 'cast' | 'fizzle') => (kind === 'cast' ? (q >= 0.9 ? 'Outstanding' : 'Acceptable') : 'Poor'),
    nameOf,
    entryOf,
  };
  const base: PracticeAttempt = { spellId: 'nox', attempt: 1, success: true, score: 0.9, quality: 0.95 };

  it('shows a clean cast as holding', () => {
    expect(describeAttempt({ ...base, castSpellId: 'nox' }, ctx)).toEqual({ kind: 'cast', grade: 'Outstanding', detail: 'The spell holds.' });
  });

  it('gives the one hint of an accepted cast', () => {
    const v = describeAttempt({ ...base, quality: 0.7, castSpellId: 'nox', hint: 'The downstroke stopped short: carry it through the circle.' }, ctx);
    expect(`${v.grade}. ${v.detail}`).toBe('Acceptable. The downstroke stopped short: carry it through the circle.');
  });

  it('says plainly when a rule blocked a correct gesture', () => {
    const v = describeAttempt({ ...base, blockedBy: 'needs-active', hint: 'Cast Lumos first.' }, ctx);
    expect(v.kind).toBe('blocked');
    expect(`${v.grade}. ${v.detail}`).toBe('Outstanding. Nox needs Lumos lit first.');
    expect(describeAttempt({ ...base, blockedBy: 'cooldown' }, ctx).detail).toBe('Nox needs a moment before it can be cast again.');
    expect(describeAttempt({ ...base, blockedBy: 'strict-mismatch', hint: 'Say the incantation as you trace.' }, ctx).detail).toBe(
      'Say the incantation as you trace.',
    );
  });

  it('names the spell that was cast instead', () => {
    const v = describeAttempt({ ...base, success: false, quality: 0.62, castSpellId: 'lumos', hint: 'Flick straight down.' }, ctx);
    expect(v).toEqual({ kind: 'miss', grade: 'Poor', detail: 'Lumos was cast instead. Flick straight down.' });
  });

  it('falls back to a general hint', () => {
    expect(describeAttempt({ ...base, success: false, quality: 0.3 }, ctx).detail).toBe('Trace the shape more closely to the guide.');
  });
});
