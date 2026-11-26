// The hand tracker's per-frame rules, pure, so the tip event rules can be tested without a model:
//  - a frame with a hand gives a TipSample in caster space (geometry.ts); the first one after a loss is
//    preceded by tip.found with the same t (rule 2);
//  - a processed frame without a hand, captured LOST_AFTER_MS (400 ms) or more after the last sample,
//    declares tip.lost at its own capture time, with lastSeen (rule 3). Time rather than a count of
//    frames: the landmarker misses runs of frames while a hand moves fast or blurs and finds it again on
//    the next sharp one, and a count is a different time at every rate (the three frames this used to
//    wait were 50 ms at 60 fps and 200 ms at 15). A frame with no hand before then changes nothing: the
//    hand is still held, and the stroke goes on when it is seen again;
//  - SEGMENTATION: what these samples need from the segmenter, published with every tracker.status
//    (contracts/events.ts SegmentationNeeds), so the segmenter bridges the same gaps instead of ending
//    the stroke in them, and copes with the hand's lower frame rate and slower corners. The loss rule and
//    these needs were measured together (the noise study: hand-like tip streams with jitter, tremor,
//    dropouts and stalls at 15 to 60 fps, through the real segmenter, recognizer and decision rule, on
//    held-out seeds): casts cast correctly went from 69.6% to 98.3% over its noise grid, and from 77.8%
//    to 99.5% with realistic noise at 30 fps, while the six recorded bright-tip sessions decided as
//    before. The needs without the loss rule reached only 77.1%: most failures were strokes cut by the
//    tracker's own tip.lost;
//  - finger mode: a collapsed finger (geometry.ts) is replaced by the finger carried on the palm, for at
//    most COLLAPSE_MAX_MS; a finger that stays short longer than that is curled, and is followed, with
//    the finger's window started afresh from it;
//  - lock, fps and stepMs over the last second; the 'hand-not-found' hint after 3 s without a confident
//    hand (Section 7.9), counted from the first processed frame so loading does not count; and the
//    'hand-too-small' hint, decided on the frames with a hand from the hand's median size over the last
//    second (SMALL_HAND, below), which a short loss of the tip does not clear.

import type { SegmentationNeeds, TipSample } from '../../../contracts';
import {
  carriedFingerTip, fingerShape, fingerTip, gripTip, handSize, isValidLandmarks, landmarksToCaster, round, tipConfidence, toCaster,
  type FingerShape, type FlatLandmarks, type HandMode, type Point2,
} from './geometry';
import type { HandWire, WandWire } from './protocol';
import { fromGrip, gripFrame, toGrip, type GripFrame } from './wand';

/** A frame without a hand this long (capture time) after the last sample declares the tip lost. 400 ms
 *  bridges the runs of missed frames of a blurred or briefly hidden hand (the noise study swept 200 to
 *  600 ms), and a hand that has really gone is still let go of within half a second. */
export const LOST_AFTER_MS = 400;

/** segmenter.lostMs for these samples: longer than LOST_AFTER_MS plus a frame, so the tracker's own
 *  tip.lost, at the frame that declared it, ends a stroke whose hand has gone; the segmenter's gap rule
 *  then only covers frames that stop coming at all (a stall). The settings' 200 ms would end every
 *  stroke at the first longer dropout. */
export const SEGMENTER_LOST_MS = 500;
/** segmenter.minSamples for these samples: a flick of a third of a second gives 5 to 7 samples at 15 to
 *  20 fps, under the 8 the settings ask of a camera at 30 fps or more (on clean input at 15 fps, 11% of
 *  casts were thrown away as too short); 5 still leaves out a twitch. */
export const SEGMENTER_MIN_SAMPLES = 5;
/** segmenter.pauseMs for these samples: a finger slows almost to a stop at a sharp corner, and with the
 *  settings' 250 ms 1% of casts (7% for a tracer who stops at corners) ended there; 300 ms roughly
 *  halves that. Longer pauses cost decision time and, with a jittery hand, strokes that do not end. */
