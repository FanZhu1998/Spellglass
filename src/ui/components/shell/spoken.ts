// What the top edge of the glass says to a screen reader (Section 10.6): the cast banner and a new
// tier's ribbon, in the words the glass shows. GlassAnnouncer.svelte speaks them.

import type { Celebration, LogEntry } from '../../app-state.svelte';

/** "Lumos, Exceeds Expectations, by voice." for a cast; "Troll. Close to Alohomora. The downstroke
 *  stopped short." for a fizzle, as the banner writes it (a rule's fizzle has no grade). */
export function spokenBanner(b: LogEntry): string {
  if (b.kind === 'fizzle') return [b.grade ? `${b.grade}.` : '', b.hint ?? ''].filter(Boolean).join(' ');
  const parts = [b.name, b.grade];
  if (b.via === 'voice') parts.push('by voice');
  if (b.replay) parts.push('replay');
  return `${parts.filter(Boolean).join(', ')}.`;
}

/** "A new page opens. New spells to learn: Alohomora, Accio and Expelliarmus." */
export function spokenCelebration(c: Celebration): string {
  return `A new page opens. ${c.text}`;
}
