// The hold-still segmenter of Section 7.4, with pen mode for mouse and touch, as a pure state machine.
//
// A camera never sees a pen lift, so the default rule is hold-still: pause, trace, pause.
//
//   searching  → hovering    the tip is found
//   hovering   → armed       held still for segmenter.armMs (0.3 s) within segmenter.armRadius (2%)
//   hovering   → searching   the tip is lost
//   armed      → tracing     the tip leaves the arm radius          (stroke.begin)
//   armed      → searching   the tip is lost
//   tracing    → evaluating  a pause (segmenter.pauseMs 0.25 s within segmenter.pauseRadius), the tip
//                            lost for segmenter.lostMs (0.2 s), or segmenter.maxMs (4 s) in total
//                            (stroke.end; or a discarded status when the stroke is too short or small)
//   evaluating → cooldown    spell.cast for this stroke
//   evaluating → hovering    spell.fizzle for this stroke, or no decision by segmenter.evaluateTimeoutMs
//   cooldown   → hovering    after segmenter.cooldownMs (0.4 s)
//   any        → paused      'segmenter.pause', voice-only mode, or a replay on the stage
//
// Pen mode (mouse and touch: tracker.status pen, or setting segmenter.mode 'pen'): tip.found begins
// tracing at once, tip.lost ends it (endReason 'pen-up'), the same minimum checks apply, no arming.
// After a rest at the press, a pointer's stroke starts where the pointer starts to move (fromFirstMove);
// stroke.begin keeps the press.
//
// Wherever a state would go to hovering while the tip is not in view it goes to searching instead,
// and to paused while paused. "Hovering" always starts a fresh hold: the hold that arms a cast is
// timed from the first sample after the state was entered, so the stillness of the pause that ended
// one stroke can never arm the next (the recorded sessions depend on this: a wand left still after a
// fizzle must not arm again).
//
// The machine never touches the bus, timers or the browser. The module feeds it events with `now`
// (the kernel clock) and publishes what comes back, in order. Durations of the tip's behaviour
// (holds, pauses, the 4 s cap) are measured on sample capture times; the machine's own deadlines
// (cooldown, evaluation, the tip lost when samples stop) are instants on the kernel clock, measured
// from when events arrived, so a constant camera latency cannot end a stroke early.
//
// Distances are isotropic, in frame widths: dx in caster x, dy divided by the aspect of the
// sample's tracker (contracts/events.ts tip event rules: tracker.status is kept per tracker).

import type { PlayArea, SegmenterState, SegmenterStatus, Stroke, TipSample, TrackerStatus } from '../../contracts';
import { DEFAULT_SETTINGS } from '../../contracts';
import { TipFilter, type OneEuroParams } from './filter';
import { QUALITY, sampleInterval, strokeQuality } from './quality';

export type SegmenterMode = 'hold-still' | 'pen';

/** Pauses the module sets on its own: a replay playing on the stage, voice-only casting. */
export type AutoPause = 'replay' | 'voice-only';

export interface SegmenterSettings {
  /** 'auto' follows the tracker: pen for pointer-style trackers (TrackerStatus.pen). */
  mode: 'auto' | SegmenterMode;
  armMs: number;
  /** Frame widths. */
  armRadius: number;
  pauseMs: number;
  /** Frame widths. */
  pauseRadius: number;
  lostMs: number;
  maxMs: number;
  minSamples: number;
  /** Fraction of the play area, per axis (contracts/settings.ts). */
  minExtent: number;
  cooldownMs: number;
  evaluateTimeoutMs: number;
  playArea: PlayArea;
  filter: OneEuroParams;
}

export const DEFAULT_SEGMENTER_SETTINGS: SegmenterSettings = {
  mode: DEFAULT_SETTINGS['segmenter.mode'],
  armMs: DEFAULT_SETTINGS['segmenter.armMs'],
  armRadius: DEFAULT_SETTINGS['segmenter.armRadius'],
  pauseMs: DEFAULT_SETTINGS['segmenter.pauseMs'],
  pauseRadius: DEFAULT_SETTINGS['segmenter.pauseRadius'],
  lostMs: DEFAULT_SETTINGS['segmenter.lostMs'],
  maxMs: DEFAULT_SETTINGS['segmenter.maxMs'],
  minSamples: DEFAULT_SETTINGS['segmenter.minSamples'],
  minExtent: DEFAULT_SETTINGS['segmenter.minExtent'],
  cooldownMs: DEFAULT_SETTINGS['segmenter.cooldownMs'],
  evaluateTimeoutMs: DEFAULT_SETTINGS['segmenter.evaluateTimeoutMs'],
  playArea: DEFAULT_SETTINGS.playArea,
  filter: {
    minCutoff: DEFAULT_SETTINGS['filter.minCutoff'],
    beta: DEFAULT_SETTINGS['filter.beta'],
    dCutoff: DEFAULT_SETTINGS['filter.dCutoff'],
  },
};

