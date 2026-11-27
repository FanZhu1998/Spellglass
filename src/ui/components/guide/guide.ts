// The spell guide's words and choices: which spells it lists, how it describes each one, and what it
// marks after a cast or a fizzle. Pure functions over the resolved Spellbook and the shell's log
// entries, so they can be tested without a browser. Pack strings are untrusted: these only build
// strings, which the guide renders as text.

import type { Spellbook, SpellbookEntry, SpellbookPack } from '../../../contracts';
import type { LogEntry } from '../../app-state.svelte';
import { progressText, typeset } from '../book/words';

export interface GuideGroup {
  pack: SpellbookPack;
  entries: SpellbookEntry[];
}

/**
 * The spells that can be cast now, in the book's order, grouped by the spell pack they come from as
 * the Spellbook groups them. "Can be cast now" is SpellbookEntry.enabled: available (pack on, needs
 * met) and not locked, so open and learned spells are listed and locked ones are not. With
 * 'spells.unlockAll' on nothing is locked, so every available spell is listed.
 */
export function guideGroups(book: Spellbook | null | undefined): GuideGroup[] {
  if (!book) return [];
  return book.packs
    .filter((p) => p.kind === 'spellpack' && p.enabled)
    .map((pack) => ({ pack, entries: book.spells.filter((e) => e.packId === pack.id && e.enabled) }))
    .filter((g) => g.entries.length > 0);
}

/** Spells that open as the player learns the listed ones: available, but in a tier not yet open. */
export function lockedCount(book: Spellbook | null | undefined): number {
  return book ? book.spells.filter((e) => e.available && e.status === 'locked').length : 0;
}

/** The guide's one quiet line about the rest: "8 more spells open as you learn these." */
export function moreLine(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? '1 more spell opens as you learn these.' : `${count} more spells open as you learn these.`;
}

/** Hints longer than this are cut at a word, so every card stays a quick read. The seed packs'
 *  longest gesture text (Incendio's, 81 characters) fits whole; packs may write up to 200. */
export const HINT_MAX = 84;

const FLICK_TEXT = { up: 'Flick straight up.', down: 'Flick straight down.', left: 'Flick right to left.', right: 'Flick left to right.' } as const;

/**
 * The gesture in words, as the Spellbook page words it for the hand it is shown for: a mirrored
 * flick by its (already mirrored) direction, a mirrored path by the pack's mirrored words when it has
 * them. Shortened to HINT_MAX.
 */
export function gestureHint(entry: SpellbookEntry, max = HINT_MAX): string {
  const spell = entry.spell;
  const g = spell.gesture;
  let text: string;
  if (g && 'flick' in g) text = entry.mirrored || !spell.gesture_text ? (FLICK_TEXT[g.flick] ?? '') : spell.gesture_text;
  else if (entry.mirrored && spell.gesture_text_mirrored) text = spell.gesture_text_mirrored;
  else text = spell.gesture_text ?? '';
  return shortHint(typeset(text), max);
}

/** Text of at most `max` characters: whole when it fits, else cut at the last word that fits and
 *  closed with an ellipsis. Runs of white space become one space. */
export function shortHint(text: string, max = HINT_MAX): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const room = t.slice(0, Math.max(1, max - 1));
  const cut = room.lastIndexOf(' ');
  const head = (cut > max / 2 ? room.slice(0, cut) : room).replace(/[\s,;:.—–-]+$/, '');
  return `${head}…`;
}

/** Progress on the card: "1 of 3" toward learning, or "Learned". */
export function statusWords(entry: SpellbookEntry, learnAfter: number): string {
  return entry.status === 'learned' ? 'Learned' : progressText(entry.accepted, learnAfter);
}

/** The same for a screen reader, where the dots beside it are not read: "1 of 3 casts to learn it". */
export function statusSpoken(entry: SpellbookEntry, learnAfter: number): string {
  return entry.status === 'learned' ? 'Learned' : `${progressText(entry.accepted, learnAfter)} casts to learn it`;
}

// ---------------------------------------------------------------------------------- marks

/** What a card says for a moment after a result: the spell was cast; a stroke fizzled close to it;
 *  or its shape was right and a rule stopped it (it needs another spell first, a cooldown). */
export type MarkKind = 'cast' | 'close' | 'blocked';

export interface GuideMark {
  /** The log entry's id, so the same result never marks twice. */
  id: string;
  spellId: string;
  kind: MarkKind;
  /** The word on the card (Section 10.6: a result reads in words, not by color alone). */
  text: string;
}

const MARK_TEXT: Record<MarkKind, string> = { cast: 'Cast', close: 'Close', blocked: 'Right shape' };

/** How long a card keeps its mark: a cast lights it briefly, a near miss stays long enough to read. */
export const MARK_MS: Record<MarkKind, number> = { cast: 2400, close: 3400, blocked: 3400 };

/**
 * The mark a result leaves on the guide, or null. A cast marks its spell; a fizzle marks the spell it
 * came closest to, as the banner's "Close to Alohomora" names it. The shell gives a fizzle that a rule
 * caused no grade (app-state.svelte.ts RULE_FIZZLES): its shape was right. Replays are not the
 * player's casts and mark nothing.
 */
export function markFor(entry: LogEntry | null | undefined): GuideMark | null {
  if (!entry || entry.replay || !entry.spellId) return null;
  const kind: MarkKind = entry.kind === 'cast' ? 'cast' : entry.grade ? 'close' : 'blocked';
  return { id: entry.id, spellId: entry.spellId, kind, text: MARK_TEXT[kind] };
}
