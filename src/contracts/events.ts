// contracts/events.ts
//
// Every event type in version 1, with its payload. Section 6 lists the 1.0 set; 1.1 adds the
// rest. All payloads are version 1 (Envelope.v = 1). Readers ignore event types they do not know.
// Fields added in 1.2 are marked `@since 1.2`.
//
// TIP EVENT RULES (1.1), followed by every tracker and expected by every consumer:
//  1. After start(), a tracker publishes 'tracker.status' (with aspect and pen) before any tip event,
//     and again whenever either changes. Consumers keep the status per tracker id and use the one
//     whose `tracker` matches sample.src, not simply the last one.
//  2. 'tip.found' is a state change sent just before the 'tip.sample' of the same frame, with the
//     same t. It adds no point of its own.
//  3. 'tip.lost'.t is the capture time of the frame at which the loss is declared; lastSeen is the
//     t of the last sample. A tracker holding the tip publishes 'tip.lost' when it stops, when the
//     camera stops, and before a camera generation changes.
//  4. Consumers must not rely on 'tip.lost' alone: a gap in sample capture times longer than
//     'segmenter.lostMs' also means the tip is gone. @since 1.2: for a tracker whose status asks for
//     a longer gap (TrackerStatus.segmentation.lostMs), the segmenter waits that long instead, and so
//     does a consumer that judges the gap itself (the stage's tip), by the same rule
//     (SegmentationNeeds), so the two never disagree about whether the tip is there.

import type { Incantation, Recognition, RecognitionDetail, SpellCast, SpellEnded, SpellFizzle, Stroke, TipSample, FizzleReason } from './v1';
import type { ModuleKind, ModuleState } from './module';
import type { PackKind, Spellbook } from './packs';
import type { SceneProps } from './scene';
import type { StorageStatus, StoreName } from './storage';

// ------------------------------------------------------------------ tracker

export interface TrackerStatus {
  tracker: string;
  state: 'starting' | 'loading' | 'searching' | 'tracking' | 'stopped' | 'error';
  /** Share of recent frames with a confident tip, 0..1 (lock quality). */
  lock: number;
  /** Frames processed per second. */
  fps: number;
  /** Width ÷ height of caster space for this tracker. */
  aspect: number;
  width?: number;
  height?: number;
  /** Pointer-style trackers set this: strokes begin on tip.found and end on tip.lost. */
  pen?: boolean;
  /** Bright tip: tip brightness ÷ brightest background (Appendix A step 5; aim for 3 or more). */
  contrast?: number;
  /** Median milliseconds of tracker work per frame over the last second (budget: 4 ms). */
  stepMs?: number;
  /** Where a camera tracker reads frames: the camera track directly (MediaStreamTrackProcessor, the fast
   *  path) or the capture module's video element. */
  source?: 'track' | 'video';
  /** Exposure state as the camera reports it. */
  exposure?: { mode: string; time?: number };
  /** While state is 'loading': download or set-up progress, 0..1. */
  progress?: number;
  /** A plain sentence for the status area, e.g. 'Hand model loading'. */
  message?: string;
  /** Camera trackers only: set 3 s after start() or after the last confident sample, cleared when
   *  the tip is found and on stop() (Section 7.9). Pointer trackers never set it.
   *  @since 1.2 'hand-too-small' (the hand tracker): the hand is found but small in the frame, its
   *  median TipSample.size over the last second under 0.05, where detection starts to fail; cleared
   *  at 0.055 or more. It is decided on the frames with a hand and lasts while the last second holds
   *  any, so a short loss of the tip does not clear it; it clears on stop() and with a new camera. */
  hint?: 'tip-not-found' | 'hand-not-found' | 'too-many-lights' | 'hand-too-small' | null;
  /** @since 1.2 What this tracker's samples need from the segmenter (SegmentationNeeds). */
  segmentation?: SegmentationNeeds;
}

/**
 * @since 1.2 Segmenter rules a tracker's samples need, where they must be more forgiving than the
 * settings: a tracker whose detection misses runs of frames, or runs at a low frame rate, says so here.
 * The segmenter keeps it per tracker, with the aspect and pen flag, and for that tracker's samples
 * only uses the more forgiving of the two in each case; a setting that is more forgiving still wins:
 *  - lostMs: the tip counts as gone after max(segmenter.lostMs, lostMs) without samples (rule 4);
 *  - minSamples: a stroke needs min(segmenter.minSamples, minSamples) samples, the tracker's value
 *    counted as at least 3;
 *  - pauseMs: a pause of max(segmenter.pauseMs, pauseMs) ends a stroke.
 * The segmenter ignores a value that is not a finite number of zero or more (the other values still
 * count), and holds lostMs and pauseMs to 2 s (SEGMENTATION_NEED_MAX_MS, the segmenter's MAX_NEED_MS),
 * so a wrong status cannot keep a tip in view, or a stroke open, for long after its samples stop or
 * still. A consumer that applies lostMs itself (rule 4) reads it the same way.
 * Every tracker.status carries the whole set: a status without it means the tracker needs nothing.
 */