/** Caster space of most webcams, used until a tracker says otherwise. */
export const DEFAULT_ASPECT = 16 / 9;
/** After spell.pending, evaluation waits until `until` plus this (contract review). */
export const PENDING_MARGIN_MS = 250;
/** armProgress goes out at most about 15 times per second (Section 7.4 table). */
export const PROGRESS_INTERVAL_MS = 1000 / 15;
/** Pen-style trackers play in the whole mirror (contracts/settings.ts segmenter.minExtent). */
const WHOLE_MIRROR: PlayArea = { x: 0, y: 0, w: 1, h: 1 };
/**
 * Where exactly a stroke starts and ends. The pause radius (1.2%) decides *whether* the tip is still,
 * but a tip easing into or out of a hold moves up to that far while already counting as still. So
 * the stroke starts at the last sample within a quarter of the pause radius of the armed position,
 * and ends at the first sample of the closing still run within a quarter of the pause radius of
 * where the tip came to rest: about 0.3% of the frame width, well above the filtered jitter of a
 * still bright tip (about 0.05%) and of a hand (about 0.15%). A pointer's pen stroke that rested at
 * the press for a pause starts the same way, at the last sample within that distance of the press
 * position (fromFirstMove).
 */
export const AT_REST_SHARE = 0.25;

export type SegmenterOutput =
  | { type: 'segmenter.state'; payload: SegmenterStatus }
  | { type: 'stroke.begin'; payload: Stroke }
  | { type: 'stroke.end'; payload: Stroke }
  | { type: 'tip.filtered'; payload: TipSample }
  /** A completed stroke for the pending 'segmenter.capture' request. It is never published. */
  | { type: 'captured'; payload: Stroke };

export interface SegmenterOptions {
  settings?: SegmenterSettings;
  /** Stroke ids (newId from the kernel; a counter in tests). */
  newId?: (prefix: string) => string;
  /** Run positions through the One Euro filter (default true). State tests feed exact positions. */
  filter?: boolean;
}

type Out = SegmenterOutput[];
type Discard = NonNullable<SegmenterStatus['discarded']>;
type EndReason = NonNullable<Stroke['endReason']>;

interface Source {
  aspect: number;
  pen: boolean;
}

/** The hold being timed while hovering: every sample since `anchor` lies within the arm radius of it. */
interface Hold {
  anchor: TipSample;
  sumX: number;
  sumY: number;
  n: number;
}

interface Armed {
  /** The armed position: the mean of the hold that armed. */
  x: number;
  y: number;
  /** The last sample still at the armed position (AT_REST_SHARE), and every sample since. The
   *  stroke starts there, so a slow start inside the arm radius belongs to the stroke. */
  buffer: TipSample[];
}

interface Trace {
  id: string;
  mode: SegmenterMode;
  src: string;
  points: TipSample[];
  /** First sample of the current still run: later samples all lie within the pause radius of it.
   *  When the stroke ends, its trailing still samples go (see lastMoving). -1 while there are no
   *  points. */
  stillIndex: number;
}

interface Evaluating {
  strokeId: string;
  mode: SegmenterMode;
  /** Kernel time the stroke.end went out. */
  since: number;
  /** The latest spell.pending `until` for this stroke, if any. */
  until: number | null;
}

let fallbackCounter = 0;
const fallbackId = (prefix: string) => `${prefix}-${++fallbackCounter}`;

export class Segmenter {
  private s: SegmenterSettings;
  private readonly newId: (prefix: string) => string;
  private readonly tipFilter: TipFilter | null;

  private current: SegmenterState = 'searching';
  /** What the last segmenter.state said, so unchanged states are not repeated. */
  private reported: { state: SegmenterState; mode: SegmenterMode; pausedFor?: string } | null = null;

