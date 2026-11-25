// The line of light the tip leaves while tracing (Section 10.1, the casting moment):
//  1. While you trace it behaves like wet ink: it swells where the tip slows and the tail dries.
//  2. On a cast it settles into the clean shape of the gesture and brightens (morph.ts).
//  A fizzle stops at step 1: the ink dulls and runs off the glass, dripping under gravity and fading.
// Plus: a listening shimmer while the engine waits for speech ('spell.pending'), a quiet fade for
// strokes that were discarded or ignored, and Obliviate's "trails fade away".
//
// Reduced motion (Section 10.6): the trail appears without animation: an even line, no settle
// morph (it jumps to the clean shape), no drips; things still fade, since fading is not motion.
// High contrast: a thick white trail with a dark edge (the edge goes on the shade layer, because a
// dark color does nothing on the screen-blended light layer).

import type { Point } from '../../../../contracts';
import { CAST_SEQUENCE } from '../../../../contracts';
import { geometry } from '../../../../kernel';
import { mixRgb, parseColor, rgba, type Rgb } from './color';
import { alignForMorph, easeOutCubic, morphInto, MORPH_POINTS, resampleSamples, samplesFromPoints, type Samples } from './morph';
import type { Random } from './random';
import type { Sprites } from './sprites';
import type { View } from './view';

export interface InkPoint {
  x: number;
  y: number;
  /** Capture time of the sample (drying runs from it). */
  t: number;
  /** Wet width, fraction of the mirror height. */
  w: number;
  /** Isotropic length from the stroke's start (for the shimmer). */
  d: number;
}

export type InkState = 'wet' | 'waiting' | 'settling' | 'settled' | 'dripping' | 'fading';

/** Tuning for the wet-ink look, in fractions of the mirror height and milliseconds. */
export const INK = {
  minWidth: 0.0055,
  maxWidth: 0.019,
  /** Width falls off with speed: maxWidth when still, near minWidth above a few v0. Wands move at
   *  roughly 0.35 to 0.7 caster heights per second (contracts/settings.ts filter notes: 0.2 to 0.4
   *  frame widths), so v0 sits in that range and the ink visibly swells where the hand slows. */
  v0: 0.5,
  /** Low-pass on width so it swells and thins smoothly. */
  smoothing: 0.35,
  /** Ink pools where the tip lingers, up to this width. */
  poolWidth: 0.024,
  dryStartMs: 220,
  dryEndMs: 1500,
  /** Dry ink shrinks to this share of its wet width. */
  dryShrink: 0.72,
  cleanWidth: 0.0105,
  settledHoldMs: 650,
  settledFadeMs: 750,
  waitingTimeoutMs: 3500,
  fadeMs: 520,
  dripMs: 1900,
  /** Shortest step between stored points; closer samples pool instead. */
  minStep: 0.0022,
  maxPoints: 900,
} as const;

/** Wet width for a tip speed in caster heights per second (pure; tested). */
export function wetWidth(speed: number): number {
  return INK.minWidth + (INK.maxWidth - INK.minWidth) * Math.exp(-Math.max(0, speed) / INK.v0);
}

/** Width of a fizzled stroke's dulled line, fraction of the mirror height: about the width the
 *  ink had while wet, so the line dulls in place instead of shrinking to a thread. */
export function dripWidth(s: { points: readonly { w: number }[] }): number {
  if (!s.points.length) return INK.minWidth;
  let sum = 0;
  for (const p of s.points) sum += p.w;
  return Math.max(INK.minWidth, (sum / s.points.length) * 0.92);
}

/** The stroke is drawn from its clean shape (settling, settled, or fading after either), not from
 *  the points as traced. */
export function hasShape(s: { state: InkState; shape: unknown; morphK: number }): boolean {
  if (!s.shape) return false;
  return s.state === 'settling' || s.state === 'settled' || (s.state === 'fading' && s.morphK > 0);
}

/** Where the listening band is along the ink (0..1 of its length), `elapsed` ms into the wait. */
export function listenBand(elapsed: number): number {
  return (((elapsed / LISTEN_PERIOD_MS) % 1) + 1) % 1;
}