export interface SegmentationNeeds {
  lostMs?: number;
  minSamples?: number;
  pauseMs?: number;
}

/** @since 1.2 The longest lostMs or pauseMs that SegmentationNeeds can ask for: longer ones count as this. */
export const SEGMENTATION_NEED_MAX_MS = 2000;

/** What the tracker sees, for the Wand tuning screen. Published only while 'tracker.debug' is on, at
 *  about 10 fps. The image is already in caster orientation (mirrored) and stays valid until the next
 *  'tracker.debug' from the same tracker, at least 100 ms later: draw it with drawImage, never call
 *  close() or transferFromImageBitmap() on it. */
export interface TrackerDebugFrame {
  tracker: string;
  t: number;
  image: ImageBitmap | null;
  width: number;
  height: number;
  /** Candidates in caster space; r, major and minor in caster-x units. */
  blobs: { x: number; y: number; r: number; score: number; chosen: boolean; major?: number; minor?: number }[];
  mean?: number;
  std?: number;
  threshold?: number;
  tipLevel?: number;
  backgroundMax?: number;
  contrast?: number;
  /** Hand tracker: the 21 landmarks in caster space. */
  landmarks?: [number, number][];
}

// ------------------------------------------------------------------ capture

export interface CameraExposureInfo {
  modes: string[];
  /** exposureTime range, in the Image Capture unit of 100 µs. */
  min?: number;
  max?: number;
  step?: number;
  /** exposureCompensation range, where the camera offers it instead of (or as well as) a time. */
  compensation?: { min: number; max: number; step: number };
  mode?: string;
  time?: number;
}

export interface CameraReady {
  deviceId: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  stream: MediaStream;
  /** Exposure control the camera offers, or null (Section 7.1: treat it as optional). */
  exposure: CameraExposureInfo | null;
  /** The label suggests an infrared camera (Appendix A step 9). */
  infrared: boolean;
  /** Increments on every open, device switch or size change. Consumers rebind to the new stream
   *  and trackers reset their per-camera state (static mask, prediction). */
  generation: number;
}

export interface CameraFrame {
  /** Capture time of this frame on the kernel clock. */
  t: number;
  /** Where t came from: the camera's own capture time, the expected presentation time, or the
   *  callback time (both later ones hide the camera's latency). */
  timeSource: 'capture' | 'presented' | 'callback';
  frame: number;
  generation: number;
  width: number;
  height: number;
  /** The capture module's video element, showing this frame right now. Read it synchronously
   *  (createImageBitmap, new VideoFrame, drawImage, detectForVideo). Never keep it or change it. */
  video: HTMLVideoElement;
}

export interface CameraError {
  /** DOMException name: NotAllowedError (blocked), NotFoundError (no camera), NotReadableError (in
   *  use), OverconstrainedError; or 'ConsentRequired' while setting 'capture.consent' is false. */
  name: string;
  message: string;
}

/** Sticky summary of the camera, for status chips, Wand tuning and recovery flows. */
export interface CameraStatus {
  state: 'off' | 'requesting' | 'on' | 'blocked' | 'missing' | 'busy' | 'error';
  generation: number;
  /** navigator.permissions state for the camera, where the browser reports it. */
  permission: 'granted' | 'prompt' | 'denied' | 'unknown';
  deviceId?: string;
  label?: string;
  width?: number;
  height?: number;
  /** Measured delivered frame rate. */
  fps?: number;
  exposure?: { mode: string; time?: number; compensation?: number };
  /** The capture size was stepped down once because the frame rate fell below 20 fps (Section 7.9). */
  steppedDown?: boolean;
  /** A plain sentence for the status area, e.g. 'Frame rate low: capture size reduced'. */
  message?: string;
  error?: CameraError;
  requesters?: string[];
}

// ------------------------------------------------------------------ segmenter

export type SegmenterState = 'searching' | 'hovering' | 'armed' | 'tracing' | 'evaluating' | 'cooldown' | 'paused';

export interface SegmenterStatus {
  state: SegmenterState;
  t: number;
  /** Which rule is in force: hold-still (wands, hands) or pen (mouse and touch). */
  mode: 'hold-still' | 'pen';
  /** While hovering: progress toward arming, 0..1 (the on-screen tip turns gold and ticks). */
  armProgress?: number;
  strokeId?: string;
  /** Why a stroke ended without 'stroke.end': dropped as too short or too small. Every 'stroke.begin'
   *  is followed by either 'stroke.end' or a status with discarded (or captured) and its strokeId. */
  discarded?: 'too-short' | 'too-small' | 'interrupted';
  /** The stroke went to a 'segmenter.capture' request (Workshop redraw) instead of being cast. */
  captured?: boolean;
  /** Why the segmenter is paused: 'voice-only' (engine.mode 'voice' while voice is ready or listening;
   *  with voice unusable every mode plays by gesture rules, Section 7.9), 'replay', or a requested reason. */
  pausedFor?: string;
}

