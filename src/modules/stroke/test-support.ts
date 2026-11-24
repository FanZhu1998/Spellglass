// Synthetic tip streams for the stroke module's tests: a 30 fps camera (or a pointer) driving the
// pure Segmenter, with the outputs collected in order. Not used by the app.

import type { SegmentationNeeds, SegmenterState, SegmenterStatus, Stroke, TipSample } from '../../contracts';
import type { SegmenterOutput, SegmenterSettings } from './segmenter';
import { DEFAULT_SEGMENTER_SETTINGS, Segmenter } from './segmenter';

export const ASPECT = 16 / 9;
export const CAMERA = 'tracker.bright-tip';
export const POINTER = 'tracker.pointer';

/** Deterministic pseudo-random numbers (a linear congruential generator) and Gaussian noise. */
export class Noise {
  private seed: number;
  constructor(seed = 1) {
    this.seed = seed >>> 0 || 1;
  }
  uniform(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }
  gauss(sd = 1): number {
    let u = 0;
    while (u === 0) u = this.uniform();
    const v = this.uniform();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * sd;
  }
}

export interface FeedOptions {
  settings?: Partial<SegmenterSettings>;
  /** Filter positions (default false: the state tests feed exact positions). */
  filter?: boolean;
  fps?: number;
  /** Tracker id of the samples. */
  src?: string;
  /** Publish tracker.status first with this pen flag (default false); null publishes none. */
  pen?: boolean | null;
  aspect?: number;
  /** The tracker's segmentation needs, sent with its tracker.status (contracts 1.2). */
  segmentation?: SegmentationNeeds;
  /** Start time on the kernel clock. */
  t0?: number;
  /** Arrival lag: kernel time = capture time + latency. */
  latencyMs?: number;
}

/** Drives a Segmenter like a tracker would, ticking every 40 ms between frames. */
export class Feed {
  readonly seg: Segmenter;
  readonly out: SegmenterOutput[] = [];
  /** Capture time of the next frame. */
  t: number;
  readonly fps: number;
  readonly src: string;
  readonly aspect: number;
  readonly segmentation: SegmentationNeeds | undefined;
  readonly latencyMs: number;
  /** Kernel time of the last tick. */
  private lastTick: number;
  private ids = 0;

  constructor(options: FeedOptions = {}) {
    this.fps = options.fps ?? 30;
    this.src = options.src ?? CAMERA;
    this.aspect = options.aspect ?? ASPECT;
    this.segmentation = options.segmentation;
    this.latencyMs = options.latencyMs ?? 0;
    this.t = options.t0 ?? 1000;
    this.lastTick = this.t;
    this.seg = new Segmenter({
      settings: { ...DEFAULT_SEGMENTER_SETTINGS, ...options.settings },
      filter: options.filter ?? false,
      newId: (prefix) => `${prefix}-${++this.ids}`,
    });
    this.out.push(...this.seg.start(this.t));
    if (options.pen !== null) this.status(options.pen ?? false);
  }

  get frameMs(): number {
    return 1000 / this.fps;
  }

  /** Kernel time now: the capture time of the latest frame plus the arrival latency. */
  get now(): number {
    return this.t + this.latencyMs;
  }

  /** A tracker.status. The feed's own tracker sends its segmentation needs unless given others, or
   *  null for none. */
  status(pen: boolean, aspect = this.aspect, tracker = this.src, segmentation: SegmentationNeeds | null = tracker === this.src ? (this.segmentation ?? null) : null): this {
    this.out.push(...this.seg.status({ tracker, state: 'tracking', lock: 1, fps: this.fps, aspect, pen, ...(segmentation ? { segmentation } : {}) }, this.now));
    return this;
  }

  found(x: number, y: number): this {
    this.ticksUntil(this.now);
    this.out.push(...this.seg.found(this.sampleAt(x, y), this.now));
    return this;
  }

