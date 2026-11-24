// The capture module's logic (blueprint Section 7.1, Section 7.9), with the browser behind CameraBackend
// so the tests can drive it with a fake camera.
//
// One camera, shared. Requesters (the stage for the mirror, the running tracker for frames) are counted
// by name; the first opens the device, the rest get the same CameraReady. Every open, device switch and
// size change bumps the generation, and consumers rebind on 'camera.ready'.
//
// Rules from the contracts (contracts/requests.ts 'camera.*', contracts/events.ts CameraStatus):
//  - Nothing opens while 'capture.consent' is false. camera.start then rejects with ConsentRequired and
//    keeps the requester registered; when consent arrives every registered requester is served.
//  - A requester whose open failed stays registered. 'camera.retry', a permission change, a device
//    change or (for busy and missing cameras) a slow timer try again. The timer's attempts are quiet:
//    the status changes only when the outcome does.
//  - A requester whose module stops or fails is dropped without calling camera.stop.
//  - The device stays open LINGER_MS after the last release, so a tracker switch does not reopen it.
//  - 'capture.deviceId' is the only choice of device; changing it reopens the camera for everyone.
//    While the chosen camera is not connected the default one stands in, and the status says so.
//    Capture goes back to the chosen camera only once that one has opened, so the stand-in is never
//    dropped for a camera that does not start.
//  - A profile holds only what was saved for its camera, and those values are written back on each open.
//  - Exposure belongs to the camera profile only while a requester that asked for 'profile' (the bright
//    tip) holds the camera; otherwise continuous exposure, so the mirror and the hand tracker see a
//    normal image. 'camera.exposure' is the only way to change it.
// Opens, closes and constraint changes run one at a time (exclusive()), because each awaits the camera.
// The one open outside it is backToChosen's try of the chosen camera beside the stand-in, another device;
// the switch that follows runs inside it.

import type {
  CameraDevice, CameraError, CameraFrame, CameraProfile, CameraReady, CameraStatus, Kernel, ModuleStatus, SettingKey,
  SettingsMap, StorageChanged,
} from '../../contracts';
import { DATA_VERSION, DEFAULT_SETTINGS } from '../../contracts';
import { ask, describeError, emit, logger, on, serve, setSetting, setting } from '../../kernel';
import {
  CONSENT_REQUIRED, FALLBACK_SIZE, MESSAGES, cameraError, classifyError, exposureConstraintSet, exposureState, isCameraProfile,
  isInfraredLabel, nextLowerSize, profileExposure, profileKey, readExposureInfo, resolveExposure, sameExposure, sizeConstraints,
  videoConstraints, type CameraConstraints, type ExposureTarget, type TrackCapabilities, type TrackSettings,
} from './camera-utils';
import type { FramePumpLike } from './frames';

const ID = 'capture.camera';
const log = logger(ID);

/** Keep the device open this long after the last release (tracker switches). */
export const LINGER_MS = 1500;
/** Retry interval for a busy or missing camera while someone is waiting for it. */
export const RECOVERY_MS = 5000;
/** A slow storage never holds up the camera. */
const PROFILE_TIMEOUT_MS = 1000;
/** Section 7.9's frame-rate floor. */
const LOW_FPS = 20;
/** The per-camera values a profile holds besides its identity, size and exposure (contracts/storage.ts). */
const PROFILE_FIELDS = ['profile', 'flipX', 'k', 'floor', 'channel', 'minArea', 'maxArea', 'playArea'] as const;

// ---------------------------------------------------------------------------------------- backend

/** The parts of MediaStreamTrack the controller uses (Image Capture fields typed in camera-utils). */
export interface CameraTrack {
  readonly label: string;
  readonly readyState: MediaStreamTrackState;
  getSettings(): TrackSettings;
  getCapabilities?(): TrackCapabilities;
  applyConstraints(constraints: CameraConstraints): Promise<void>;
  stop(): void;
  addEventListener(type: 'ended', listener: () => void): void;
  removeEventListener(type: 'ended', listener: () => void): void;
}

export interface CameraBackend {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<{ deviceId: string; label: string; kind: string }[]>;
  /** Call fn on 'devicechange'; returns the unsubscribe function. */
  watchDevices(fn: () => void): () => void;
  /** Call fn with the camera permission state now (when known) and on every change. */
  watchPermission(fn: (state: CameraStatus['permission']) => void): () => void;
  createPump(onFrame: (frame: CameraFrame) => void): FramePumpLike;
}

function videoTrack(stream: MediaStream): CameraTrack | null {
  const t = stream.getVideoTracks?.()[0];
  return t ? (t as unknown as CameraTrack) : null;
}

function stopStream(stream: MediaStream): void {
  for (const t of stream.getTracks?.() ?? []) {
    try {
      t.stop();
    } catch {
      /* already stopped */
    }
  }
}

// ---------------------------------------------------------------------------------------- state

