// How the app sees the wand (Section 4's routes), and the camera and tracker states in plain words
// (Sections 7.9 and 10.5). The Threshold screen and the Mirror's notes share these, so a player reads
// the same sentence for the same situation everywhere.

import type { CameraStatus, ModuleManifest, ModuleState, SettingsMap, TrackerStatus } from '../../../contracts';

/** 'wand' follows the wand in the hand that holds it (the hand tracker's wand mode); 'glint' the lit tip
 *  alone (the bright-tip tracker with a light beside the lens, route A); 'infrared' the same with an infrared
 *  camera (route C); 'hand' the hand or fingertip (route B); 'pointer' the mouse or a finger on the glass. */
export type Route = 'wand' | 'hand' | 'glint' | 'infrared' | 'pointer';

export interface RouteInfo {
  id: Route;
  title: string;
  text: string;
  /** The text in the desktop app, where it differs (the hand model comes with the app there). */
  desktopText?: string;
  /** Module that must be usable for this route. */
  tracker: 'tracker.bright-tip' | 'tracker.hand' | 'tracker.pointer';
  /** What else the route sets: the bright tip's profile. (The hand tracker's mode goes by handModeFor.) */
  settings?: { 'brightTip.profile'?: 'visible' | 'infrared' };
  camera: boolean;
}

export const ROUTES: readonly RouteInfo[] = [
  {
    id: 'wand',
    title: 'The tip of my wand',
    text: 'Hold your wand up in front of you: the camera finds the hand that holds it, then the wand. Ordinary room light will do. A 23 MB model downloads once.',
    desktopText: 'Hold your wand up in front of you: the camera finds the hand that holds it, then the wand. Ordinary room light will do.',
    tracker: 'tracker.hand',
    camera: true,
  },
  {
    id: 'hand',
    title: 'My hand or finger',
    text: 'No wand needed: your index finger is the wand. A 23 MB model downloads once.',
    desktopText: 'No wand needed: your index finger is the wand. Its model comes with the app.',
    tracker: 'tracker.hand',
    camera: true,
  },
  {
    id: 'glint',
    title: "The glint of my wand's tip",
    text: 'A small light touching the bezel beside the lens makes the tip glint, and the camera follows the glint alone. Best in a dim room.',
    tracker: 'tracker.bright-tip',
    settings: { 'brightTip.profile': 'visible' },
    camera: true,
  },
  {
    id: 'infrared',
    title: 'An infrared camera',
    text: 'A camera ringed with infrared lights, as in the parks. The steadiest choice.',
    tracker: 'tracker.bright-tip',
    settings: { 'brightTip.profile': 'infrared' },
    camera: true,
  },
  {
    id: 'pointer',
    title: 'Mouse or touch (no camera)',
    text: 'Trace spells on the mirror with the pointer. The camera stays off.',
    tracker: 'tracker.pointer',
    camera: false,
  },
];

/** The route the settings describe now. */
export function currentRoute(s: SettingsMap): Route {
  const t = s['tracker.active'];
  if (t === 'tracker.hand') return s['hand.mode'] === 'wand' ? 'wand' : 'hand';
  if (t === 'tracker.bright-tip') return s['brightTip.profile'] === 'infrared' ? 'infrared' : 'glint';
  return 'pointer';
}

/** A route's description. */
export function routeInfo(id: Route): RouteInfo {
  return ROUTES.find((r) => r.id === id) ?? ROUTES[ROUTES.length - 1];
}

/** The route follows the hand (and the wand in it, in wand mode): the hand tracker's lines apply. */
export function handRoute(route: Route): boolean {
  return routeInfo(route).tracker === 'tracker.hand';
}

/**
 * The hand tracker's mode a route asks for, given the mode now, or null to leave it as it is. The wand
 * route is wand mode. The hand route keeps the player's own choice of the fingertip or the point past the
 * knuckles (Wand tuning), unless it comes from wand mode, which it turns to the fingertip. The Threshold
 * and Wand tuning both choose routes through this, so they cannot disagree.
 */
export function handModeFor(route: Route, current: unknown): 'wand' | 'finger' | null {
  if (route === 'wand') return current === 'wand' ? null : 'wand';
  if (route === 'hand') return current === 'wand' ? 'finger' : null;
  return null;
}

/** The hand tracker in wand mode has found the wand (contracts 1.3 TrackerStatus.wand): seen in half or
 *  more of the last second's frames with a hand, or its place in the hand learned. Not learned alone: fair finds, or finds
 *  on a hand the model is unsure of, are followed without teaching the place. */
export function wandFound(t: TrackerStatus | null | undefined): boolean {
  const w = t?.wand;
  return !!w && (w.learned || w.seen >= 0.5);
}

type ModuleRow = { manifest: ModuleManifest; state: ModuleState; reason?: string };