export const SEGMENTER_PAUSE_MS = 300;
/** What the hand's samples need from the segmenter (contracts/events.ts SegmentationNeeds). */
export const SEGMENTATION: Readonly<SegmentationNeeds> = Object.freeze({
  lostMs: SEGMENTER_LOST_MS,
  minSamples: SEGMENTER_MIN_SAMPLES,
  pauseMs: SEGMENTER_PAUSE_MS,
});

/** Section 7.9: "After 3 s without a tip it shows the 'tip not found' hint" ('hand-not-found' here). */
export const HINT_AFTER_MS = 3000;
/** A sample at or above this confidence counts toward lock and resets the hint clock. */
export const CONFIDENT = 0.5;

/** 'hand-too-small' when the median hand size (TipSample.size: wrist to middle knuckle ÷ frame width)
 *  over the last second falls under this: below about 5% of the frame width the landmarker finds the
 *  hand in fewer and fewer frames (the hand study: a hand at 3.8% was found in 45% of the frames of a
 *  trace and cast 1 spell in 30). A wide or 4K webcam makes a hand that small at 1.5 to 2 m. */
export const SMALL_HAND = 0.05;
/** ... and clears at this or more, so a hand near the line does not make the hint flicker. */
export const SMALL_HAND_CLEAR = 0.055;
/** Samples the last second must hold before the size is judged either way. */
export const SIZE_MIN_SAMPLES = 3;

/** A finger shorter than this share of its recent median length (for the palm's) is collapsed. */
export const COLLAPSE_SHARE = 0.6;
/** The median is over this many frames with a hand (half a second at 30 fps)... */
export const COLLAPSE_WINDOW = 15;
/** ... and needs at least this many before any frame is judged. */
export const COLLAPSE_MIN_FRAMES = 3;
/** A finger short for longer than this (capture time) is curled, not blurred: it is followed again, and
 *  the window starts afresh from it, so the curled finger is what later frames are judged by. A blurred
 *  flick collapses for a frame or a few. */
export const COLLAPSE_MAX_MS = 400;

export interface TrackingSettings {
  mode: HandMode;
  reach: number;
  flipX: boolean;
}

export interface ProcessedFrame {
  t: number;
  frame: number;
  width: number;
  height: number;
  hand: HandWire | null;
  stepMs: number;
  /** Wand mode: what the worker found (protocol.ts). */
  wand?: WandWire | null;
}

/** Where a wand-mode tip came from: the shaft seen in this frame, a glint at its end, the wand's learned
 *  place in the hand or where it was last seen in it (carried), or the grip projection before the wand
 *  has been seen in this hold. */
export type WandSource = 'shaft' | 'glint' | 'carried' | 'grip';

export interface FrameOutcome {
  /** Publish before `sample`. */
  found?: TipSample;
  sample?: TipSample;
  lost?: { t: number; lastSeen?: number };
  /** The 21 landmarks in caster space, when a hand was seen (for 'tracker.debug'). */
  landmarks?: [number, number][];
  /** Wand mode: the shaft found in this frame and where the tip came from, caster space (for
   *  'tracker.debug'). */
  wand?: { base?: [number, number]; tip: [number, number]; quality: number; source: WandSource };
}

// ------------------------------------------------------------------------------------------ wand mode

/** A find of this quality or more is the tip (wand.ts quality)... */
export const WAND_USE = 0.35;
/** ... and one of this quality or more may teach the tracker where the tip sits in the hand. */
export const WAND_LEARN = 0.5;
/** A find this far from the learned place (palm lengths, in the hand's own frame) is doubted: a crossing
 *  stick, a door frame lined up with the grip. The tip is carried instead... */
