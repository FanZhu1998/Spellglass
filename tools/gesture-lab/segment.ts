// An approximation of the filter and hold-still segmenter of Section 7.4, for checking recorded-
// session fixtures in the lab without the real stroke module (which another package owns and which
// may filter or cut strokes a little differently). Not used by the app.
//
// States: searching → hovering (tip found) → armed (held still 0.3 s within 2% of the frame width)
// → tracing (the tip moves) → a decision at a 0.25 s pause within 1.2%, after 0.2 s without the tip,
// or at 4 s. Trailing still samples are trimmed. Strokes under 8 samples or 15% of the frame are
// dropped without a decision. A cast is followed by a 0.4 s cooldown; a fizzle goes straight back to
// hovering. Distances are in caster-x units (fractions of the frame width), as the settings say.

import type { SessionEvent } from '../../src/contracts';
import { DEFAULT_SETTINGS } from '../../src/contracts';

/** The One Euro filter (Casiez et al.): smooths hard when slow, backs off when fast. */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;
  constructor(
    private minCutoff = DEFAULT_SETTINGS['filter.minCutoff'],
    private beta = DEFAULT_SETTINGS['filter.beta'],
    private dCutoff = DEFAULT_SETTINGS['filter.dCutoff'],
  ) {}

  filter(value: number, tMs: number): number {
    if (this.x === null) {
      this.x = value;
      this.dx = 0;
      this.t = tMs;
      return value;
    }
    const dt = Math.max(1e-3, (tMs - this.t) / 1000);
    const ad = alpha(this.dCutoff, dt);
    this.dx = ad * ((value - this.x) / dt) + (1 - ad) * this.dx;
    const a = alpha(this.minCutoff + this.beta * Math.abs(this.dx), dt);
    this.x = a * value + (1 - a) * this.x;
    this.t = tMs;
    return this.x;
  }

  reset(): void {
    this.x = null;
  }
}

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

export interface SegmentOptions {
  aspect: number;
  /** Filter positions with One Euro, multiplying caster units by `scale` first (1: caster units, the
   *  heaviest smoothing the default settings allow; 1920: pixels, almost none). null: raw. */
  filterScale: number | null;
  armMs: number;
  armRadius: number;
  pauseMs: number;
  pauseRadius: number;
  lostMs: number;
  maxMs: number;
  minSamples: number;
  minExtent: number;
  cooldownMs: number;
}

export const SEGMENT_DEFAULTS: Omit<SegmentOptions, 'aspect'> = {
  filterScale: null,
  armMs: DEFAULT_SETTINGS['segmenter.armMs'],
  armRadius: DEFAULT_SETTINGS['segmenter.armRadius'],
  pauseMs: DEFAULT_SETTINGS['segmenter.pauseMs'],
  pauseRadius: DEFAULT_SETTINGS['segmenter.pauseRadius'],
  lostMs: DEFAULT_SETTINGS['segmenter.lostMs'],
  maxMs: DEFAULT_SETTINGS['segmenter.maxMs'],
  minSamples: DEFAULT_SETTINGS['segmenter.minSamples'],
  minExtent: DEFAULT_SETTINGS['segmenter.minExtent'],
  cooldownMs: DEFAULT_SETTINGS['segmenter.cooldownMs'],
};

export interface FoundStroke {
  points: { t: number; x: number; y: number }[];
  t0: number;
  t1: number;
  endReason: 'pause' | 'lost' | 'max';
}

/** Decide one stroke: true when it was cast (so a cooldown follows), false for a fizzle. */
export type StrokeDecider = (stroke: FoundStroke) => boolean;

/** Run the approximate segmenter over a session's events. Returns every stroke that reached a
 *  decision, in order. */