/** Why a route cannot be used in this browser, as a plain sentence, or null when it can. */
export function routeUnavailable(route: RouteInfo, modules: readonly ModuleRow[]): string | null {
  const row = modules.find((m) => m.manifest.id === route.tracker);
  if (!row) return route.camera ? 'Not part of this edition.' : null;
  // A tracker that failed to start can be tried again; only one the browser cannot run is shut.
  if (row.state !== 'unavailable') return null;
  const reason = row.reason ?? '';
  if (/platform\.camera|camera\.frames/.test(reason)) {
    const secure = typeof window === 'undefined' || window.isSecureContext !== false;
    return secure
      ? 'This browser cannot open a camera.'
      : 'Cameras need a secure address. Open Spellglass from its https link, or on localhost.';
  }
  if (route.tracker === 'tracker.hand') return 'This browser cannot run the hand model.';
  return 'Not available in this browser.';
}

export type Tone = 'ok' | 'wait' | 'warn' | 'error';

export interface StatusLine {
  tone: Tone;
  text: string;
  /** 0..1 while something downloads. */
  progress?: number;
}

/** Glyphs that tell the tones apart by shape as well as color (Section 10.6). */
export const TONE_GLYPH: Record<Tone, string> = { ok: '✓', wait: '…', warn: '!', error: '✕' };

export const TEXT = {
  blocked: 'Camera is blocked. Allow camera access in the address bar, then choose Try again.',
  /** The desktop app has no address bar: there a block comes from the computer's privacy settings. */
  blockedDesktop: "Camera is blocked. Allow Spellglass to use the camera in your computer's privacy settings, then choose Try again.",
  missing: 'No camera found. Plug one in, then choose Try again.',
  busy: 'The camera is in use by another app. Close that app, then choose Try again.',
  failed: 'The camera could not start. Choose Try again.',
  opening: 'Opening the camera. If the browser asks, choose Allow.',
  openingDesktop: 'Opening the camera. If your computer asks, choose Allow.',
  tipNotFound: 'Wand tip not found. Point the tip at the camera and switch on the light beside the lens.',
  handNotFound: 'Hand not found. Hold your hand up where the camera can see it, in good light.',
  /** The wand route: the hand that holds the wand is what the camera looks for first. */
  wandHandNotFound: 'Hand not found. Hold the wand up where the camera can see it, and the hand holding it, in good light.',
  /** The hand tracker's 'wand-not-seen' (contracts 1.3): the hand is held, but no wand found in it for 3 s. */
  wandNotSeen: 'Hand found, but not the wand. Hold it up across the camera, not pointed at it, with a plain wall behind if you can.',
  /** The hand tracker's 'hand-too-small' (contracts 1.2): wrist to middle knuckle under 5% of the frame's width. */
  handTooSmall: 'Your hand looks small to the camera. Step closer, or zoom the camera in.',
  /** Webcams that track the player (the Insta360 Link 2, for one) pan and zoom the picture under the tip. */
  followingCamera: 'If your camera follows or reframes you on its own (AI tracking, auto-framing), turn that off in its app while you play.',
  tooManyLights: 'Too many bright lights in view. Dim the lamps behind you, or tune the wand.',
  coachHold: 'Hold still, trace the spell, then hold still again.',
  coachPen: 'Press on the mirror, trace the spell, then let go.',
} as const;

/** The camera is in a state the player has to fix (Section 7.9). */
export function cameraTrouble(c: CameraStatus | null | undefined): boolean {
  if (!c) return false;
  return c.state === 'blocked' || c.state === 'missing' || c.state === 'busy' || c.state === 'error' || c.error?.name === 'NotAllowedError';
}

/** The camera matters: the route's tracker needs it, or the player wants a reflection (Sections 7.8
 *  and 10.1; 'capture.mirror' asks for one, once the camera is allowed). */
export function cameraWanted(s: SettingsMap): boolean {
  return currentRoute(s) !== 'pointer' || (s['capture.mirror'] === true && s['capture.consent'] === true);
}

export interface Chip {
  state: 'on' | 'warn' | 'error' | 'off';
  text: string;
}

/**
 * The camera chip of the status area (Section 10.3). A problem is shown only while something wants the
 * camera: once the player has chosen mouse or touch and nothing asks for it, a blocked or missing camera
 * is simply off, and a red chip would warn of a problem they chose to avoid. Capture keeps the last
 * problem in its status even after every requester has gone (it never opened a device to close).
 */