export const WAND_DOUBT = 0.6;
/** ... unless this many finds in a row agree with each other there: the player has changed their grip. */
export const WAND_REGRIP = 3;
/** A find this sure (wand.ts quality) and at least a palm long is the tip even far from the learned place:
 *  in a fast stroke the landmarker places a blurred hand badly, so a find on the shaft can look far from
 *  where the wand sits in the hand while the shaft itself is plain (wand clips: two in every quick flick
 *  were carried over as doubtful, though each was within 0.008 frame widths of the tip). */
export const WAND_SURE = 0.8;
/** Only a hand this sure (MediaPipe's handedness score) teaches the tip's place in it: a blurred hand's
 *  landmarks would teach a wrong one. */
export const WAND_STEADY_HAND = 0.9;
/** When the shaft is lost (a fast stroke smears it), the carried tip starts where the shaft was last seen and
 *  the step to the learned place fades out over about this long (capture time), so the stroke gets no kink.
 *  When the shaft is seen again the tip goes straight to it: the frames in between were the guess, and
 *  holding the tip near a guess only stretches its error over the next frames (measured with the hand
 *  model on wand clips: a flick whose hand blurred out of sight for 170 ms came back 0.09 frame widths
 *  off with the fade, and on the shaft without it). */
export const WAND_SETTLE_MS = 120;
/** No fade across a gap of frames this long: a step then is the hand gone and back, not a change of source. */
export const WAND_GAP_MS = 150;
/** Nor for a step longer than this (palm lengths, in the hand's frame): the learned place lags a find by a
 *  fraction of a palm, and a step of more than a palm means the hand's frame itself jumped (a hand coming
 *  into view, or blurred, is placed badly for a frame or two, and the same point then has other grip
 *  coordinates). Shorter steps fade: in a blurred stroke the next frames' hands are placed badly in the
 *  same way, and keeping the step keeps the tip near where it was seen (wand clips at 1/30 s: tip error at
 *  the 95th percentile 0.011 frame widths fading steps up to a palm, 0.019 fading only those under 0.35). */
export const WAND_FADE_MAX = 1;
/** 'wand-not-seen' when the hand is held and no shaft has been found for this long (kernel time). */
export const WAND_HINT_MS = 3000;

const dist = (p: { a: number; b: number }, q: { a: number; b: number }) => Math.hypot(p.a - q.a, p.b - q.b);

/**
 * Wand mode's tip (wand.ts finds the shaft in a frame; this follows it from frame to frame). The tip is
 * kept in the hand's own frame (grip coordinates: palm lengths from the anchor, along and across the palm),
 * where a wand held still in the hand stays put however the hand moves. So:
 *  - a frame whose shaft is found gives the tip directly (or its glint, when the tip is lit), and teaches
 *    the tip's place in the hand, an average that follows a wand turned in the fingers;
 *  - a frame without one (a fast stroke smears the shaft; the shaft points at the camera; something
 *    hides it) carries the learned place on the hand, which the landmarker still finds: a flick of the
 *    wrist turns the hand, and the carried tip sweeps with it, as the real one does. Before the place is
 *    learned, the place where the wand was last seen in this hold is carried instead;
 *  - before the wand has been seen in a hold, the grip projection (geometry.ts gripTip) stands in;
 *  - a find cut off by the frame's edge reaches at least the learned length, and teaches nothing;
 *  - a fair find far from the learned place is doubted, and carried over, until a few agree (a new grip),
 *    and is then the tip; a sure one (WAND_SURE) is taken at once, since then it is the blurred hand that
 *    is placed badly. Only a steady hand (WAND_STEADY_HAND) teaches the place;
 *  - when the shaft is lost, the step to the carried tip fades out over WAND_SETTLE_MS (a short step only,
 *    WAND_FADE_MAX); when it is seen, after a guess or after the glint at its end, the tip goes straight to it.
 */
