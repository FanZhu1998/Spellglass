// Where a small prop is, and how it gets there: levitate, pull, push and the glide home (Section 7.8,
// "Props" primitives; Section 8 "On screen"). Pure and deterministic: no canvas, no clock of its own.
// Each motion advances by env.dt, the prop's local milliseconds (frame.dt × timeScale), so Impedimenta
// and Arresto Momentum slow every flight with no extra code (task brief: "use frame.dt * timeScale").
//
// A motion has an active part (with the action's duration) and an epilogue that brings the prop home.
// When the active part ends on its own the motion calls env.complete(handle), which queues the action's
// done() so the core can send 'effect.end' and clear 'stage.steering' (contract review). end(castId)
// calls release(): the prop heads home and the core is not told, since it asked.
//
// Section 10.6 reduced motion: no bobbing or swaying, and every flight is shorter.

import { BOUNDS } from './geometry';
import type { ActionHandle } from './actions';

// ------------------------------------------------------------------ easing and springs

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const easeOut = (t: number): number => 1 - (1 - t) ** 3;
export const easeIn = (t: number): number => t * t * t;
export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
/** Overshoots a little and settles: for things that pop (a lid, a costume, a grown plant). */
export const easeOutBack = (t: number, s = 1.5): number => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2;

/** Seconds for a spring step. Long frames (a tab returning from the background) are capped so springs
 *  never jump; timers still count the full time. */
export const springSeconds = (dtMs: number): number => Math.min(dtMs, 50) / 1000;

export interface Body {
  /** Centre, caster space. */
  x: number;
  y: number;
  /** Caster units per second. */
  vx: number;
  vy: number;
  /** Visual tilt in radians (clockwise positive on screen) and its rate. */
  rot: number;
  vrot: number;
}

/** Critically damped spring toward (tx, ty): exact for any step, never overshoots, never unstable. */
export function springBody(b: Body, tx: number, ty: number, omega: number, dtS: number): void {
  if (dtS <= 0) return;
  const e = Math.exp(-omega * dtS);
  let d = b.x - tx;
  let k = (b.vx + omega * d) * dtS;
  b.x = tx + (d + k) * e;
  b.vx = (b.vx - omega * k) * e;
  d = b.y - ty;
  k = (b.vy + omega * d) * dtS;
  b.y = ty + (d + k) * e;
  b.vy = (b.vy - omega * k) * e;
}

/** The same spring for the tilt. */
export function springRot(b: Body, target: number, omega: number, dtS: number): void {
  if (dtS <= 0) return;
  const e = Math.exp(-omega * dtS);
  const d = b.rot - target;
  const k = (b.vrot + omega * d) * dtS;
  b.rot = target + (d + k) * e;
  b.vrot = (b.vrot - omega * k) * e;
}

/** An underdamped spring, for things that wobble (the dummy rocking back). Semi-implicit Euler in
 *  8 ms substeps: stable for the stiffness used here. Writes into `out` to avoid allocating. */
export function wobble(out: { p: number; v: number }, target: number, omega: number, zeta: number, dtS: number): void {
  if (dtS <= 0) return;
  const n = Math.max(1, Math.ceil(dtS / 0.008));
  const h = dtS / n;
  let p = out.p;
  let v = out.v;
  for (let i = 0; i < n; i++) {
    v += (-omega * omega * (p - target) - 2 * zeta * omega * v) * h;
    p += v * h;
  }
  out.p = p;
  out.v = v;
}

/** Move to (x, y) and record the velocity (the candle's flame leans against it). */
function placeAt(b: Body, x: number, y: number, dtMs: number): void {
  if (dtMs > 0) {
    b.vx = ((x - b.x) * 1000) / dtMs;
    b.vy = ((y - b.y) * 1000) / dtMs;
  }
  b.x = x;
  b.y = y;
}

// ------------------------------------------------------------------ the environment of one frame

export interface MotionEnv {
  /** Local ms this frame (frame.dt × timeScale). */
  dt: number;
  /** The filtered tip in caster space; hasTip is false when it is out of view. */
  tipX: number;
  tipY: number;
  hasTip: boolean;
  reduced: boolean;
  /** Where the prop rests (caster space). */
  homeX: number;
  homeY: number;
  /** Caster units per mirror height, along x and y. */
  hToX: number;
  hToY: number;
  /** 0..1, how much the prop rocks in the air: the feather 1, a box 0.3. */
  sway: number;
  /** Caster-y distance below the tip at which a held prop hangs, so it never hides the tip's light. */
  hang: number;
  /** Queue the action's done() (it runs after the prop's state has settled this frame). */
  complete(handle: ActionHandle | null): void;
}

export function clampX(x: number): number {
  return clamp(x, BOUNDS.minX, BOUNDS.maxX);
}

export function clampY(y: number, env: MotionEnv): number {
  return clamp(y, BOUNDS.minY, env.homeY);
}

