// Types shared by the spell engine's pure core (engine.ts and its helpers) and the thin module
// wrapper (index.ts). Nothing here touches the bus, timers or the browser.

import type { CastingMode, EventMap, PlayArea } from '../../contracts';
import { CAST_SEQUENCE, DEFAULT_SETTINGS } from '../../contracts';

/** The settings the engine reads, gathered fresh for every decision (Sections 7.5 and 7.7). */
export interface EngineSettings {
  /** engine.mode: gesture, assisted, strict or voice (Section 7.7 table). */
  mode: CastingMode;
  /** engine.acceptScore: the best spell must score at least this (Section 7.5 Decision: 0.72). */
  acceptScore: number;
  /** engine.leadMargin: ... and lead the best other spell by this much (0.04). */
  leadMargin: number;
  /** engine.assistedScore: the lower bar for a spell heard in assisted mode (0.60). */
  assistedScore: number;
  /** engine.voiceBeforeMs / engine.voiceAfterMs: the incantation window around a stroke. */
  voiceBeforeMs: number;
  voiceAfterMs: number;
  /** engine.voiceLatencyMs: extra wait when an utterance is already under way. */
  voiceLatencyMs: number;
  /** playArea: power and "too small" are measured against it, for camera trackers. Strokes from
   *  pen-style trackers are measured against the whole mirror (contracts/settings.ts). */
  playArea: PlayArea;
  /** recognizer.flickLinearity: how straight a flick must be; flick hints compare against it. */
  flickLinearity: number;
  /** segmenter.minExtent: the smallest stroke the segmenter evaluates; power's zero point for size. */
  minExtent: number;
  /** CAST_SEQUENCE bloom delay in force (0 under reduced motion). Timed spells last from the bloom,
   *  so "active" lines up with what the player sees. */
  bloomDelayMs: number;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  mode: DEFAULT_SETTINGS['engine.mode'],
  acceptScore: DEFAULT_SETTINGS['engine.acceptScore'],
  leadMargin: DEFAULT_SETTINGS['engine.leadMargin'],
  assistedScore: DEFAULT_SETTINGS['engine.assistedScore'],
  voiceBeforeMs: DEFAULT_SETTINGS['engine.voiceBeforeMs'],
  voiceAfterMs: DEFAULT_SETTINGS['engine.voiceAfterMs'],
  voiceLatencyMs: DEFAULT_SETTINGS['engine.voiceLatencyMs'],
  playArea: { ...DEFAULT_SETTINGS.playArea },
  flickLinearity: DEFAULT_SETTINGS['recognizer.flickLinearity'],
  minExtent: DEFAULT_SETTINGS['segmenter.minExtent'],
  bloomDelayMs: CAST_SEQUENCE.bloomDelayMs,
};

/** The events the engine publishes. */
export type EngineEventType = 'spell.cast' | 'spell.fizzle' | 'spell.ended' | 'spell.pending' | 'practice.attempt';

/** One event for the module to publish, in the order the core returns them. */
export type EngineOutput = { [K in EngineEventType]: { type: K; payload: EventMap[K] } }[EngineEventType];

/** Strokes from this tracker are a recorded session played back: their casts are replays
 *  (contracts/v1.ts Stroke.src). */
export const REPLAY_TRACKER_ID = 'tracker.replay';

/** Caster-space aspect to assume when a stroke or the scene does not say (most webcams). */
export const DEFAULT_ASPECT = 16 / 9;

export function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** Copy of an object without its undefined fields, so payloads stay tidy in logs and storage. */
export function compact<T extends object>(value: T): T {
  const out = {} as T;
  for (const [k, v] of Object.entries(value)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
