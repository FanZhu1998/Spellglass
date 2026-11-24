// contracts/requests.ts  (@since 1.1)
//
// Named requests: the shell, and modules that need an answer rather than a broadcast, ask
// with kernel.request(name, payload). Exactly one module handles each name, registered with
// kernel.handle(name, fn) during init() ('tracker.*' during start()). Like events, requests are
// additive within version 1. Rejections carry a KernelError code or a {name, message} pair; turn
// either into a sentence with describeError().

import type { CameraReady } from './events';
import type { ModuleKind, ModuleManifest, ModuleState } from './module';
import type { Gesture, PackKind, Point, Spellbook } from './packs';
import type { RecordedSession } from './session';
import type { ReplayData, ShareResult } from './share';
import type { CameraProfile, Keepsake, StorageStatus, StoreName, UserDataExport } from './storage';
import type { Recognition, SpellCast, Stroke } from './v1';

export interface CameraDevice {
  deviceId: string;
  /** Empty until the camera permission has been granted once; fetch the list again after camera.ready. */
  label: string;
  /** The label suggests an infrared camera. */
  infrared: boolean;
}

export interface AutotuneResult {
  ok: boolean;
  /** One plain sentence for the Wand tuning screen. */
  message: string;
  contrast?: number;
  exposureTime?: number | null;
  k?: number;
}

export interface RequestMap {
  // ---------------------------------------------------------------- kernel: settings
  /** Resolves after the change has taken effect, including a tracker switch for 'tracker.active'. */
  'settings.set': { payload: { key: string; value: unknown }; result: void };
  'settings.reset': { payload: { key?: string }; result: void };
  /** Defaults merged with the player's values. */
  'settings.all': { payload: undefined; result: Record<string, unknown> };
  /** Only the values the player changed (exports, session recordings). */
  'settings.user': { payload: undefined; result: Record<string, unknown> };

  // ---------------------------------------------------------------- kernel: modules
  'modules.list': { payload: undefined; result: { manifest: ModuleManifest; state: ModuleState; reason?: string }[] };
  /** Make a module the running member of an exclusive kind (one tracker at a time). transient: true
   *  does not touch the persisted setting (the replay tracker uses this). Resolves once it runs. */
  'modules.activate': { payload: { kind: ModuleKind; id: string; transient?: boolean }; result: { active: string } };
  /** End a transient activation: go back to the module the setting names. */
  'modules.release': { payload: { kind: ModuleKind; id: string }; result: { active: string } };
  /** Stop a module if it runs, clear an error from start(), and start it again (recovery). */
  'modules.restart': { payload: { id: string }; result: { state: ModuleState } };

  // ---------------------------------------------------------------- kernel: packs, spellbook, progress
  'spellbook.get': { payload: undefined; result: Spellbook };
  /** Save the player's own drawing of a spell (Workshop). The pack is left alone. Pass either a
   *  gesture (isotropic unit square, as drawn in the current view) or the captured stroke, which the
   *  service converts with stroke.aspect. The service stores it in right-handed form (mirroring it
   *  back when 'access.leftHanded' is on), keeps the pack gesture's parts, any_start and start_points
   *  unless given, and stores a nearly straight drawing as a flick. */
  'spellbook.override.set': { payload: { spellId: string; gesture?: Gesture; stroke?: Stroke }; result: void };
  'spellbook.override.clear': { payload: { spellId: string }; result: void };
  'packs.enable': { payload: { id: string; enabled: boolean }; result: void };
  /** A pack file dropped onto the Workshop: spellpack, themepack or gesturepack JSON. */
  'packs.import': { payload: { text: string; filename?: string }; result: { id: string; kind: PackKind; warnings: string[] } };
  'packs.remove': { payload: { id: string }; result: void };
  /** Export one pack, or the player's redrawn gestures as a gesturepack. */
  'packs.export': { payload: { id?: string; gestures?: boolean }; result: { filename: string; text: string } };
  /** Reload everything (after an import of saved data, for instance). Never rejects. */
  'packs.reload': { payload: undefined; result: Spellbook };
  'progress.reset': { payload: { spellId?: string }; result: void };