interface OpenCamera {
  stream: MediaStream;
  track: CameraTrack;
  ready: CameraReady;
  key: string;
  /** The stored profile for this camera, if any. */
  profile: CameraProfile | null;
  /** The exposure the bright tip uses on this camera: the profile's, or (no profile yet) the exposure
   *  settings, which the tip-finder page may have written (Appendix A: its numbers become the starting
   *  values). Applied only while a 'profile' requester holds the camera. */
  pref: ExposureTarget;
  /** The exposure the camera had when it opened: continuous exposure is restored to this. */
  baseline: ExposureTarget;
  /** What capture last applied (or found), for the status and to skip no-op changes. */
  applied: { mode: string; time?: number; compensation?: number };
  /** The chosen camera ('capture.deviceId') was not connected, so this is the default one. The setting
   *  is kept, and capture goes back to the chosen camera once it is connected again and opens
   *  (backToChosen). */
  fallback: boolean;
  onEnded: () => void;
}

type Requested = 'auto' | 'profile';

export class CameraController {
  private readonly requesters = new Map<string, Requested>();
  private cam: OpenCamera | null = null;
  private generation = 0;
  private status: CameraStatus = { state: 'off', generation: 0, permission: 'unknown', requesters: [] };
  private lock: Promise<unknown> = Promise.resolve();
  private opening: Promise<CameraReady> | null = null;
  private lingerTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private deviceTimer: ReturnType<typeof setTimeout> | null = null;
  /** The next try of a chosen camera that is connected but did not open, while the default one stands in. */
  private chosenTimer: ReturnType<typeof setTimeout> | null = null;
  private fpsTimer: ReturnType<typeof setInterval> | null = null;
  /** Sizes cameras were stepped down to this session (Section 7.9: once). */
  private readonly steppedDown = new Map<string, { width: number; height: number; fps: number }>();
  /** Cameras that offered no smaller size when a step-down was tried this session: not tried again. */
  private readonly noSmallerSize = new Set<string>();
  private readonly profiles = new Map<string, CameraProfile | null>();
  private readonly pump: FramePumpLike;
  private offs: (() => void)[] = [];
  private running = false;

  constructor(
    private readonly kernel: Kernel,
    private readonly backend: CameraBackend,
  ) {
    this.pump = backend.createPump((frame) => emit(kernel, ID, 'camera.frame', frame, frame.t));
  }

  /** init(): requests and the subscriptions that matter even before start(). */
  register(): void {
    const k = this.kernel;
    serve(k, 'camera.start', (p) => this.start(p));
    serve(k, 'camera.stop', (p) => {
      if (p && typeof p.requester === 'string') this.release(p.requester);
    });
    serve(k, 'camera.retry', () => this.retry());
    serve(k, 'camera.devices', () => this.devices());
    serve(k, 'camera.exposure', (p) => this.exposure(p));
    serve(k, 'camera.step-down', (p) => this.stepDown(p));
    serve(k, 'camera.profile.save', (p) => this.saveProfileRequest(p));
    on(k, 'settings.changed', ({ key }) => {
      if (key === 'capture.consent') this.onConsent();
      else if (key === 'capture.deviceId') this.onDeviceSetting();
    });
    on(k, 'module.status', (m: ModuleStatus) => {
      if ((m.state === 'stopped' || m.state === 'error') && this.requesters.has(m.id)) this.release(m.id);
    });
    on(k, 'storage.changed', (c: StorageChanged) => this.onStorageChanged(c));
    this.publishStatus(true);
  }

  /** start(): watch permission and devices, and serve requesters left from an earlier run. */
  begin(): void {
    if (this.running) return;
    this.running = true;
    this.offs.push(
      this.backend.watchPermission((permission) => this.onPermission(permission)),
      this.backend.watchDevices(() => this.onDevicesChanged()),
    );
    if (this.requesters.size && this.consent() && !this.cam) void this.ensureOpen().catch(() => undefined);
  }

  /** stop(): release the device at once. Requesters stay registered for the next start(). */
  async end(): Promise<void> {
    this.running = false;
    for (const off of this.offs) off();
    this.offs = [];
    this.cancelLinger();
    this.cancelRecovery();
    this.cancelChosenRetry();
    if (this.deviceTimer) clearTimeout(this.deviceTimer);
    this.deviceTimer = null;
    await this.exclusive(() => this.close('released'));
  }

  // ------------------------------------------------------------------------------------ requests

  async start(p: { requester: string; exposure?: 'auto' | 'profile' } | undefined): Promise<CameraReady> {
    const requester = p?.requester;
    if (typeof requester !== 'string' || !requester) throw cameraError('TypeError', 'camera.start needs a requester.');
    const want: Requested = p?.exposure === 'profile' ? 'profile' : 'auto';
    const before = this.requesters.get(requester);
    this.requesters.set(requester, want);
    this.cancelLinger();
    this.publishStatus();
    if (!this.consent()) {
      const e = cameraError(CONSENT_REQUIRED);
      this.publishStatus(false, { state: 'off', error: e, message: e.message });
      emit(this.kernel, ID, 'camera.error', e);
      throw e;
    }
    if (this.cam) {
      const cam = this.cam;
      if (before !== want) await this.exclusive(() => this.applyOwnership(cam));
      return cam.ready;
    }
    return this.ensureOpen();
  }