/** 1 for fresh ink, 0 for dry. */
export function wetness(ageMs: number): number {
  if (ageMs <= INK.dryStartMs) return 1;
  if (ageMs >= INK.dryEndMs) return 0;
  const t = (ageMs - INK.dryStartMs) / (INK.dryEndMs - INK.dryStartMs);
  return 1 - t * t * (3 - 2 * t);
}

interface Drip {
  /** Index of the ink point it runs from. */
  at: number;
  delay: number;
  gravity: number;
  maxLen: number;
  width: number;
}

export class InkStroke {
  points: InkPoint[] = [];
  state: InkState = 'wet';
  since: number;
  pending = false;
  pendingSince = 0;
  /** SpellPending.until: when the engine stops waiting for speech (kernel clock). */
  pendingUntil = Infinity;
  /** Morph endpoints and the current shape while settling or settled. */
  from: Samples | null = null;
  to: Samples | null = null;
  shape: Samples | null = null;
  /** How far the morph had gone (eased, 0..1) when the stroke left 'settling', so a settled shape
   *  that is then faded (Obliviate) keeps its clean form instead of jumping back to the raw trace. */
  morphK = 0;
  drips: Drip[] = [];
  sagDelay: Float32Array | null = null;
  /** Shape fades: alpha at the start of the current fade. */
  fadeMs: number = INK.fadeMs;
  dead = false;
  /** Drawn without animation (reduced motion when it was decided). */
  still = false;
  /** A voice-only sketch: drawn along its length while settling instead of morphed. */
  drawIn = false;

  constructor(public id: string, now: number, public readonly replay = false) {
    this.since = now;
  }

  get length(): number {
    return this.points.length ? this.points[this.points.length - 1].d : 0;
  }

  /** Caster-space points of the ink as traced. */
  asPoints(): Point[] {
    return this.points.map((p) => [p.x, p.y] as Point);
  }
}

/** Scratch buffers for drawing, so frames allocate nothing. */
class Scratch {
  x = new Float32Array(1024);
  y = new Float32Array(1024);
  w = new Float32Array(1024);
  wet = new Float32Array(1024);
  /** Where the listening glint is on the stroke being drawn (caster space), when it shows. */
  glint = false;
  glintX = 0;
  glintY = 0;
  ensure(n: number): void {
    if (n <= this.x.length) return;
    const size = Math.max(n, this.x.length * 2);
    this.x = new Float32Array(size); this.y = new Float32Array(size);
    this.w = new Float32Array(size); this.wet = new Float32Array(size);
  }
}

export interface InkStyle {
  highContrast: boolean;
  reducedMotion: boolean;
  /** FrameInfo.quality: 'low' draws a cheaper glow. Default 'high'. */
  quality?: 'high' | 'low';
}

/** Wetness levels in the ink palettes. */
const LEVELS = 24;
/** Fade levels: light fades by darkening, never by alpha (see inkColor). */
const FADES = 16;

const DRY = parseColor('#6E4C1C', '#000');
const WET = parseColor('#FFD27E', '#000');
const CORE_RGB = parseColor('#FFF9EC', '#000');
const HC_DRY = parseColor('#C9C9C9', '#000');
const HC_WET = parseColor('#FFFFFF', '#000');
/** The soft glow round the line: warm gold, added in faint passes of decreasing width. Many thin
 *  steps rather than a few strong ones, so the glow falls off smoothly instead of in bands. */
const HALO = '#C98A2E';
export const HALO_PASSES: readonly [width: number, alpha: number][] = [
  [7.2, 0.022], [5.8, 0.03], [4.6, 0.04], [3.6, 0.052], [2.8, 0.068], [2.1, 0.09],
];
/** At 'low' quality (stage.quality, or 'auto' when frames get slow) three wide passes do: the glow
 *  shows a little banding up close, at well under half the fill cost. */
