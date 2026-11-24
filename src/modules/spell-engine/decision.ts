// The decision rule (Section 7.5 "Decision") and the four ways of combining gesture and voice
// (Section 7.7 table). Pure functions: the engine core gathers the inputs, this file says what
// happens, and the core then applies the pack's rules (needs_active, cooldown) to a cast.

import type { CastingMode, FizzleReason, Recognition } from '../../contracts';
import type { HeardIncantation } from './voice-log';

/** Scores are compared with this tolerance, so a score of exactly 0.72 or a lead of exactly 0.04
 *  passes despite floating-point rounding (0.74 - 0.70 is 0.03999...). */
export const SCORE_EPSILON = 1e-9;

export interface Candidate {
  spellId: string;
  score: number;
}

/** The recognition's candidates that may be cast right now: one per spell (the best, should a
 *  recognizer repeat one), only spells the spellbook has enabled (it may have changed since the
 *  stroke was scored), best first. */
export function rankCandidates(rec: Recognition, isEnabled: (spellId: string) => boolean): Candidate[] {
  const best = new Map<string, number>();
  for (const c of rec.candidates ?? []) {
    if (!c || typeof c.spellId !== 'string' || !isEnabled(c.spellId)) continue;
    const score = Number.isFinite(c.score) ? Math.min(1, Math.max(0, c.score)) : 0;
    if (score > (best.get(c.spellId) ?? -1)) best.set(c.spellId, score);
  }
  // A stable sort keeps the recognizer's order among equal scores.
  return [...best].map(([spellId, score]) => ({ spellId, score })).sort((a, b) => b.score - a.score);
}

export type GestureVerdict =
  | { accepted: true; spellId: string; score: number; rule: 'thresholds' | 'flick' }
  | { accepted: false; reason: 'low-score' | 'ambiguous' | 'no-candidates' | 'unavailable'; nearest?: Candidate };

/**
 * Section 7.5: accept the best spell if its score is at least acceptScore and it leads the best
 * other spell by at least leadMargin; otherwise the cast fizzles, naming the nearest spell.
 * `flickStage`: the recognizer's stage 1 (a straight flick) produced the winner. Only one direction
 * can lie within the flick cone, so the lead margin does not apply (contracts/v1.ts Recognition.stage).
 */
export function judgeGesture(cands: readonly Candidate[], flickStage: boolean, acceptScore: number, leadMargin: number): GestureVerdict {
  const [best, runnerUp] = cands;
  if (!best) return { accepted: false, reason: 'no-candidates' };
  if (best.score < acceptScore - SCORE_EPSILON) return { accepted: false, reason: 'low-score', nearest: best };
  if (flickStage) return { accepted: true, spellId: best.spellId, score: best.score, rule: 'flick' };
  const lead = best.score - (runnerUp?.score ?? 0);
  if (lead < leadMargin - SCORE_EPSILON) return { accepted: false, reason: 'ambiguous', nearest: best };
  return { accepted: true, spellId: best.spellId, score: best.score, rule: 'thresholds' };
}

/**
 * A stroke no open spell accepts may still be a spell the player has not unlocked yet. When the best
 * locked spell (Recognition.locked) passes the acceptance score and leads the best open spell by the
 * margin, the fizzle names it as 'unavailable', so a learner hears which spell they drew instead of
 * "close to" an unrelated one. Locked spells are never cast, so accuracy among open spells is untouched.
 */
export function withLockedSpell(
  verdict: GestureVerdict, rec: Recognition, isLocked: (spellId: string) => boolean, acceptScore: number, leadMargin: number,
): GestureVerdict {
  if (verdict.accepted) return verdict;
  let best: Candidate | undefined;
  for (const c of rec.locked ?? []) {
    if (!c || typeof c.spellId !== 'string' || !isLocked(c.spellId) || !Number.isFinite(c.score)) continue;
    if (!best || c.score > best.score) best = { spellId: c.spellId, score: Math.min(1, Math.max(0, c.score)) };
  }
  if (!best || best.score < acceptScore - SCORE_EPSILON) return verdict;
  if (best.score - (verdict.nearest?.score ?? 0) < leadMargin - SCORE_EPSILON) return verdict;
  return { accepted: false, reason: 'unavailable', nearest: best };
}

/** What the voice offers a stroke at the moment of deciding. */
export interface VoiceView {
  /** Unconsumed final incantations naming a spell, overlapping the stroke's window, and not held back
   *  as spoken around an earlier stroke (VoiceLog.finalsFor), oldest first. */
  finals: readonly HeardIncantation[];
  /** An utterance is under way that could still land in the window. */
  inProgress: boolean;
}

export interface StrokeDecisionInput {
  /** The mode in force: 'gesture' whenever voice is not usable (Section 7.9: gesture play is
   *  unaffected). Voice mode never reaches here: its strokes are ignored. */
  mode: Exclude<CastingMode, 'voice'>;
  verdict: GestureVerdict;
  candidates: readonly Candidate[];
  voice: VoiceView;
  assistedScore: number;
  isEnabled: (spellId: string) => boolean;
  /** Waiting for speech is allowed (false once the deadline has passed, and while steering). */
  mayWait: boolean;
}