  release(requester: string): void {
    if (!this.requesters.delete(requester)) return;
    this.publishStatus();
    const cam = this.cam;
    // The last 'profile' requester gone: continuous exposure again, at once, even while the device lingers.
    if (cam) void this.exclusive(() => (this.cam === cam ? this.applyOwnership(cam) : Promise.resolve()));
    if (!this.requesters.size) {
      this.scheduleLinger();
      this.cancelRecovery();
    }
  }

  async retry(): Promise<CameraReady> {
    if (!this.consent()) {
      const e = cameraError(CONSENT_REQUIRED);
      emit(this.kernel, ID, 'camera.error', e);
      throw e;
    }
    if (this.cam) return this.cam.ready;
    if (!this.requesters.size) throw cameraError('InvalidStateError', MESSAGES.nobodyWaiting);
    return this.ensureOpen();
  }

  async devices(): Promise<CameraDevice[]> {
    try {
      const list = await this.backend.enumerateDevices();
      return list.filter((d) => d.kind === 'videoinput').map((d) => ({ deviceId: d.deviceId, label: d.label, infrared: isInfraredLabel(d.label) }));
    } catch (err) {
      throw describeError(err);
    }
  }

  async exposure(p: { requester: string; mode: 'continuous' | 'manual'; time?: number; compensation?: number }): Promise<{ mode: string; time?: number; compensation?: number }> {
    if (!p || (p.mode !== 'manual' && p.mode !== 'continuous')) throw cameraError('TypeError', "camera.exposure needs mode 'continuous' or 'manual'.");
    return this.exclusive(async () => {
      const cam = this.cam;
      if (!cam) throw cameraError('InvalidStateError', MESSAGES.notOn);
      const resolved = resolveExposure(cam.ready.exposure, { mode: p.mode, time: num(p.time), compensation: num(p.compensation) });
      if (!resolved) {
        // No exposure control on this camera (Section 7.1: optional). Report what it does.
        const s = exposureState(cam.track.getSettings());
        return { mode: s.mode, time: s.time, compensation: s.compensation };
      }
      // Stored in this camera's profile and mirrored into the settings...
      cam.pref = resolved;
      cam.profile = this.profileFor(cam, {
        exposureMode: resolved.mode,
        exposureTime: resolved.mode === 'manual' ? (resolved.time ?? null) : null,
        exposureCompensation: resolved.compensation ?? null,
      });
      this.storeProfile(cam.key, cam.profile);
      await this.writeSettings([
        ['capture.exposureMode', resolved.mode],
        ['capture.exposureTime', resolved.mode === 'manual' ? (resolved.time ?? null) : null],
      ]);
      // ...and applied now only while a requester that owns exposure holds the camera.
      if (this.cam === cam) await this.applyOwnership(cam);
      return { mode: resolved.mode, time: resolved.time, compensation: resolved.compensation };
    });
  }

  async stepDown(p: { requester: string; fps: number } | undefined): Promise<{ width: number; height: number } | null> {
    return this.exclusive(async () => {
      const cam = this.cam;
      if (!cam || this.steppedDown.has(cam.key) || this.noSmallerSize.has(cam.key)) return null;
      const s = cam.track.getSettings();
      const delivered = this.pump.fps;
      const nominal = s.frameRate ?? cam.ready.fps;
      // The camera itself delivers few frames although its mode is faster: continuous exposure has
      // lengthened the exposure in a dim room. A smaller size would not help; say what would.
      if (delivered > 0 && delivered < LOW_FPS && nominal >= 24 && cam.applied.mode !== 'manual') {
        this.publishStatus(false, { message: cam.ready.exposure ? MESSAGES.dimRoom : MESSAGES.dimRoomNoControl });
        return null;
      }
      const width = s.width ?? cam.ready.width;
      const height = s.height ?? cam.ready.height;
      const next = nextLowerSize(width, height);
      if (!next) return null;
      const fps = setting(this.kernel, 'capture.fps');
      const applied = await tryApply(cam.track, sizeConstraints(next.width, next.height, fps));
      // The size constraints are ideal values, so applyConstraints resolves even on a camera with no
      // smaller mode (one that offers a single size, as many virtual cameras do): only the track's
      // settings tell whether the size went down. If it did not, nothing changed for the consumers, so
      // there is no new generation, and the status says what happened instead of "capture size reduced".
      const after = cam.track.getSettings();
      const w = after.width ?? width;
      const h = after.height ?? height;
      if (!applied || w * h >= width * height) {
        this.noSmallerSize.add(cam.key);
        if (w !== width || h !== height) await tryApply(cam.track, sizeConstraints(width, height, s.frameRate ?? fps));
        log.info(`frame rate low (${Math.round(p?.fps ?? 0)} fps processed), and the camera offers no smaller size than ${width}x${height}`);
        this.publishStatus(false, { message: MESSAGES.noSmallerSize });
        return null;
      }
      this.steppedDown.set(cam.key, { width: w, height: h, fps });
      log.info(`frame rate low (${Math.round(p?.fps ?? 0)} fps processed): capture size reduced to ${w}x${h}`);
      // Some cameras reset exposure with a new format: apply it again.
      cam.applied = { mode: 'unknown' };
      await this.applyOwnership(cam);
      this.renew(cam);
      this.publishStatus(false, { steppedDown: true, message: MESSAGES.steppedDown });
      emit(this.kernel, ID, 'camera.ready', cam.ready);
      return { width: cam.ready.width, height: cam.ready.height };
    });
  }

