// contracts/v1.ts
//
// The data that flows through the pipeline. These types are the only thing modules share.
// Within version 1, changes are additive: new fields are optional, nothing is removed or
// given a new meaning. Fields marked `@since 1.1` were added while implementing the blueprint,
// fields marked `@since 1.2` after measuring the hand route.

/**
 * Contract version. 1.0 is the set in the blueprint (Section 6). 1.1 adds, without changing
 * anything in 1.0: camera, segmenter, replay and storage events, request/response on the kernel,
 * sticky "last value" reads, fizzle and practice details, and the optional fields marked below.
 * 1.2 adds, without changing anything in 1.1, two optional parts of tracker.status
 * (contracts/events.ts TrackerStatus): the hint 'hand-too-small', and `segmentation`, the segmenter
 * rules a tracker's samples need (SegmentationNeeds, held to SEGMENTATION_NEED_MAX_MS); and the same
 * `segmentation` in a recorded session (contracts/session.ts RecordedSession), so that a replay keeps
 * it. Modules that use none of these still say '^1.1'.
 */
export const CONTRACT = '1.2';

/** Engine version that pack `engine` ranges are checked against (Section 9.2). */
export const ENGINE_VERSION = '1.1.0';

/** One observation of the wand tip.
 *  Caster space: x runs 0 to 1 from left to right as you see yourself in the
 *  mirror view; y runs 0 to 1 from top to bottom. t is capture time in ms.
 *
 *  1.1 rules:
 *  - Caster space is the whole camera frame as shown in the mirror. Camera trackers flip x once,
 *    at the source (Section 6). The pointer tracker maps through StageSurface.caster, so every
 *    tracker and the stage share one space.
 *  - x and y may fall slightly outside 0..1 (a pointer dragged past the edge, a grip projection);
 *    consumers clamp where they need to.
 *  - t is on the kernel clock (performance.now() in the main thread). Workers never stamp time:
 *    they carry the CameraFrame.t they were given. */
export interface TipSample {
  t: number;
  x: number;
  y: number;
  conf: number;            // 0..1
  src: string;             // tracker id
  size?: number;           // blob radius, normalized; an optional depth hint
  //                          @since 1.1 normalized means: radius ÷ frame width (caster-x units).
  //                          The hand tracker reports wrist-to-middle-knuckle distance ÷ frame width.
  /** @since 1.1 A frame counter of the tracker's source, for tracker-clip fixtures: CameraFrame.frame,
   *  or the tracker's own count of camera frames when it reads the camera track directly. */
  frame?: number;
}

export interface Stroke {
  id: string;
  points: TipSample[];     // filtered, in time order
  /** @since 1.1 defined as: capture time of the first point, a rest before the stroke left out. A
   *  hold-still stroke starts at the last sample at the armed position. A pen stroke starts at the
   *  press, or, when the pointer rested there for a pause (segmenter.pauseMs) or sent nothing for
   *  longer than a dropout, where it started to move; its first point is then the press position with
   *  that time. stroke.begin of a pen stroke always carries the press, and the engine's incantation
   *  window reaches back to it. */
  t0: number;
  t1: number;              // @since 1.1 defined as: capture time of the last point, trailing still samples trimmed
  quality: number;         // 0..1, lowered by dropouts and jitter (@since 1.1: for pen-style trackers, jitter only; a still pointer sends nothing)
  /** @since 1.1 Width ÷ height of caster space for this stroke's source (16/9 for most webcams).
   *  Caster space is normalized per axis, so a circle in the air is an ellipse in (x, y).
   *  Multiply x by `aspect` to get isotropic coordinates before any shape comparison.
   *  The segmenter always sets it, from the tracker.status of the tracker that sent the samples. */
  aspect?: number;
  /** @since 1.1 Tracker id that produced the samples. Always set by the segmenter.
   *  'tracker.replay' marks a recorded session played back: its casts are replays. */
  src?: string;
  /** @since 1.1 Why the stroke ended: a pause, the tip lost, the 4 s cap, or a pen lifted. */
  endReason?: 'pause' | 'lost' | 'max' | 'pen-up';
}