export function cameraChip(c: CameraStatus | null | undefined, wanted: boolean, infrared = false): Chip {
  const requested = (c?.requesters?.length ?? 0) > 0;
  if (cameraTrouble(c) && !wanted && !requested) return { state: 'off', text: 'camera off' };
  if (c?.error?.name === 'NotAllowedError') return { state: 'error', text: 'camera blocked' };
  switch (c?.state) {
    case 'on':
      return { state: 'on', text: infrared ? 'infrared camera on' : 'camera on' };
    case 'requesting':
      return { state: 'warn', text: 'opening camera' };
    case 'blocked':
      return { state: 'error', text: 'camera blocked' };
    case 'missing':
      return { state: 'error', text: 'no camera' };
    case 'busy':
      return { state: 'error', text: 'camera in use' };
    case 'error':
      return { state: 'error', text: 'camera problem' };
    default:
      return { state: 'off', text: 'camera off' };
  }
}

/** One plain sentence for the camera, or null when there is nothing to say. In the desktop app the
 *  words point at the computer's privacy settings, since there is no address bar. */
export function cameraLine(c: CameraStatus | null | undefined, desktop = false): StatusLine | null {
  if (!c) return null;
  if (c.error?.name === 'NotAllowedError' || c.state === 'blocked') return { tone: 'error', text: desktop ? TEXT.blockedDesktop : TEXT.blocked };
  switch (c.state) {
    case 'requesting':
      return { tone: 'wait', text: desktop ? TEXT.openingDesktop : TEXT.opening };
    case 'on':
      return { tone: 'ok', text: 'Camera on.' };
    case 'missing':
      // Capture says more when a chosen camera vanished or the camera stopped; both are plain.
      return { tone: 'error', text: c.message && /chosen camera|camera stopped/i.test(c.message) ? c.message : TEXT.missing };
    case 'busy':
      return { tone: 'error', text: TEXT.busy };
    case 'error':
      return { tone: 'error', text: TEXT.failed };
    default:
      return null;
  }
}

/** One plain sentence for the tracker of a route, or null when there is nothing to say. */
export function trackerLine(t: TrackerStatus | null | undefined, route: Route): StatusLine | null {
  if (route === 'pointer') return { tone: 'ok', text: 'Mouse or touch is ready. Press on the mirror, trace a spell, then let go.' };
  const want = routeInfo(route).tracker;
  if (!t || t.tracker !== want) return { tone: 'wait', text: route === 'hand' ? 'Starting the hand tracker.' : 'Starting the wand tracker.' };
  if (t.state === 'error') return { tone: 'error', text: t.message || (route === 'hand' ? 'The hand tracker stopped.' : 'The wand tracker stopped.') };
  if (handRoute(route)) {
    if (t.state === 'loading') {
      // The percentage goes in the progress bar, not the sentence: a live region would read every step.
      const p = typeof t.progress === 'number' ? Math.max(0, Math.min(1, t.progress)) : 0;
      const starting = t.message === 'Hand model starting' || p >= 0.9;
      return { tone: 'wait', text: starting ? 'Hand model starting.' : 'Hand model loading. It downloads once, then works offline.', progress: p };
    }
    // Said while the hand is found, too: a small hand is found in fewer and fewer frames.
    if (t.hint === 'hand-too-small') return { tone: 'warn', text: TEXT.handTooSmall };
    if (route === 'wand') {
      if (t.hint === 'wand-not-seen') return { tone: 'warn', text: TEXT.wandNotSeen };
      if (t.state === 'tracking') {
        return wandFound(t)
          ? { tone: 'ok', text: 'Wand found. Hold still, then trace a spell.' }
          : { tone: 'wait', text: 'Hand found. Now hold the wand up so the camera sees all of it.' };
      }
      if (t.hint === 'hand-not-found') return { tone: 'warn', text: TEXT.wandHandNotFound };
      if (t.state === 'starting') return { tone: 'wait', text: 'The wand tracker is waiting for the camera.' };
      return { tone: 'wait', text: 'Looking for your wand. Hold it up where the camera can see it.' };
    }
    if (t.state === 'tracking') return { tone: 'ok', text: 'Hand found. Your index finger is the wand.' };
    if (t.hint === 'hand-not-found') return { tone: 'warn', text: TEXT.handNotFound };
    if (t.state === 'starting') return { tone: 'wait', text: 'The hand tracker is waiting for the camera.' };
    return { tone: 'wait', text: 'Looking for your hand. Hold it up where the camera can see it.' };
  }
  if (t.state === 'tracking') return { tone: 'ok', text: 'Wand found. Hold still, then trace a spell.' };
  if (t.hint === 'too-many-lights') return { tone: 'warn', text: TEXT.tooManyLights };
  if (t.hint === 'tip-not-found') return { tone: 'warn', text: TEXT.tipNotFound };
  if (t.state === 'starting' || t.state === 'loading') return { tone: 'wait', text: 'The wand tracker is waiting for the camera.' };
  return { tone: 'wait', text: 'Looking for the wand tip. Point it at the camera.' };
}