export const HALO_PASSES_LOW: readonly [width: number, alpha: number][] = [[5.5, 0.06], [3.4, 0.1], [2.1, 0.16]];
/** An undecided stroke whose wait ('spell.pending') overruns its deadline by this much fades anyway. */
const PENDING_GRACE_MS = 2500;
/** A stroke that has settled into its spell's shape pulses this long (drawLight). */
const SETTLED_PULSE_MS = 480;
/** Dulled ink: a dark pigment on the shade layer (it shows on a bright room) under a tarnished
 *  sheen on the light layer (it shows on a dark one). */
const DULL = 'rgba(52, 42, 33, 0.86)';
const DULL_EDGE = 'rgba(14, 11, 8, 0.4)';
const DULL_SHEEN = '#5C4A33';
/** The glint that travels along the ink while the engine listens for speech ('spell.pending'). */
const LISTEN_GLINT = '#FFE6B0';
const LISTEN_PERIOD_MS = 1100;

export type InkTone = 'body' | 'core' | 'contrast';
const colorCache = new Map<number, string>();

/**
 * The ink's color for a wetness level (0 dry .. LEVELS-1 wet) and a fade level (0 out .. FADES-1 full).
 * Segments are drawn opaque, one after another with round caps, so translucent overlaps would show
 * as beads; instead light fades by darkening, which is neutral on the screen-blended light layer.
 */
export function inkColor(tone: InkTone, level: number, fade: number): string {
  const l = Math.max(0, Math.min(LEVELS - 1, Math.round(level)));
  const f = Math.max(0, Math.min(FADES - 1, Math.round(fade)));
  const key = ((tone === 'body' ? 0 : tone === 'core' ? 1 : 2) * LEVELS + l) * FADES + f;
  let css = colorCache.get(key);
  if (css === undefined) {
    const k = l / (LEVELS - 1);
    const base = tone === 'contrast' ? mixRgb(HC_DRY, HC_WET, k) : tone === 'core' ? mixRgb(mixRgb(DRY, WET, k), CORE_RGB, k) : mixRgb(DRY, WET, k);
    css = rgba(shadeRgb(base, f / (FADES - 1)), 1);
    colorCache.set(key, css);
  }
  return css;
}

function shadeRgb(c: Rgb, k: number): Rgb {
  return { r: c.r * k, g: c.g * k, b: c.b * k };
}

export class InkLayer {
  strokes: InkStroke[] = [];
  /** Recently settled shapes, newest last: Revelio's "the glass remembers" ghost traces. */
  history: Point[][] = [];
  /** geometry.arcFractions of each history shape, so drawing them allocates nothing. */
  historyFractions: number[][] = [];
  private scratch = new Scratch();

  constructor(private readonly random: Random) {}

  get(id: string): InkStroke | undefined {
    return this.strokes.find((s) => s.id === id && !s.dead);
  }

  /** The stroke still waiting for its decision, newest first. */
  undecided(): InkStroke | undefined {
    for (let i = this.strokes.length - 1; i >= 0; i--) {
      const s = this.strokes[i];
      if (!s.dead && (s.state === 'wet' || s.state === 'waiting')) return s;
    }
    return undefined;
  }

  begin(id: string, now: number, replay = false): InkStroke {
    const existing = this.get(id);
    if (existing) return existing;
    const s = new InkStroke(id, now, replay);
    this.strokes.push(s);
    // A few strokes at once is plenty; drop the oldest finished ones.
    while (this.strokes.length > 8) this.strokes.shift();
    return s;
  }

  /** Add a tip sample (caster space) to a wet stroke. */
  add(s: InkStroke, x: number, y: number, t: number, aspect: number): void {
    if (s.state !== 'wet' || s.points.length >= INK.maxPoints) return;
    const last = s.points[s.points.length - 1];
    if (!last) {
      // The tip was held still to arm, so the stroke starts with a small pool of ink.
      s.points.push({ x, y, t, w: INK.maxWidth * 0.85, d: 0 });
      return;
    }
    const step = Math.hypot((x - last.x) * aspect, y - last.y);
    if (step < INK.minStep) {
      // Lingering: the ink pools and stays fresh.
      last.w = Math.min(INK.poolWidth, last.w + 0.0005);
      last.t = Math.max(last.t, t);
      return;
    }
    const dt = Math.max(1, t - last.t);
    const speed = (step / dt) * 1000;
    const w = last.w + (wetWidth(speed) - last.w) * INK.smoothing;
    s.points.push({ x, y, t, w, d: last.d + step });
  }