export class WandTip {
  private place: { a: number; b: number } | null = null;
  /** Finds averaged into `place` (capped), so a long-learned place is not thrown away by one frame. */
  private weight = 0;
  private doubt: { a: number; b: number; n: number } | null = null;
  /** Last output, in grip coordinates, its source and capture time; the fading step. */
  private last: { a: number; b: number } | null = null;
  private lastSource: WandSource | null = null;
  private lastT: number | null = null;
  private offset = { a: 0, b: 0 };

  /** Forget everything (a new camera, a mode switch). */
  reset(): void {
    this.place = null;
    this.weight = 0;
    this.restart();
  }

  /** A new hold of the tip: the learned place stays (the player still holds the wand the same way), but
   *  counts for less, so a changed grip is learned quickly. */
  restart(): void {
    this.weight = Math.min(this.weight, WAND_REGRIP);
    this.doubt = null;
    this.last = null;
    this.lastSource = null;
    this.lastT = null;
    this.offset = { a: 0, b: 0 };
  }

  /** What the worker should search around next: the learned place, once there is one. */
  prior(): { a: number; b: number } | null {
    return this.place && this.weight >= 2 ? { a: round(this.place.a, 4), b: round(this.place.b, 4) } : null;
  }

  /**
   * The tip for one frame with a hand: frame-normalized and unflipped (as geometry.ts fingerTip), with its
   * source and the find's quality (0 when none was used).
   */
  tip(lm: FlatLandmarks, aspect: number, wand: WandWire | null | undefined, t: number, reach: number, handScore = 1): { p: Point2; source: WandSource; quality: number } {
    // Isotropic frame widths: x as is, y ÷ aspect (geometry.ts), a uniform scale of the pixels.
    const g = gripFrame(lm, 3, 1, 1 / aspect);
    let raw: { a: number; b: number } | null = null;
    let source: WandSource = 'grip';
    let quality = 0;
    if (wand && wand.quality >= WAND_USE && Number.isFinite(wand.tip[0]) && Number.isFinite(wand.tip[1])) {
      const lit = wand.glint && litTip(g, wand, aspect);
      const at = lit ? wand.glint! : wand.tip;
      let h = toGrip(g, at[0], at[1] / aspect);
      // A cut find ends where the shaft ran out of the frame: the tip is at least that far along the shaft,
      // and as far as the learned place when that reaches further. It teaches nothing (learning from such
      // finds shortened the wand in the hand by half a palm in four frames, and every carried tip after).
      if (wand.cut && !lit && this.place && this.weight >= 2) {
        const b = toGrip(g, wand.base[0], wand.base[1] / aspect);
        const dl = Math.hypot(h.a - b.a, h.b - b.b);
        if (dl > 1e-9) {
          const da = (h.a - b.a) / dl, db = (h.b - b.b) / dl;
          const on = (this.place.a - h.a) * da + (this.place.b - h.b) * db;
          if (on > 0) h = { a: h.a + on * da, b: h.b + on * db };
        }
      }
      const teach = wand.quality >= WAND_LEARN && handScore >= WAND_STEADY_HAND && !wand.cut;
      const far = this.place !== null && this.weight >= WAND_REGRIP && dist(h, this.place) > WAND_DOUBT;
      if (far && wand.cut) {
        // Cut off by the frame and far from where the wand sits: carried over, and no step towards a new
        // grip (a room's shelves run off the frame too, and such a bar once passed for a sure find).
      } else if (far && wand.quality >= WAND_SURE && wand.length >= 1) {
        // Plainly the shaft, though not where the wand sits in the hand: the hand is what is off.
        raw = h;
      } else if (far) {
        // Far from where the wand has been: carried over unless a few finds in a row agree. Once they have
        // (a new grip, followed but not taught on an unsure hand), one noisy find does not undo it.
        const agreeWithin = this.doubt && this.doubt.n >= WAND_REGRIP ? WAND_DOUBT : WAND_DOUBT / 2;
        if (this.doubt && dist(h, this.doubt) < agreeWithin) {
          this.doubt = { a: (this.doubt.a + h.a) / 2, b: (this.doubt.b + h.b) / 2, n: this.doubt.n + 1 };
        } else {
          this.doubt = { ...h, n: 1 };
        }
        if (this.doubt.n >= WAND_REGRIP) {
          // A few finds in a row agree: the wand is held another way, and is the tip from now on. Only a
          // steady hand teaches its place; on an unsteady one the finds are followed meanwhile (otherwise
          // the tip stayed on the old place, and the player was told the wand was not seen, while it was
          // found in every frame).
          raw = h;
          if (teach) {
            this.place = { a: h.a, b: h.b };
            this.weight = WAND_REGRIP;
            this.doubt = null;
          }
        }
      } else {
        this.doubt = null;
        raw = h;
        if (teach) {
          if (!this.place) {
            this.place = { a: h.a, b: h.b };
            this.weight = 1;
          } else {
            // A quick average for a good find, a slower one for a fair one.
            const k = wand.quality >= 0.6 ? 0.3 : 0.15;
            this.place = { a: this.place.a + k * (h.a - this.place.a), b: this.place.b + k * (h.b - this.place.b) };
            this.weight = Math.min(30, this.weight + 1);
          }
        }
      }
      if (raw) {
        source = lit ? 'glint' : 'shaft';
        quality = wand.quality;
      }
    }
    if (!raw) {
      const lastSeen = this.lastSource === 'shaft' || this.lastSource === 'glint';
      if (this.last && lastSeen && this.doubt && this.doubt.n >= WAND_REGRIP) {
        // A new grip followed but not taught (an unsure hand): carry where the wand was last seen, not the
        // old place (that stepped a tenth of the frame there and back at every smeared frame).
        raw = { a: this.last.a - this.offset.a, b: this.last.b - this.offset.b };
        source = 'carried';
      } else if (this.place && this.weight >= 2) {
        raw = { ...this.place };
        source = 'carried';
      } else if (this.last && this.lastSource !== null && this.lastSource !== 'grip') {
        // Seen in this hold, its place not learned yet (fair finds, or a hand the model is unsure of): the
        // wand is still where it was last seen in the hand (the guess past the knuckles, here, made the tip
        // jump a tenth of the frame and back at every smeared frame).
        raw = { a: this.last.a - this.offset.a, b: this.last.b - this.offset.b };
        source = 'carried';
      } else {
        const p = gripTip(lm, reach, aspect);
        raw = toGrip(g, p.x, p.y / aspect);
        source = 'grip';
      }
    }
    // The fading step: decay what is left of the last one, and on a change of source start a new one that
    // keeps the tip where it was.
    if (this.lastT !== null) {
      const f = Math.exp(-Math.max(0, t - this.lastT) / WAND_SETTLE_MS);
      this.offset = { a: this.offset.a * f, b: this.offset.b * f };
    }
    // A change of source keeps the tip where it was only when the shaft is lost and the carried tip is near
    // where it was seen; any sight of the wand (the shaft's end, or the glint there) is taken at once. (Fading
    // from the shaft's end to the glint, both in view, carried a hand placed badly as it came into view into
    // the next frames: every hold of the lit-tip clip began 0.05 to 0.08 frame widths off.)
    const wasSeen = this.lastSource === 'shaft' || this.lastSource === 'glint';
    if (this.lastT !== null && t - this.lastT > WAND_GAP_MS) this.offset = { a: 0, b: 0 };
    else if (this.last && this.lastSource !== null && this.lastSource !== source) {
      const step = { a: this.last.a - raw.a, b: this.last.b - raw.b };
      this.offset = wasSeen && source === 'carried' && Math.hypot(step.a, step.b) <= WAND_FADE_MAX ? step : { a: 0, b: 0 };
    }
    const out = { a: raw.a + this.offset.a, b: raw.b + this.offset.b };
    this.last = out;
    this.lastSource = source;
    this.lastT = t;
    const p = fromGrip(g, out.a, out.b);
    return { p: { x: p.x, y: p.y * aspect }, source, quality };
  }
}