  // Trackers and the tip.
  private readonly sources = new Map<string, Source>();
  /** Tracker of the latest tracker.status: decides the mode before any tip arrives. */
  private statusSrc: string | null = null;
  /** Tracker of the tip being followed. */
  private src: string | null = null;
  private present = false;
  /** Latest filtered sample of `src` since the tip was last found. */
  private last: TipSample | null = null;
  /** Kernel time the latest tip.sample or tip.found arrived. */
  private lastArrival = 0;

  // Work in progress; at most one of these is set, matching the state.
  private hold: Hold | null = null;
  private armed: Armed | null = null;
  private trace: Trace | null = null;
  private evaluating: Evaluating | null = null;
  private cooldown: { strokeId: string; until: number } | null = null;

  /** The armProgress last published while hovering, and when (kernel time). */
  private progress = { value: 0, at: -Infinity };

  // Pauses and captures.
  private readonly autoPauses = new Set<AutoPause>();
  private requestPauses: string[] = [];
  private captureArmed = false;

  constructor(options: SegmenterOptions = {}) {
    this.s = options.settings ?? DEFAULT_SEGMENTER_SETTINGS;
    this.newId = options.newId ?? fallbackId;
    this.tipFilter = options.filter === false ? null : new TipFilter(this.s.filter);
  }

  // ------------------------------------------------------------------------------ inspection

  get state(): SegmenterState {
    return this.current;
  }

  /** The rule in force: the stroke's own while one is traced or evaluated. */
  get mode(): SegmenterMode {
    return this.trace?.mode ?? this.evaluating?.mode ?? this.modeFor(this.src ?? this.statusSrc);
  }

  /** The tip is in view as far as the segmenter can tell. */
  get tipPresent(): boolean {
    return this.present;
  }

  get settings(): SegmenterSettings {
    return this.s;
  }

  // ---------------------------------------------------------------------------------- inputs

  /** New settings. The mode applies now unless a stroke is under way (it keeps the mode it began with). */
  configure(settings: SegmenterSettings, now: number): Out {
    this.s = settings;
    this.tipFilter?.setParams(settings.filter);
    const out: Out = [];
    if (this.current === 'hovering' && this.mode === 'pen') this.hold = null;
    this.report(now, out);
    return out;
  }

  /** tracker.status: kept per tracker (aspect and pen). */
  status(status: TrackerStatus, now: number): Out {
    const out: Out = [];
    if (!status || typeof status.tracker !== 'string') return out;
    const aspect = validAspect(status.aspect);
    const before = this.sources.get(status.tracker);
    this.sources.set(status.tracker, { aspect, pen: status.pen === true });
    this.statusSrc = status.tracker;
    // A new aspect moves every isotropic position: start the filter again.
    if (before && before.aspect !== aspect && status.tracker === this.src) this.tipFilter?.reset();
    this.report(now, out);
    return out;
  }

  /** tip.found: a state change. It adds no point: the tip.sample of the same frame follows. */
  found(sample: TipSample, now: number): Out {
    const out: Out = [];
    if (!validSample(sample)) return out;
    this.useSource(sample.src, sample.t, now, out);
    // Found again without a tip.lost in between: treat it as lost and found.
    if (this.present) this.loseTip(sample.t, now, out);
    this.tipFilter?.reset();
    this.last = null;
    this.lastArrival = now;
    this.appear(sample.t, out);
    return out;
  }

  /** tip.sample: filter it, run the state machine, and return tip.filtered last, so the published
   *  state already reflects this sample when the trail draws it. */
  sample(raw: TipSample, now: number): Out {
    const out: Out = [];
    if (!validSample(raw)) return out;
    this.useSource(raw.src, raw.t, now, out);
    if (this.present && this.last) {
      // A camera tracker's samples that stopped for lostMs mean the tip had gone (contracts/events.ts
      // rule 4), even though the tracker never said so; so does time running backwards.
      const gap = Math.max(raw.t - this.last.t, now - this.lastArrival);
      if (raw.t < this.last.t || (!this.isPenSource(this.src) && gap >= this.s.lostMs)) {
        this.loseTip(Math.min(raw.t, this.last.t + this.s.lostMs), now, out);
      }
    }
    if (!this.present) {
      if (this.isPenSource(raw.src)) {
        // A pointer-style tracker's tip is there from tip.found to tip.lost and nowhere else: a
        // sample outside (a mouse moving with no button down) moves the trail but starts nothing.
        out.push({ type: 'tip.filtered', payload: this.tipFilter ? this.tipFilter.filter(raw, this.aspectOf(raw.src)) : { ...raw } });
        return out;
      }
      // A camera tracker's samples again without a tip.found: after a gap, the tip is back.
      this.tipFilter?.reset();
      this.appear(raw.t, out);
    }
    const p = this.tipFilter ? this.tipFilter.filter(raw, this.aspectOf(raw.src)) : { ...raw };
    this.last = p;
    this.lastArrival = now;
    this.step(p, now, out);
    out.push({ type: 'tip.filtered', payload: p });
    return out;
  }