  /** The stroke ended; the decision is still to come. */
  end(s: InkStroke, now: number): void {
    if (s.state !== 'wet') return;
    s.state = 'waiting';
    s.since = now;
  }

  /** Listening for speech: the stroke stays wet until the decision, or until a little past `until`
   *  if no decision comes (a lost event must not leave ink on the glass for good). */
  setPending(s: InkStroke, on: boolean, now: number, until?: number): void {
    if (on && !s.pending) s.pendingSince = now;
    s.pending = on;
    s.pendingUntil = on && typeof until === 'number' && Number.isFinite(until) ? until : Infinity;
  }

  /** Cast: settle onto the clean shape (caster space). */
  settle(s: InkStroke, target: readonly Point[], now: number, aspect: number, reducedMotion: boolean): void {
    if (s.dead || s.state === 'settling' || s.state === 'settled' || s.state === 'dripping') return;
    s.pending = false;
    const n = MORPH_POINTS;
    const pts = s.points.length ? s.points : [{ x: target[0][0], y: target[0][1], t: now, w: INK.cleanWidth, d: 0 }];
    s.from = resampleSamples(pts.map((p) => p.x), pts.map((p) => p.y), pts.map((p) => p.w), n, aspect);
    s.to = alignForMorph(s.from, samplesFromPoints(target, n, aspect), aspect);
    s.shape = { x: new Float32Array(n), y: new Float32Array(n), w: new Float32Array(n) };
    s.still = reducedMotion;
    s.state = reducedMotion ? 'settled' : 'settling';
    s.since = now;
    s.morphK = reducedMotion ? 1 : 0;
    morphInto(s.from, s.to, s.morphK, s.shape);
    this.remember(target);
  }

  /** A cast with no ink (voice only): the clean shape appears on its own, already settled. */
  sketch(id: string, target: readonly Point[], now: number, aspect: number, reducedMotion: boolean): InkStroke {
    const s = this.begin(id, now);
    s.state = 'waiting';
    this.settle(s, target, now, aspect, reducedMotion);
    // Drawn in rather than morphed: start from the target itself and reveal it along its length.
    if (s.from && s.to && s.shape) {
      s.from = { x: s.to.x, y: s.to.y, w: new Float32Array(s.to.x.length).fill(INK.cleanWidth) };
      morphInto(s.from, s.to, 1, s.shape);
    }
    s.drawIn = !reducedMotion;
    return s;
  }

  /** Fizzle: dull and drip (or, for steering/ignored and under reduced motion, just fade). */
  fizzle(s: InkStroke, now: number, drip: boolean, reducedMotion: boolean): void {
    if (s.dead || s.state === 'settling' || s.state === 'settled' || s.state === 'dripping' || s.state === 'fading') return;
    s.pending = false;
    if (!drip) {
      this.fade(s, now);
      return;
    }
    s.state = 'dripping';
    s.since = now;
    s.still = reducedMotion;
    const n = s.points.length;
    s.sagDelay = new Float32Array(n);
    const phase = this.random() * 10;
    for (let i = 0; i < n; i++) s.sagDelay[i] = 120 + 160 * (0.5 + 0.5 * Math.sin(i * 0.21 + phase));
    s.drips = [];
    if (!reducedMotion && n > 2) {
      const count = Math.max(3, Math.min(14, Math.round(s.length * 16)));
      for (let k = 0; k < count; k++) {
        const at = Math.min(n - 1, Math.floor(this.random() * n));
        s.drips.push({
          at,
          delay: 60 + this.random() * 420,
          gravity: 0.25 + this.random() * 0.55,
          maxLen: 0.05 + this.random() * 0.2,
          width: s.points[at].w * (0.45 + this.random() * 0.35),
        });
      }
    }
  }