/** The glint marks the tip when it lies at the end of the found shaft, within a fifth of a palm. */
function litTip(g: GripFrame, wand: WandWire, aspect: number): boolean {
  if (!wand.glint) return false;
  const dx = wand.glint[0] - wand.tip[0], dy = (wand.glint[1] - wand.tip[1]) / aspect;
  return Math.hypot(dx, dy) <= 0.2 * g.palm;
}

interface Timed {
  at: number;
  v: number;
}

/**
 * Finger mode's guard against a collapsed finger (geometry.ts header). It keeps the finger's length
 * for the palm's over the last frames with a hand, and the last finger that was not collapsed; the window
 * starts afresh with each new hold of the tip, so one hand's finger is never judged by another's.
 */
export class FingerCollapse {
  private ratios: number[] = [];
  private good: FingerShape | null = null;
  /** Capture time of the first frame of the finger's current short run. */
  private shortSince: number | null = null;

  reset(): void {
    this.ratios = [];
    this.good = null;
    this.shortSince = null;
  }

  /** The fingertip for this frame, frame-normalized and unflipped (as geometry.ts fingerTip). */
  tip(lm: FlatLandmarks, aspect: number, t: number): Point2 {
    const shape = fingerShape(lm, aspect);
    const ref = this.ratios.length >= COLLAPSE_MIN_FRAMES ? median(this.ratios) : null;
    if (ref !== null && shape.ratio < COLLAPSE_SHARE * ref) {
      this.shortSince ??= t;
      if (t - this.shortSince <= COLLAPSE_MAX_MS) {
        // A collapsed frame says nothing about the finger: it neither joins the median nor replaces the
        // good finger, so a run of them is judged against the finger as it was.
        if (this.good) return carriedFingerTip(lm, this.good, aspect);
      } else {
        // Short for longer than a blur lasts: the finger is curled, and is followed from this frame on.
        // The window starts afresh from it, as with a new hold, so the curled finger is the measure from
        // now on: a frame that reads longer during the curl (landmark noise, a twitch) is no reason to
        // carry the long finger again, as it would be against a median still full of it.
        this.ratios = [];
        this.shortSince = null;
      }
    } else {
      this.shortSince = null;
    }
    this.ratios.push(shape.ratio);
    if (this.ratios.length > COLLAPSE_WINDOW) this.ratios.shift();
    this.good = shape;
    return fingerTip(lm);
  }
}