export function segmentSession(events: readonly SessionEvent[], options: Partial<SegmentOptions> & { aspect: number }, decide: StrokeDecider): FoundStroke[] {
  const o: SegmentOptions = { ...SEGMENT_DEFAULTS, ...options };
  const fx = new OneEuro();
  const fy = new OneEuro();
  const out: FoundStroke[] = [];
  type P = { t: number; x: number; y: number };
  type State = 'searching' | 'hovering' | 'armed' | 'tracing' | 'cooldown';
  // Widened on purpose: finish() and lose() change the state from inside closures, which
  // TypeScript's narrowing does not see.
  let state = 'searching' as State;
  let anchor: P | null = null;
  let armedAt: P | null = null;
  /** Samples since arming: a trace that starts slowly moves inside the arm radius for a few frames,
   *  and those frames belong to the stroke. */
  let armed: P[] = [];
  let stroke: P[] = [];
  let still: P | null = null;
  let stillIndex = 0;
  let cooldownUntil = 0;
  let lastT = -Infinity;
  // Distances in caster-x units: y is scaled by 1/aspect to the same units.
  const d = (a: P, b: P) => Math.hypot(a.x - b.x, (a.y - b.y) / o.aspect);

  const finish = (reason: FoundStroke['endReason'], until: number, now: P) => {
    const pts = stroke.slice(0, until + 1);
    stroke = [];
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const extent = pts.length ? Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) : 0;
    if (pts.length < o.minSamples || extent < o.minExtent) {
      state = 'hovering';
      anchor = now;
      return;
    }
    const found: FoundStroke = { points: pts, t0: pts[0].t, t1: pts[pts.length - 1].t, endReason: reason };
    out.push(found);
    if (decide(found)) {
      state = 'cooldown';
      cooldownUntil = now.t + o.cooldownMs;
    } else {
      state = 'hovering';
      anchor = now;
    }
  };

  const lose = (now: number) => {
    if (state === 'tracing') finish('lost', stroke.length - 1, stroke[stroke.length - 1] ?? { t: now, x: 0, y: 0 });
    state = 'searching';
    anchor = null;
    fx.reset();
    fy.reset();
  };

  for (const e of events) {
    if (e.type === 'tip.lost') {
      lose(e.t);
      continue;
    }
    if (e.type !== 'tip.sample') continue;
    if (e.t - lastT > o.lostMs && state !== 'searching') lose(e.t);
    lastT = e.t;
    const p: P = o.filterScale === null
      ? { t: e.t, x: e.x, y: e.y }
      : { t: e.t, x: fx.filter(e.x * o.filterScale, e.t) / o.filterScale, y: fy.filter(e.y * o.filterScale, e.t) / o.filterScale };

    switch (state) {
      case 'searching':
        state = 'hovering';
        anchor = p;
        break;
      case 'cooldown':
        if (p.t >= cooldownUntil) {
          state = 'hovering';
          anchor = p;
        }
        break;
      case 'hovering':
        if (!anchor || d(p, anchor) > o.armRadius) anchor = p;
        else if (p.t - anchor.t >= o.armMs) {
          state = 'armed';
          armedAt = p;
          armed = [p];
        }
        break;
      case 'armed':
        // The tip moves once it leaves the arm radius around where it was armed. The stroke starts at
        // the last sample that was still at the arm point, so a slow start is kept.
        if (armedAt && d(p, armedAt) > o.armRadius) {
          let j = armed.length - 1;
          while (j > 0 && d(armed[j], armedAt) > o.pauseRadius) j--;
          state = 'tracing';
          stroke = [...armed.slice(j), p];
          still = p;
          stillIndex = stroke.length - 1;
        } else armed.push(p);
        break;
      case 'tracing': {
        stroke.push(p);
        if (!still || d(p, still) > o.pauseRadius) {
          still = p;
          stillIndex = stroke.length - 1;
        } else if (p.t - still.t >= o.pauseMs) {
          finish('pause', stillIndex, p);
          break;
        }
        if (p.t - stroke[0].t >= o.maxMs) finish('max', stroke.length - 1, p);
        break;
      }
    }
  }
  if (state === 'tracing') finish('lost', stroke.length - 1, stroke[stroke.length - 1]);
  return out;
}