export interface Recognition {
  strokeId: string;
  recognizer: string;
  candidates: { spellId: string; score: number }[];   // best first, score 0..1
  //  @since 1.1 defined as: exactly one entry per enabled spell (its best template), best first.
  //  Stage 2 scores every enabled path spell even when stage 1 fires, so a spell heard in
  //  assisted mode always has a score.
  /** @since 1.1 Narrow spread ÷ long spread along the stroke's principal axes (Section 7.5). */
  linearity?: number;
  /** @since 1.1 Which stage produced the winner. When 'flick', the engine applies the acceptance
   *  threshold but not the lead margin (only one direction can lie within the flick cone). */
  stage?: 'flick' | 'template';
  /** @since 1.1 Alignment detail for: the top three candidates, every candidate scoring at least
   *  min(engine.acceptScore, engine.assistedScore), and the practice focus spell. */
  details?: RecognitionDetail[];
  /** @since 1.1 Set by recognizers running in shadow (Section 9.1 rule 9). The engine ignores
   *  shadow results; diagnostics compare them with the primary recognizer's. */
  shadow?: boolean;
  /** @since 1.1 The best few available spells of locked tiers, scored the same way, best first.
   *  They are never cast; when no open spell passes and one of these clearly would, the engine
   *  fizzles 'unavailable' naming it, so a learner hears which spell they drew. */
  locked?: { spellId: string; score: number }[];
}

/** @since 1.1 How a stroke lined up against one spell. Fractions refer to one of the spell's stored
 *  paths (the pack's or the player's redrawn one), so they line up with GesturePart.until. Details
 *  are computed against stored paths even when a learned 'user:N' template won the score. */
export interface RecognitionDetail {
  spellId: string;
  /** The spell's candidate score. */
  score: number;
  /** Which template produced the score: 'seed:0', 'seed:0@start2', 'user:3', 'flick:up'. */
  template: string;
  /** Index into the spell's stored paths that the fractions below refer to (start shifts undone). */
  pathIndex: number;
  /** Per-point distance between point i of the resampled stroke and point i of the whole aligned
   *  stored path (64 values, in normalized units where the longer side is 1). Stroke fractions come
   *  straight from these indices. */
  deviation: number[];
  /** The stored path, rotated and fitted onto the stroke, in caster space (64 points). The stage
   *  morphs the ink onto this shape when the spell is cast. Flicks: a straight line from the
   *  stroke's start to its end. */
  aligned: [number, number][];
  /** The stroke's tilt relative to the template, degrees, clockwise positive on screen. */
  rotation: number;
  /** Arc fraction (0..1) of the stored path that the stroke's end reached, found by matching the
   *  stroke against prefixes of the path. Below about 0.9 the stroke stopped short. Flicks: 1. */
  reached: number;
  /** Arc fraction of the stored path where the stroke began (above about 0.1 is a late start).
   *  For any_start loops both fractions are positions on the loop: a full circle begun at the bottom
   *  reports started 0.5 and reached 0.5, so coverage there is (reached - started) mod 1, a full loop
   *  when they meet, and the late-start rule does not apply. */
  started?: number;
  /** The window that strayed most, as fractions of the stored path. */
  strayPath?: { from: number; to: number };
}

export interface Incantation {
  t: number;
  text: string;
  spellId?: string;
  conf: number;
  final: boolean;
  /** @since 1.1 Stable across the interim and final results of one utterance. Each id serves at
   *  most one decision. */
  id?: string;
  /** @since 1.1 Estimated start and end of the speech on the kernel clock. `t` equals t0 when set.
   *  Web Speech gives no word timings, so the voice module estimates t0 from the first interim result. */
  t0?: number;
  t1?: number;
  /** @since 1.1 Other spells the transcript could be, best first. */
  alternatives?: { spellId: string; conf: number }[];
}