  /** tip.lost. A loss reported for another tracker than the one followed is stale and ignored. */
  lost(e: { t: number; src: string }, now: number): Out {
    const out: Out = [];
    if (!e || (this.src !== null && e.src !== this.src)) return out;
    if (!this.present) return out;
    this.loseTip(Number.isFinite(e.t) ? e.t : now, now, out);
    return out;
  }

  /** Time passes: called about every 40 ms, also when no samples arrive (Section 7.9). */
  tick(now: number): Out {
    const out: Out = [];
    if (this.present) {
      if (!this.isPenSource(this.src)) {
        if (now - this.lastArrival >= this.s.lostMs) {
          // End a stroke at the last sample's time + lostMs rather than wait for tip.lost (the bright
          // tip declares a loss only after six missed frames).
          this.loseTip((this.last?.t ?? now - this.s.lostMs) + this.s.lostMs, now, out);
        }
      } else if (this.last) {
        // A pointer that does not move sends no events but stays where it is: time its stillness.
        this.stillPointer(this.last.t + (now - this.lastArrival), now, out);
      }
    }
    this.expire(now, out);
    if (this.current === 'hovering') this.reportProgress(now, out);
    return out;
  }

  /** spell.cast (kind 'cast') or spell.fizzle for a stroke. Only the stroke being evaluated counts. */
  decided(strokeId: string | undefined, kind: 'cast' | 'fizzle', now: number): Out {
    const out: Out = [];
    const e = this.evaluating;
    if (this.current !== 'evaluating' || !e || !strokeId || e.strokeId !== strokeId) return out;
    if (kind === 'cast') {
      this.evaluating = null;
      this.cooldown = { strokeId, until: now + this.s.cooldownMs };
      this.current = 'cooldown';
      this.report(now, out);
    } else {
      this.goIdle(now, out);
    }
    return out;
  }

  /** spell.pending: the engine is waiting for speech. Stay in evaluating until `until` + 250 ms;
   *  a later message for the same stroke replaces an earlier one. */
  pending(strokeId: string | undefined, until: number, now: number): Out {
    const e = this.evaluating;
    if (this.current === 'evaluating' && e && strokeId === e.strokeId && Number.isFinite(until)) e.until = until;
    return this.expireOnly(now);
  }

  /** The module's own pauses: a replay playing on the stage, voice-only casting. */
  setAutoPause(reason: AutoPause, on: boolean, now: number): Out {
    if (on) this.autoPauses.add(reason);
    else this.autoPauses.delete(reason);
    return this.applyPause(now);
  }

  /** 'segmenter.pause'. Several callers may pause for different reasons; resuming without a reason
   *  clears every requested pause. */
  setRequestPause(paused: boolean, reason: string | undefined, now: number): Out {
    const r = reason && reason.trim() ? reason.trim() : 'request';
    if (paused) {
      if (!this.requestPauses.includes(r)) this.requestPauses.push(r);
    } else {
      this.requestPauses = reason ? this.requestPauses.filter((x) => x !== r) : [];
    }
    return this.applyPause(now);
  }

  /** 'segmenter.capture' armed (true) or given up (false). The next completed stroke comes out as
   *  'captured' instead of stroke.end. */
  setCapture(armed: boolean, now: number): Out {
    this.captureArmed = armed;
    return this.applyPause(now);
  }

  /** The module starts: begin from searching and say so. Trackers, settings and pauses are kept. */
  start(now: number): Out {
    this.reset();
    this.reported = null;
    const out: Out = [];
    this.current = this.pausedFor() !== undefined ? 'paused' : 'searching';
    this.report(now, out);
    return out;
  }

