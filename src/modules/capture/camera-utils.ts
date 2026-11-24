// Pure helpers for the capture module (blueprint Section 7.1). No browser state: the controller and the
// tip-finder page both use them, and the tests run them in Node.

import type { CameraError, CameraExposureInfo, CameraFrame, CameraProfile, CameraStatus } from '../../contracts';

// ---------------------------------------------------------------------------------------- types

/** MediaTrackSettings plus the Image Capture fields Chromium reports (not in the DOM library yet). */
export interface TrackSettings extends MediaTrackSettings {
  exposureMode?: string;
  /** 100 µs units. */
  exposureTime?: number;
  exposureCompensation?: number;
  resizeMode?: string;
}

export interface NumberRange {
  min: number;
  max: number;
  step?: number;
}

export interface TrackCapabilities extends MediaTrackCapabilities {
  exposureMode?: string[];
  exposureTime?: NumberRange;
  exposureCompensation?: NumberRange;
  resizeMode?: string[];
}

export interface ExposureConstraintSet {
  exposureMode?: string;
  exposureTime?: number;
  exposureCompensation?: number;
}

/** Constraints with resizeMode and Image Capture exposure, which the DOM library does not list. */
export type CameraConstraints = MediaTrackConstraints & {
  resizeMode?: ConstrainDOMString;
  advanced?: (MediaTrackConstraintSet & ExposureConstraintSet)[];
};

/** An exposure as capture applies it: 'manual' with a time, or 'continuous' with an optional bias. */
export interface ExposureTarget {
  mode: 'continuous' | 'manual';
  /** 100 µs units (Image Capture). */
  time?: number;
  compensation?: number;
}

// ---------------------------------------------------------------------------------------- devices

/**
 * Appendix A step 9 and Section 4: a face-unlock laptop may list its infrared camera as a second device,
 * and USB night-vision cameras say so in their names. Matches "IR" as a word ("Integrated IR Camera",
 * "HP IR Camera") but not inside words ("FireWire", "Iris").
 */
export function isInfraredLabel(label: string | undefined | null): boolean {
  if (!label) return false;
  return /(^|[^a-z0-9])(ir|nir|infra[\s-]?red)([^a-z0-9]|$)/i.test(label) || /night[\s-]?vision|\bnoir\b|windows hello/i.test(label);
}

/** The key a camera profile is stored under: the device id, or the label when ids are hidden. */
export function profileKey(deviceId: string | undefined | null, label: string | undefined | null): string {
  return deviceId || label || '';
}

// ---------------------------------------------------------------------------------------- constraints

/**
 * Section 7.1: ask for the preferred size and rate as ideal values (1920x1080, 60 fps by default, so a
 * camera that offers 60 fps gets it), never exact ones, so any camera opens. resizeMode 'none' keeps
 * Chrome from rescaling frames: a scaled frame blurs a glint only a few pixels wide (Section 4).
 */
export function videoConstraints(o: { deviceId?: string | null; width: number; height: number; fps: number }): CameraConstraints {
  const c: CameraConstraints = {
    width: { ideal: o.width },
    height: { ideal: o.height },
    frameRate: { ideal: o.fps },
    resizeMode: 'none',
  };
  if (o.deviceId) c.deviceId = { exact: o.deviceId };
  return c;
}

export function sizeConstraints(width: number, height: number, fps: number): CameraConstraints {
  return { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: fps }, resizeMode: 'none' };
}

/** Section 7.1 fallback size when the preferred one cannot reach capture.minFps. */
export const FALLBACK_SIZE = { width: 1280, height: 720 };

/** Section 7.9 steps the capture size down once: 1920x1080 to 1280x720, and on down for smaller cameras. */
const SIZE_LADDER: readonly { width: number; height: number }[] = [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 960, height: 540 },
  { width: 640, height: 360 },
];

export function nextLowerSize(width: number, height: number): { width: number; height: number } | null {
  for (const s of SIZE_LADDER) if (s.width < width && s.height < height) return { ...s };
  return null;
}

// ---------------------------------------------------------------------------------------- exposure