export class HandTipState {
  holding = false;
  private lastSeen: number | null = null;
  lastFrameT: number | null = null;
  private firstResultAt: number | null = null;
  private lastConfidentAt: number | null = null;
  private processed: number[] = [];
  private steps: Timed[] = [];
  private locks: Timed[] = [];
  /** TipSample.size of the samples of the last second, for 'hand-too-small'. */
  private sizes: Timed[] = [];
  private small = false;
  private readonly finger = new FingerCollapse();
  private readonly wandTip = new WandTip();
  /** Wand mode was on for the last frame with a hand; kernel times the hold began and a shaft was last
   *  found (for 'wand-not-seen'); finds of the last second (TrackerStatus.wand). */
  private wandMode = false;
  private holdAt: number | null = null;
  private wandSeenAt: number | null = null;
  private wandFinds: Timed[] = [];

  constructor(private readonly src: string) {}

  /** Wand mode: the tip's learned place in the hand, for the worker's next search (protocol.ts). */
  wandPrior(): { a: number; b: number } | null {
    return this.wandTip.prior();
  }

  /** Wand mode: the share of the last second's frames with a hand whose shaft was found, and whether the
   *  tip's place in the hand has been learned. Null outside wand mode. */
  wandStatus(k: number): { seen: number; learned: boolean } | null {
    if (!this.wandMode) return null;
    this.trim(k);
    const seen = this.wandFinds.length ? this.wandFinds.reduce((s, f) => s + f.v, 0) / this.wandFinds.length : 0;
    return { seen: round(seen, 3), learned: this.wandTip.prior() !== null };
  }