// ------------------------------------------------------------------ engine and practice

/** The engine has deferred a decision (assisted or strict mode waiting for speech). The segmenter
 *  stays in evaluating until `until` plus a margin; the stage may show that it is listening. */
export interface SpellPending {
  strokeId: string;
  until: number;
  waitingFor: 'voice';
}

export interface PracticeFocus {
  /** Spell being practised, or null when practice ends. */
  spellId: string | null;
}

export interface PracticeAttempt {
  spellId: string;
  attempt: number;
  /** The gesture was accepted for the practised spell (score at the threshold with the lead, or the
   *  assisted rule), whether or not a rule then stopped the cast. */
  success: boolean;
  /** Set when a rule (needs-active, cooldown) prevented the cast of a correct gesture. */
  blockedBy?: FizzleReason;
  /** What was cast instead, if anything. */
  castSpellId?: string;
  /** Match score against the practised spell. */
  score: number;
  quality: number;
  hint?: string;
  stray?: { from: number; to: number };
  detail?: RecognitionDetail;
  strokeId?: string;
}

export interface PracticeGuide {
  spellId: string;
  /** "Show me slowly": animate the guide at half pace with a pace dot. */
  slow: boolean;
}

// ------------------------------------------------------------------ voice

export interface VoiceStatus {
  state: 'off' | 'unavailable' | 'needs-download' | 'downloading' | 'ready' | 'listening' | 'error';
  /** Audio and transcripts stay on the device. */
  local: boolean;
  /** Whether the browser's server-based service could be used if the player opts in. */
  cloud?: 'available' | 'unavailable';
  lang?: string;
  message?: string;
}

// ------------------------------------------------------------------ effects and stage

export interface EffectEvent {
  spellId: string;
  castId: string;
  /** The effect step's `use` name, or 'fallback:sparkle'. */
  use: string;
  t: number;
  /** `${castId}#${step}`: pairs an effect.start with its effect.end. */
  id?: string;
  /** Index of the step in spell.effect.steps (-1 for the fallback). */
  step?: number;
  /** The step as run, after limits. */
  params?: Record<string, unknown>;
  durationMs?: number;
  /** effect.end only. */
  reason?: 'done' | 'spell-ended' | 'effects-end' | 'reset';
}

export interface AudioCaption {
  cue: string;
  text: string;
  t: number;
}

/** The stage's drawing surface. Re-published on every resize, camera change and layer change. */
export interface StageSurface {
  /** The mirror element (created by src/main.ts, given to the stage and the pointer tracker, and
   *  placed by the shell). It has touch-action: none; others may listen on it but not restyle it. */
  mirror: HTMLElement;
  /** The rectangle, in CSS px relative to `mirror`, that caster space (0,0)..(1,1) maps to. It equals
   *  the mirror when the mirror has the camera's aspect, and is letterboxed inside it otherwise. */
  caster: { x: number; y: number; width: number; height: number };
  /** caster.width ÷ caster.height. The pointer tracker reports this aspect. */
  aspect: number;
  /** The displayed camera video, or null on a plain backdrop. */
  video: HTMLVideoElement | null;
  /** The video is shown flipped left to right (the mirror view). */
  videoMirrored: boolean;
  /** Canvases bottom to top, with the CSS blend mode each is composited with. */
  layers: { canvas: HTMLCanvasElement; blend: 'normal' | 'screen' }[];
  /** Mirror size in CSS px, and canvas pixels per CSS px. */
  width: number;
  height: number;
  dpr: number;
}

/** A follow-the-tip effect is running (Leviosa, Locomotor, Accio's hover, Imperio). While castId is
 *  set the stage draws no ink and the engine publishes stroke decisions as fizzles with reason
 *  'steering' (casts still happen, so Finite can end the spell). */
export interface StageSteering {
  castId: string | null;
  spellId?: string;
}

/** A replay is playing on the stage. While playing, the segmenter is paused and the engine ignores
 *  live strokes and incantations. */
export interface ReplayState {
  playing: boolean;
  castId?: string;
  spellId?: string;
}

export interface ClipState {
  state: 'recording' | 'stopped' | 'error';
  elapsedMs: number;
  castId?: string;
  reason?: string;
}

// ------------------------------------------------------------------ packs, progress, storage

export interface PackLoaded {
  id: string;
  kind: PackKind;
  version: string;
  /** Unmet capability needs (Section 6: "Pack id, version, unmet needs"). */
  unmet: string[];
  skippedSteps: number;
  user: boolean;
}