// ------------------------------------------------------------------ motions

export type MotionName = 'levitating' | 'pulled' | 'pushed';

export abstract class Motion {
  /** Local ms since this motion (or its current phase) began. */
  protected age = 0;

  constructor(readonly handle: ActionHandle | null) {}

  /** Advance one frame. Returns the motion for the next frame: itself, the glide home, or null at rest. */
  abstract step(b: Body, env: MotionEnv): Motion | null;

  /** Shown in state() while the action is running; null while returning home. */
  abstract readonly name: MotionName | null;

  /** True while the tip steers the prop (Leviosa, Locomotor, Accio's hover). */
  get following(): boolean {
    return false;
  }

  /** end(castId): stop the active part and head home. The core asked, so done() is not called. */
  release(): Motion {
    this.handle?.drop();
    return new Glide('float');
  }
}

export type GlideStyle = 'float' | 'feather' | 'slide';

/** Home again: floats down, rocks down like a feather, or slides along the shelf. */
export class Glide extends Motion {
  readonly name = null;
  private started = false;
  private x0 = 0;
  private y0 = 0;
  private r0 = 0;
  private dur = 1;

  constructor(private readonly style: GlideStyle) {
    super(null);
  }

  step(b: Body, env: MotionEnv): Motion | null {
    if (!this.started) {
      this.started = true;
      this.x0 = b.x;
      this.y0 = b.y;
      this.r0 = b.rot;
      // Distance in mirror heights decides the time: a short hop is quick, a fall from the top is slow.
      const dist = Math.hypot((b.x - env.homeX) / env.hToX, (b.y - env.homeY) / env.hToY);
      const base = this.style === 'slide' ? 320 + dist * 1100 : 420 + dist * 1500;
      const styled = this.style === 'feather' ? base * 1.5 : base;
      this.dur = clamp(env.reduced ? styled * 0.4 : styled, env.reduced ? 160 : 360, 2400);
    }
    this.age += env.dt;
    const u = clamp01(this.age / this.dur);
    const e = this.style === 'slide' ? easeOut(u) : easeInOut(u);
    let x = lerp(this.x0, env.homeX, e);
    const y = lerp(this.y0, env.homeY, e);
    let rot = lerp(this.r0, 0, e);
    if (this.style === 'feather' && !env.reduced) {
      // A falling feather rocks from side to side, less as it lands.
      const k = Math.sin(u * Math.PI * 3) * (1 - u);
      x += 0.02 * env.hToX * k;
      rot += 0.3 * env.sway * k;
    }
    placeAt(b, x, y, env.dt);
    b.rot = rot;
    b.vrot = 0;
    if (u < 1) return this;
    b.x = env.homeX;
    b.y = env.homeY;
    b.vx = b.vy = b.rot = b.vrot = 0;
    return null;
  }

  override release(): Motion {
    return this;
  }
}

/** prop.levitate: rise, follow the tip with a gentle lag (follow_tip) or hover, then drift home. */
export class Levitate extends Motion {
  readonly name = 'levitating';
  private startX = Number.NaN;

  constructor(
    handle: ActionHandle | null,
    private readonly follow: boolean,
    /** Lift in mirror heights when not following (or before the tip is in view). */
    private readonly lift: number,
    private readonly durMs: number,
    private readonly glide: GlideStyle,
  ) {
    super(handle);
  }

  override get following(): boolean {
    return this.follow;
  }

  step(b: Body, env: MotionEnv): Motion | null {
    if (Number.isNaN(this.startX)) this.startX = b.x;
    this.age += env.dt;
    if (this.age >= this.durMs) {
      env.complete(this.handle);
      return new Glide(this.glide);
    }
    const dtS = springSeconds(env.dt);
    const t = this.age / 1000;
    // Rise straight up first, then go to the tip: the lift reads before the chase.
    const chasing = this.follow && env.hasTip && this.age > 280;
    let tx = chasing ? env.tipX : this.startX;
    let ty = chasing ? env.tipY + env.hang : env.homeY - this.lift * env.hToY;
    if (!env.reduced) {
      tx += 0.012 * env.hToX * env.sway * Math.sin(t * 2.1);
      if (!chasing) ty += 0.006 * env.hToY * Math.sin(t * 3.4);
    }
    springBody(b, clampX(tx), clampY(ty, env), chasing ? 3.4 : 2.6, dtS);
    const rock = env.reduced ? 0 : (0.04 + 0.14 * env.sway) * Math.sin(t * 2.6) + clamp(b.vx * 0.5, -0.25, 0.25) * env.sway;
    springRot(b, rock, 6, dtS);
    return this;
  }
}

/** prop.pull: fly to the tip, hover there for hold_ms (the tip steers it), then float home. */
export class Pull extends Motion {
  readonly name = 'pulled';
  private phase: 'fly' | 'hover' = 'fly';
  private x0 = Number.NaN;
  private y0 = 0;
  private tx: number;
  private ty: number;

