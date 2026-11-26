// contracts/settings.ts
//
// Every setting a module reads with kernel.setting(key, fallback), with its default.
// Starting values come from the blueprint's tables (Sections 7.2, 7.4, 7.5, 7.7).
// Writes go through the request 'settings.set'; changes are published as 'settings.changed'.

export interface PlayArea { x: number; y: number; w: number; h: number }

export type CastingMode = 'gesture' | 'assisted' | 'strict' | 'voice';
export type TrackerId = 'tracker.bright-tip' | 'tracker.hand' | 'tracker.pointer' | 'tracker.replay';

/** A row of the bindings table (Section 7.8: "Lumos also turns on the desk lamp"). Outputs are a
 *  late milestone (M5); the table exists so they need no contract change. */
export interface Binding {
  id: string;
  spellId: string;
  /** Module id of the output that performs it. */
  output: string;
  /** What the output acts on, e.g. a webhook id. Fixed at build time for a static site. */
  target: string;
  enabled: boolean;
  params?: Record<string, unknown>;
}

export interface SettingsMap {
  // Which tracker runs (one active at a time).
  'tracker.active': TrackerId | string;
  /** Wand-tuning view: trackers publish 'tracker.debug' frames while true. Session-only. */
  'tracker.debug': boolean;

  // Capture (7.1)
  /** No module may open the camera while this is false. The Threshold screen sets it when the player
   *  chooses a route that uses the camera, after saying why (Section 11.2). */
  'capture.consent': boolean;
  /** Show your reflection: the stage asks for the camera even when the tracker does not need it.
   *  The Threshold screen turns this off for "Mouse or touch (no camera)". */
  'capture.mirror': boolean;
  /** The camera to use; the single source of truth (null: the default camera). */
  'capture.deviceId': string | null;
  /** Preferred size and rate (ideal constraints, Section 7.1: 1920x1080 at 30 fps or better, falling
   *  back to 1280x720; prefer 60 fps when offered at either size). */
  'capture.width': number;
  'capture.height': number;
  'capture.fps': number;
  /** Below this, capture tries the smaller size. */
  'capture.minFps': number;
  /** Flip x into caster space (true for ordinary webcams; false for cameras that already mirror). */
  'capture.flipX': boolean;
  /** Mirrors of the current camera's exposure, written only by capture (per-camera values live in
   *  CameraProfile). Change exposure through the 'camera.exposure' request. */
  'capture.exposureMode': 'continuous' | 'manual';
  'capture.exposureTime': number | null;

  // Bright-tip tracker (7.2)
  'brightTip.k': number;
  'brightTip.floor': number;              // 0..255 brightness floor
  'brightTip.channel': 'luma' | 'r' | 'g' | 'b';
  'brightTip.minArea': number;            // px² at full resolution
  'brightTip.maxArea': number;
  'brightTip.searchRadius': number;       // fraction of frame width per frame at 30 fps
  'brightTip.lostAfter': number;          // frames
  'brightTip.searchWidth': number;        // width of the max-pooled search image
  'brightTip.staticMask': boolean;
  'brightTip.profile': 'visible' | 'infrared';

  // Hand tracker (7.3)
  // 'wand' (@since 1.3): the tip of the wand held in the hand, found in the frame; the grip projection
  // (gripReach) stands in until the wand has been seen.
  'hand.mode': 'finger' | 'grip' | 'wand';
  'hand.gripReach': number;               // how far past the knuckles the virtual tip sits, in hand lengths

  // Filter and segmenter (7.4)
  // One Euro filter (Casiez et al.) on isotropic positions in frame widths (x, and y ÷ aspect),
  // one cutoff for both axes from the 2D speed. beta is Hz per (frame width per second).
  'filter.minCutoff': number;             // Hz
  'filter.beta': number;
  'filter.dCutoff': number;               // Hz
  'segmenter.mode': 'auto' | 'hold-still' | 'pen';
  'segmenter.armMs': number;
  'segmenter.armRadius': number;          // fraction of frame width
  'segmenter.pauseMs': number;
  'segmenter.pauseRadius': number;        // fraction of frame width
  'segmenter.lostMs': number;
  'segmenter.maxMs': number;
  'segmenter.minSamples': number;
  /** A stroke is evaluated when max(bbox.w / playArea.w, bbox.h / playArea.h) >= this, in caster
   *  units. Pen-style trackers use the whole mirror as their play area. */
  'segmenter.minExtent': number;
  'segmenter.cooldownMs': number;
  'segmenter.evaluateTimeoutMs': number;
  /** The part of caster space the player casts in, from Wand tuning (Section 10.4). Power and the
   *  minimum stroke size are measured against it. */
  'playArea': PlayArea;

  // Recognizer (7.5)
  'recognizer.flickLinearity': number;
  'recognizer.flickAngleDeg': number;
  'recognizer.lineTemplateLinearity': number;
  'recognizer.rotationDeg': number;
  'recognizer.rotationStepDeg': number;
  'recognizer.userTemplatesPerSpell': number;

  // Spell engine (7.7)
  'engine.mode': CastingMode;
  'engine.acceptScore': number;
  'engine.leadMargin': number;
  'engine.assistedScore': number;
  /** Window for incantations: from this long before the stroke's t0 ... */
  'engine.voiceBeforeMs': number;
  /** ... to this long after its t1. */
  'engine.voiceAfterMs': number;
  /** Extra wait past t1 + voiceAfterMs for the final result of an utterance already under way. */
  'engine.voiceLatencyMs': number;

  // Voice (7.6)
  'voice.enabled': boolean;
  /** Opt-in to the browser's server-based recognition, with a plain statement that audio leaves the device. */
  'voice.allowCloud': boolean;
  'voice.lang': string;
  'voice.minConf': number;
  /** Boost for phrase hints, 0..10 (SpeechRecognitionPhrase throws outside that range). */
  'voice.phraseBoost': number;
  'voice.quality': 'command' | 'dictation' | 'conversation';