export interface PackFailed {
  /** The pack id, or 'index' when the pack index itself could not be read. */
  id: string;
  path?: string;
  reason: string;
}

export interface ProgressChanged {
  spellId: string;
  accepted: number;
  learned: boolean;
  /** Set when this cast unlocked a new tier. */
  unlockedTier?: number;
  unlockedSpells?: string[];
}

/** Published by storage after committed writes (coalesced per task). Modules that cache a store
 *  reload it: the pack service (packs, overrides, progress, kv), the recognizer (samples), capture
 *  (profiles), share (keepsakes). */
export interface StorageChanged {
  stores: StoreName[];
  reason: 'put' | 'delete' | 'clear' | 'import'
    /** @since 1.1 Another tab or window of the app on this device committed the change to the
     *  database this one reads (an installed window beside a tab, a replay link opened in a new tab).
     *  It is never an echo of this tab's own writes, so caches of these stores are stale and reload.
     *  keys are those the other tab published, when it published any. */
    | 'other-tab';
  keys?: string[];
}

// ------------------------------------------------------------------ kernel and shell

export interface SettingsChanged {
  key: string;
  value: unknown;
}

export interface ModuleStatus {
  id: string;
  kind: ModuleKind;
  state: ModuleState;
  reason?: string;
  /** Which lifecycle step an 'error' came from. */
  phase?: 'init' | 'start' | 'stop';
}

export interface DiagnosticsStats {
  t: number;
  /** Events per second by type over the last second. */
  rates: Record<string, number>;
  /** Milliseconds from stroke end to decision, last value. */
  decisionMs?: number;
  /** Milliseconds from capture to tip.filtered, median over the last second. */
  trailLatencyMs?: number;
  recording: boolean;
}

export interface AppUpdateReady {
  version?: string;
}

// ------------------------------------------------------------------ the map

export interface EventMap {
  // tracker (1.0)
  'tip.sample': TipSample;
  'tip.found': TipSample;
  'tip.lost': { t: number; src: string; /** @since 1.1 */ lastSeen?: number };
  'tracker.status': TrackerStatus;
  // tracker (1.1)
  'tracker.debug': TrackerDebugFrame;

  // capture (1.1)
  'camera.ready': CameraReady;
  'camera.frame': CameraFrame;
  'camera.error': CameraError;
  'camera.stopped': { reason?: 'released' | 'switching' | 'ended' | 'error'; generation?: number };
  'camera.status': CameraStatus;

  // segmenter (1.0)
  'stroke.begin': Stroke;
  'stroke.end': Stroke;
  // segmenter (1.1): filtered tip for the trail, and the hold-still state machine
  'tip.filtered': TipSample;
  'segmenter.state': SegmenterStatus;

  // recognizer (1.0)
  'recognition.result': Recognition;

  // voice (1.0)
  'voice.incantation': Incantation;
  // voice (1.1)
  'voice.status': VoiceStatus;

  // spell engine (1.0)
  'spell.cast': SpellCast;
  'spell.fizzle': SpellFizzle;
  // spell engine (1.1)
  'spell.ended': SpellEnded;
  'spell.pending': SpellPending;
  'practice.attempt': PracticeAttempt;

  // shell → engine and stage (1.1)
  'practice.focus': PracticeFocus;
  'practice.guide': PracticeGuide;

  // effects (1.0)
  'effect.start': EffectEvent;
  'effect.end': EffectEvent;
  // effects (1.1)
  'scene.props': SceneProps;
  'stage.surface': StageSurface;
  'stage.steering': StageSteering;
  'replay.state': ReplayState;
  'audio.caption': AudioCaption;

  // share (1.1)
  'share.clip.state': ClipState;

  // pack loader (1.0)
  'pack.loaded': PackLoaded;
  // pack loader (1.1)
  'pack.failed': PackFailed;
  'spellbook.changed': Spellbook;
  'progress.changed': ProgressChanged;

  // storage (1.1)
  'storage.status': StorageStatus;
  'storage.changed': StorageChanged;

  // kernel (1.1)
  'settings.changed': SettingsChanged;
  'module.status': ModuleStatus;
  'diagnostics.stats': DiagnosticsStats;

  // shell (1.0)
  'app.update-ready': AppUpdateReady;
}

export type EventType = keyof EventMap;

/** Payload version for each type. Every type is at version 1 in contract 1.x. */
export const EVENT_VERSION: Partial<Record<EventType, number>> = {};
export const eventVersion = (type: string): number => EVENT_VERSION[type as EventType] ?? 1;

/** Types whose last envelope the kernel does not keep (they hold frames or are per-frame noise). */
export const NON_STICKY_EVENTS: readonly string[] = ['camera.frame', 'tracker.debug'];