  constructor(
    handle: ActionHandle | null,
    private readonly holdMs: number,
    /** Where to go when the tip is out of view: the stroke's end. */
    aimX: number,
    aimY: number,
  ) {
    super(handle);
    this.tx = aimX;
    this.ty = aimY;
  }

  override get following(): boolean {
    return true;
  }

  step(b: Body, env: MotionEnv): Motion | null {
    if (Number.isNaN(this.x0)) {
      this.x0 = b.x;
      this.y0 = b.y;
    }
    this.age += env.dt;
    if (env.hasTip) {
      this.tx = env.tipX;
      this.ty = env.tipY + env.hang;
    }
    const tx = clampX(this.tx);
    const ty = clampY(this.ty, env);
    if (this.phase === 'fly') {
      const T = env.reduced ? 260 : 620;
      const u = clamp01(this.age / T);
      const e = easeInOut(u);
      // A low arc on the way: it leaps off the shelf rather than sliding up the glass.
      const arc = env.reduced ? 0 : 0.07 * env.hToY * Math.sin(Math.PI * u);
      placeAt(b, lerp(this.x0, tx, e), lerp(this.y0, ty, e) - arc, env.dt);
      b.rot = env.reduced ? 0 : 0.3 * env.sway * Math.sin(Math.PI * u);
      if (u >= 1) {
        this.phase = 'hover';
        this.age = 0;
      }
      return this;
    }
    if (this.age >= this.holdMs) {
      env.complete(this.handle);
      return new Glide('float');
    }
    const dtS = springSeconds(env.dt);
    springBody(b, tx, ty, 9, dtS);
    springRot(b, env.reduced ? 0 : 0.06 * env.sway * Math.sin(this.age / 260) + clamp(b.vx * 0.3, -0.2, 0.2) * env.sway, 8, dtS);
    return this;
  }
}

/** prop.push mode 'away': slide along the shelf away from the aim, rest, then slide home. */
export class PushAway extends Motion {
  readonly name = 'pushed';
  private x0 = Number.NaN;
  private y0 = 0;
  private tx = 0;

  constructor(
    handle: ActionHandle | null,
    /** +1 to the right, -1 to the left. */
    private readonly dir: number,
    /** Distance in mirror heights. */
    private readonly dist: number,
    private readonly restMs: number,
  ) {
    super(handle);
  }

  step(b: Body, env: MotionEnv): Motion | null {
    if (Number.isNaN(this.x0)) {
      this.x0 = b.x;
      this.y0 = b.y;
      this.tx = clamp(b.x + this.dir * this.dist * env.hToX, BOUNDS.slideMinX, BOUNDS.slideMaxX);
    }
    this.age += env.dt;
    const T = env.reduced ? 200 : 420;
    if (this.age < T) {
      const u = this.age / T;
      placeAt(b, lerp(this.x0, this.tx, easeOut(u)), lerp(this.y0, env.homeY, easeOut(u)), env.dt);
      // Leans back against the shove, then settles.
      b.rot = env.reduced ? 0 : -this.dir * 0.07 * Math.sin(Math.PI * u);
      return this;
    }
    placeAt(b, this.tx, env.homeY, env.dt);
    b.rot = 0;
    if (this.age >= T + this.restMs) {
      env.complete(this.handle);
      return new Glide('slide');
    }
    return this;
  }
}

/** prop.push mode 'follow' (Locomotor): slide along the shelf wherever the tip points for duration_ms,
 *  then rest a moment and slide home. "Slide" keeps it on the shelf; Leviosa is the one that flies. */
export class PushFollow extends Motion {
  readonly name = 'pushed';
  private settle = -1;
  private tx = Number.NaN;

  constructor(handle: ActionHandle | null, private readonly durMs: number) {
    super(handle);
  }

  override get following(): boolean {
    return this.settle < 0;
  }

  step(b: Body, env: MotionEnv): Motion | null {
    if (Number.isNaN(this.tx)) this.tx = b.x;
    this.age += env.dt;
    const dtS = springSeconds(env.dt);
    if (this.settle < 0 && this.age >= this.durMs) {
      env.complete(this.handle);
      this.settle = env.reduced ? 500 : 1200;
    }
    if (this.settle >= 0) {
      this.settle -= env.dt;
      springBody(b, b.x, env.homeY, 10, dtS);
      b.vx = 0;
      springRot(b, 0, 10, dtS);
      return this.settle <= 0 ? new Glide('slide') : this;
    }
    if (env.hasTip) this.tx = clamp(env.tipX, BOUNDS.slideMinX, BOUNDS.slideMaxX);
    springBody(b, this.tx, env.homeY, 4.5, dtS);
    // Dragged along by its base, the top lags behind the motion.
    springRot(b, env.reduced ? 0 : clamp(-b.vx * 0.5, -0.12, 0.12), 10, dtS);
    return this;
  }
}