export interface SpellCast {
  id: string;
  spellId: string;
  t: number;               // @since 1.1 defined as: capture time of the deciding input (stroke t1 or incantation t);
  //                          the envelope's t is the decision time.
  via: 'gesture' | 'voice' | 'both';
  quality: number;         // 0..1; the theme turns this into a grade
  power: number;           // 0..1, from stroke size and speed
  aim: { x: number; y: number };
  //                          @since 1.1 defined as: the stroke's last point, in caster space. Voice-only casts aim
  //                          at the last tip.filtered when it is under 1 s old, else the centre of the play area.
  strokeId?: string;
  /** @since 1.1 Gesture match score that won (absent for voice-only casts). */
  score?: number;
  /** @since 1.1 Label of the pack variant that applied, e.g. 'Lumos Maxima'. */
  variant?: string;
  /** @since 1.1 Multiplier for effect size and brightness from the variant (default 1). */
  effectScale?: number;
  /** @since 1.1 Prop the spell acts on, chosen nearest to `aim` among the spell's `targets`. */
  targetId?: string;
  /** @since 1.1 Display text of the incantation, from the pack. */
  incantation?: string;
  /** @since 1.1 The recognition detail the engine used: the stage settles the ink onto detail.aligned. */
  detail?: RecognitionDetail;
  /** @since 1.1 A replay: a share link played on the stage, or a recorded session played through the
   *  pipeline (stroke src 'tracker.replay'). Replays never count toward progress, never become
   *  learned templates and never become keepsakes. */
  replay?: boolean;
  /** @since 1.1 True when cast during practice mode. */
  practice?: boolean;
}

/** @since 1.1 Payload of `spell.fizzle`: "the nearest candidate and a hint" (Section 6). */
export interface SpellFizzle {
  id: string;
  t: number;
  strokeId?: string;
  reason: FizzleReason;
  /** The closest spell, when there was one. */
  nearest?: { spellId: string; score: number };
  /** One plain, specific sentence, e.g. "The downstroke stopped short: carry it through the circle."
   *  It never repeats the spell's name: the shell prefixes "Close to {Spell}." itself. */
  hint?: string;
  /** 0..1, turned into a fizzle grade by the theme (Poor, Dreadful, Troll). */
  quality: number;
  /** The part of the stroke that strayed most, as fractions of the stroke's length (for drawing). */
  stray?: { from: number; to: number };
  practice?: boolean;
}

export type FizzleReason =
  | 'low-score'        // best score under the threshold
  | 'ambiguous'        // best did not lead the runner-up by the margin
  | 'needs-active'     // e.g. Nox without Lumos
  | 'cooldown'         // the spell was cast too recently
  | 'unavailable'      // matched a spell that is locked or unavailable
  | 'strict-mismatch'  // strict mode: gesture and incantation disagree, or one is missing
  | 'no-candidates'    // nothing is enabled
  | 'steering'         // a follow-the-tip effect is running (stage.steering): the stroke was steering, not casting.
  //                      The stage, audio and shell ignore these: no drip, no cue, no hint; practice skips them.
  | 'ignored';         // the current mode or a replay does not evaluate strokes

/** @since 1.1 Payload of `spell.ended`: an active spell stopped. */
export interface SpellEnded {
  spellId: string;
  castId: string;
  t: number;
  /** Spell id that ended it (the same spell id when it was cast again), or 'timeout' when its
   *  duration ran out, 'replay' when a replay finished, 'unavailable' when its pack was turned off,
   *  'reset' (engine.reset) or 'stopped' (the engine stopped). */
  by: string;
  /** The cast that ended it, when `by` is a spell id. The engine publishes that cast's spell.cast
   *  first and then one spell.ended per cast it ended, in the same task. */
  byCastId?: string;
}
