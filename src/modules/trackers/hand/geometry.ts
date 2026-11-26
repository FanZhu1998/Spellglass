// Pure geometry of the hand tracker (Section 7.3): where the "wand tip" is, given MediaPipe's 21 hand
// landmarks. The worker sends landmarks as the model gives them: normalized to the frame it was fed
// (x 0..1 left to right and y 0..1 top to bottom of the raw, unmirrored camera image; z is depth, unused
// here). Everything below works on that flat array, so it is tested without a model or a browser.
//
// Two tip definitions (Section 7.3):
//  - Finger mode: the index fingertip (landmark 8) is the wand. Best for visitors without a wand.
//  - Grip mode: a point projected forward from the knuckles of the hand holding the wand. The blueprint
//    says it needs tuning in the first milestone; this is the starting geometry:
//
//        wrist W = landmark 0
//        knuckles K = mean of the index, middle, ring and pinky knuckles (landmarks 5, 9, 13, 17)
//        hand length L = |landmark 9 - landmark 0| (wrist to middle knuckle)
//        tip = K + reach · L · (K - W) / |K - W|          reach = setting 'hand.gripReach'
//
//    in isotropic units (pixels, not per-axis fractions), so the projection points the same way the hand
//    does on screen. The knuckles stay put whether the fingers are open or curled around a wand, which is
//    why they, not the fingertips, anchor the projection, and why L is wrist to knuckle (a full hand is
//    about 1.8 L). Projecting forward turns a turn of the wrist into a larger sweep of the virtual tip, as
//    a real wand does; a wand pointed at the camera foreshortens the projection, which is the main thing
//    to tune against recordings.
//
// The collapsed finger (finger mode). In a quick flick the camera blurs the index finger, and the model,
// which still finds the hand, can put landmark 8 down on the fist: for a frame or a few the tip jumps a
// finger's length back toward the palm, and the stroke gets a hook the player never drew. The landmarks
// themselves show it: the finger (knuckle 5 to tip 8) is suddenly much shorter than it has just been,
// measured against the palm (wrist 0 to middle knuckle 9), which blur hardly shortens. In such a frame
// the tip is better guessed from the palm, which the model still places well:
//
//        finger F = landmark 8 - landmark 5        palm P = landmark 9 - landmark 0      (isotropic)
//        ratio = |F| / |P|
//        tip = landmark 5 + F', where F' is the finger F of the last frame that was not collapsed,
//              turned by the angle P has turned since and scaled by |P now| / |P then|
//
// fingerShape and carriedFingerTip below are that arithmetic; when a frame counts as collapsed is the
// tracker's per-frame state (tracking.ts). Measured with MediaPipe on clips of a real hand photo moved
// along the spells' paths with speed blur (the hand study, collapse.mts and estimators.mts): the tip's
// error in fast motion fell from 0.069 to 0.037 frame widths (95th percentile), and the rule fired on
// none of more than 2,200 still frames. A line fitted through landmarks 5 to 8 did no better than
// landmark 8 alone, so it is not used.
//
// Caster space (Section 6): x is flipped once, here at the source, when the camera image is unmirrored
// (setting 'capture.flipX'); y is unchanged. TipSample.size is the hand's scale: wrist-to-middle-knuckle
// distance ÷ frame width (contracts/v1.ts).

/** MediaPipe hand landmark indices used here. */
export const LANDMARK = {
  WRIST: 0,
  INDEX_MCP: 5,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  RING_MCP: 13,
  PINKY_MCP: 17,
} as const;

export const LANDMARK_COUNT = 21;

/** Landmarks as [x0, y0, z0, x1, y1, z1, ...], normalized to the frame (unmirrored). */
export type FlatLandmarks = ArrayLike<number>;

export interface Point2 {
  x: number;
  y: number;
}

/** 'wand': the tip of the wand held in the hand, found in the frame (wand.ts, tracking.ts WandTip); before the
 *  wand has been seen, the grip projection stands in for it. */
export type HandMode = 'finger' | 'grip' | 'wand';

const KNUCKLES = [LANDMARK.INDEX_MCP, LANDMARK.MIDDLE_MCP, LANDMARK.RING_MCP, LANDMARK.PINKY_MCP] as const;

/** Bounds on the grip reach, so a mistyped setting cannot throw the tip off the frame. */
export const MIN_REACH = 0;
export const MAX_REACH = 4;

export function isValidLandmarks(lm: FlatLandmarks | null | undefined): lm is FlatLandmarks {
  if (!lm || lm.length < LANDMARK_COUNT * 3) return false;
  for (let i = 0; i < LANDMARK_COUNT * 3; i++) if (!Number.isFinite(lm[i])) return false;
  return true;
}

/** Landmark i in frame-normalized coordinates. */
export function landmark(lm: FlatLandmarks, i: number): Point2 {
  return { x: lm[i * 3], y: lm[i * 3 + 1] };
}

/** Landmark i in isotropic units of frame width: x unchanged, y scaled by height ÷ width. */
function iso(lm: FlatLandmarks, i: number, aspect: number): Point2 {
  return { x: lm[i * 3], y: lm[i * 3 + 1] / aspect };
}