  async saveProfileRequest(patch: Partial<CameraProfile> | undefined): Promise<CameraProfile> {
    return this.exclusive(async () => {
      const cam = this.cam;
      if (!cam) throw cameraError('InvalidStateError', MESSAGES.notOn);
      // No payload: Wand tuning's "Save for this camera", which keeps the values in effect now. A payload
      // changes only the fields it gives. The Threshold saves the route and the autotune its threshold; a
      // snapshot there would hold every other value as it was then, and since a profile's values are
      // written back on each open (applyProfileSettings), it would undo whatever the player changed later.
      // Exposure changes go through 'camera.exposure', the only write path; a save stores the exposure in
      // effect for this camera, whatever the payload says about it.
      const profile = this.profileFor(cam, patch == null ? this.currentValues() : profileFields(patch));
      cam.profile = profile;
      this.storeProfile(cam.key, profile);
      return profile;
    });
  }

  // ------------------------------------------------------------------------------------ opening

  private consent(): boolean {
    return setting(this.kernel, 'capture.consent') === true;
  }

  private ensureOpen(): Promise<CameraReady> {
    if (this.cam) return Promise.resolve(this.cam.ready);
    if (!this.opening) {
      const p = this.exclusive(() => this.doOpen());
      this.opening = p;
      const clear = () => {
        if (this.opening === p) this.opening = null;
      };
      p.then(clear, clear);
    }
    return this.opening;
  }

  private async doOpen(quiet = false): Promise<CameraReady> {
    if (this.cam) return this.cam.ready;
    // Before start() (or after stop()) nothing opens; begin() serves the registered requesters.
    if (!this.running) throw cameraError('AbortError', 'The camera is not ready yet.');
    if (!this.consent()) throw cameraError(CONSENT_REQUIRED);
    if (!this.requesters.size) throw cameraError('AbortError', MESSAGES.nobodyWaiting);
    const chosen = setting(this.kernel, 'capture.deviceId');
    // A quiet attempt (the recovery timer's) leaves the status alone until it has an answer. Publishing
    // 'requesting' every 5 s would swap "The camera is in use by another app... Try again" for "Opening
    // the camera" and back, hide the buttons for a moment and announce the problem again each time.
    if (!quiet) this.publishStatus(false, { state: 'requesting', error: undefined, message: undefined });

    let deviceId = chosen;
    let stream: MediaStream;
    try {
      stream = await this.openStream(deviceId);
    } catch (err) {
      if (!chosen || !(await this.isGone(err, chosen))) throw this.failed(err, !!chosen, quiet);
      // The chosen camera is not connected: unplugged, or an id from another browser (device ids are
      // per browser profile, so one imported with the player's data names no camera here). Use the
      // default camera and say so. The setting is kept, and capture goes back to the chosen camera once
      // it is connected again and opens (backToChosen).
      deviceId = null;
      try {
        stream = await this.openStream(null);
      } catch (err2) {
        throw this.failed(err2, false, quiet);
      }
    }
    return this.adopt(stream, deviceId, deviceId !== chosen, quiet);
  }

  /** getUserMedia for one camera (null: the default one) at the preferred size and rate (Section 7.1). */
  private openStream(deviceId: string | null): Promise<MediaStream> {
    const k = this.kernel;
    const video = videoConstraints({ deviceId, width: setting(k, 'capture.width'), height: setting(k, 'capture.height'), fps: setting(k, 'capture.fps') });
    return this.backend.getUserMedia({ audio: false, video });
  }