  reset(): void {
    this.holding = false;
    this.lastSeen = null;
    this.lastFrameT = null;
    this.forgetMode();
    this.rebase();
  }

  /** One processed frame; `k` is kernel time now. */
  frame(r: ProcessedFrame, s: TrackingSettings, k: number): FrameOutcome {
    const out: FrameOutcome = {};
    this.lastFrameT = r.t;
    this.firstResultAt ??= k;
    this.processed.push(k);
    this.steps.push({ at: k, v: r.stepMs });
    const hand = r.hand && isValidLandmarks(r.hand.points) ? r.hand : null;
    if (hand) {
      const aspect = r.width > 0 && r.height > 0 ? r.width / r.height : 16 / 9;
      // A new hold starts the finger's window afresh (a loss, a new camera, a mode switch all end one).
      if (!this.holding) {
        this.finger.reset();
        this.wandTip.restart();
        this.holdAt = k;
      }
      if (this.wandMode !== (s.mode === 'wand')) {
        this.wandMode = s.mode === 'wand';
        this.wandTip.reset();
        this.wandSeenAt = null;
        this.wandFinds = [];
      }
      let raw: Point2;
      let confScale = 1;
      if (s.mode === 'wand') {
        this.finger.reset();
        const w = this.wandTip.tip(hand.points, aspect, r.wand, r.t, s.reach, hand.score);
        raw = w.p;
        const seen = w.source === 'shaft' || w.source === 'glint';
        if (seen) this.wandSeenAt = k;
        this.wandFinds.push({ at: k, v: seen ? 1 : 0 });
        // The tip is as sure as the hand, less when it is carried or guessed (lock and hints read this).
        confScale = seen ? 0.7 + 0.3 * w.quality : w.source === 'carried' ? 0.75 : 0.6;
        const wb = r.wand && seen ? toCaster({ x: r.wand.base[0], y: r.wand.base[1] }, s.flipX) : null;
        const wt = toCaster(raw, s.flipX);
        out.wand = {
          ...(wb ? { base: [round(wb.x, 4), round(wb.y, 4)] as [number, number] } : {}),
          tip: [round(wt.x, 4), round(wt.y, 4)],
          quality: round(w.quality, 3),
          source: w.source,
        };
      } else if (s.mode === 'grip') {
        // The knuckles anchor the grip projection; the fingertip plays no part in it.
        this.finger.reset();
        raw = gripTip(hand.points, s.reach, aspect);
      } else {
        raw = this.finger.tip(hand.points, aspect, r.t);
      }
      const p = toCaster(raw, s.flipX);
      const conf = round(tipConfidence(hand.score, hand.tipPresence) * confScale, 3);
      const sample: TipSample = {
        t: r.t,
        x: round(clamp(p.x, -1, 2), 5),
        y: round(clamp(p.y, -1, 2), 5),
        conf,
        src: this.src,
        size: round(clamp(handSize(hand.points, aspect), 0, 1), 5),
        frame: r.frame,
      };
      this.locks.push({ at: k, v: conf >= CONFIDENT ? 1 : 0 });
      if (conf >= CONFIDENT) this.lastConfidentAt = k;
      this.sizes.push({ at: k, v: sample.size! });
      if (!this.holding) {
        this.holding = true;
        out.found = sample;
      }
      out.sample = sample;
      this.lastSeen = r.t;
      out.landmarks = landmarksToCaster(hand.points, s.flipX);
    } else {
      this.locks.push({ at: k, v: 0 });
      if (this.holding && this.lastSeen !== null && r.t - this.lastSeen >= LOST_AFTER_MS) {
        this.holding = false;
        out.lost = { t: r.t, lastSeen: this.lastSeen };
      }
    }
    this.trim(k);
    if (hand) this.judgeSize();
    return out;
  }