  /** Fade quietly: discarded, ignored, steering, or forgotten. A shape that was settling or settled
   *  fades as the shape it had (see morphK). */
  fade(s: InkStroke, now: number, ms: number = INK.fadeMs): void {
    if (s.dead || s.state === 'fading') return;
    if (s.state === 'settling') s.morphK = s.still ? 1 : easeOutCubic((now - s.since) / CAST_SEQUENCE.settleMs);
    else if (s.state === 'settled') s.morphK = 1;
    s.pending = false;
    s.state = 'fading';
    s.since = now;
    s.fadeMs = ms;
  }

  /** Obliviate: every trail fades away, and the glass forgets the old ones too. */
  forgetAll(now: number): void {
    for (const s of this.strokes) this.fade(s, now, 700);
    this.history = [];
    this.historyFractions = [];
  }

  clear(): void {
    this.strokes = [];
  }

  /** Ink is moving of itself: a stroke settling into its spell's shape or pulsing as it settles,
   *  dripping after a fizzle, or carrying the listening glint ('spell.pending'). The stage then draws
   *  every frame (pacing.ts). Ink being traced moves with the tip, and drying or fading ink changes
   *  slowly: the stage draws those on demand. */
  animating(now: number): boolean {
    for (const s of this.strokes) {
      if (s.dead) continue;
      if (s.pending || s.state === 'settling' || s.state === 'dripping') return true;
      if (s.state === 'settled' && now - s.since < SETTLED_PULSE_MS) return true;
    }
    return false;
  }

  update(now: number): void {
    for (const s of this.strokes) {
      if (s.dead) continue;
      const age = now - s.since;
      switch (s.state) {
        case 'waiting':
          if (s.pending ? now > s.pendingUntil + PENDING_GRACE_MS : age > INK.waitingTimeoutMs) this.fade(s, now);
          break;
        case 'settling':
          if (s.from && s.to && s.shape) {
            const k = easeOutCubic(age / CAST_SEQUENCE.settleMs);
            morphInto(s.from, s.to, k, s.shape);
            s.morphK = k;
            if (age >= CAST_SEQUENCE.settleMs) {
              s.state = 'settled';
              s.since = now;
              s.morphK = 1;
            }
          }
          break;
        case 'settled':
          if (age > INK.settledHoldMs + INK.settledFadeMs) s.dead = true;
          break;
        case 'dripping':
          if (age > (s.still ? 900 : INK.dripMs)) s.dead = true;
          break;
        case 'fading':
          if (age > s.fadeMs) s.dead = true;
          break;
        default:
          break;
      }
    }
    if (this.strokes.some((s) => s.dead)) this.strokes = this.strokes.filter((s) => !s.dead);
  }

  /** Shade layer: dull dripping ink, and the dark edge of the high-contrast trail. */
  drawShade(ctx: CanvasRenderingContext2D, view: View, now: number, style: InkStyle): void {
    for (const s of this.strokes) {
      if (s.state === 'dripping') this.drawDrip(ctx, s, view, now);
      else if (style.highContrast) this.drawStroke(ctx, s, view, now, style, 'edge');
    }
  }

  /** Light layer: the luminous ink. `sprites` draws the listening glint (no glint without them). */
  drawLight(ctx: CanvasRenderingContext2D, view: View, now: number, style: InkStyle, sprites?: Sprites): void {
    for (const s of this.strokes) {
      if (s.state === 'dripping') this.drawDripSheen(ctx, s, view, now);
      else this.drawStroke(ctx, s, view, now, style, 'light', sprites);
    }
  }

  // ---------------------------------------------------------------- drawing