  /** Make an opened stream the camera everyone shares: its size, profile and exposure, then camera.ready. */
  private async adopt(stream: MediaStream, deviceId: string | null, fallback: boolean, quiet: boolean): Promise<CameraReady> {
    // The permission prompt may have been up for a while: is the camera still wanted?
    if (!this.consent() || !this.requesters.size || !this.running) {
      stopStream(stream);
      this.publishStatus(false, { state: 'off', error: undefined, message: undefined });
      throw cameraError('AbortError', MESSAGES.nobodyWaiting);
    }
    const track = videoTrack(stream);
    if (!track) {
      stopStream(stream);
      throw this.failed({ name: 'NotFoundError', message: '' }, !!deviceId, quiet);
    }

    const fps = setting(this.kernel, 'capture.fps');
    await this.reachMinFps(track, fps);
    const first = track.getSettings();
    const key = profileKey(first.deviceId ?? deviceId, track.label);
    const profile = await this.loadProfile(key);
    // A size this camera was stepped down to this session, or its profile's working size.
    const size = this.steppedDown.get(key) ?? (profile ? { width: profile.width, height: profile.height, fps: profile.fps || fps } : null);
    if (size && (size.width !== first.width || size.height !== first.height)) await tryApply(track, sizeConstraints(size.width, size.height, size.fps));

    const s = track.getSettings();
    const caps = typeof track.getCapabilities === 'function' ? safe(() => track.getCapabilities!()) : undefined;
    const label = track.label ?? '';
    this.generation++;
    const ready: CameraReady = {
      deviceId: s.deviceId ?? deviceId ?? '',
      label,
      width: s.width ?? 0,
      height: s.height ?? 0,
      fps: s.frameRate ?? 0,
      stream,
      exposure: readExposureInfo(caps, s),
      infrared: isInfraredLabel(label),
      generation: this.generation,
    };
    const baseline = exposureState(s);
    const cam: OpenCamera = {
      stream,
      track,
      ready,
      key,
      profile,
      pref: profile
        ? profileExposure(profile)
        : profileExposure({ exposureMode: setting(this.kernel, 'capture.exposureMode'), exposureTime: setting(this.kernel, 'capture.exposureTime') }),
      baseline: { mode: 'continuous', compensation: typeof baseline.compensation === 'number' ? baseline.compensation : undefined },
      applied: baseline,
      fallback,
      onEnded: () => this.onEnded(cam),
    };
    this.cam = cam;
    track.addEventListener('ended', cam.onEnded);

    await this.applyOwnership(cam);
    await this.applyProfileSettings(cam);
    if (this.cam !== cam) throw cameraError('AbortError', MESSAGES.nobodyWaiting);

    this.cancelRecovery();
    this.publishStatus(false, {
      state: 'on', deviceId: ready.deviceId, label, width: ready.width, height: ready.height, fps: undefined,
      exposure: cam.applied, steppedDown: this.steppedDown.has(key) || undefined, error: undefined,
      message: fallback ? MESSAGES.defaultInstead : undefined,
    });
    emit(this.kernel, ID, 'camera.ready', ready);
    this.pump.bind(stream, ready.generation);
    this.startFpsTimer();
    return ready;
  }

  /** Section 7.1: if the preferred size cannot reach capture.minFps, try 1280x720. */
  private async reachMinFps(track: CameraTrack, fps: number): Promise<void> {
    const minFps = setting(this.kernel, 'capture.minFps');
    const s = track.getSettings();
    if ((s.frameRate ?? minFps) >= minFps || (s.height ?? 0) <= FALLBACK_SIZE.height) return;
    if (!(await tryApply(track, sizeConstraints(FALLBACK_SIZE.width, FALLBACK_SIZE.height, fps)))) return;
    const after = track.getSettings();
    // The smaller size was no faster: go back to the sharper picture.
    if ((after.frameRate ?? 0) <= (s.frameRate ?? 0) && s.width && s.height) await tryApply(track, sizeConstraints(s.width, s.height, fps));
  }

  /** Report a failed open: status, camera.error, and a recovery plan. Returns the {name, message}. */
  private failed(err: unknown, chosenDevice: boolean, quiet: boolean): CameraError {
    const d = describeError(err);
    const e = cameraError(d.name, undefined, chosenDevice);
    const state = classifyError(e.name);
    // A quiet attempt left the status as it was, so it still says how the last attempt failed. Failing
    // the same way again is no news: no new status and no new camera.error.
    const repeat = quiet && this.status.error?.name === e.name && this.status.state === state;
    if (!repeat) {
      this.publishStatus(false, { state, error: e, message: e.message, width: undefined, height: undefined, fps: undefined });
      emit(this.kernel, ID, 'camera.error', e);
    }
    if (d.message) log.info(`camera did not open: ${d.name}: ${d.message}`);
    this.scheduleRecovery(state);
    return e;
  }

  /** The open of the chosen camera failed because no such camera is connected now. */
  private async isGone(err: unknown, deviceId: string): Promise<boolean> {
    // An unknown exact deviceId rejects with OverconstrainedError (NotFoundError in some browsers).
    if (classifyError(describeError(err).name) !== 'missing') return false;
    try {
      const list = await this.backend.enumerateDevices();
      return !list.some((d) => d.kind === 'videoinput' && d.deviceId === deviceId);
    } catch {
      return false;
    }
  }

  private async close(reason: 'released' | 'switching' | 'ended' | 'error', next: CameraStatus['state'] = 'off'): Promise<void> {
    const cam = this.cam;
    if (!cam) return;
    this.cam = null;
    this.stopFpsTimer();
    this.pump.unbind();
    cam.track.removeEventListener('ended', cam.onEnded);
    stopStream(cam.stream);
    emit(this.kernel, ID, 'camera.stopped', { reason, generation: cam.ready.generation });
    this.publishStatus(false, { state: next, width: undefined, height: undefined, fps: undefined, exposure: undefined, steppedDown: undefined });
  }

  /** The same track at a new size: a new generation for consumers. */
  private renew(cam: OpenCamera): void {
    const s = cam.track.getSettings();
    this.generation++;
    cam.ready = { ...cam.ready, width: s.width ?? cam.ready.width, height: s.height ?? cam.ready.height, fps: s.frameRate ?? cam.ready.fps, generation: this.generation };
    this.pump.setGeneration(this.generation);
    this.publishStatus(false, { width: cam.ready.width, height: cam.ready.height });
  }

  // ------------------------------------------------------------------------------------ exposure