  /** The tip is let go now (stop, camera stopped, a new camera generation, a mode switch). */
  loseNow(t: number): { t: number; lastSeen?: number } | null {
    if (!this.holding) return null;
    this.holding = false;
    return { t: Math.max(t, this.lastSeen ?? -Infinity), lastSeen: this.lastSeen ?? undefined };
  }

  /** A new camera: start the hint clock, the measurements and the finger's window again. */
  rebase(): void {
    this.firstResultAt = null;
    this.lastConfidentAt = null;
    this.processed = [];
    this.steps = [];
    this.locks = [];
    this.sizes = [];
    this.small = false;
    this.finger.reset();
    this.wandTip.reset();
    this.holdAt = null;
    this.wandSeenAt = null;
    this.wandFinds = [];
  }

  /** The tracker stops or starts again: as new, wand mode included (the next frame with a hand sets it). */
  private forgetMode(): void {
    this.wandMode = false;
  }

  fps(k: number): number {
    this.trim(k);
    return this.processed.length;
  }

  lock(k: number): number {
    this.trim(k);
    return this.locks.length ? round(this.locks.reduce((s, l) => s + l.v, 0) / this.locks.length, 3) : 0;
  }

  /** Median detection time over the last second, or undefined before any frame. */
  stepMs(k: number): number | undefined {
    this.trim(k);
    if (!this.steps.length) return undefined;
    const sorted = this.steps.map((s) => s.v).sort((a, b) => a - b);
    return round(sorted[sorted.length >> 1], 2);
  }

  /** Frames have been processed within the last second. */
  flowing(k: number): boolean {
    return this.processed.length > 0 && k - this.processed[this.processed.length - 1] < 1000;
  }

  /** 'hand-not-found' after HINT_AFTER_MS of processed frames without a confident hand, while the tip
   *  is not held; otherwise 'hand-too-small' while the hand of the last second is small; otherwise, in wand
   *  mode, 'wand-not-seen' while the hand is held and no shaft has been found for WAND_HINT_MS (since the
   *  hold began or the shaft was last seen). */
  hint(k: number): 'hand-not-found' | 'hand-too-small' | 'wand-not-seen' | null {
    if (this.firstResultAt === null || !this.flowing(k)) return null;
    if (!this.holding) {
      const since = Math.max(this.firstResultAt, this.lastConfidentAt ?? -Infinity);
      if (k - since >= HINT_AFTER_MS) return 'hand-not-found';
    }
    this.trim(k);
    if (this.small) return 'hand-too-small';
    if (this.wandMode && this.holding && this.holdAt !== null) {
      const since = Math.max(this.holdAt, this.wandSeenAt ?? -Infinity);
      if (k - since >= WAND_HINT_MS) return 'wand-not-seen';
    }
    return null;
  }

  /** The hand's size, on a frame with a hand: small under SMALL_HAND, not small from SMALL_HAND_CLEAR,
   *  unchanged in between or with too few samples to tell. */
  private judgeSize(): void {
    if (this.sizes.length < SIZE_MIN_SAMPLES) return;
    const m = median(this.sizes.map((s) => s.v));
    if (m < SMALL_HAND) this.small = true;
    else if (m >= SMALL_HAND_CLEAR) this.small = false;
  }

  private trim(k: number): void {
    const cut = k - 1000;
    while (this.processed.length && this.processed[0] < cut) this.processed.shift();
    while (this.steps.length && this.steps[0].at < cut) this.steps.shift();
    while (this.locks.length && this.locks[0].at < cut) this.locks.shift();
    while (this.sizes.length && this.sizes[0].at < cut) this.sizes.shift();
    while (this.wandFinds.length && this.wandFinds[0].at < cut) this.wandFinds.shift();
    // No sample in the last second: no size to judge, and no hint about it.
    if (!this.sizes.length) this.small = false;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The middle value (the mean of the two middle ones for an even count). */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
