// The hand tracker's per-frame rules, pure, so the tip event rules can be tested without a model:
//  - a frame with a hand gives a TipSample in caster space (geometry.ts); the first one after a loss is
//    preceded by tip.found with the same t (rule 2);
//  - after LOST_AFTER_FRAMES processed frames without a hand, tip.lost at the capture time of the frame
//    that declared it, with lastSeen (rule 3). A few frames, not one: the landmarker misses single frames
//    during fast motion and recovers on the next. Three frames is 100 ms at 30 fps, inside the
//    segmenter's own 200 ms gap rule (rule 4), so a slow model still ends strokes promptly;
//  - lock, fps and stepMs over the last second, and the 'hand-not-found' hint after 3 s without a
//    confident hand (Section 7.9), counted from the first processed frame so loading does not count.

import type { TipSample } from '../../../contracts';
import {
  handSize, isValidLandmarks, landmarksToCaster, round, tipConfidence, tipFor, toCaster, type HandMode,
} from './geometry';
import type { HandWire } from './protocol';

export const LOST_AFTER_FRAMES = 3;
/** Section 7.9: "After 3 s without a tip it shows the 'tip not found' hint" ('hand-not-found' here). */
export const HINT_AFTER_MS = 3000;
/** A sample at or above this confidence counts toward lock and resets the hint clock. */
export const CONFIDENT = 0.5;

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

export class HandTipState {
  holding = false;
  private misses = 0;
  private lastSeen: number | null = null;
  lastFrameT: number | null = null;
  private firstResultAt: number | null = null;
  private lastConfidentAt: number | null = null;
  private processed: number[] = [];
  private steps: Timed[] = [];
  private locks: Timed[] = [];

  constructor(private readonly src: string) {}

  reset(): void {
    this.holding = false;
    this.misses = 0;
    this.lastSeen = null;
    this.lastFrameT = null;
    this.firstResultAt = null;
    this.lastConfidentAt = null;
    this.processed = [];
    this.steps = [];
    this.locks = [];
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
      const p = toCaster(tipFor(hand.points, s.mode, s.reach, aspect), s.flipX);
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
      this.misses = 0;
      if (!this.holding) {
        this.holding = true;
        out.found = sample;
      }
      out.sample = sample;
      this.lastSeen = r.t;
      out.landmarks = landmarksToCaster(hand.points, s.flipX);
    } else {
      this.locks.push({ at: k, v: 0 });
      if (this.holding && ++this.misses >= LOST_AFTER_FRAMES) {
        this.holding = false;
        this.misses = 0;
        out.lost = { t: r.t, lastSeen: this.lastSeen ?? undefined };
      }
    }
    this.trim(k);
    return out;
  }

  /** The tip is let go now (stop, camera stopped, a new camera generation, a mode switch). */
  loseNow(t: number): { t: number; lastSeen?: number } | null {
    if (!this.holding) return null;
    this.holding = false;
    this.misses = 0;
    return { t: Math.max(t, this.lastSeen ?? -Infinity), lastSeen: this.lastSeen ?? undefined };
  }

  /** A new camera: start the hint clock and the measurements again. */
  rebase(): void {
    this.firstResultAt = null;
    this.lastConfidentAt = null;
    this.processed = [];
    this.steps = [];
    this.locks = [];
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

  /** 'hand-not-found' after HINT_AFTER_MS of processed frames without a confident hand. */
  hint(k: number): 'hand-not-found' | null {
    if (this.holding || this.firstResultAt === null || !this.flowing(k)) return null;
    const since = Math.max(this.firstResultAt, this.lastConfidentAt ?? -Infinity);
    return k - since >= HINT_AFTER_MS ? 'hand-not-found' : null;
  }

  private trim(k: number): void {
    const cut = k - 1000;
    while (this.processed.length && this.processed[0] < cut) this.processed.shift();
    while (this.steps.length && this.steps[0].at < cut) this.steps.shift();
    while (this.locks.length && this.locks[0].at < cut) this.locks.shift();
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