  /** One frame at (x, y), then the clock moves to the next frame. */
  frame(x: number, y: number, extra: Partial<TipSample> = {}): this {
    this.ticksUntil(this.now);
    this.out.push(...this.seg.sample({ ...this.sampleAt(x, y), ...extra }, this.now));
    this.t += this.frameMs;
    return this;
  }

  /** Hold still at (x, y) for ms, with optional jitter (frame widths, both axes). */
  hold(x: number, y: number, ms: number, jitter = 0, noise = new Noise(7)): this {
    const end = this.t + ms;
    while (this.t < end - 1e-6) this.frame(x + noise.gauss(jitter), y + noise.gauss(jitter) * this.aspect);
    return this;
  }

  /** Move in a straight line from a to b over ms (frames along the way, b on the last). */
  move(a: [number, number], b: [number, number], ms: number): this {
    const n = Math.max(1, Math.round(ms / this.frameMs));
    for (let i = 1; i <= n; i++) {
      const k = i / n;
      this.frame(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k);
    }
    return this;
  }

  /** Follow a polyline over ms at constant speed. */
  path(points: [number, number][], ms: number): this {
    const lens = [0];
    for (let i = 1; i < points.length; i++) lens.push(lens[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], (points[i][1] - points[i - 1][1]) / this.aspect));
    const total = lens[lens.length - 1];
    const n = Math.max(1, Math.round(ms / this.frameMs));
    for (let f = 1; f <= n; f++) {
      const d = (f / n) * total;
      let i = 1;
      while (i < lens.length - 1 && lens[i] < d) i++;
      const k = (d - lens[i - 1]) / (lens[i] - lens[i - 1] || 1);
      this.frame(points[i - 1][0] + (points[i][0] - points[i - 1][0]) * k, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * k);
    }
    return this;
  }

  /** tip.lost now, for the last frame. */
  lost(): this {
    this.ticksUntil(this.now);
    this.out.push(...this.seg.lost({ t: this.t, src: this.src }, this.now));
    return this;
  }

  /** Let time pass with no frames, ticking every 40 ms. */
  wait(ms: number): this {
    const end = this.t + ms;
    this.ticksUntil(end + this.latencyMs);
    this.t = end;
    return this;
  }

  /** Answer the latest stroke.end. */
  decide(kind: 'cast' | 'fizzle', strokeId = this.lastStroke('stroke.end')?.id): this {
    this.out.push(...this.seg.decided(strokeId, kind, this.now));
    return this;
  }

  private ticksUntil(now: number): void {
    while (this.lastTick + 40 <= now) {
      this.lastTick += 40;
      this.out.push(...this.seg.tick(this.lastTick));
    }
  }

  private sampleAt(x: number, y: number): TipSample {
    return { t: Math.round(this.t * 10) / 10, x, y, conf: 0.95, src: this.src };
  }

  // ------------------------------------------------------------------------------- reading

  statuses(): SegmenterStatus[] {
    return this.out.filter((o): o is Extract<SegmenterOutput, { type: 'segmenter.state' }> => o.type === 'segmenter.state').map((o) => o.payload);
  }

  /** States in the order they were entered (repeated hovering progress reports collapsed). */
  states(): SegmenterState[] {
    const seq: SegmenterState[] = [];
    for (const s of this.statuses()) if (seq[seq.length - 1] !== s.state) seq.push(s.state);
    return seq;
  }

  strokes(type: 'stroke.begin' | 'stroke.end' | 'captured' = 'stroke.end'): Stroke[] {
    return this.out.filter((o) => o.type === type).map((o) => o.payload as Stroke);
  }

  lastStroke(type: 'stroke.begin' | 'stroke.end' | 'captured' = 'stroke.end'): Stroke | undefined {
    const all = this.strokes(type);
    return all[all.length - 1];
  }

  filtered(): TipSample[] {
    return this.out.filter((o) => o.type === 'tip.filtered').map((o) => o.payload as TipSample);
  }

  /** Forget the outputs so far. */
  clear(): this {
    this.out.length = 0;
    return this;
  }
}