/** Wrist to middle knuckle ÷ frame width: the hand's scale (TipSample.size for the hand tracker). */
export function handSize(lm: FlatLandmarks, aspect: number): number {
  const a = iso(lm, LANDMARK.WRIST, aspect);
  const b = iso(lm, LANDMARK.MIDDLE_MCP, aspect);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Finger mode: the index fingertip. */
export function fingerTip(lm: FlatLandmarks): Point2 {
  return landmark(lm, LANDMARK.INDEX_TIP);
}

/** The index finger and the palm of one frame, in isotropic units of frame width (see the header). */
export interface FingerShape {
  /** Knuckle 5 to fingertip 8. */
  finger: Point2;
  /** Wrist 0 to middle knuckle 9. */
  palm: Point2;
  /** |finger| ÷ |palm|: how long the finger looks for the hand it is on. */
  ratio: number;
}

/** The finger and palm vectors of a hand, and the finger's length for the palm's (the header's ratio).
 *  `aspect` is the frame's width ÷ height. */
export function fingerShape(lm: FlatLandmarks, aspect: number): FingerShape {
  const knuckle = iso(lm, LANDMARK.INDEX_MCP, aspect);
  const tip = iso(lm, LANDMARK.INDEX_TIP, aspect);
  const wrist = iso(lm, LANDMARK.WRIST, aspect);
  const middle = iso(lm, LANDMARK.MIDDLE_MCP, aspect);
  const finger = { x: tip.x - knuckle.x, y: tip.y - knuckle.y };
  const palm = { x: middle.x - wrist.x, y: middle.y - wrist.y };
  return { finger, palm, ratio: Math.hypot(finger.x, finger.y) / Math.max(1e-6, Math.hypot(palm.x, palm.y)) };
}

/** Where the fingertip would be if the finger still looked as it did in `good`: knuckle 5 plus the
 *  finger of `good`, turned as the palm has turned since and scaled as it has grown or shrunk (the
 *  header). Frame-normalized and unflipped, like fingerTip. */
export function carriedFingerTip(lm: FlatLandmarks, good: FingerShape, aspect: number): Point2 {
  const knuckle = iso(lm, LANDMARK.INDEX_MCP, aspect);
  const palm = fingerShape(lm, aspect).palm;
  const was = Math.hypot(good.palm.x, good.palm.y);
  const now = Math.hypot(palm.x, palm.y);
  let fx = good.finger.x, fy = good.finger.y;
  // A palm of no length has no direction: carry the finger as it was rather than spin it.
  if (was > 1e-6 && now > 1e-6) {
    const turn = Math.atan2(palm.y, palm.x) - Math.atan2(good.palm.y, good.palm.x);
    const c = Math.cos(turn) * (now / was), s = Math.sin(turn) * (now / was);
    fx = good.finger.x * c - good.finger.y * s;
    fy = good.finger.x * s + good.finger.y * c;
  }
  return { x: knuckle.x + fx, y: (knuckle.y + fy) * aspect };
}

/** Grip mode: `reach` hand lengths beyond the knuckles, along the wrist-to-knuckles direction (see the
 *  header). `aspect` is the frame's width ÷ height. */
export function gripTip(lm: FlatLandmarks, reach: number, aspect: number): Point2 {
  const r = Number.isFinite(reach) ? Math.min(MAX_REACH, Math.max(MIN_REACH, reach)) : 0.9;
  const w = iso(lm, LANDMARK.WRIST, aspect);
  let kx = 0, ky = 0;
  for (const i of KNUCKLES) {
    const p = iso(lm, i, aspect);
    kx += p.x;
    ky += p.y;
  }
  kx /= KNUCKLES.length;
  ky /= KNUCKLES.length;
  const dx = kx - w.x, dy = ky - w.y;
  const d = Math.hypot(dx, dy);
  const length = handSize(lm, aspect);
  // A degenerate hand (wrist on the knuckles): the knuckles themselves are the best guess.
  const tx = d > 1e-6 ? kx + (dx / d) * r * length : kx;
  const ty = d > 1e-6 ? ky + (dy / d) * r * length : ky;
  return { x: tx, y: ty * aspect };
}

/** The tip for finger or grip mode, in frame-normalized coordinates (not yet flipped). Wand mode needs the
 *  frame as well as the landmarks: tracking.ts WandTip. */
export function tipFor(lm: FlatLandmarks, mode: Exclude<HandMode, 'wand'>, reach: number, aspect: number): Point2 {
  return mode === 'grip' ? gripTip(lm, reach, aspect) : fingerTip(lm);
}

/** Frame-normalized to caster space: flip x once, when the camera image is not already mirrored. */
export function toCaster(p: Point2, flipX: boolean): Point2 {
  return { x: flipX ? 1 - p.x : p.x, y: p.y };
}

/** All 21 landmarks in caster space, for 'tracker.debug' (contracts/events.ts TrackerDebugFrame). */
export function landmarksToCaster(lm: FlatLandmarks, flipX: boolean): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < LANDMARK_COUNT; i++) {
    const p = toCaster(landmark(lm, i), flipX);
    out.push([round(p.x, 4), round(p.y, 4)]);
  }
  return out;
}

/**
 * Confidence of the tip, 0..1. The landmark model reports a presence score per landmark when it has one;
 * the hand landmarker in this version leaves it out, so the handedness score (how sure the model is that
 * this is a hand, and which one) stands in. MediaPipe already drops hands under its presence threshold
 * (0.5), so a published hand is at least that likely.
 */
export function tipConfidence(handednessScore: number | undefined, tipPresence: number | undefined): number {
  const v = typeof tipPresence === 'number' && tipPresence > 0 ? tipPresence : handednessScore;
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0.5;
  return round(Math.min(1, Math.max(0, v)), 3);
}

export function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
