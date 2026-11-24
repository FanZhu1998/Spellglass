// Progress rules (contracts/storage.ts SpellProgress, Section 7.5 "Learning your hand", Section 8
// staged unlocking). Pure functions; the service stores the results.

import type { PracticeAttempt, SpellCast, SpellProgress } from '../../contracts';
import { DATA_VERSION } from '../../contracts';
import { isRecord } from './types';

/** Store 'kv' key of the highest tier opened. */
export const UNLOCKED_TIER_KEY = 'progress.unlockedTier';

/** Every spell.cast counts toward progress except replays (share links, recorded sessions), and a cast
 *  by voice alone counts only in voice-only mode, where it is the way to play (contracts/storage.ts).
 *  Practice casts count. */
export function countsTowardProgress(cast: SpellCast, engineMode: string): boolean {
  if (cast.replay === true) return false;
  if (cast.via === 'voice' && engineMode !== 'voice') return false;
  return typeof cast.spellId === 'string' && cast.spellId.length > 0;
}

export function emptyProgress(spellId: string): SpellProgress {
  return { dataVersion: DATA_VERSION, spellId, casts: 0, practiceAttempts: 0, best: 0, learnedAt: null };
}

/** One more accepted cast. learnedAt is set the first time casts reach learnAfter, and is never cleared
 *  afterwards (a spell stays learned). The service applies this to the stored record when it writes
 *  (another window may have counted too), so of two times the earlier one is kept. */
export function applyCast(prev: SpellProgress | undefined, cast: SpellCast, learnAfter: number, now: number): SpellProgress {
  const base = prev ?? emptyProgress(cast.spellId);
  const casts = base.casts + 1;
  const quality = Number.isFinite(cast.quality) ? Math.min(1, Math.max(0, cast.quality)) : 0;
  return {
    ...base,
    dataVersion: DATA_VERSION,
    casts,
    best: Math.max(base.best, quality),
    learnedAt: earlier(base.learnedAt, casts >= learnAfter ? now : null),
  };
}

/** Two records of one spell as one that is behind neither: the most casts and practice attempts, the
 *  best quality, and the earlier learnedAt, so a spell learned in either stays learned. The service
 *  writes this (service.ts, "Two windows"): what storage holds with this window's new steps, merged
 *  with what this window holds. Other fields come from `a`. */
export function mergeProgress(a: SpellProgress | undefined, b: SpellProgress | undefined): SpellProgress | undefined {
  if (!a || !b) return a ?? b;
  return {
    ...a,
    casts: Math.max(a.casts, b.casts),
    practiceAttempts: Math.max(a.practiceAttempts, b.practiceAttempts),
    best: Math.max(a.best, b.best),
    learnedAt: earlier(a.learnedAt, b.learnedAt),
  };
}

/** The earlier of two times, either of which may be unset. */
function earlier(a: number | null, b: number | null): number | null {
  return a === null ? b : b === null ? a : Math.min(a, b);
}

export function applyPracticeAttempt(prev: SpellProgress | undefined, attempt: PracticeAttempt): SpellProgress {
  const base = prev ?? emptyProgress(attempt.spellId);
  return { ...base, dataVersion: DATA_VERSION, practiceAttempts: base.practiceAttempts + 1 };
}

/** Learned: accepted learnAfter times, or learned before (learnedAt set). */
export function isLearned(p: SpellProgress | undefined, learnAfter: number): boolean {
  return !!p && (p.learnedAt !== null || p.casts >= learnAfter);
}

/** A stored progress record, read tolerantly: missing counts become 0, a bad record is dropped. */
export function readProgressRecord(key: string, value: unknown): SpellProgress | null {
  if (!isRecord(value)) return null;
  const spellId = typeof value.spellId === 'string' && value.spellId ? value.spellId : key;
  if (!spellId) return null;
  const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  const best = typeof value.best === 'number' && Number.isFinite(value.best) ? Math.min(1, Math.max(0, value.best)) : 0;
  const learnedAt = typeof value.learnedAt === 'number' && Number.isFinite(value.learnedAt) ? value.learnedAt : null;
  return {
    ...value,
    dataVersion: typeof value.dataVersion === 'number' ? value.dataVersion : DATA_VERSION,
    spellId,
    casts: count(value.casts),
    practiceAttempts: count(value.practiceAttempts),
    best,
    learnedAt,
  };
}

/** The stored unlocked tier: written as { dataVersion, value } (everything stored carries a version,
 *  Section 9.1 rule 4); a bare number is read too. */
export function readUnlockedTier(value: unknown): number | null {
  const n = isRecord(value) ? value.value : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

export function unlockedTierRecord(tier: number): { dataVersion: number; value: number } {
  return { dataVersion: DATA_VERSION, value: tier };
}

type TierItem = { tier: number; available: boolean; learned: boolean };

/** Staged unlocking (Section 8, "Practice mode unlocks spells in stages"), the part that is saved:
 *  from the stored tier, move on while the current tier has available spells and every one of them
 *  is learned, to the next tier any loaded spell has. It stops at a tier with nothing available (its
 *  pack is turned off, or a need is unmet) instead of passing through it, so turning a pack off and
 *  on again does not skip its stages. It never goes down. */
export function completedTier(items: readonly TierItem[], start: number): number {
  let tier = validTier(start);
  const tiers = [...new Set(items.map((i) => i.tier))].sort((a, b) => a - b);
  for (;;) {
    const here = items.filter((i) => i.available && i.tier === tier);
    if (!here.length || here.some((i) => !i.learned)) return tier;
    const next = tiers.find((t) => t > tier);
    if (next === undefined) return tier;
    tier = next;
  }
}

/** Staged unlocking as one spellbook shows it: from the current tier, move to the next tier that has
 *  available spells whenever every available spell of the current tier is learned. A tier with no
 *  available spells is passed straight through, so a player who turns the first pack off is not
 *  stuck. Started from completedTier, it only adds that pass-through, which is never saved: turning
 *  the pack on again brings this back down to the saved tier. */
export function advanceTier(items: readonly TierItem[], start: number): number {
  let tier = validTier(start);
  const tiers = [...new Set(items.filter((i) => i.available).map((i) => i.tier))].sort((a, b) => a - b);
  for (;;) {
    if (items.some((i) => i.available && i.tier === tier && !i.learned)) return tier;
    const next = tiers.find((t) => t > tier);
    if (next === undefined) return tier;
    tier = next;
  }
}

function validTier(start: number): number {
  return Number.isFinite(start) && start >= 1 ? Math.floor(start) : 1;
}