  /** Fill the scratch buffers with the stroke as it should look now. Returns the point count. */
  private fill(s: InkStroke, now: number, style: InkStyle): number {
    const sc = this.scratch;
    sc.glint = false;
    if (hasShape(s) && s.shape && s.from) {
      const k = s.state === 'settling' ? (s.still ? 1 : easeOutCubic((now - s.since) / CAST_SEQUENCE.settleMs)) : s.morphK;
      const all = s.shape.x.length;
      const n = s.drawIn ? Math.max(2, Math.ceil(all * k)) : all;
      sc.ensure(n);
      for (let i = 0; i < n; i++) {
        sc.x[i] = s.shape.x[i];
        sc.y[i] = s.shape.y[i];
        const w0 = style.reducedMotion ? INK.cleanWidth : s.from.w[i] || INK.cleanWidth;
        sc.w[i] = w0 + (INK.cleanWidth - w0) * k;
        sc.wet[i] = 1;
      }
      return n;
    }
    const n = s.points.length;
    sc.ensure(n);
    const total = s.length || 1;
    const band = s.pending ? listenBand(now - s.pendingSince) : -1;
    if (s.pending && !style.reducedMotion && n > 1) {
      // The glint rides the band: find where it is along the stroke's length.
      const at = band * total;
      let i = 1;
      while (i < n - 1 && s.points[i].d < at) i++;
      const a = s.points[i - 1], b = s.points[i];
      const k = b.d > a.d ? Math.min(1, Math.max(0, (at - a.d) / (b.d - a.d))) : 0;
      sc.glintX = a.x + (b.x - a.x) * k;
      sc.glintY = a.y + (b.y - a.y) * k;
      sc.glint = true;
    }
    for (let i = 0; i < n; i++) {
      const p = s.points[i];
      sc.x[i] = p.x;
      sc.y[i] = p.y;
      // Reduced motion: an even line that does not dry while you watch.
      let wet = style.reducedMotion ? 1 : i === n - 1 && s.state === 'wet' ? 1 : wetness(now - p.t);
      let w = style.reducedMotion ? INK.cleanWidth : p.w * (INK.dryShrink + (1 - INK.dryShrink) * wet);
      if (s.pending) {
        // Listening: the ink stays wet until the decision, and a soft band of light travels
        // along it (a steady glow under reduced motion).
        const off = (p.d / total - band) / 0.09;
        const boost = style.reducedMotion ? 0.35 : Math.exp(-(off * off));
        wet = Math.min(1, Math.max(wet, 0.55) + boost);
        w = p.w * (1 + 0.4 * boost);
      }
      sc.w[i] = w;
      sc.wet[i] = wet;
    }
    return n;
  }

  private alphaOf(s: InkStroke, now: number): number {
    const age = now - s.since;
    if (s.state === 'fading') return Math.max(0, 1 - age / s.fadeMs);
    if (s.state === 'settled') {
      if (age < INK.settledHoldMs) return 1;
      return Math.max(0, 1 - (age - INK.settledHoldMs) / INK.settledFadeMs);
    }
    return 1;
  }