  // ---------------------------------------------------------------- capture
  'camera.devices': { payload: undefined; result: CameraDevice[] };
  /** Ref-counted by requester. The device is setting 'capture.deviceId' (or the default camera).
   *  exposure 'profile' asks for the camera profile's exposure (bright tip); everyone else gets
   *  continuous exposure, restored when the last 'profile' requester stops. Rejects with
   *  {name: 'ConsentRequired'} while 'capture.consent' is false, or with the DOMException name. A
   *  requester whose open failed stays registered, and 'camera.retry' serves it on success. */
  'camera.start': { payload: { requester: string; exposure?: 'auto' | 'profile' }; result: CameraReady };
  'camera.stop': { payload: { requester: string }; result: void };
  /** Try to open the camera again for every registered requester (the "Try again" button). */
  'camera.retry': { payload: undefined; result: CameraReady };
  /** The only way to change exposure. time is in 100 µs units (Image Capture). Stored in the current
   *  camera's profile. */
  'camera.exposure': { payload: { requester: string; mode: 'continuous' | 'manual'; time?: number; compensation?: number }; result: { mode: string; time?: number; compensation?: number } };
  /** Step the capture size down once (1920x1080 to 1280x720) when processing falls below 20 fps.
   *  Resolves null when it has already stepped down this session. */
  'camera.step-down': { payload: { requester: string; fps: number }; result: { width: number; height: number } | null };
  /** Save the working settings for the current camera (Section 7.1). Without a payload ("Save for this
   *  camera") the profile takes every per-camera value in effect now: the settings behind its fields
   *  profile, flipX, k, floor, channel, minArea, maxArea and playArea. With a payload only the fields it
   *  gives change, on the camera's stored profile or on a new one that holds just the camera's identity,
   *  size and exposure. Every field a profile holds is written back to its setting each time the camera
   *  opens, so a caller that keeps one choice (the route, a tuned threshold) saves only that. Exposure
   *  fields in the payload are ignored: 'camera.exposure' changes exposure. Rejects with
   *  {name: 'InvalidStateError'} while the camera is not on. */
  'camera.profile.save': { payload: Partial<CameraProfile> | undefined; result: CameraProfile };

  // ---------------------------------------------------------------- trackers (handled by the running tracker)
  /** Bright tip: lower exposure until the room is nearly black, then pick a threshold. */
  'tracker.autotune': { payload: undefined; result: AutotuneResult };
  /** Bright tip: forget the static mask of lamps and windows, and learn it again. */
  'tracker.relearn-mask': { payload: undefined; result: void };
  /** Replay tracker: play a recorded session through the pipeline. It activates itself transiently
   *  and releases when done. Published t = start + recorded t, so spacing is kept; speed changes the
   *  pacing only (decisions are identical only at speed 1). Session settings are never applied to
   *  the player's settings. */
  'replay.play': { payload: { session: RecordedSession; speed?: number }; result: { played: number } };
  'replay.stop': { payload: undefined; result: void };

  // ---------------------------------------------------------------- segmenter and recognizer
  /** Pause or resume stroke segmentation (tip.filtered keeps flowing). */
  'segmenter.pause': { payload: { paused: boolean; reason?: string }; result: void };
  /** Return the next completed stroke to the caller instead of publishing it as stroke.end, so it
   *  is never recognized or cast (Workshop redraw). Resolves null on timeout. */
  'segmenter.capture': { payload: { timeoutMs?: number } | undefined; result: Stroke | null };
  /** Dry run: score points against available spells (locked ones included) and publish nothing.
   *  points are caster-space; aspect defaults to 16/9. */
  'recognizer.score': { payload: { points: Point[]; aspect?: number; spellIds?: string[] }; result: Recognition };

  // ---------------------------------------------------------------- engine
  /** Cast a spell without a stroke (replays). The engine applies variants, targeting, durations and
   *  ends, publishes spell.cast and later spell.ended. replay casts with lasts 'until-ended' end
   *  after holdMs (default min(duration_ms, 8000) or 4000). */
  'engine.cast': {
    payload: {
      spellId: string; via: SpellCast['via']; quality: number; power: number; aim?: { x: number; y: number };
      variant?: boolean; targetId?: string; replay: true; holdMs?: number; detail?: SpellCast['detail'];
    };
    result: SpellCast;
  };
  /** End every active spell (by 'reset') and clear cooldowns; the shell calls it with stage.reset.
   *  @since 1.1 The stage also calls it at the start of a replay (see 'stage.replay'). */
  'engine.reset': { payload: undefined; result: void };

  // ---------------------------------------------------------------- diagnostics
  /** intended: the spell the caster was asked to cast (ground truth for the confusion matrix). */
  'session.record.start': { payload: { title?: string; intended?: string } | undefined; result: void };
  /** Change the intended spell mid-recording. */
  'session.record.label': { payload: { spellId: string | null }; result: void };
  'session.record.stop': { payload: undefined; result: RecordedSession };