  private ownsExposure(): boolean {
    for (const v of this.requesters.values()) if (v === 'profile') return true;
    return false;
  }

  /** Profile exposure while a 'profile' requester holds the camera, else continuous (the baseline). */
  private async applyOwnership(cam: OpenCamera): Promise<void> {
    const target = this.ownsExposure() ? cam.pref : cam.baseline;
    const resolved = resolveExposure(cam.ready.exposure, target);
    if (!resolved || sameExposure(cam.applied, resolved)) return;
    const set = exposureConstraintSet(cam.ready.exposure, resolved);
    if (!set) return;
    const before = cam.track.getSettings();
    try {
      await cam.track.applyConstraints({ advanced: [set] });
    } catch (err) {
      log.warn('the camera refused an exposure change', describeError(err));
      return;
    }
    const after = cam.track.getSettings();
    // applyConstraints replaces the whole constraint set in some browsers: put the size back if it moved.
    if (before.width && before.height && (after.width !== before.width || after.height !== before.height)) {
      await tryApply(cam.track, sizeConstraints(before.width, before.height, before.frameRate ?? setting(this.kernel, 'capture.fps')));
    }
    const live = exposureState(cam.track.getSettings());
    // Some cameras report the new values only later; the request is the better answer meanwhile.
    cam.applied = { mode: resolved.mode, time: resolved.time ?? live.time, compensation: resolved.compensation ?? live.compensation };
    if (this.cam === cam) this.publishStatus(false, { exposure: cam.applied });
  }

  // ------------------------------------------------------------------------------------ profiles

  private async loadProfile(key: string): Promise<CameraProfile | null> {
    if (!key) return null;
    if (this.profiles.has(key)) return this.profiles.get(key) ?? null;
    try {
      const value = await withTimeout(ask(this.kernel, 'storage.get', { store: 'profiles', key }), PROFILE_TIMEOUT_MS);
      const profile = isCameraProfile(value) ? value : null;
      this.profiles.set(key, profile);
      return profile;
    } catch {
      // Storage absent, blocked or slow: run without a profile (Section 7.9).
      return null;
    }
  }

  private storeProfile(key: string, profile: CameraProfile): void {
    this.profiles.set(key, profile);
    ask(this.kernel, 'storage.put', { store: 'profiles', key, value: profile }).catch((err) => log.info('camera profile not saved', describeError(err).message));
  }

  /** The current bright-tip and play-area values, as a profile stores them. */
  private currentValues(): Partial<CameraProfile> {
    const k = this.kernel;
    return {
      profile: setting(k, 'brightTip.profile'),
      flipX: setting(k, 'capture.flipX'),
      k: setting(k, 'brightTip.k'),
      floor: setting(k, 'brightTip.floor'),
      channel: setting(k, 'brightTip.channel'),
      minArea: setting(k, 'brightTip.minArea'),
      maxArea: setting(k, 'brightTip.maxArea'),
      playArea: setting(k, 'playArea'),
    };
  }

  /** A full profile for this camera: the stored one, the exposure and size now, then patch. */
  private profileFor(cam: OpenCamera, patch: Partial<CameraProfile>): CameraProfile {
    const s = cam.track.getSettings();
    return {
      // A camera without a profile starts from its identity, size and exposure only, never from the
      // current settings: whatever a profile holds is written back on every open.
      ...(cam.profile ?? {}),
      exposureMode: cam.pref.mode,
      exposureTime: cam.pref.mode === 'manual' ? (cam.pref.time ?? null) : null,
      exposureCompensation: cam.pref.compensation ?? null,
      ...patch,
      dataVersion: DATA_VERSION,
      deviceId: cam.ready.deviceId || cam.key,
      label: cam.ready.label,
      width: s.width ?? cam.ready.width,
      height: s.height ?? cam.ready.height,
      fps: s.frameRate ?? cam.ready.fps,
      savedAt: Date.now(),
    };
  }

  /**
   * After each open: the per-camera values into the settings, so the tracker and the segmenter use what
   * worked for this camera. Only the fields the profile holds are written, and brightTip.profile, when
   * no profile names a route, comes from CameraReady.infrared. Everything else stays as it is, so the
   * tip-finder page's numbers remain the starting values.
   */
  private async applyProfileSettings(cam: OpenCamera): Promise<void> {
    const p = cam.profile;
    const writes: [SettingKey, unknown][] = [['brightTip.profile', p?.profile === 'infrared' || p?.profile === 'visible' ? p.profile : cam.ready.infrared ? 'infrared' : 'visible']];
    if (p) {
      for (const [field, key] of [['k', 'brightTip.k'], ['floor', 'brightTip.floor'], ['minArea', 'brightTip.minArea'], ['maxArea', 'brightTip.maxArea']] as const) {
        if (typeof p[field] === 'number' && Number.isFinite(p[field])) writes.push([key, p[field]]);
      }
      if (p.channel === 'luma' || p.channel === 'r' || p.channel === 'g' || p.channel === 'b') writes.push(['brightTip.channel', p.channel]);
      if (typeof p.flipX === 'boolean') writes.push(['capture.flipX', p.flipX]);
      if (isPlayArea(p.playArea)) writes.push(['playArea', p.playArea]);
      writes.push(['capture.exposureMode', cam.pref.mode], ['capture.exposureTime', cam.pref.mode === 'manual' ? (cam.pref.time ?? null) : null]);
    }
    await this.writeSettings(writes);
  }

