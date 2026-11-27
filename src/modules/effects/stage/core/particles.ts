// Pooled particles (particles.burst, particles.stream, and every sparkle the stage or the props make).
//
// One fixed pool of EFFECT_LIMITS.particlesMax particles in typed arrays: no allocation per frame
// and a hard cap no pack can exceed (Section 10.6). Positions are isotropic (x × caster aspect, y),
// in units of the caster height, so a burst is round on screen.
//
// Light presets (sparks, embers, water, mist, stars) are drawn on the light layer; dust and smoke
// are not light, so they are drawn on the shade layer with normal blending (an interpretation of
// the draw order, where the light pass lists "particles").
//
// Reduced motion (Section 10.6): every count the core spawns has already been cut by
// EFFECT_LIMITS.reducedMotionParticleFactor (limits.ts prepares the steps; stream rates are cut in
// prepareStream). ParticleApi.burst() takes the count it is given: the props cut their own counts
// from FrameInfo.reducedMotion (PropBase.count), so cutting again here would apply the factor twice.

import type { ParticlePreset } from '../../../../contracts';
import { EFFECT_LIMITS, PARTICLE_PRESETS } from '../../../../contracts';
import type { BurstOptions, ParticleApi } from '../types';
import type { Random } from './random';
import { MAX_BURST } from './limits';
import type { Sprites } from './sprites';
import type { View } from './view';
import type { XY } from './anchors';

type Shape = 'streak' | 'dot' | 'star' | 'puff' | 'drop';

export interface PresetDef {
  layer: 'light' | 'shade';
  /** Lifetime range, ms. */
  life: [number, number];
  /** Launch speed range, caster heights per second. */
  speed: [number, number];
  /** Radius range, fraction of the mirror height. */
  size: [number, number];
  /** Caster heights per second squared; positive falls. */
  gravity: number;
  /** Fraction of velocity lost per second. */
  drag: number;
  color: string;
  shape: Shape;
  alpha: number;
  twinkle?: boolean;
  flicker?: boolean;
  /** Size growth over the lifetime (smoke and mist spread out). */
  grow?: number;
  /** Sideways curl, caster heights per second (smoke). The phase follows height, so a rising
   *  column bends into an S rather than every puff swaying together. */
  curl?: number;
  /** Water splashes into droplets when it lands. */
  splash?: boolean;
  /** Share of the lifetime spent fading in (default 0.08). Mist and smoke gather slowly, so a
   *  burst of them never jumps to full brightness the way a flash would. */
  fadeIn?: number;
  /** Particles start scattered over a disc of this radius (fraction of the mirror height) instead
   *  of a single point, so soft presets read as a cloud rather than a bright knot. */
  jitter?: number;
}

export const PRESETS: Record<ParticlePreset, PresetDef> = {
  sparks: { layer: 'light', life: [320, 700], speed: [0.35, 0.95], size: [0.0026, 0.005], gravity: 0.55, drag: 2.6, color: '#FFD487', shape: 'streak', alpha: 1 },
  embers: { layer: 'light', life: [900, 1700], speed: [0.1, 0.38], size: [0.003, 0.0065], gravity: -0.16, drag: 1.3, color: '#FF7B2E', shape: 'dot', alpha: 0.95, flicker: true },
  // Drops: a bright bead with a short tail along its motion, so a stream reads as moving water.
  water: { layer: 'light', life: [700, 1100], speed: [0.35, 0.8], size: [0.0035, 0.007], gravity: 1.5, drag: 0.35, color: '#A8DCFF', shape: 'drop', alpha: 0.9, splash: true },
  // A faint haze: many soft, translucent puffs that gather slowly and spread. Each is dim, so even
  // forty of them overlapping stay a haze, never a white blob (or anything flash-like).
  mist: { layer: 'light', life: [1500, 2600], speed: [0.05, 0.16], size: [0.04, 0.08], gravity: -0.012, drag: 0.9, color: '#C7D9EE', shape: 'puff', alpha: 0.12, grow: 1.4, fadeIn: 0.35, jitter: 0.03 },
  stars: { layer: 'light', life: [850, 1650], speed: [0.12, 0.42], size: [0.0055, 0.011], gravity: 0.03, drag: 2.3, color: '#FFF1C2', shape: 'star', alpha: 1, twinkle: true },
  dust: { layer: 'shade', life: [800, 1500], speed: [0.18, 0.65], size: [0.003, 0.008], gravity: 0.9, drag: 1.8, color: '#8E7C66', shape: 'dot', alpha: 0.85 },
  // A curl of smoke: small wisps that rise, widen and bend as they go (light.snuff, a snuffed candle).
  smoke: { layer: 'shade', life: [1400, 2400], speed: [0.05, 0.14], size: [0.007, 0.013], gravity: -0.06, drag: 0.9, color: '#A59E95', shape: 'puff', alpha: 0.3, grow: 3.2, curl: 0.06, fadeIn: 0.15, jitter: 0.004 },
};