  /** The module stops: a stroke being traced is dropped (every stroke.begin gets its ending). */
  stop(now: number): Out {
    const out: Out = [];
    const strokeId = this.trace?.id;
    this.reset();
    this.captureArmed = false;
    this.current = 'searching';
    this.report(now, out, strokeId ? { strokeId, discarded: 'interrupted' } : undefined);
    return out;
  }

  // ------------------------------------------------------------------------------ the machine

  /** One filtered sample through the state it arrives in. */
  private step(p: TipSample, now: number, out: Out): void {
    this.expire(now, out);
    switch (this.current) {
      case 'hovering':
        if (this.mode === 'hold-still') this.hover(p, now, out);
        break;
      case 'armed':
        this.armedStep(p, out);
        break;
      case 'tracing':
        this.traceStep(p, now, out);
        break;
      default:
        // searching cannot happen here (the tip is present); evaluating, cooldown and paused follow
        // the tip without segmenting it.
        break;
    }
  }

  private hover(p: TipSample, now: number, out: Out): void {
    const h = this.hold;
    if (!h || this.distance(p, h.anchor) > this.s.armRadius) {
      this.hold = { anchor: p, sumX: p.x, sumY: p.y, n: 1 };
    } else {
      h.sumX += p.x;
      h.sumY += p.y;
      h.n++;
      if (p.t - h.anchor.t >= this.s.armMs) {
        this.arm(p, out);
        return;
      }
    }
    this.reportProgress(now, out, p.t);
  }

  private arm(p: TipSample, out: Out): void {
    const h = this.hold!;
    this.hold = null;
    this.armed = { x: h.sumX / h.n, y: h.sumY / h.n, buffer: [p] };
    this.current = 'armed';
    this.report(p.t, out);
  }

  private armedStep(p: TipSample, out: Out): void {
    const a = this.armed!;
    const d = this.distance(p, a);
    if (d > this.s.armRadius) {
      this.beginTrace([...a.buffer, p], 'hold-still', p.t, out);
      return;
    }
    if (d <= this.s.pauseRadius * AT_REST_SHARE) {
      a.buffer = [p];
    } else {
      a.buffer.push(p);
      // A tip lingering inside the arm radius is not a slow start: keep the stroke's lead-in short.
      while (a.buffer.length > 1 && p.t - a.buffer[0].t > this.s.armMs) a.buffer.shift();
    }
  }

  private beginTrace(points: TipSample[], mode: SegmenterMode, t: number, out: Out): void {
    this.hold = null;
    this.armed = null;
    this.cooldown = null;
    const trace: Trace = { id: this.newId('stroke'), mode, src: this.src ?? 'unknown', points, stillIndex: points.length - 1 };
    this.trace = trace;
    this.current = 'tracing';
    this.report(t, out);
    out.push({ type: 'stroke.begin', payload: this.strokeOf(trace, points.slice(), t) });
  }

  private traceStep(p: TipSample, now: number, out: Out): void {
    const tr = this.trace!;
    tr.points.push(p);
    const i = tr.points.length - 1;
    if (tr.stillIndex < 0 || this.distance(p, tr.points[tr.stillIndex]) > this.s.pauseRadius) {
      tr.stillIndex = i;
    } else if (tr.mode === 'hold-still' && p.t - tr.points[tr.stillIndex].t >= this.s.pauseMs) {
      this.endTrace('pause', p.t, now, out);
      return;
    }
    if (p.t - tr.points[0].t >= this.s.maxMs) this.endTrace('max', p.t, now, out);
  }

  /** Pen-style trackers between samples: the pointer is still at its last position, at time vt. */
  private stillPointer(vt: number, now: number, out: Out): void {
    if (this.current === 'hovering' && this.mode === 'hold-still' && this.hold && vt - this.hold.anchor.t >= this.s.armMs) {
      this.arm(this.last!, out);
      return;
    }
    const tr = this.trace;
    if (this.current !== 'tracing' || !tr || !tr.points.length) return;
    if (tr.mode === 'hold-still' && tr.stillIndex >= 0 && vt - tr.points[tr.stillIndex].t >= this.s.pauseMs) {
      this.endTrace('pause', vt, now, out);
    } else if (vt - tr.points[0].t >= this.s.maxMs) {
      this.endTrace('max', vt, now, out);
    }
  }

