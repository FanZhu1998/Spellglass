// Plain words for the Spellbook and Practice screens (Section 10.5: flavor lives in names,
// instructions stay plain, sentence case). Pure functions over the resolved Spellbook, so the
// sentences are the same wherever a spell is described, and can be tested without a browser.
//
// Spell data comes from packs and is untrusted: these functions only build strings, which the
// screens render as text.

import type { FizzleReason, PracticeAttempt, Spell, Spellbook, SpellbookEntry, SpellStatus } from '../../../contracts';

export type NameOf = (spellId: string) => string;
export type EntryOf = (spellId: string) => SpellbookEntry | null;

/** The word beside a spell in the list (Section 10.3: "learned", "next", "locked"). */
export const STATUS_WORD: Record<SpellStatus, string> = { learned: 'learned', open: 'next', locked: 'locked' };

/** The same status as a phrase for screen readers and the spell's own page. */
export const STATUS_PHRASE: Record<SpellStatus, string> = { learned: 'Learned', open: 'Next to learn', locked: 'Locked' };

/** "2 of 3": accepted casts toward learning, never more than the goal. */
export function progressText(accepted: number, learnAfter: number): string {
  const goal = Math.max(1, Math.floor(learnAfter) || 1);
  const done = Math.max(0, Math.min(goal, Math.floor(accepted) || 0));
  return `${done} of ${goal}`;
}

/** Where a gesture comes from, in plain words (Section 8, "Basis"). */
export function basisText(basis: Spell['basis']): { label: string; text: string } | null {
  switch (basis) {
    case 'story':
      return { label: 'Story', text: 'follows the well-known description in the stories.' };
    case 'park':
      return { label: 'Park', text: 'follows a shape used at a Universal park.' };
    case 'list':
      return { label: 'List', text: 'follows a published wand-motion list.' };
    case 'app':
      return { label: 'App', text: 'designed for this app.' };
    default:
      return null;
  }
}

