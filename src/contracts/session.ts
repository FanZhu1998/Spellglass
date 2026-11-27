// contracts/session.ts
//
// Recorded sessions guard behavior (Section 9.1 rule 8, Section 13). A session is a saved
// stream of tracker events plus the casts it produced. The diagnostics overlay records them in
// this format; tests replay them through filter, segmenter, recognizer and engine.

import type { SegmentationNeeds } from './events';
import type { FizzleReason } from './v1';

export const SESSION_SCHEMA = 'session/1';

export type SessionEvent =
  | { type: 'tip.sample'; t: number; x: number; y: number; conf: number; size?: number; frame?: number }
  | { type: 'tip.found'; t: number; x: number; y: number; conf: number; frame?: number }
  | { type: 'tip.lost'; t: number; lastSeen?: number }
  | { type: 'voice.incantation'; t: number; text: string; spellId?: string; conf: number; final: boolean; id?: string; t0?: number; t1?: number };

export interface SessionExpectation {
  /** The spell that should be cast, or null for a fizzle. When the recording had an intended spell,
   *  this is the intended one (ground truth), not what the app decided. */
  spellId: string | null;
  /** Capture time of the decision, relative to the session start (tolerance applies). */
  t: number;
  /** The spell the caster was asked to cast. */
  intended?: string;
  /** What the app actually decided when this was recorded (null for a fizzle). */
  decided?: string | null;
  /** Why a fizzle fizzled. 'steering' and 'ignored' were not failed casts (a follow-the-tip effect,
   *  a replay), so fixture tooling can leave those strokes out. */
  reason?: FizzleReason;
  strokeId?: string;
}

export interface RecordedSession {
  schema: typeof SESSION_SCHEMA;
  id: string;
  title?: string;
  recordedAt: string;
  /** Tracker id that produced the samples. */
  tracker: string;
  /** Width ÷ height of caster space. */
  aspect: number;
  /** The segmenter ran in pen mode (mouse or touch) rather than hold-still. */
  pen?: boolean;
  /** @since 1.2 What the tracker's samples needed from the segmenter: the `segmentation` of its
   *  tracker.status (contracts/events.ts SegmentationNeeds), as the segmenter reads it (values that are
   *  not finite numbers of zero or more left out, lostMs and pauseMs held to SEGMENTATION_NEED_MAX_MS).
   *  Whatever plays the session back publishes it with the session's tracker.status, so the samples are
   *  segmented as they were live: the hand tracker's, say, keep the 500 ms gaps they were allowed.
   *  Absent: the tracker needed nothing, and the settings applied. */
  segmentation?: SegmentationNeeds;
  /** Settings that shape the pipeline, captured at recording time (only non-default ones). Applied
   *  only by test harnesses, never to a player's settings. */
  settings?: Record<string, unknown>;
  /** Spell ids that were enabled when recorded. Tests enable exactly these. */
  enabledSpells?: string[];
  /** The spell the caster was asked to cast, for single-spell recordings. */
  intended?: string;
  /** The camera, for tracker-clip fixtures (Section 13 "Tracker clips"). */
  camera?: { label: string; width: number; height: number; fps: number; exposure?: { mode: string; time?: number } };
  /** Path of the matching fixture clip (.y4m), when there is one. */
  video?: string;
  /** Events in time order; t is capture time in ms from the start of the session. */
  events: SessionEvent[];
  expected: SessionExpectation[];
}