  /** The stroke is over: drop it, hand it to a capture, or send it for evaluation. */
  private endTrace(reason: EndReason, t: number, now: number, out: Out): void {
    const tr = this.trace!;
    this.trace = null;
    // The trailing still samples are not part of the stroke (Stroke.t1), nor is a pointer's rest
    // after the press (Stroke.t0).
    let points = tr.points.slice(0, this.lastMoving(tr) + 1);
    if (tr.mode === 'pen' && this.isPenSource(tr.src)) points = this.fromFirstMove(points);
    const stroke = this.strokeOf(tr, points, t, reason);
    const discarded = this.discardReason(points, tr.src);
    if (discarded) {
      this.goIdle(t, out, { strokeId: tr.id, discarded });
      return;
    }
    if (this.captureArmed) {
      this.captureArmed = false;
      out.push({ type: 'captured', payload: stroke });
      this.goIdle(t, out, { strokeId: tr.id, captured: true });
      return;
    }
    // State first, then the stroke: the decision it causes can arrive before our publish returns.
    this.evaluating = { strokeId: tr.id, mode: tr.mode, since: now, until: null };
    this.current = 'evaluating';
    this.report(t, out);
    out.push({ type: 'stroke.end', payload: stroke });
  }

  /** Index of the stroke's last point: the first sample of the closing still run that is already at
   *  the rest position (AT_REST_SHARE), the rest position being the mean of the run's later half.
   *  Never before the run's first sample, so trimming only ever removes still samples. */
  private lastMoving(tr: Trace): number {
    const s = tr.stillIndex;
    const n = tr.points.length;
    if (s < 0 || n - s < 2) return s;
    const from = s + ((n - s) >> 1);
    let x = 0, y = 0;
    for (let i = from; i < n; i++) {
      x += tr.points[i].x;
      y += tr.points[i].y;
    }
    const rest = { x: x / (n - from), y: y / (n - from) };
    const near = this.s.pauseRadius * AT_REST_SHARE;
    for (let i = s; i < n; i++) if (this.distance(tr.points[i], rest) <= near) return i;
    return s;
  }

  /** A pointer's pen stroke without a rest after the press. The press begins the stroke (stroke.begin
   *  keeps its time), but a rest there is no part of the gesture, and left in it would stretch the
   *  duration that tempo, speed and power are measured on (Section 7.7). Only a rest is cut: a hand
   *  that starts slowly stays near the press without resting, and that start is the stroke's. A
   *  minimum-jerk reach across half the frame in 1.6 s stays within AT_REST_SHARE of the press for
   *  about 0.18 s through the filter; one taking 3 s stays about 0.3 s and counts as a rest, as the
   *  same start would be cut from a hold-still stroke.
   *  - A stay at the press position of a pause (segmenter.pauseMs, Section 7.4) or longer is a rest,
   *    whatever was sent meanwhile: a mouse at rest sends nothing, a finger or a pen's changing
   *    pressure may send samples that stay put. The stroke starts where and when the pointer was last
   *    there, as a hold-still stroke starts at the last sample at the armed position.
   *  - In a shorter stay only a silence is cut: a pointer that sent nothing for longer than a dropout
   *    lasts (quality.ts) was still, as a mouse that has not yet moved a pixel is. The stroke starts at
   *    the sample before the last such silence, held there until one sample interval before the
   *    silence ended, as stillPointer times a resting pointer; the samples after it are kept.
   *  The first point is then a copy with that time, because the sample has gone out as tip.filtered.
   *  A stroke that never left the press position stays as it is. */
  private fromFirstMove(points: TipSample[]): TipSample[] {
    const near = this.s.pauseRadius * AT_REST_SHARE;
    let m = 1;
    while (m < points.length && this.distance(points[m], points[0]) <= near) m++;
    if (m >= points.length) return points;
    const interval = sampleInterval(points);
    if (!(interval > 0)) return points;
    // The pointer left the press position about one sample interval before the first sample beyond it.
    const left = points[m].t - interval;
    if (left - points[0].t >= this.s.pauseMs) {
      const start = points[m - 1];
      return [{ ...start, t: Math.max(start.t, left) }, ...points.slice(m)];
    }
    for (let i = m; i > 0; i--) {
      if (points[i].t - points[i - 1].t > QUALITY.dropoutGapFrames * interval) return [{ ...points[i - 1], t: points[i].t - interval }, ...points.slice(i)];
    }
    return points;
  }