/** "Lumos", "Lumos and Nox", "Lumos, Nox and Protego" (or with "or"). */
export function joinNames(names: readonly string[], conj: 'and' | 'or' = 'and'): string {
  const list = names.filter((n) => n.length > 0);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} ${conj} ${list[list.length - 1]}`;
}

/** Book typography for pack text: straight quotes become curly ones ("swish and flick" →
 *  “swish and flick”, dummy's → dummy’s). Only characters change; the result is still plain text. */
export function typeset(text: string | undefined | null): string {
  if (!text) return '';
  return text
    .replace(/(^|[\s([{—-])"/g, '$1“')
    .replace(/"/g, '”')
    .replace(/(^|[\s([{—-])'/g, '$1‘')
    .replace(/'/g, '’');
}

/** "finite-incantatem" → "Finite incantatem", for ids that name no loaded spell. */
export function readableId(id: string): string {
  const words = id.replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : id;
}

/** How a spell looks while it is active, from its effect: a held light is "lit", a held fire
 *  "burning", anything else "active". Effect primitives are a fixed set (contracts/effects.ts). */
export function activeWord(entry: SpellbookEntry | null | undefined): 'lit' | 'burning' | 'active' {
  const steps = Array.isArray(entry?.spell.effect?.steps) ? entry.spell.effect.steps : [];
  const held = steps.filter((s) => s.hold === true);
  const look = held.length ? held : steps;
  if (look.some((s) => s.use === 'light.orb')) return 'lit';
  if (look.some((s) => s.use === 'prop.ignite')) return 'burning';
  return 'active';
}

function ids(list: unknown): string[] {
  return Array.isArray(list) ? [...new Set(list.filter((x): x is string => typeof x === 'string' && x.length > 0))] : [];
}

function sameWord(words: readonly string[]): string {
  return words.length && words.every((w) => w === words[0]) ? words[0] : 'active';
}

/** "Needs Lumos lit first." (needs_active: every listed spell must be active). */
export function needsLine(spell: Spell, nameOf: NameOf, entryOf: EntryOf): string | null {
  const need = ids(spell.needs_active);
  if (!need.length) return null;
  const word = sameWord(need.map((id) => activeWord(entryOf(id))));
  return `Needs ${joinNames(need.map(nameOf), 'and')} ${word} first.`;
}

/** "Nox needs Lumos lit first.": why a correct gesture did not cast (practice). */
export function needsSentence(spell: Spell, nameOf: NameOf, entryOf: EntryOf): string | null {
  const need = ids(spell.needs_active);
  if (!need.length) return null;
  const word = sameWord(need.map((id) => activeWord(entryOf(id))));
  return `${spell.incantation} needs ${joinNames(need.map(nameOf), 'and')} ${word} first.`;
}

/** "Puts out Incendio." / "Ends Protego." / "Ends every spell that is active." (ends, '*'). */
export function endsLine(spell: Spell, nameOf: NameOf, entryOf: EntryOf): string | null {
  const ended = ids(spell.ends);
  if (!ended.length) return null;
  if (ended.includes('*')) return 'Ends every spell that is active.';
  const looks = ended.map((id) => activeWord(entryOf(id)));
  const putsOut = looks.every((w) => w === 'lit' || w === 'burning');
  return `${putsOut ? 'Puts out' : 'Ends'} ${joinNames(ended.map(nameOf), 'and')}.`;
}

const SMALL_NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** 5000 → "five seconds", 1000 → "one second", 2500 → "2.5 seconds". */
export function secondsText(ms: number): string {
  const s = Math.round((ms / 1000) * 10) / 10;
  if (Number.isInteger(s) && s >= 0 && s < SMALL_NUMBERS.length) return `${SMALL_NUMBERS[s]} second${s === 1 ? '' : 's'}`;
  return `${s} seconds`;
}

/** How long the spell holds once cast, and what ends it (lasts, ended_by), in one sentence:
 *  "Stays lit until Nox or Finite Incantatem puts it out." / "Lasts five seconds, or until
 *  Finite Incantatem ends it." */
export function lastsLine(entry: SpellbookEntry, nameOf: NameOf): string | null {
  const by = ids(entry.spell.ended_by).filter((id) => id !== entry.spell.id).map(nameOf);
  const word = activeWord(entry);
  const endsIt = word === 'active' ? 'ends it' : 'puts it out';
  const who = joinNames(by, 'or');
  if (typeof entry.lasts === 'number' && entry.lasts > 0) {
    const span = secondsText(entry.lasts);
    return by.length ? `Lasts ${span}, or until ${who} ${endsIt}.` : `Lasts ${span}.`;
  }
  if (entry.lasts === 'until-ended') {
    const stays = word === 'lit' ? 'Stays lit' : word === 'burning' ? 'Burns' : 'Stays';
    return by.length ? `${stays} until ${who} ${endsIt}.` : `${stays} until another spell ends it.`;
  }
  return by.length ? `Ended by ${who}.` : null;
}

/** Every sentence about how the spell works with others, in reading order. */
export function interactionLines(entry: SpellbookEntry, nameOf: NameOf, entryOf: EntryOf): string[] {
  return [needsLine(entry.spell, nameOf, entryOf), endsLine(entry.spell, nameOf, entryOf), lastsLine(entry, nameOf)].filter(
    (x): x is string => !!x,
  );
}

/** A spell's tier, as the pack service reads it (absent means 1). */
export function tierOf(entry: SpellbookEntry): number {
  const t = entry.spell.tier;
  return typeof t === 'number' && t >= 1 ? Math.floor(t) : 1;
}

/** "tier 1", "tiers 1 and 2", "tiers 1 to 4". */
export function tierWords(tiers: readonly number[]): string {
  const list = [...new Set(tiers)].sort((a, b) => a - b);
  if (list.length === 0) return '';
  if (list.length === 1) return `tier ${list[0]}`;
  if (list.length === 2) return `tiers ${list[0]} and ${list[1]}`;
  const contiguous = list.every((t, i) => i === 0 || t === list[i - 1] + 1);
  return contiguous ? `tiers ${list[0]} to ${list[list.length - 1]}` : `tiers ${joinNames(list.map(String), 'and')}`;
}

/** The tiers a locked spell waits on: every tier with available spells from the one now open up to
 *  just below its own (Section 8, staged unlocking). */
export function tiersBefore(entry: SpellbookEntry, book: Spellbook): number[] {
  const own = tierOf(entry);
  const tiers = [...new Set(book.spells.filter((e) => e.available).map(tierOf))].filter((t) => t >= book.unlockedTier && t < own);
  return tiers.length ? tiers.sort((a, b) => a - b) : [Math.min(book.unlockedTier, own - 1 || 1)];
}

/** "Learn the spells of tier 1 first, or open every spell in the Workshop." */
export function lockedReason(entry: SpellbookEntry, book: Spellbook): string {
  return `Learn the spells of ${tierWords(tiersBefore(entry, book))} first, or open every spell in the Workshop.`;
}

/** Spells of the tier now open that are still to learn, in spellbook order (available ones only). */
export function stillToLearn(book: Spellbook): SpellbookEntry[] {
  return book.spells.filter((e) => e.available && e.status === 'open' && tierOf(e) === book.unlockedTier);
}

/** Why a spell cannot be practised right now, or null when it can. */
export function practiceBlock(entry: SpellbookEntry, book: Spellbook): string | null {
  if (entry.status === 'locked') return lockedReason(entry, book);
  if (!entry.available) return entry.unavailableReason ?? 'This spell is not available here.';
  return null;
}

// ---------------------------------------------------------------------------------- practice

export type AttemptKind = 'cast' | 'blocked' | 'miss';

export interface AttemptView {
  /** cast: the gesture was right and the spell was cast; blocked: right, but a rule stopped it;
   *  miss: the gesture was not right (another spell may have been cast instead). */
  kind: AttemptKind;
  grade: string;
  /** The sentence after the grade: one specific hint, or what happened. */
  detail: string;
}

export interface AttemptContext {
  grade: (quality: number, kind: 'cast' | 'fizzle') => string;
  nameOf: NameOf;
  entryOf: EntryOf;
}

/** Why a rule stopped a correct gesture, in a plain sentence ("Nox needs Lumos lit first."). */
export function blockedSentence(reason: FizzleReason, spell: Spell | null, hint: string | undefined, ctx: AttemptContext): string {
  const name = spell?.incantation ?? 'This spell';
  switch (reason) {
    case 'needs-active':
      return (spell && needsSentence(spell, ctx.nameOf, ctx.entryOf)) ?? hint ?? `${name} needs another spell active first.`;
    case 'cooldown':
      return `${name} needs a moment before it can be cast again.`;
    case 'strict-mismatch':
      return hint ?? 'Say the incantation as you trace.';
    case 'unavailable':
      return `${name} is not open here yet.`;
    default:
      return hint ?? `${name} did not cast this time.`;
  }
}

/** One practice attempt as the bar shows it: "Acceptable. The downstroke stopped short: carry it
 *  through the circle." Success and failure differ by kind (shape on screen) and by words. */
export function describeAttempt(a: PracticeAttempt, ctx: AttemptContext): AttemptView {
  const entry = ctx.entryOf(a.spellId);
  if (a.success) {
    const grade = ctx.grade(a.quality, 'cast');
    if (a.blockedBy) return { kind: 'blocked', grade, detail: blockedSentence(a.blockedBy, entry?.spell ?? null, a.hint, ctx) };
    return { kind: 'cast', grade, detail: a.hint ?? 'The spell holds.' };
  }
  const grade = ctx.grade(a.quality, 'fizzle');
  const other = a.castSpellId && a.castSpellId !== a.spellId ? `${ctx.nameOf(a.castSpellId)} was cast instead.` : '';
  const hint = a.hint ?? 'Trace the shape more closely to the guide.';
  return { kind: 'miss', grade, detail: other ? `${other} ${hint}` : hint };
}