  // ---------------------------------------------------------------- stage
  /** Put every prop back on the shelf in its starting state. */
  'stage.reset': { payload: undefined; result: void };
  /** Play a replay on the stage: publishes replay.state, animates the trace as ink over durationMs on
   *  a plain backdrop (unless backdrop 'camera'), asks 'engine.cast' for the cast, lets the effect
   *  play, resets the shelf, and resolves when it is over.
   *  @since 1.1 A replay starts from a clean stage: before the trace it asks 'engine.reset' (live
   *  spells end) and puts the shelf back as PROP_START has it, so the replayed spell always acts on
   *  the props it was cast on. It waits for the replayed props to settle before the final reset. */
  'stage.replay': {
    payload: {
      spellId: string; points: Point[]; aspect: number; durationMs: number;
      via: SpellCast['via']; quality: number; power: number; variant: boolean; targetId?: string;
      backdrop?: 'plain' | 'camera'; holdMs?: number;
    };
    result: { castId: string; durationMs: number };
  };
  /** A video stream of the composited mirror (the camera only when includeCamera), for clips. */
  'stage.capture.start': { payload: { requester: string; includeCamera: boolean; fps?: number }; result: { stream: MediaStream } };
  'stage.capture.stop': { payload: { requester: string }; result: void };

  // ---------------------------------------------------------------- audio
  /** Resume the AudioContext after a user gesture. Resolves at once with the current state. */
  'audio.unlock': { payload: undefined; result: { state: string } };
  /** Play a cue now and publish its caption (interface cues such as 'page-turn', and previews). */
  'audio.play': { payload: { cue: string; gain?: number }; result: void };
  /** A stream of the effect sound (never the microphone), from the master bus after the muffle. */
  'audio.capture.start': { payload: { requester: string }; result: { stream: MediaStream } };
  'audio.capture.stop': { payload: { requester: string }; result: void };

  // ---------------------------------------------------------------- voice
  /** Download the on-device language pack. Call it straight from a click: install() needs the click's
   *  user activation, so the handler calls it before awaiting anything else. */
  'voice.install': { payload: undefined; result: { ok: boolean; message?: string } };

  // ---------------------------------------------------------------- share
  'share.link': { payload: { castId: string }; result: { url: string; hash: string } };
  'share.parse': { payload: { hash: string }; result: ReplayData };
  /** Play a replay (decoded link data, or a keepsake by cast id) through 'stage.replay'. Resolves when
   *  it has finished. */
  'share.replay': { payload: { data?: ReplayData; castId?: string }; result: { durationMs: number } };
  'share.card': { payload: { castId: string }; result: { blob: Blob; filename: string } };
  /** Record a clip of the live mirror, or with castId a replay of that keepsake. Publishes
   *  share.clip.state. Stops on its own at maxMs (default 10000). */
  'share.clip.start': { payload: { includeCamera: boolean; maxMs?: number; castId?: string }; result: void };
  /** Resolves with the clip, also when it already stopped on its own. */
  'share.clip.stop': { payload: undefined; result: { blob: Blob; filename: string; mime: string } };
  /** System share sheet where the browser can share this file, a download otherwise. Call it straight
   *  from a click (navigator.share needs user activation). */
  'share.file': { payload: { blob: Blob; filename: string; title?: string; text?: string }; result: ShareResult };
  'share.url': { payload: { url: string; title?: string; text?: string }; result: ShareResult };
  'keepsakes.list': { payload: { limit?: number } | undefined; result: Keepsake[] };
  'keepsakes.delete': { payload: { id: string }; result: void };

  // ---------------------------------------------------------------- storage
  // Storage serves every request from the end of its init(), opening IndexedDB lazily. When IndexedDB
  // is blocked, full or closed it switches to memory, keeps resolving, and says so in storage.status.
  // Values are structured-cloned on put (pass $state.snapshot(), not Svelte proxies). Requests reject
  // only with KernelError 'invalid-payload'.
  'storage.get': { payload: { store: StoreName; key: string }; result: unknown };
  'storage.put': { payload: { store: StoreName; key: string; value: unknown }; result: void };
  'storage.delete': { payload: { store: StoreName; key: string }; result: void };
  /** In ascending key order unless reverse. Keys made with newId() sort roughly by time. */
  'storage.list': { payload: { store: StoreName; limit?: number; reverse?: boolean; prefix?: string }; result: { key: string; value: unknown }[] };
  'storage.clear': { payload: { store?: StoreName }; result: void };
  /** Every store except 'sessions' unless stores says otherwise; settings are the player's own values. */
  'storage.export': { payload: { stores?: StoreName[] } | undefined; result: UserDataExport };
  /** merge (default: the newer savedAt wins) or replace. */
  'storage.import': { payload: { data: unknown; mode?: 'merge' | 'replace' }; result: { imported: Partial<Record<StoreName, number>>; settings: number } };
  'storage.status': { payload: undefined; result: StorageStatus };
  /** Ask the browser to keep the data (navigator.storage.persist()). */
  'storage.persist': { payload: undefined; result: { durable: boolean } };
}

export type RequestName = keyof RequestMap;
export type RequestPayload<N extends RequestName> = RequestMap[N]['payload'];
export type RequestResult<N extends RequestName> = RequestMap[N]['result'];