  /** Too short (segmenter.minSamples) or too small (segmenter.minExtent of the play area). */
  private discardReason(points: readonly TipSample[], src: string): Discard | null {
    if (points.length < this.s.minSamples) return 'too-short';
    const pa = this.isPenSource(src) ? WHOLE_MIRROR : sanePlayArea(this.s.playArea);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    const extent = Math.max((maxX - minX) / pa.w, (maxY - minY) / pa.h);
    return extent < this.s.minExtent ? 'too-small' : null;
  }

  private strokeOf(tr: Trace, points: TipSample[], t: number, endReason?: EndReason): Stroke {
    const aspect = this.aspectOf(tr.src);
    const stroke: Stroke = {
      id: tr.id,
      points,
      t0: points.length ? points[0].t : t,
      t1: points.length ? points[points.length - 1].t : t,
      quality: strokeQuality(points, aspect, { pen: this.isPenSource(tr.src) }),
      aspect,
      src: tr.src,
    };
    if (endReason) stroke.endReason = endReason;
    return stroke;
  }

  /** The tip has appeared (tip.found, or samples again after a loss). */
  private appear(t: number, out: Out): void {
    this.present = true;
    if (this.current === 'paused') return;
    if (this.modeFor(this.src) === 'pen') {
      // A pen down begins a stroke at once, also during a cooldown (an explicit press is intent
      // enough). While a stroke is being evaluated the press is ignored: one stroke at a time.
      if (this.current === 'searching' || this.current === 'hovering' || this.current === 'cooldown') this.beginTrace([], 'pen', t, out);
    } else if (this.current === 'searching') {
      this.goIdle(t, out);
    }
  }

  /** The tip has gone: tip.lost, samples that stopped, a new tracker, or time running backwards. */
  private loseTip(t: number, now: number, out: Out): void {
    this.present = false;
    this.tipFilter?.reset();
    this.last = null;
    switch (this.current) {
      case 'hovering':
      case 'armed':
        this.goIdle(t, out);
        break;
      case 'tracing':
        this.endTrace(this.trace!.mode === 'pen' ? 'pen-up' : 'lost', t, now, out);
        break;
      default:
        // evaluating, cooldown and paused carry on, and end in searching.
        break;
    }
  }

  /** Follow a sample's tracker. Another tracker's tip means the previous one has gone. */
  private useSource(src: string, t: number, now: number, out: Out): void {
    if (this.src === src) return;
    if (this.src !== null && this.present) this.loseTip(this.last ? this.last.t : t, now, out);
    this.src = src;
    this.tipFilter?.reset();
    this.last = null;
    this.report(t, out);
  }

  /** Deadlines on the kernel clock: the cooldown, and evaluation with no decision. */
  private expire(now: number, out: Out): void {
    if (this.current === 'cooldown' && this.cooldown && now >= this.cooldown.until) this.goIdle(now, out);
    if (this.current === 'evaluating' && this.evaluating && now >= this.evaluateDeadline(this.evaluating)) this.goIdle(now, out);
  }

  private expireOnly(now: number): Out {
    const out: Out = [];
    this.expire(now, out);
    return out;
  }

  private evaluateDeadline(e: Evaluating): number {
    const timeout = e.since + this.s.evaluateTimeoutMs;
    return e.until === null ? timeout : Math.max(timeout, e.until + PENDING_MARGIN_MS);
  }

  /** Back to waiting for a hold: hovering when the tip is in view, else searching, or paused. */
  private goIdle(t: number, out: Out, extra?: Partial<SegmenterStatus>): void {
    this.clearWork();
    this.current = this.pausedFor() !== undefined ? 'paused' : this.present ? 'hovering' : 'searching';
    this.report(t, out, extra);
  }

  private clearWork(): void {
    this.hold = null;
    this.armed = null;
    this.trace = null;
    this.evaluating = null;
    this.cooldown = null;
    this.progress = { value: 0, at: -Infinity };
  }

  private reset(): void {
    this.clearWork();
    this.present = false;
    this.src = null;
    this.last = null;
    this.tipFilter?.reset();
  }

  // ----------------------------------------------------------------------------------- pauses

  /** Why the segmenter is paused, or undefined. A capture (Workshop redraw) runs through voice-only
   *  and requested pauses, since it asks for exactly one stroke and that stroke is never cast; a
   *  replay on the stage pauses everything. */
  private pausedFor(): string | undefined {
    if (this.autoPauses.has('replay')) return 'replay';
    if (this.captureArmed) return undefined;
    if (this.autoPauses.has('voice-only')) return 'voice-only';
    return this.requestPauses[0];
  }