/** What exposure control the camera offers (Section 7.1: treat it as optional), or null. */
export function readExposureInfo(caps: TrackCapabilities | undefined | null, settings: TrackSettings | undefined | null): CameraExposureInfo | null {
  if (!caps) return null;
  const modes = Array.isArray(caps.exposureMode) ? caps.exposureMode.filter((m) => typeof m === 'string') : [];
  const time = validRange(caps.exposureTime);
  const comp = validRange(caps.exposureCompensation);
  if (!modes.length && !time && !comp) return null;
  const info: CameraExposureInfo = { modes };
  if (time) {
    info.min = time.min;
    info.max = time.max;
    if (time.step !== undefined) info.step = time.step;
  }
  if (comp) info.compensation = { min: comp.min, max: comp.max, step: comp.step ?? 0 };
  if (typeof settings?.exposureMode === 'string') info.mode = settings.exposureMode;
  if (typeof settings?.exposureTime === 'number') info.time = settings.exposureTime;
  return info;
}

function validRange(r: NumberRange | undefined): NumberRange | null {
  if (!r || typeof r.min !== 'number' || typeof r.max !== 'number' || !(r.max >= r.min)) return null;
  return { min: r.min, max: r.max, step: typeof r.step === 'number' && r.step > 0 ? r.step : undefined };
}

/** The exposure a track reports now. */
export function exposureState(s: TrackSettings | undefined | null): { mode: string; time?: number; compensation?: number } {
  const out: { mode: string; time?: number; compensation?: number } = { mode: typeof s?.exposureMode === 'string' ? s.exposureMode : 'continuous' };
  if (typeof s?.exposureTime === 'number') out.time = s.exposureTime;
  if (typeof s?.exposureCompensation === 'number') out.compensation = s.exposureCompensation;
  return out;
}

/** Clamp to a range and snap to its step. */
export function snap(value: number, range: { min: number; max: number; step?: number }): number {
  const v = Math.min(range.max, Math.max(range.min, value));
  const step = range.step && range.step > 0 ? range.step : 0;
  if (!step) return v;
  const snapped = range.min + Math.round((v - range.min) / step) * step;
  // Round away floating noise (steps like 0.333).
  return Math.min(range.max, Math.max(range.min, Math.round(snapped * 1e6) / 1e6));
}

/** An exposure time as a compensation, in stops relative to 1/30 s (a webcam's usual auto exposure). */
export function compensationForTime(time: number | undefined): number {
  if (!time || time <= 0) return 0;
  return Math.log2(time / 333);
}

/**
 * What to apply for a requested exposure on this camera, after clamping. A manual time on a camera
 * that offers only exposureCompensation becomes a negative bias on its automatic exposure (Section 7.1:
 * the control is optional and differs between cameras). null: the camera offers nothing that applies.
 */
export function resolveExposure(info: CameraExposureInfo | null, want: ExposureTarget): ExposureTarget | null {
  if (!info) return null;
  const hasManual = info.modes.includes('manual') && info.min !== undefined && info.max !== undefined;
  const comp = info.compensation;
  if (want.mode === 'manual') {
    if (hasManual) {
      const time = snap(want.time ?? info.time ?? 333, { min: info.min!, max: info.max!, step: info.step });
      return { mode: 'manual', time };
    }
    if (comp) return { mode: 'continuous', compensation: snap(want.compensation ?? compensationForTime(want.time), comp) };
    return null;
  }
  const out: ExposureTarget = { mode: 'continuous' };
  if (comp && typeof want.compensation === 'number') out.compensation = snap(want.compensation, comp);
  if (!info.modes.includes('continuous') && out.compensation === undefined) return null;
  return out;
}

/** The advanced constraint set for a resolved exposure. */
export function exposureConstraintSet(info: CameraExposureInfo | null, target: ExposureTarget): ExposureConstraintSet | null {
  if (!info) return null;
  const set: ExposureConstraintSet = {};
  if (info.modes.includes(target.mode)) set.exposureMode = target.mode;
  if (target.mode === 'manual' && target.time !== undefined) set.exposureTime = target.time;
  if (target.compensation !== undefined && info.compensation) set.exposureCompensation = target.compensation;
  return Object.keys(set).length ? set : null;
}

export function sameExposure(a: { mode?: string; time?: number; compensation?: number } | null, b: ExposureTarget): boolean {
  if (!a || a.mode !== b.mode) return false;
  if (b.mode === 'manual' && a.time !== b.time) return false;
  if (b.compensation !== undefined && a.compensation !== b.compensation) return false;
  return true;
}

// ---------------------------------------------------------------------------------------- errors

export const CONSENT_REQUIRED = 'ConsentRequired';