export type StrokeDecision =
  | {
      kind: 'cast';
      spellId: string;
      score: number;
      via: 'gesture' | 'both';
      /** The incantation used: consumed by this decision. */
      incantation?: HeardIncantation;
      /** The voice decided the spell (the gesture alone would not have cast it), so the cast's
       *  capture time is the later of the stroke's end and the incantation (contracts/v1.ts SpellCast.t). */
      voiceDecided: boolean;
    }
  | {
      kind: 'fizzle';
      reason: FizzleReason;
      nearest?: Candidate;
      incantation?: HeardIncantation;
      /** Strict mode: no incantation was heard, or it named another spell. */
      voiceIssue?: 'none-heard' | 'disagreed';
    }
  | { kind: 'wait' };

/** Decide a stroke under the mode's rules, or say that it must wait for speech. */
export function decideStroke(input: StrokeDecisionInput): StrokeDecision {
  switch (input.mode) {
    case 'assisted':
      return decideAssisted(input);
    case 'strict':
      return decideStrict(input);
    default:
      return decideGesture(input);
  }
}

/** Gesture (default): the stroke passes the thresholds. Voice is ignored, except that an agreeing
 *  incantation already heard in the window marks the cast 'both'. Never waits. */
function decideGesture({ verdict, voice }: StrokeDecisionInput): StrokeDecision {
  if (!verdict.accepted) return fizzleFrom(verdict);
  const agreeing = voice.finals.find((f) => f.spellId === verdict.spellId);
  return { kind: 'cast', spellId: verdict.spellId, score: verdict.score, via: agreeing ? 'both' : 'gesture', incantation: agreeing, voiceDecided: false };
}

/**
 * Assisted: an incantation heard in the window picks the spell, which is accepted at the lower
 * assisted score; other spells are ignored. Without one, the stroke casts at once when it passes the
 * thresholds on its own and nobody is speaking; otherwise it waits for speech until the deadline,
 * then the gesture decides alone.
 */
function decideAssisted({ verdict, candidates, voice, assistedScore, isEnabled, mayWait }: StrokeDecisionInput): StrokeDecision {
  const heard = pickHeard(voice.finals, candidates);
  if (heard) {
    const spellId = heard.spellId!;
    const score = candidates.find((c) => c.spellId === spellId)?.score ?? 0;
    if (!isEnabled(spellId)) return { kind: 'fizzle', reason: 'unavailable', nearest: { spellId, score }, incantation: heard };
    if (score >= assistedScore - SCORE_EPSILON) {
      const gestureAlone = verdict.accepted && verdict.spellId === spellId;
      return { kind: 'cast', spellId, score, via: 'both', incantation: heard, voiceDecided: !gestureAlone };
    }
    return { kind: 'fizzle', reason: 'low-score', nearest: { spellId, score }, incantation: heard };
  }
  if (verdict.accepted && !voice.inProgress) return castFrom(verdict);
  if (mayWait) return { kind: 'wait' };
  return verdict.accepted ? castFrom(verdict) : fizzleFrom(verdict);
}

/**
 * Strict: the stroke must pass the thresholds and an incantation must name the same spell. A
 * stroke that fails on its own fizzles at once with its own reason, since no incantation could save
 * it. One that passes waits for speech until the deadline; a disagreeing incantation ends the wait
 * as soon as nobody is still speaking.
 */
function decideStrict({ verdict, voice, mayWait }: StrokeDecisionInput): StrokeDecision {
  if (!verdict.accepted) return fizzleFrom(verdict);
  const nearest = { spellId: verdict.spellId, score: verdict.score };
  const agreeing = voice.finals.find((f) => f.spellId === verdict.spellId);
  if (agreeing) return { kind: 'cast', spellId: verdict.spellId, score: verdict.score, via: 'both', incantation: agreeing, voiceDecided: true };
  const other = voice.finals[voice.finals.length - 1];
  if (other && !voice.inProgress) return { kind: 'fizzle', reason: 'strict-mismatch', nearest, incantation: other, voiceIssue: 'disagreed' };
  if (mayWait) return { kind: 'wait' };
  return { kind: 'fizzle', reason: 'strict-mismatch', nearest, incantation: other, voiceIssue: other ? 'disagreed' : 'none-heard' };
}

/** Of several incantations in the window, the one whose spell the gesture resembles most; on a tie,
 *  the latest (the player's last word). */
function pickHeard(finals: readonly HeardIncantation[], candidates: readonly Candidate[]): HeardIncantation | undefined {
  let pick: HeardIncantation | undefined;
  let pickScore = -1;
  for (const f of finals) {
    const score = candidates.find((c) => c.spellId === f.spellId)?.score ?? 0;
    if (score >= pickScore) {
      pick = f;
      pickScore = score;
    }
  }
  return pick;
}

function castFrom(v: Extract<GestureVerdict, { accepted: true }>): StrokeDecision {
  return { kind: 'cast', spellId: v.spellId, score: v.score, via: 'gesture', voiceDecided: false };
}

function fizzleFrom(v: Extract<GestureVerdict, { accepted: false }>): StrokeDecision {
  return { kind: 'fizzle', reason: v.reason, nearest: v.nearest };
}