  private drawStroke(ctx: CanvasRenderingContext2D, s: InkStroke, view: View, now: number, style: InkStyle, pass: 'light' | 'edge', sprites?: Sprites): void {
    const n = this.fill(s, now, style);
    if (n === 0) return;
    const alpha = this.alphaOf(s, now);
    if (alpha <= 0.01) return;
    const sc = this.scratch;
    const H = view.height * view.dpr;
    const hc = style.highContrast;
    const widthK = hc ? 1.7 : 1;
    const fade = alpha * (FADES - 1);
    let sumW = 0, maxW = 0;
    for (let i = 0; i < n; i++) {
      sumW += sc.w[i];
      if (sc.w[i] > maxW) maxW = sc.w[i];
    }
    const meanW = sumW / n;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (pass === 'edge') {
      // The dark edge under the high-contrast trail: one path, wide enough for the widest point.
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 0.85 * alpha;
      ctx.strokeStyle = '#05070c';
      ctx.lineWidth = maxW * widthK * H + Math.max(4, 0.006 * H);
      this.path(ctx, view, n);
      ctx.stroke();
      ctx.globalAlpha = 1;
      return;
    }

    const tone: InkTone = hc ? 'contrast' : 'body';
    if (n === 1) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.fillStyle = inkColor(tone, LEVELS - 1, fade);
      ctx.beginPath();
      ctx.arc(view.px(sc.x[0]), view.py(sc.y[0]), (sc.w[0] * widthK * H) / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }

    // 1. A soft glow round the whole line: a few faint, widening passes added together.
    if (!hc) {
      const settledGlow = s.state === 'settling' || s.state === 'settled';
      // As it settles the line brightens, then the glow eases back.
      const pulse = s.state === 'settled' && !s.still ? 1 + 0.5 * Math.max(0, 1 - (now - s.since) / SETTLED_PULSE_MS) : 1;
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = HALO;
      for (const [k, a] of style.quality === 'low' ? HALO_PASSES_LOW : HALO_PASSES) {
        ctx.globalAlpha = Math.min(1, a * alpha * (settledGlow ? 1.7 : 1) * pulse);
        ctx.lineWidth = meanW * H * k * (settledGlow ? 1.15 : 1);
        this.path(ctx, view, n);
        ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    if (s.state === 'settled') {
      // The clean shape: an even line and a bright core, each one path.
      ctx.strokeStyle = inkColor(tone, LEVELS - 1, fade);
      ctx.lineWidth = Math.max(1, meanW * widthK * H);
      this.path(ctx, view, n);
      ctx.stroke();
      if (!hc) {
        ctx.strokeStyle = inkColor('core', LEVELS - 1, fade);
        ctx.lineWidth = Math.max(1, meanW * H * 0.42);
        this.path(ctx, view, n);
        ctx.stroke();
      }
      return;
    }

    // 2. The body, segment by segment: width and dryness vary along the line. Opaque, so the
    //    round caps where segments meet never show.
    let last = '';
    for (let i = 1; i < n; i++) {
      const css = inkColor(tone, ((sc.wet[i] + sc.wet[i - 1]) / 2) * (LEVELS - 1), fade);
      if (css !== last) {
        ctx.strokeStyle = css;
        last = css;
      }
      ctx.lineWidth = Math.max(1, ((sc.w[i] + sc.w[i - 1]) / 2) * widthK * H);
      this.segment(ctx, view, i);
    }

    // 3. A bright core where the ink is still wet (and all along a settling shape).
    if (!hc) {
      last = '';
      for (let i = 1; i < n; i++) {
        const wet = Math.min(sc.wet[i], sc.wet[i - 1]);
        if (wet < 0.3) continue;
        const css = inkColor('core', wet * (LEVELS - 1), fade);
        if (css !== last) {
          ctx.strokeStyle = css;
          last = css;
        }
        ctx.lineWidth = Math.max(1, ((sc.w[i] + sc.w[i - 1]) / 2) * H * (s.state === 'settling' ? 0.42 : 0.36));
        this.segment(ctx, view, i);
      }
    }

    // 4. Listening ('spell.pending'): a soft glint travels along the ink until the decision. The
    //    ink is already lit, so the glint is what makes the waiting visible; it stays small.
    if (sc.glint && sprites) {
      const gx = view.px(sc.glintX), gy = view.py(sc.glintY);
      const R = 0.034 * H, r = 0.011 * H;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55 * alpha;
      ctx.drawImage(sprites.glow(LISTEN_GLINT), gx - R, gy - R, R * 2, R * 2);
      ctx.globalAlpha = 0.8 * alpha;
      ctx.drawImage(sprites.glow('#FFFFFF'), gx - r, gy - r, r * 2, r * 2);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  private path(ctx: CanvasRenderingContext2D, view: View, n: number): void {
    const sc = this.scratch;
    ctx.beginPath();
    ctx.moveTo(view.px(sc.x[0]), view.py(sc.y[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(view.px(sc.x[i]), view.py(sc.y[i]));
  }

  private segment(ctx: CanvasRenderingContext2D, view: View, i: number): void {
    const sc = this.scratch;
    ctx.beginPath();
    ctx.moveTo(view.px(sc.x[i - 1]), view.py(sc.y[i - 1]));
    ctx.lineTo(view.px(sc.x[i]), view.py(sc.y[i]));
    ctx.stroke();
  }

  private dripAlpha(s: InkStroke, now: number): number {
    const age = now - s.since;
    const total = s.still ? 900 : INK.dripMs;
    const hold = s.still ? 450 : 320;
    if (age < hold) return 1;
    return Math.max(0, 1 - (age - hold) / (total - hold)) ** 1.3;
  }

  /** Sag of point i at a given age: ink running down the glass. */
  private sag(s: InkStroke, i: number, age: number): number {
    if (s.still || !s.sagDelay) return 0;
    const t = Math.max(0, age - s.sagDelay[i]) / 1000;
    return 0.5 * 0.05 * t * t;
  }

  /** The dulled ink and its drips, on the shade layer. */
  private drawDrip(ctx: CanvasRenderingContext2D, s: InkStroke, view: View, now: number): void {
    const n = s.points.length;
    if (n === 0) return;
    const age = now - s.since;
    const alpha = this.dripAlpha(s, now);
    if (alpha <= 0.01) return;
    const H = view.height * view.dpr;
    // The ink loses its light over the first moments and becomes dull pigment, keeping the body it
    // had while wet (a fizzle is the casting moment stopped at step 1, not a different line).
    // Drawn as single paths: overlapping translucent segments would bead.
    const dull = Math.min(1, age / 260);
    const w = dripWidth(s) * H;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = alpha * dull;
    ctx.strokeStyle = DULL_EDGE;
    ctx.lineWidth = Math.max(1, w + Math.max(2, 0.003 * H));
    this.dripPath(ctx, s, view, age);
    ctx.stroke();
    ctx.strokeStyle = DULL;
    ctx.lineWidth = Math.max(1, w);
    this.dripPath(ctx, s, view, age);
    ctx.stroke();
    // Drips run from the line under gravity: slow at first, then quicker. Each leaves the line wide,
    // narrows as it runs, and ends in a bead.
    ctx.fillStyle = DULL;
    for (const d of s.drips) {
      const t = Math.max(0, age - d.delay) / 1000;
      if (t <= 0) continue;
      const len = Math.min(d.maxLen, 0.5 * d.gravity * t * t) * H;
      const p = s.points[d.at];
      const x = view.px(p.x);
      const y0 = view.py(p.y + this.sag(s, d.at, age));
      const root = Math.max(1.5, d.width * H * 1.1);
      const bead = Math.max(1.2, d.width * H * 0.62);
      const neck = Math.max(0.8, bead * 0.45);
      const y1 = y0 + Math.max(len, bead);
      ctx.beginPath();
      ctx.moveTo(x - root / 2, y0);
      ctx.quadraticCurveTo(x - neck, y0 + len * 0.35, x - neck, y1 - bead);
      ctx.lineTo(x + neck, y1 - bead);
      ctx.quadraticCurveTo(x + neck, y0 + len * 0.35, x + root / 2, y0);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(x, y1, bead, bead * 1.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  private dripPath(ctx: CanvasRenderingContext2D, s: InkStroke, view: View, age: number): void {
    ctx.beginPath();
    for (let i = 0; i < s.points.length; i++) {
      const p = s.points[i];
      const x = view.px(p.x), y = view.py(p.y + this.sag(s, i, age));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  }

  /** The last of the ink's light as it dulls, on the light layer, so it still reads on a dark room. */
  private drawDripSheen(ctx: CanvasRenderingContext2D, s: InkStroke, view: View, now: number): void {
    const n = s.points.length;
    if (n < 2) return;
    const age = now - s.since;
    const alpha = this.dripAlpha(s, now);
    if (alpha <= 0.01) return;
    const H = view.height * view.dpr;
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 1;
    // Fades from the ink's own light to a tarnished sheen, then out with the drip.
    ctx.strokeStyle = age < 300 ? inkColor('body', (1 - age / 300) * (LEVELS - 1), alpha * (FADES - 1)) : DULL_SHEEN;
    if (age >= 300) ctx.globalAlpha = alpha * 0.9;
    ctx.lineWidth = Math.max(1, dripWidth(s) * H * 0.5);
    this.dripPath(ctx, s, view, age);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private remember(shape: readonly Point[]): void {
    const copy = shape.map((p) => [p[0], p[1]] as Point);
    this.history.push(copy);
    this.historyFractions.push(geometry.arcFractions(copy));
    while (this.history.length > 6) {
      this.history.shift();
      this.historyFractions.shift();
    }
  }
}