  // Spells and packs
  'spells.unlockAll': boolean;
  /** Accepted casts after which a spell is learned and its strokes become your templates (Section 7.5). */
  'spells.learnAfter': number;
  'packs.enabled': Record<string, boolean>;

  // Access (10.6)
  'access.reducedMotion': 'system' | 'on' | 'off';
  'access.captions': boolean;
  'access.leftHanded': boolean;
  'access.highContrastTrail': boolean;

  // Sound
  'audio.volume': number;                 // 0..1
  'audio.muted': boolean;

  // Look
  'theme.id': string;
  'theme.accent': string;                 // 'default' or a key of ThemePack.accents
  'stage.quality': 'auto' | 'high' | 'low';

  // Lighting (route A without a clip-on light, Section 4 and Appendix A step 4)
  /** The shell shows a full-brightness white band along the top of the window, under the camera. */
  'shell.screenLight': boolean;
  /** Height of that band as a fraction of the window's height. */
  'shell.screenLightHeight': number;

  // Learning
  /** @since 1.1 The spell guide stays open beside the mirror on the Mirror screen: the spells that can
   *  be cast now, each with its gesture, so a new player need not learn them all by heart first. On by
   *  default, since new players need it most; the Mirror bar's "Spell guide" button turns it off. */
  'shell.spellGuide': boolean;

  // Sharing
  'share.includeCamera': boolean;

  // Outputs (M5)
  'bindings': Binding[];

  // Shell
  'app.onboarded': boolean;
  /** Session-only. */
  'diagnostics.overlay': boolean;
}

export type SettingKey = keyof SettingsMap;

export const DEFAULT_SETTINGS: SettingsMap = {
  'tracker.active': 'tracker.pointer',
  'tracker.debug': false,

  'capture.consent': false,
  'capture.mirror': true,
  'capture.deviceId': null,
  'capture.width': 1920,
  'capture.height': 1080,
  'capture.fps': 60,
  'capture.minFps': 30,
  'capture.flipX': true,
  'capture.exposureMode': 'continuous',
  'capture.exposureTime': null,

  'brightTip.k': 4,
  'brightTip.floor': 200,
  'brightTip.channel': 'luma',
  'brightTip.minArea': 4,
  'brightTip.maxArea': 400,
  'brightTip.searchRadius': 0.12,
  'brightTip.lostAfter': 6,
  'brightTip.searchWidth': 640,
  'brightTip.staticMask': true,
  'brightTip.profile': 'visible',

  'hand.mode': 'finger',
  'hand.gripReach': 0.9,

  // Tuned with the published recipe on 30 fps data: a still tip's 0.15% jitter drops to about 0.045%,
  // and lag stays under about 20 ms at gesture speed (0.2 to 0.4 frame widths per second).
  'filter.minCutoff': 1.0,
  'filter.beta': 20,
  'filter.dCutoff': 1.0,
  'segmenter.mode': 'auto',
  'segmenter.armMs': 300,
  'segmenter.armRadius': 0.02,
  'segmenter.pauseMs': 250,
  'segmenter.pauseRadius': 0.012,
  'segmenter.lostMs': 200,
  'segmenter.maxMs': 4000,
  'segmenter.minSamples': 8,
  'segmenter.minExtent': 0.15,
  'segmenter.cooldownMs': 400,
  'segmenter.evaluateTimeoutMs': 1500,
  'playArea': { x: 0, y: 0, w: 1, h: 1 },

  'recognizer.flickLinearity': 0.2,
  'recognizer.flickAngleDeg': 35,
  'recognizer.lineTemplateLinearity': 0.3,
  'recognizer.rotationDeg': 15,
  'recognizer.rotationStepDeg': 3,
  'recognizer.userTemplatesPerSpell': 5,

  'engine.mode': 'gesture',
  'engine.acceptScore': 0.72,
  'engine.leadMargin': 0.04,
  'engine.assistedScore': 0.6,
  'engine.voiceBeforeMs': 2500,
  'engine.voiceAfterMs': 1000,
  'engine.voiceLatencyMs': 800,

  'voice.enabled': false,
  'voice.allowCloud': false,
  'voice.lang': 'en-US',
  'voice.minConf': 0.55,
  'voice.phraseBoost': 5,
  'voice.quality': 'command',

  'spells.unlockAll': false,
  'spells.learnAfter': 3,
  'packs.enabled': {},

  'access.reducedMotion': 'system',
  'access.captions': false,
  'access.leftHanded': false,
  'access.highContrastTrail': false,

  'audio.volume': 0.8,
  'audio.muted': false,

  'theme.id': 'candlelit',
  'theme.accent': 'default',
  'stage.quality': 'auto',

  'shell.screenLight': false,
  'shell.screenLightHeight': 0.12,

  'shell.spellGuide': true,

  'share.includeCamera': false,

  'bindings': [],

  'app.onboarded': false,
  'diagnostics.overlay': false,
};

/** Settings that live for one session only: never persisted, so a reload or crash cannot leave a
 *  debug view running (Section 13 performance budget). */
export const EPHEMERAL_SETTINGS: readonly SettingKey[] = ['tracker.debug', 'diagnostics.overlay'];

/** Version of the stored settings shape; bump and add a migration when it changes (kernel/settings.ts
 *  SETTINGS_MIGRATIONS). 2: "The tip of my wand" is the hand tracker's wand mode (contracts 1.3), and
 *  settings that chose it under 1 (the bright tip, visible profile) move there. */
export const SETTINGS_VERSION = 2;
