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
import type { HandWire } from './protocol';

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
}

export interface FrameOutcome {
  /** Publish before `sample`. */
  found?: TipSample;
  sample?: TipSample;
  lost?: { t: number; lastSeen?: number };
  /** The 21 landmarks in caster space, when a hand was seen (for 'tracker.debug'). */
  landmarks?: [number, number][];
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

  constructor(private readonly src: string) {}

  reset(): void {
    this.holding = false;
    this.lastSeen = null;
    this.lastFrameT = null;
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
      if (!this.holding) this.finger.reset();
      let raw: Point2;
      if (s.mode === 'grip') {
        // The knuckles anchor the grip projection; the fingertip plays no part in it.
        this.finger.reset();
        raw = gripTip(hand.points, s.reach, aspect);
      } else {
        raw = this.finger.tip(hand.points, aspect, r.t);
      }
      const p = toCaster(raw, s.flipX);
      const conf = tipConfidence(hand.score, hand.tipPresence);
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
   *  is not held; otherwise 'hand-too-small' while the hand of the last second is small. */
  hint(k: number): 'hand-not-found' | 'hand-too-small' | null {
    if (this.firstResultAt === null || !this.flowing(k)) return null;
    if (!this.holding) {
      const since = Math.max(this.firstResultAt, this.lastConfidentAt ?? -Infinity);
      if (k - since >= HINT_AFTER_MS) return 'hand-not-found';
    }
    this.trim(k);
    return this.small ? 'hand-too-small' : null;
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