  private async writeSettings(writes: [SettingKey, unknown][]): Promise<void> {
    for (const [key, value] of writes) {
      const current = this.kernel.setting(key, (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key]);
      if (JSON.stringify(current) === JSON.stringify(value)) continue;
      await setSetting(this.kernel, key, value as SettingsMap[typeof key]).catch((err) => log.warn(`could not set ${key}`, describeError(err).message));
    }
  }

  // ------------------------------------------------------------------------------------ events

  private onConsent(): void {
    if (this.consent()) {
      if (this.requesters.size && !this.cam && this.running) void this.ensureOpen().catch(() => undefined);
      return;
    }
    // Consent withdrawn: close, and say why while anyone is still waiting.
    void this.exclusive(async () => {
      await this.close('released');
      if (this.requesters.size) {
        const e = cameraError(CONSENT_REQUIRED);
        this.publishStatus(false, { state: 'off', error: e, message: e.message });
      }
    });
  }

  /** 'capture.deviceId' changed: stop, reopen once for every requester, new generation. */
  private onDeviceSetting(): void {
    void this.exclusive(async () => {
      if (this.cam) await this.close('switching', 'requesting');
      if (!this.requesters.size || !this.consent() || !this.running) return;
      try {
        await this.doOpen();
      } catch {
        /* reported by doOpen */
      }
    });
  }

  private onEnded(cam: OpenCamera): void {
    void this.exclusive(async () => {
      if (this.cam !== cam) return;
      // The player took the permission back (Chrome ends the track): blocked, not missing.
      if (this.status.permission === 'denied') {
        await this.close('ended', 'blocked');
        this.reportBlocked();
        return;
      }
      // Unplugged, or taken away by the system: wait for it to come back.
      await this.close('ended', 'missing');
      const e = cameraError('NotFoundError', MESSAGES.ended);
      this.publishStatus(false, { state: 'missing', error: e, message: e.message });
      emit(this.kernel, ID, 'camera.error', e);
      this.scheduleRecovery('missing');
    });
  }

  private onPermission(permission: CameraStatus['permission']): void {
    this.publishStatus(false, { permission });
    if (permission === 'granted' && !this.cam && this.requesters.size && this.consent() && this.running && this.status.state === 'blocked') {
      void this.ensureOpen().catch(() => undefined);
    }
    // Taken back after the track had already ended (the events can come in either order): a camera
    // that "went missing" was blocked, and retrying cannot help until the permission changes again.
    if (permission === 'denied' && !this.cam && this.requesters.size && ['missing', 'busy', 'error'].includes(this.status.state)) {
      this.reportBlocked();
    }
  }

  private reportBlocked(): void {
    this.cancelRecovery();
    const e = cameraError('NotAllowedError');
    this.publishStatus(false, { state: 'blocked', error: e, message: e.message });
    emit(this.kernel, ID, 'camera.error', e);
  }

  private onDevicesChanged(): void {
    if (this.deviceTimer) clearTimeout(this.deviceTimer);
    // Devices arrive in bursts; let them settle.
    this.deviceTimer = setTimeout(() => {
      this.deviceTimer = null;
      const waiting = ['missing', 'busy', 'error'].includes(this.status.state);
      if (!this.cam && waiting && this.requesters.size && this.consent() && this.running && !this.opening) {
        void this.ensureOpen().catch(() => undefined);
      } else if (this.cam?.fallback) {
        void this.backToChosen(this.cam);
      }
    }, 600);
  }

  /**
   * The default camera stands in for the chosen one: switch once the chosen one is connected and has
   * opened. It is opened before the stand-in closes, so a camera that is connected but does not start
   * (another app holds it, or it is still waking up after being plugged in) costs the working one
   * nothing. Such a camera is tried again quietly every RECOVERY_MS while it stays connected, since no
   * device change says when the other app lets go; one that is not connected waits for the next device
   * change. Only the switch runs in exclusive(): the chosen camera is another device, and requests for
   * the stand-in need not wait while it starts.
   */
  private async backToChosen(cam: OpenCamera): Promise<void> {
    const chosen = setting(this.kernel, 'capture.deviceId');
    if (this.cam !== cam || !chosen) return;
    // A device change does not wait for the next timed try.
    this.cancelChosenRetry();
    let listed = false;
    try {
      listed = (await this.backend.enumerateDevices()).some((d) => d.kind === 'videoinput' && d.deviceId === chosen);
    } catch {
      /* the list could not be read: stay with the default camera */
    }
    if (!listed || this.cam !== cam) return;
    // Nothing opens without consent. While nobody holds the camera (between two trackers) or the choice
    // is changing, ask again later; retryChosen gives up once this camera no longer stands in.
    const wanted = () => setting(this.kernel, 'capture.deviceId') === chosen && this.consent() && this.requesters.size > 0 && this.running;
    if (!wanted()) {
      this.retryChosen(cam);
      return;
    }
    let stream: MediaStream;
    try {
      stream = await this.openStream(chosen);
    } catch (err) {
      log.info(`the chosen camera is connected but did not open: ${describeError(err).name}`);
      this.retryChosen(cam);
      return;
    }
    await this.exclusive(async () => {
      if (this.cam !== cam || !wanted()) {
        stopStream(stream);
        this.retryChosen(cam);
        return;
      }
      // The same switch as a new choice of camera; the setting has not changed, so nothing else would.
      await this.close('switching', 'requesting');
      try {
        await this.adopt(stream, chosen, false, false);
      } catch {
        /* reported by adopt */
      }
    });
  }