/** Streak length per unit of speed (caster heights per second), as a fraction of the mirror height. */
const STREAK_K = 0.045;
/** Drops trail a shorter, fainter tail than sparks: a bead of water with a little motion blur. */
const DROP_K = 0.011;

const PRESET_INDEX = new Map<ParticlePreset, number>(PARTICLE_PRESETS.map((p, i) => [p, i]));

/** A stream of particles flying from one anchor to another (Aguamenti's water arc, Accio's stars). */
interface Stream {
  preset: ParticlePreset;
  color: number;
  arc: number;
  rate: number;
  until: number;
  acc: number;
  /** Current endpoints, caster space, refreshed every frame. */
  resolve: () => { from: XY; to: XY };
  a: XY;
  b: XY;
  alive: boolean;
  /** Span of the arc its live particles cover (0 at the source, 1 at the target), from the last
   *  update. A water stream draws its jet over this span, so the jet grows out of the tip, and
   *  when the stream stops its tail leaves the tip and runs into the target. */
  pMin: number;
  pMax: number;
}

/** The quadratic arc of a stream in isotropic units: from a to b, bowed upward through c. Kept in
 *  one reused object so placing particles allocates nothing. */
export interface Arc {
  ax: number; ay: number; bx: number; by: number; cx: number; cy: number;
  /** Unit normal pointing up the screen. */
  nx: number; ny: number;
}

/** Fill `out` with the arc from (ax, ay) to (bx, by), bowed upward by `arc` × its length. */
export function arcThrough(ax: number, ay: number, bx: number, by: number, arc: number, out: Arc): Arc {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  // Perpendicular that points up the screen, so arcs bow upward like a thrown stream.
  let nx = -dy / len, ny = dx / len;
  if (ny > 0) { nx = -nx; ny = -ny; }
  out.ax = ax; out.ay = ay; out.bx = bx; out.by = by;
  out.cx = (ax + bx) / 2 + nx * arc * len;
  out.cy = (ay + by) / 2 + ny * arc * len;
  out.nx = nx; out.ny = ny;
  return out;
}

export interface StreamOptions {
  preset: ParticlePreset;
  resolve: () => { from: XY; to: XY };
  /** How long it flows; Infinity for a held stream, which flows until stop(). */
  durationMs: number;
  rate: number;
  arc: number;
  color?: string;
}

export class ParticleSystem implements ParticleApi {
  readonly capacity: number;
  private n = 0;
  private x: Float32Array; private y: Float32Array;
  private vx: Float32Array; private vy: Float32Array;
  private age: Float32Array; private life: Float32Array;
  private size: Float32Array; private seed: Float32Array;
  private preset: Uint8Array; private color: Uint16Array;
  private stream: Int16Array; private p: Float32Array; private pRate: Float32Array; private off: Float32Array;
  private floorY: Float32Array;
  private palette: string[] = [];
  private paletteIndex = new Map<string, number>();
  private streams: (Stream | null)[] = [];
  private aspect = 16 / 9;
  /** Time the system has advanced, ms (scaled by the global time scale). */
  private clock = 0;
  private readonly arc: Arc = { ax: 0, ay: 0, bx: 0, by: 0, cx: 0, cy: 0, nx: 0, ny: 0 };

  constructor(
    private readonly random: Random,
    private readonly reducedMotion: () => boolean,
    capacity: number = EFFECT_LIMITS.particlesMax,
  ) {
    this.capacity = Math.max(1, Math.min(capacity, EFFECT_LIMITS.particlesMax));
    const f = () => new Float32Array(this.capacity);
    this.x = f(); this.y = f(); this.vx = f(); this.vy = f(); this.age = f(); this.life = f();
    this.size = f(); this.seed = f(); this.p = f(); this.pRate = f(); this.off = f(); this.floorY = f();
    this.preset = new Uint8Array(this.capacity);
    this.color = new Uint16Array(this.capacity);
    this.stream = new Int16Array(this.capacity);
  }

