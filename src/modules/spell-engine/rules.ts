// Spell rules from pack data, not code (Section 7.7; Section 8 "Spells interact"): what must be
// active first (needs_active), what a cast ends (ends, '*'), what ends a spell (ended_by), and
// cooldowns. Whether and how long a spell stays active comes only from SpellbookEntry.lasts, never
// from the effect steps, so the rules do not depend on which effect modules are installed.

import type { Spell, SpellbookEntry } from '../../contracts';

export interface ActiveCast {
  castId: string;
  spellId: string;
  /** Kernel time of the cast. */
  since: number;
  /** Kernel time it runs out, or null for 'until-ended'. */
  endsAt: number | null;
  /** What ends it at endsAt: its duration ran out, or a replay's hold did. */
  endBy: 'timeout' | 'replay' | null;
  /** Cast through the 'engine.cast' request (a share-link replay on the stage). */
  fromRequest: boolean;
}

/** How a new cast becomes active. Timed spells and replay holds count from the bloom, the moment
 *  the effect appears (CAST_SEQUENCE.bloomDelayMs after the cast), so "active" matches the screen. */
export function activationFor(
  lasts: SpellbookEntry['lasts'],
  now: number,
  bloomDelayMs: number,
  replayHoldMs?: number,
): Pick<ActiveCast, 'endsAt' | 'endBy'> | null {
  if (lasts === 'until-ended') {
    // A replay's 'until-ended' spell ends after its hold (contracts/requests.ts engine.cast).
    if (replayHoldMs !== undefined) return { endsAt: now + bloomDelayMs + Math.max(0, replayHoldMs), endBy: 'replay' };
    return { endsAt: null, endBy: null };
  }
  if (typeof lasts === 'number' && Number.isFinite(lasts) && lasts > 0) return { endsAt: now + bloomDelayMs + lasts, endBy: 'timeout' };
  return null;
}

/** Active spells, at most one activation per spell: a spell cast again replaces its earlier
 *  activation. Kept in activation order, oldest first. */
export class ActiveSpells {
  private bySpell = new Map<string, ActiveCast>();

  isActive(spellId: string): boolean {
    return this.bySpell.has(spellId);
  }

  get(spellId: string): ActiveCast | undefined {
    return this.bySpell.get(spellId);
  }

  list(): ActiveCast[] {
    return [...this.bySpell.values()];
  }

  add(cast: ActiveCast): void {
    // Delete first so a re-added spell moves to the end of the activation order.
    this.bySpell.delete(cast.spellId);
    this.bySpell.set(cast.spellId, cast);
  }

  remove(spellId: string): void {
    this.bySpell.delete(spellId);
  }

  clear(): void {
    this.bySpell.clear();
  }

  /** needs_active ids that are not active. Every listed spell must be active ("Nox needs Lumos"). */
  missingNeeds(spell: Spell): string[] {
    return (spell.needs_active ?? []).filter((id) => typeof id === 'string' && !this.isActive(id));
  }

  /**
   * The activations a cast of `spell` ends, oldest first: its own earlier activation (cast again),
   * every spell its `ends` lists ('*' is every active spell), and every active spell whose
   * `ended_by` lists it. (Nox ends Lumos; Aguamenti ends Incendio; Finite Incantatem ends all.)
   */
  endedBy(spell: Spell, entries: ReadonlyMap<string, SpellbookEntry>): ActiveCast[] {
    const ends = Array.isArray(spell.ends) ? spell.ends : [];
    const all = ends.includes('*');
    return this.list().filter((a) => {
      if (a.spellId === spell.id || all || ends.includes(a.spellId)) return true;
      const endedBy = entries.get(a.spellId)?.spell.ended_by;
      return Array.isArray(endedBy) && endedBy.includes(spell.id);
    });
  }

  /** Activations whose time is up at `now`, earliest first. */
  due(now: number): ActiveCast[] {
    return this.list()
      .filter((a) => a.endsAt !== null && a.endsAt <= now)
      .sort((a, b) => a.endsAt! - b.endsAt!);
  }

  nextDue(): number | null {
    let next: number | null = null;
    for (const a of this.bySpell.values()) if (a.endsAt !== null && (next === null || a.endsAt < next)) next = a.endsAt;
    return next;
  }
}

/** cooldown_ms per spell, measured between capture times of casts (contracts/v1.ts SpellCast.t),
 *  so a recorded session replayed at speed 1 decides exactly as it did live. */
export class Cooldowns {
  private lastCastT = new Map<string, number>();

  blocked(spell: Spell, t: number): boolean {
    const ms = spell.cooldown_ms;
    if (typeof ms !== 'number' || !(ms > 0)) return false;
    const last = this.lastCastT.get(spell.id);
    return last !== undefined && t - last < ms;
  }

  note(spellId: string, t: number): void {
    this.lastCastT.set(spellId, t);
  }

  clear(): void {
    this.lastCastT.clear();
  }
}