  private onStorageChanged(c: StorageChanged): void {
    if (!c.stores.includes('profiles') || c.reason === 'put') return;
    // An import or a clear: forget cached profiles and take this camera's afresh.
    this.profiles.clear();
    const cam = this.cam;
    if (!cam) return;
    void this.exclusive(async () => {
      if (this.cam !== cam) return;
      cam.profile = await this.loadProfile(cam.key);
      if (cam.profile) cam.pref = profileExposure(cam.profile);
      await this.applyOwnership(cam);
      await this.applyProfileSettings(cam);
    });
  }

  // ------------------------------------------------------------------------------------ timers

  private scheduleLinger(): void {
    this.cancelLinger();
    if (!this.cam && !this.opening) return;
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      if (!this.requesters.size) void this.exclusive(() => this.close('released'));
    }, LINGER_MS);
  }

  private cancelLinger(): void {
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
  }

  private scheduleRecovery(state: CameraStatus['state']): void {
    // A blocked camera waits for the permission to change or for Try again (retrying could prompt).
    if (state === 'blocked' || state === 'off' || this.recoveryTimer || !this.running) return;
    this.recoveryTimer = setInterval(() => {
      if (this.cam || !this.requesters.size || !this.consent() || !this.running) {
        this.cancelRecovery();
        return;
      }
      if (this.opening || !['missing', 'busy', 'error'].includes(this.status.state)) return;
      const p = this.exclusive(() => this.doOpen(true));
      this.opening = p;
      const clear = () => {
        if (this.opening === p) this.opening = null;
      };
      p.then(clear, clear);
    }, RECOVERY_MS);
  }

  private cancelRecovery(): void {
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    this.recoveryTimer = null;
  }

  /** Try the chosen camera again in a while, as long as cam still stands in for it. One timer at most;
   *  a late answer for a stand-in that has gone leaves the current one's timer alone. */
  private retryChosen(cam: OpenCamera): void {
    if (this.cam !== cam || !this.running) return;
    this.cancelChosenRetry();
    this.chosenTimer = setTimeout(() => {
      this.chosenTimer = null;
      void this.backToChosen(cam);
    }, RECOVERY_MS);
  }

  private cancelChosenRetry(): void {
    if (this.chosenTimer) clearTimeout(this.chosenTimer);
    this.chosenTimer = null;
  }

  private startFpsTimer(): void {
    this.stopFpsTimer();
    this.fpsTimer = setInterval(() => {
      if (!this.cam) return;
      const fps = Math.round(this.pump.fps);
      if (fps !== this.status.fps) this.publishStatus(false, { fps });
    }, 1000);
  }

  private stopFpsTimer(): void {
    if (this.fpsTimer) clearInterval(this.fpsTimer);
    this.fpsTimer = null;
  }

  // ------------------------------------------------------------------------------------ status

  /** Publish the sticky camera.status when anything in it changed (or when forced). */
  private publishStatus(force = false, patch: Partial<CameraStatus> = {}): void {
    const next: CameraStatus = { ...this.status, ...patch, generation: this.generation, requesters: [...this.requesters.keys()].sort() };
    // Drop cleared fields, so the published object (and the comparison) has no undefined members.
    const fields = next as unknown as Record<string, unknown>;
    for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];
    if (!force && JSON.stringify(next) === JSON.stringify(this.status)) return;
    this.status = next;
    emit(this.kernel, ID, 'camera.status', next);
  }

  /** Run camera work one piece at a time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.lock.then(fn, fn);
    this.lock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// ---------------------------------------------------------------------------------------- helpers

async function tryApply(track: CameraTrack, c: CameraConstraints): Promise<boolean> {
  try {
    await track.applyConstraints(c);
    return true;
  } catch (err) {
    log.info('the camera refused a size change', describeError(err));
    return false;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** The per-camera fields a partial 'camera.profile.save' gives. Identity, size and exposure are capture's. */
function profileFields(patch: Partial<CameraProfile>): Partial<CameraProfile> {
  const out: Record<string, unknown> = {};
  for (const field of PROFILE_FIELDS) if (patch[field] !== undefined) out[field] = patch[field];
  return out as Partial<CameraProfile>;
}

function isPlayArea(v: unknown): v is SettingsMap['playArea'] {
  if (!v || typeof v !== 'object') return false;
  const a = v as Record<string, unknown>;
  return ['x', 'y', 'w', 'h'].every((k) => typeof a[k] === 'number' && Number.isFinite(a[k] as number));
}