  get count(): number {
    return this.n;
  }

  setAspect(aspect: number): void {
    if (aspect > 0) this.aspect = aspect;
  }

  /** Public ParticleApi (props). The count is used as given, within MAX_BURST and the pool: the
   *  props have already cut it for reduced motion (see the note at the top of this file). */
  burst(opts: BurstOptions): void {
    this.spawn(opts);
  }

  /** Spawn exactly opts.count particles (the caller already applied the limits). Returns how many fit. */
  spawn(opts: BurstOptions & { floorY?: number }): number {
    const def = PRESETS[opts.preset] ?? PRESETS.sparks;
    const pi = PRESET_INDEX.get(opts.preset) ?? 0;
    const ci = this.colorIndex(opts.color ?? def.color);
    const count = Math.min(MAX_BURST, Math.max(0, Math.round(Number.isFinite(opts.count) ? (opts.count as number) : 16)));
    const spread = ((opts.spreadDeg ?? 360) * Math.PI) / 180;
    const dir = ((opts.directionDeg ?? -90) * Math.PI) / 180;
    const speedK = opts.speed ?? 1;
    const sizeK = opts.size ?? 1;
    const ix = opts.x * this.aspect, iy = opts.y;
    if (!Number.isFinite(ix) || !Number.isFinite(iy)) return 0;
    const jitter = def.jitter ?? 0;
    let made = 0;
    for (let k = 0; k < count && this.n < this.capacity; k++) {
      const i = this.n++;
      const a = spread >= Math.PI * 2 ? this.random() * Math.PI * 2 : dir + (this.random() - 0.5) * spread;
      const sp = (def.speed[0] + (def.speed[1] - def.speed[0]) * this.random()) * speedK;
      if (jitter > 0) {
        // Uniform over the disc (sqrt keeps the centre from crowding).
        const ja = this.random() * Math.PI * 2, jr = jitter * Math.sqrt(this.random());
        this.x[i] = ix + Math.cos(ja) * jr; this.y[i] = iy + Math.sin(ja) * jr;
      } else {
        this.x[i] = ix; this.y[i] = iy;
      }
      this.vx[i] = Math.cos(a) * sp; this.vy[i] = Math.sin(a) * sp;
      this.age[i] = 0;
      this.life[i] = opts.lifeMs ? opts.lifeMs * (0.75 + 0.5 * this.random()) : def.life[0] + (def.life[1] - def.life[0]) * this.random();
      this.size[i] = (def.size[0] + (def.size[1] - def.size[0]) * this.random()) * sizeK;
      this.seed[i] = this.random();
      this.preset[i] = pi; this.color[i] = ci;
      this.stream[i] = -1; this.p[i] = 0; this.pRate[i] = 0; this.off[i] = 0;
      this.floorY[i] = def.splash ? (opts.floorY ?? 0.97) : NaN;
      made++;
    }
    return made;
  }

  /** Start a stream; returns a handle to stop it early. */
  addStream(opts: StreamOptions, now: number): { stop(): void; finished(now: number): boolean } {
    const s: Stream = {
      preset: opts.preset, color: this.colorIndex(opts.color ?? PRESETS[opts.preset].color), arc: opts.arc,
      rate: Math.max(0, opts.rate), until: this.clock + Math.max(0, opts.durationMs), acc: 0.6,
      resolve: opts.resolve, a: { x: 0, y: 0 }, b: { x: 0, y: 0 }, alive: true, pMin: 0, pMax: -1,
    };
    const ends = opts.resolve();
    s.a = { ...ends.from };
    s.b = { ...ends.to };
    let slot = this.streams.indexOf(null);
    if (slot < 0) slot = this.streams.push(null) - 1;
    this.streams[slot] = s;
    const startedAt = now;
    return {
      stop: () => {
        s.until = Math.min(s.until, this.clock);
      },
      finished: (t: number) => t - startedAt >= opts.durationMs || s.until <= this.clock,
    };
  }

  clear(): void {
    this.n = 0;
    this.streams = [];
  }