/** DOMException name to the CameraStatus state the shell shows. */
export function classifyError(name: string): CameraStatus['state'] {
  switch (name) {
    case CONSENT_REQUIRED:
      return 'off';
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'blocked';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'missing';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'busy';
    default:
      return 'error';
  }
}

/** One plain sentence per problem (Section 10.5: instructions stay plain; the blocked text is the blueprint's own). */
export function errorMessage(name: string, chosenDevice: boolean): string {
  switch (classifyError(name)) {
    case 'off':
      return 'Camera use has not been allowed yet.';
    case 'blocked':
      return 'Camera is blocked. Allow camera access in the address bar, then choose Try again.';
    case 'missing':
      return chosenDevice
        ? 'The chosen camera was not found. Plug it in, or choose another camera in Wand tuning.'
        : 'No camera found. Plug one in, then choose Try again.';
    case 'busy':
      return 'The camera is in use by another app. Close that app, then choose Try again.';
    default:
      return 'The camera could not start. Choose Try again.';
  }
}

export const MESSAGES = {
  ended: 'The camera stopped. Plug it back in, or choose another camera in Wand tuning.',
  /** The chosen camera is not connected, so the default one opened (capture.deviceId is kept). */
  defaultInstead: 'The chosen camera was not found, so the default camera is in use.',
  steppedDown: 'Frame rate low: capture size reduced',
  /** A step-down was asked for, but the camera kept its size (it offers no smaller mode). */
  noSmallerSize: 'Frames are slow, and this camera offers no smaller size.',
  dimRoom: 'Frames are slow because the camera lengthens its exposure in a dim room. Add light, or set the exposure in Wand tuning.',
  dimRoomNoControl: 'Frames are slow because the camera lengthens its exposure in a dim room. Add light to speed it up.',
  notOn: 'The camera is not on.',
  nobodyWaiting: 'Nothing is waiting for the camera.',
} as const;

/** A {name, message} pair for a rejection, keeping the DOMException name. */
export function cameraError(name: string, message?: string, chosenDevice = false): CameraError {
  return { name, message: message || errorMessage(name, chosenDevice) };
}

// ---------------------------------------------------------------------------------------- profiles

/** Loose shape check for a stored profile (storage owns migrations; this only guards against junk). */
export function isCameraProfile(v: unknown): v is CameraProfile {
  if (!v || typeof v !== 'object') return false;
  const p = v as Partial<CameraProfile>;
  return typeof p.deviceId === 'string' && typeof p.width === 'number' && typeof p.height === 'number' && (p.exposureMode === 'manual' || p.exposureMode === 'continuous');
}

/** The exposure a profile asks for, as a target. */
export function profileExposure(p: { exposureMode?: string; exposureTime?: number | null; exposureCompensation?: number | null } | null | undefined): ExposureTarget {
  if (p?.exposureMode === 'manual' && typeof p.exposureTime === 'number') return { mode: 'manual', time: p.exposureTime };
  const out: ExposureTarget = { mode: 'continuous' };
  if (typeof p?.exposureCompensation === 'number') out.compensation = p.exposureCompensation;
  return out;
}

// ---------------------------------------------------------------------------------------- frame times

/** A captureTime older than this, or in the future, is not trusted (some drivers report junk). */
const MAX_CAPTURE_AGE_MS = 1000;

/** How a frame's capture time is chosen ('capture', then 'presented', then 'callback'); frames.ts says why. */
export function frameTimestamp(
  meta: Pick<VideoFrameCallbackMetadata, 'captureTime' | 'expectedDisplayTime'> | null,
  perfNow: number,
  kernelNow: number,
): { t: number; timeSource: CameraFrame['timeSource'] } {
  const offset = kernelNow - perfNow;
  const ct = meta?.captureTime;
  if (typeof ct === 'number' && Number.isFinite(ct) && ct > 0) {
    const age = perfNow - ct;
    if (age >= -5 && age <= MAX_CAPTURE_AGE_MS) return { t: ct + offset, timeSource: 'capture' };
  }
  const edt = meta?.expectedDisplayTime;
  if (typeof edt === 'number' && Number.isFinite(edt) && edt > 0 && Math.abs(edt - perfNow) < MAX_CAPTURE_AGE_MS) {
    return { t: edt + offset, timeSource: 'presented' };
  }
  return { t: kernelNow, timeSource: 'callback' };
}
