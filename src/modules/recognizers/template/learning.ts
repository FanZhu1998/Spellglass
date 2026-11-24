// Learning your hand (Section 7.5): after `spells.learnAfter` accepted casts of a spell, its strokes
// are kept on the device as extra templates for that spell, at most
// `recognizer.userTemplatesPerSpell` of them. The shipped templates stay untouched. Pure rules here;
// the module does the storage requests.
//
// Interpretation (documented because the blueprint leaves it open):
//  - Every qualifying stroke is saved as a GestureSample as soon as its cast is accepted, and a
//    spell's samples count as templates once it has min(learnAfter, cap) of them. That is "after
//    three accepted casts, keep those strokes": the first three strokes are the ones kept, and they
//    survive a reload in between.
//  - Drift guard: a stroke scoring above LEARN_MAX_OTHER_SCORE against any other available spell is
//    never kept, and when the spell has `cap` samples a new one replaces the weakest only if it scores
//    higher. A sample's score is its score against the spell's stored paths alone (learned samples
//    left out), so the most typical drawings are the ones kept and samples cannot pull one another
//    away from the shape the pack defines.
//  - Samples carry the gestureKey they were learned under; others are ignored, not deleted, so turning
//    the left-handed switch off and on again, or clearing a redraw, brings the old samples back.

import type { GestureSample, SpellCast } from '../../../contracts';

/** Pack lint's limit for two templates (Section 7.5): a stroke this close to another spell would
 *  blur the two together if it became a template. */
export const LEARN_MAX_OTHER_SCORE = 0.8;

/** Replays never become learned templates (SpellCast.replay; Stroke.src 'tracker.replay'), voice-only
 *  casts have no stroke, and only a cast whose gesture passed the acceptance threshold counts. */
export function castQualifies(cast: SpellCast, strokeSrc: string | undefined, acceptScore: number, recognizedScore?: number): boolean {
  if (!cast || cast.replay) return false;
  if (cast.via !== 'gesture' && cast.via !== 'both') return false;
  if (strokeSrc === 'tracker.replay') return false;
  const score = typeof cast.score === 'number' ? cast.score : recognizedScore;
  return typeof score === 'number' && Number.isFinite(score) && score >= acceptScore;
}

/** Shape check for records read from storage (the storage module migrates them; this only refuses
 *  what the recognizer cannot use). */
export function isGestureSample(v: unknown): v is GestureSample {
  if (!v || typeof v !== 'object') return false;
  const s = v as Partial<GestureSample>;
  if (typeof s.id !== 'string' || typeof s.spellId !== 'string' || !Array.isArray(s.points) || s.points.length < 2) return false;
  if (typeof s.score !== 'number' || !Number.isFinite(s.score)) return false;
  if (s.gestureKey !== undefined && typeof s.gestureKey !== 'string') return false;
  return s.points.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

/** A spell's samples learned under its current gesture, best first (then oldest first). Samples
 *  without a key cannot be checked against the gesture and are treated as stale. */
export function samplesFor(all: readonly GestureSample[], spellId: string, gestureKey: string): GestureSample[] {
  if (!gestureKey) return [];
  return all
    .filter((s) => s.spellId === spellId && s.gestureKey === gestureKey)
    .sort((a, b) => b.score - a.score || (a.savedAt ?? 0) - (b.savedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The samples that act as templates now: none until the spell has enough of them. */
export function activeSamples(all: readonly GestureSample[], spellId: string, gestureKey: string, learnAfter: number, cap: number): GestureSample[] {
  const max = Math.max(0, Math.floor(cap));
  if (max === 0) return [];
  const mine = samplesFor(all, spellId, gestureKey);
  const need = Math.max(1, Math.min(Math.floor(learnAfter) || 1, max));
  return mine.length >= need ? mine.slice(0, max) : [];
}

/**
 * Whether to keep a new sample, and which existing ones (same spell and key, any order) to drop:
 * kept while there is room; once full, kept only when it scores above the weakest, which it then
 * replaces. Samples beyond the cap (after the cap was lowered) are dropped either way.
 */
export function planSample(existing: readonly GestureSample[], sample: GestureSample, cap: number): { keep: boolean; drop: string[] } {
  const max = Math.max(0, Math.floor(cap));
  if (max === 0) return { keep: false, drop: existing.map((s) => s.id) };
  const sorted = [...existing].sort((a, b) => b.score - a.score || (a.savedAt ?? 0) - (b.savedAt ?? 0));
  if (sorted.length < max) return { keep: true, drop: [] };
  const weakest = sorted[max - 1];
  if (sample.score > weakest.score) return { keep: true, drop: sorted.slice(max - 1).map((s) => s.id) };
  return { keep: false, drop: sorted.slice(max).map((s) => s.id) };
}