  /** Advance by dt ms (already multiplied by the global time scale). */
  update(dt: number): void {
    if (dt <= 0) return;
    this.clock += dt;
    const sec = dt / 1000;
    this.updateStreams(dt);
    for (const s of this.streams) {
      if (!s) continue;
      s.pMin = Infinity;
      s.pMax = -1;
    }
    let i = 0;
    while (i < this.n) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.kill(i);
        continue;
      }
      const def = PRESETS[PARTICLE_PRESETS[this.preset[i]]];
      const si = this.stream[i];
      if (si >= 0) {
        const s = this.streams[si];
        if (!s) {
          this.kill(i);
          continue;
        }
        this.p[i] += this.pRate[i] * dt;
        if (this.p[i] >= 1) {
          if (def.splash) this.splash(s.b.x * this.aspect, s.b.y, this.color[i]);
          this.kill(i);
          continue;
        }
        this.placeOnStream(i, s);
        if (this.p[i] < s.pMin) s.pMin = this.p[i];
        if (this.p[i] > s.pMax) s.pMax = this.p[i];
      } else {
        const damp = Math.max(0, 1 - def.drag * sec);
        this.vx[i] *= damp;
        this.vy[i] = this.vy[i] * damp + def.gravity * sec;
        this.x[i] += this.vx[i] * sec;
        this.y[i] += this.vy[i] * sec;
        // The phase follows the height, so wisps at different heights lean different ways: the
        // column bends into a slow S that drifts upward, like smoke from a snuffed wick.
        if (def.curl) this.x[i] += Math.sin(this.y[i] * 26 + this.age[i] / 420 + this.seed[i] * 0.8) * def.curl * sec;
        if (def.splash && this.y[i] > this.floorY[i] && this.vy[i] > 0) {
          this.splash(this.x[i], this.floorY[i], this.color[i]);
          this.kill(i);
          continue;
        }
      }
      i++;
    }
    for (let k = 0; k < this.streams.length; k++) {
      const s = this.streams[k];
      // A stream that has stopped is dropped once its last particle has landed.
      if (s && !s.alive && s.pMax < 0) this.streams[k] = null;
    }
  }

  /** Draw the particles that belong on one layer. */
  draw(ctx: CanvasRenderingContext2D, layer: 'light' | 'shade', view: View, sprites: Sprites): void {
    const hpx = view.height * view.dpr;
    const aspect = this.aspect;
    if (layer === 'light') this.drawJets(ctx, view);
    ctx.lineCap = 'round';
    let lastColor = -1;
    let glow: CanvasImageSource | null = null, star: CanvasImageSource | null = null, puff: CanvasImageSource | null = null;
    for (let i = 0; i < this.n; i++) {
      const def = PRESETS[PARTICLE_PRESETS[this.preset[i]]];
      if (def.layer !== layer) continue;
      if (this.color[i] !== lastColor) {
        lastColor = this.color[i];
        const css = this.palette[lastColor];
        glow = sprites.glow(css);
        star = sprites.star(css);
        puff = sprites.puff(css);
      }
      const t = this.age[i] / this.life[i];
      let a = def.alpha * particleFade(t, def.fadeIn ?? 0.08);
      if (def.twinkle) a *= 0.55 + 0.45 * Math.sin(this.age[i] * 0.018 + this.seed[i] * 40);
      if (def.flicker) a *= 0.7 + 0.3 * Math.sin(this.age[i] * 0.035 + this.seed[i] * 25);
      if (a <= 0.01) continue;
      const px = view.px(this.x[i] / aspect), py = view.py(this.y[i]);
      const r = this.size[i] * hpx * (def.grow ? 1 + def.grow * t : 1);
      ctx.globalAlpha = Math.min(1, a);
      if (def.shape === 'streak') {
        // A spark's streak: a line behind it along its motion.
        const k = STREAK_K * hpx;
        ctx.strokeStyle = this.palette[lastColor];
        ctx.lineWidth = Math.max(1, r);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - this.vx[i] * k, py - this.vy[i] * k);
        ctx.stroke();
        ctx.drawImage(glow!, px - r * 2.5, py - r * 2.5, r * 5, r * 5);
      } else if (def.shape === 'drop') {
        // A drop: a bright bead with a short, fainter, thinner tail (a dash of uniform light would
        // read as rain or a dotted line rather than water).
        const k = DROP_K * hpx;
        ctx.strokeStyle = this.palette[lastColor];
        ctx.lineWidth = Math.max(1, r * 0.8);
        ctx.globalAlpha = Math.min(1, a * 0.55);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - this.vx[i] * k, py - this.vy[i] * k);
        ctx.stroke();
        ctx.globalAlpha = Math.min(1, a);
        ctx.drawImage(glow!, px - r * 2, py - r * 2, r * 4, r * 4);
      } else if (def.shape === 'star') {
        const s = r * (def.twinkle ? 0.8 + 0.4 * Math.sin(this.age[i] * 0.011 + this.seed[i] * 17) : 1);
        ctx.drawImage(star!, px - s * 2.6, py - s * 2.6, s * 5.2, s * 5.2);
      } else if (def.shape === 'puff') {
        ctx.drawImage(puff!, px - r, py - r, r * 2, r * 2);
      } else {
        ctx.drawImage(glow!, px - r * 2.5, py - r * 2.5, r * 5, r * 5);
      }
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Water streams are drawn as a jet as well as drops (Aguamenti: "a water arc from the tip"):
   * a translucent body and a brighter core along the arc, over the span the drops cover, thinning
   * toward the front where the jet breaks up into drops. A slow ripple runs along it on the
   * stage's scaled clock (so Arresto Momentum stills it); none under reduced motion.
   */
  private drawJets(ctx: CanvasRenderingContext2D, view: View): void {
    const hpx = view.height * view.dpr;
    const still = this.reducedMotion();
    let drew = false;
    for (const s of this.streams) {
      if (!s || s.preset !== 'water' || !(s.pMax > s.pMin)) continue;
      const arc = arcThrough(s.a.x * this.aspect, s.a.y, s.b.x * this.aspect, s.b.y, s.arc, this.arc);
      if (!drew) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.lineCap = 'round';
        drew = true;
      }
      ctx.strokeStyle = this.palette[s.color];
      const from = Math.max(0, s.pMin), to = Math.min(1, s.pMax);
      for (let pass = 0; pass < 2; pass++) {
        const width = (pass === 0 ? 0.016 : 0.0048) * hpx;
        const alpha = pass === 0 ? 0.2 : 0.55;
        let prevX = 0, prevY = 0;
        for (let j = 0; j <= JET_SEGMENTS; j++) {
          const t = from + ((to - from) * j) / JET_SEGMENTS;
          const ripple = still ? 0 : Math.sin(t * 14 - this.clock / 90) * 0.0028;
          const x = view.px(arcX(arc, t, ripple) / this.aspect), y = view.py(arcY(arc, t, ripple));
          if (j > 0) {
            // Thinner and fainter toward the front, where the jet breaks into drops.
            const taper = 1 - 0.65 * t;
            ctx.globalAlpha = alpha * taper;
            ctx.lineWidth = Math.max(1, width * taper);
            ctx.beginPath();
            ctx.moveTo(prevX, prevY);
            ctx.lineTo(x, y);
            ctx.stroke();
          }
          prevX = x;
          prevY = y;
        }
      }
    }
    if (drew) {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // ---------------------------------------------------------------- internals

  private colorIndex(css: string): number {
    const key = css.toLowerCase();
    let i = this.paletteIndex.get(key);
    if (i === undefined) {
      i = this.palette.push(css) - 1;
      this.paletteIndex.set(key, i);
    }
    return i;
  }

  private kill(i: number): void {
    const last = --this.n;
    if (i === last) return;
    this.x[i] = this.x[last]; this.y[i] = this.y[last];
    this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last];
    this.age[i] = this.age[last]; this.life[i] = this.life[last];
    this.size[i] = this.size[last]; this.seed[i] = this.seed[last];
    this.preset[i] = this.preset[last]; this.color[i] = this.color[last];
    this.stream[i] = this.stream[last]; this.p[i] = this.p[last]; this.pRate[i] = this.pRate[last];
    this.off[i] = this.off[last]; this.floorY[i] = this.floorY[last];
  }

  private splash(ix: number, iy: number, color: number): void {
    const drops = 2 + Math.floor(this.random() * 2);
    for (let k = 0; k < drops && this.n < this.capacity; k++) {
      const i = this.n++;
      const a = -Math.PI / 2 + (this.random() - 0.5) * 2.2;
      const sp = 0.18 + this.random() * 0.3;
      this.x[i] = ix; this.y[i] = iy;
      this.vx[i] = Math.cos(a) * sp; this.vy[i] = Math.sin(a) * sp;
      this.age[i] = 0; this.life[i] = 260 + this.random() * 260;
      this.size[i] = 0.0025 + this.random() * 0.002; this.seed[i] = this.random();
      this.preset[i] = PRESET_INDEX.get('water')!; this.color[i] = color;
      this.stream[i] = -1; this.p[i] = 0; this.pRate[i] = 0; this.off[i] = 0;
      this.floorY[i] = NaN; // droplets do not splash again
    }
  }

  private updateStreams(dt: number): void {
    for (let k = 0; k < this.streams.length; k++) {
      const s = this.streams[k];
      if (!s) continue;
      const ends = s.resolve();
      s.a.x = ends.from.x; s.a.y = ends.from.y;
      s.b.x = ends.to.x; s.b.y = ends.to.y;
      if (this.clock > s.until) {
        s.alive = false;
        continue;
      }
      s.acc += (s.rate * dt) / 1000;
      const length = Math.hypot((s.b.x - s.a.x) * this.aspect, s.b.y - s.a.y);
      const def = PRESETS[s.preset];
      while (s.acc >= 1 && this.n < this.capacity) {
        s.acc -= 1;
        const i = this.n++;
        this.stream[i] = k;
        this.p[i] = this.random() * 0.04;
        // About 1.1 caster heights per second along the arc, never under a third of a second.
        const travel = Math.max(320, Math.min(950, (length / 1.1) * 1000)) * (0.85 + 0.3 * this.random());
        this.pRate[i] = 1 / travel;
        this.off[i] = (this.random() - 0.5) * 0.035;
        this.age[i] = 0;
        this.life[i] = travel * 1.2 + 200;
        this.size[i] = def.size[0] + (def.size[1] - def.size[0]) * this.random();
        this.seed[i] = this.random();
        this.preset[i] = PRESET_INDEX.get(s.preset) ?? 0;
        this.color[i] = s.color;
        this.vx[i] = 0; this.vy[i] = 0;
        this.floorY[i] = NaN;
        this.placeOnStream(i, s);
      }
      if (s.acc >= 1) s.acc = 0; // pool full: drop the backlog rather than burst later
    }
  }

  /** Position on the stream's arc: a quadratic curve bowed upward by `arc` × its length. The
   *  particle's velocity is set to its motion along the arc, so streaks and drops trail behind it. */
  private placeOnStream(i: number, s: Stream): void {
    const arc = arcThrough(s.a.x * this.aspect, s.a.y, s.b.x * this.aspect, s.b.y, s.arc, this.arc);
    const t = this.p[i];
    const wobble = this.off[i] * Math.sin(Math.PI * t);
    this.x[i] = arcX(arc, t, wobble);
    this.y[i] = arcY(arc, t, wobble);
    // d/dt of the curve, times how fast t advances (per ms), in caster heights per second.
    const rate = this.pRate[i] * 1000;
    this.vx[i] = (2 * (1 - t) * (arc.cx - arc.ax) + 2 * t * (arc.bx - arc.cx)) * rate;
    this.vy[i] = (2 * (1 - t) * (arc.cy - arc.ay) + 2 * t * (arc.by - arc.cy)) * rate;
  }
}

/** Segments the water jet is drawn in. */
const JET_SEGMENTS = 18;

/** Point t (0..1) on an arc, pushed `off` along its upward normal (isotropic units). */
export function arcX(a: Arc, t: number, off = 0): number {
  const u = 1 - t;
  return u * u * a.ax + 2 * u * t * a.cx + t * t * a.bx + a.nx * off;
}

export function arcY(a: Arc, t: number, off = 0): number {
  const u = 1 - t;
  return u * u * a.ay + 2 * u * t * a.cy + t * t * a.by + a.ny * off;
}

/** Opacity over a particle's life t (0..1): fade in over `fadeIn`, hold, fade out over the last 45%. */
export function particleFade(t: number, fadeIn: number): number {
  const up = fadeIn > 0 ? Math.min(1, t / fadeIn) : 1;
  const down = t > 0.55 ? Math.max(0, (1 - t) / 0.45) : 1;
  return up * down;
}