  private applyPause(now: number): Out {
    const out: Out = [];
    const reason = this.pausedFor();
    if (reason !== undefined && this.current !== 'paused') {
      // A stroke being traced is dropped ('interrupted'); the paused state says why.
      const strokeId = this.trace?.id;
      this.clearWork();
      this.current = 'paused';
      this.report(now, out, strokeId ? { strokeId, discarded: 'interrupted' } : undefined);
    } else if (reason === undefined && this.current === 'paused') {
      this.goIdle(now, out);
    } else {
      // Still paused, perhaps for another reason now.
      this.report(now, out);
    }
    return out;
  }

  // --------------------------------------------------------------------------------- reporting

  /** Publish segmenter.state when the state, mode or pause reason changed, or with `extra`
   *  (a discarded or captured stroke) always. */
  private report(t: number, out: Out, extra?: Partial<SegmenterStatus>): void {
    const state = this.current;
    const mode = this.mode;
    const pausedFor = state === 'paused' ? this.pausedFor() : undefined;
    const r = this.reported;
    if (!extra && r && r.state === state && r.mode === mode && r.pausedFor === pausedFor) return;
    const payload: SegmenterStatus = { state, t, mode };
    if (state === 'hovering' && mode === 'hold-still') payload.armProgress = this.progress.value;
    if (pausedFor !== undefined) payload.pausedFor = pausedFor;
    const strokeId = this.trace?.id ?? this.evaluating?.strokeId ?? this.cooldown?.strokeId;
    if (strokeId) payload.strokeId = strokeId;
    Object.assign(payload, extra);
    this.reported = { state, mode, pausedFor };
    out.push({ type: 'segmenter.state', payload });
  }

  /** While hovering, how far the hold has come (0..1), at most about 15 times a second. `t` is the
   *  capture time the hold has lasted until (the latest sample, or a still pointer's present). */
  private reportProgress(now: number, out: Out, t?: number): void {
    if (this.current !== 'hovering' || this.mode !== 'hold-still') return;
    const h = this.hold;
    let until = t ?? this.last?.t;
    if (t === undefined && this.last && this.isPenSource(this.src)) until = this.last.t + (now - this.lastArrival);
    const value = h && until !== undefined ? Math.round(Math.min(1, Math.max(0, (until - h.anchor.t) / this.s.armMs)) * 100) / 100 : 0;
    if (value === this.progress.value || now - this.progress.at < PROGRESS_INTERVAL_MS) return;
    this.progress = { value, at: now };
    out.push({ type: 'segmenter.state', payload: { state: 'hovering', t: until ?? now, mode: 'hold-still', armProgress: value } });
  }

  // ----------------------------------------------------------------------------------- helpers

  private modeFor(src: string | null): SegmenterMode {
    if (this.s.mode === 'pen' || this.s.mode === 'hold-still') return this.s.mode;
    return this.isPenSource(src) ? 'pen' : 'hold-still';
  }

  /** Pointer-style trackers (TrackerStatus.pen): their tip is present from found to lost, whatever
   *  the gaps between samples, and they play in the whole mirror. */
  private isPenSource(src: string | null): boolean {
    return !!src && this.sources.get(src)?.pen === true;
  }

  private aspectOf(src: string | null): number {
    return (src && this.sources.get(src)?.aspect) || DEFAULT_ASPECT;
  }

  /** Isotropic distance in frame widths. */
  private distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
    return Math.hypot(a.x - b.x, (a.y - b.y) / this.aspectOf(this.src));
  }
}

function validSample(s: TipSample | undefined): s is TipSample {
  return !!s && typeof s.src === 'string' && Number.isFinite(s.t) && Number.isFinite(s.x) && Number.isFinite(s.y);
}

function validAspect(a: unknown): number {
  return typeof a === 'number' && Number.isFinite(a) && a > 0 ? a : DEFAULT_ASPECT;
}

/** A play area with a usable size (a zero-width one from a bad setting falls back to the frame). */
export function sanePlayArea(pa: PlayArea | undefined): PlayArea {
  if (!pa || !(pa.w > 0) || !(pa.h > 0) || !Number.isFinite(pa.w) || !Number.isFinite(pa.h)) return WHOLE_MIRROR;
  return pa;
}
