// What every prop shares: its place on the shelf, its local clock (Impedimenta and Arresto Momentum),
// the size channel (Engorgio, Reducio), telling the core about changes, and the done() queue.
//
// The state machine (update, apply, end, reset) never touches a canvas, so the props are unit-tested in
// Node. Drawing reads that state and nothing else.

import { EFFECT_LIMITS, PROP_TAGS, SHELF_LAYOUT, type PropId } from '../../../../contracts';
import type { FrameInfo, Layers, PropAction, PropView, StageServices } from '../types';
import { durationOf, effectScale, handleOf, num, type ActionHandle } from './actions';
import { drawSprite, type CanvasFactory, type RepaintGate } from './art/canvas';
import type { CommonArtCache } from './art/common';
import { DIMS, MH, SHELF_TOP, baseOffset, type PropDims } from './geometry';
import { clamp, clamp01 } from './motion';
import { ChangeNotifier } from './notify';
import { SCALE_MAX, SCALE_MIN, ScaleChannel } from './scale';
import type { ViewCache } from './view';

/** What the shelf lends every prop. */
export interface PropEnv {
  readonly view: ViewCache;
  readonly canvas: CanvasFactory;
  readonly common: CommonArtCache;
  /** One prop repaints its sprites per frame (art/canvas.ts RepaintGate). */
  readonly repaints: RepaintGate;
}

/** The longest step any animation takes in one frame (a tab coming back from the background). */
export const MAX_FRAME_MS = 250;

const T = PROP_TAGS;
/** The tags every small prop carries (contracts/scene.ts PROP_START). */
export const SMALL_TAGS: readonly string[] = [T.any, T.movable, T.levitatable, T.scalable, T.breakable];

/** The cool light hidden details shimmer in while Revelio shows them. */
export const SECRET_GLOW = '#D6E0F5';
/** Below this reveal alpha nothing hidden is drawn (the core skips drawHidden there too). */
export const REVEAL_MIN = 0.01;

/** Scratch point for transforms, so the hot path allocates nothing. */
export interface Pt {
  x: number;
  y: number;
}

export abstract class PropBase implements PropView {
  readonly home: { x: number; y: number };
  x: number;
  y: number;
  /** Set by the core for time.slow with scope 'target' (Impedimenta). */
  timeScale = 1;

  protected readonly dims: PropDims;
  /** Base of the prop below its centre, caster-y units. */
  protected readonly baseOffY: number;
  protected readonly scaler = new ScaleChannel();
  protected readonly notifier = new ChangeNotifier();
  protected services: StageServices | null = null;
  /** Local ms: advanced by frame.dt × timeScale. Every timer and animation runs on it. */
  protected clock = 0;
  /** Kernel clock of the latest frame (real time). */
  protected now = 0;
  protected reduced = false;
  protected quality: 'high' | 'low' = 'high';
  private readonly doneQueue: (() => void)[] = [];
  private lastX: number;
  private lastY: number;
  private lastR = Number.NaN;

  constructor(readonly id: PropId, protected readonly env: PropEnv) {
    const h = SHELF_LAYOUT[id];
    this.home = Object.freeze({ x: h.x, y: h.y });
    this.x = h.x;
    this.y = h.y;
    this.lastX = h.x;
    this.lastY = h.y;
    this.dims = DIMS[id];
    this.baseOffY = baseOffset(id);
  }

  /** Hit radius in caster-x units; grows and shrinks with Engorgio and Reducio. */
  get radius(): number {
    return this.dims.radius * MH * this.env.view.hToX * Math.max(0.5, this.scaler.value);
  }

  abstract label(): string;
  abstract tags(): string[];
  abstract state(): Record<string, boolean | number | string>;
  abstract apply(use: string, action: PropAction, services: StageServices): boolean;
  abstract draw(layers: Layers, frame: FrameInfo, services: StageServices): void;
  abstract end(castId: string): void;
  abstract reset(): void;

  /** Not still showing a change (types.ts PropView.settled): every prop can change size. */
  settled(): boolean {
    return !this.scaler.easing;
  }

  update(frame: FrameInfo, services: StageServices): void {
    this.bind(services, frame.now);
    this.reduced = frame.reducedMotion;
    this.quality = frame.quality;
    const scale = Number.isFinite(this.timeScale) ? Math.max(0, this.timeScale) : 1;
    const frameDt = Number.isFinite(frame.dt) ? clamp(frame.dt, 0, MAX_FRAME_MS) : 0;
    const dt = frameDt * scale;
    this.clock += dt;
    this.advance(dt, frame, services);
    const scaleTarget = this.scaler.target;
    this.scaler.step(dt, this.reduced, (h) => this.complete(h));
    if (this.scaler.target !== scaleTarget) this.changed();
    this.trackMovement();
    this.notifier.tick(frame.now);
    this.flushDone();
  }

  /** Advance this prop's own state by `dt` local ms. */
  protected abstract advance(dt: number, frame: FrameInfo, services: StageServices): void;

  /** Remember the services and the view (apply and end may come before any frame). */
  protected bind(services: StageServices, now: number): void {
    this.services = services;
    this.now = now;
    this.env.view.sync(services.view, now);
    this.notifier.bind(services);
  }

  /** Tags, state or label changed: the core republishes 'scene.props' at once. */
  protected changed(): void {
    this.notifier.changed(this.services?.now() ?? this.now);
  }

  /** An action finished on its own: its done() runs at the end of this frame's update, after the
   *  prop's state has settled (contracts/module.ts: set your state before you publish). */
  protected complete(handle: ActionHandle | null): void {
    const done = handle?.close();
    if (done) this.doneQueue.push(done);
  }

  /** Forget done() calls still queued (reset: the core cleared its own bookkeeping). */
  protected clearDone(): void {
    this.doneQueue.length = 0;
  }

  private flushDone(): void {
    while (this.doneQueue.length > 0) {
      const done = this.doneQueue.shift();
      done?.();
    }
  }

  private trackMovement(): void {
    const r = this.radius;
    if (Math.abs(this.x - this.lastX) > 1e-5 || Math.abs(this.y - this.lastY) > 1e-5 || Math.abs(r - this.lastR) > 1e-6) {
      const first = Number.isNaN(this.lastR);
      this.lastX = this.x;
      this.lastY = this.y;
      this.lastR = r;
      if (!first) this.notifier.moved();
    }
  }

  /** prop.scale grow or shrink. Shatter is handled by the caller. */
  protected startScale(action: PropAction): boolean {
    const factor = num(action.step.factor, 1, 0, 10);
    // A stronger variant grows (or shrinks) further: effectScale stretches the change, not the size.
    const target = clamp(1 + (factor - 1) * effectScale(action), SCALE_MIN, SCALE_MAX);
    if (this.scaler.handle) this.complete(this.scaler.handle);
    this.scaler.start(target, durationOf(action, 8000), handleOf(action), this.reduced);
    this.changed();
    return true;
  }

  /** end(castId) for the size channel. */
  protected endScale(castId: string): void {
    if (this.scaler.handle?.matches(castId)) {
      this.scaler.release(this.reduced);
      this.changed();
    }
  }

  /** Particle count for a burst, scaled by the variant and cut under reduced motion (Section 10.6). */
  protected count(base: number, action?: PropAction): number {
    const k = action ? effectScale(action) : 1;
    const n = base * k * (this.reduced ? EFFECT_LIMITS.reducedMotionParticleFactor : 1);
    return Math.max(3, Math.round(n));
  }

  /** The size multiplier as published in state(), or undefined at normal size. */
  protected scaleState(): number | undefined {
    const t = this.scaler.target;
    return t === 1 ? undefined : Math.round(t * 100) / 100;
  }

  /** Base point of the prop on the canvas (pixels). */
  protected baseX(): number {
    return this.env.view.px(this.x);
  }

  protected baseY(): number {
    return this.env.view.py(this.y + this.baseOffY);
  }

  /** Where the shelf line is under this prop, canvas pixels. */
  protected shelfY(): number {
    return this.env.view.py(SHELF_TOP);
  }

  // ---------------------------------------------------------------- Revelio
  // Section 8: "Hidden ink and objects shimmer into view". Each prop paints its hidden detail as ink on
  // the shade layer, in its proper place in the drawing order (chalk under the dummy's arms, the key
  // under the pot), because pale light on the screen-blended layer vanishes over white china or a white
  // vane. The light layer adds the shimmer: a cool halo and, now and then, a glint.

  /** A slow swell of the hidden ink's light; steady under reduced motion or low quality. */
  protected shimmer(frame: FrameInfo): number {
    if (frame.reducedMotion || frame.quality === 'low') return 1;
    return 0.8 + 0.2 * Math.sin(frame.now / 260 + this.home.x * 9);
  }

  /** A brief glint every few seconds, offset per prop so they never flash together. None under
   *  reduced motion (Section 10.6: motion answers an action, and the reveal already fades in). */
  protected twinkle(frame: FrameInfo): number {
    if (frame.reducedMotion || frame.quality === 'low') return 0;
    const s = Math.sin(frame.now / 420 + this.home.x * 11);
    return s > 0 ? s ** 12 : 0;
  }

  /** In the current transform (mH): a soft halo `halo` mH wide around a hidden detail at (x, y), and
   *  its glint. The caller has set up the light layer's transform and restores it. */
  protected drawSecretLight(light: CanvasRenderingContext2D, frame: FrameInfo, services: StageServices,
    alpha: number, x: number, y: number, halo: number, haloAlpha = 0.34): void {
    const a = clamp01(alpha);
    if (a <= 0) return;
    light.globalAlpha = haloAlpha * a * this.shimmer(frame);
    light.drawImage(services.glow(SECRET_GLOW), x - halo / 2, y - halo / 2, halo, halo);
    const k = this.twinkle(frame) * a;
    const common = this.env.common.get(this.env.canvas);
    if (k > 0.02 && common) {
      light.globalAlpha = k;
      light.translate(x, y);
      light.scale(0.62, 0.62);
      drawSprite(light, common.glint);
      light.scale(1 / 0.62, 1 / 0.62);
      light.translate(-x, -y);
    }
  }

  /** Shadows on the shelf, shrinking and fading as the prop rises: a broad soft one thrown to the right
   *  by the candle on the left, and a tight dark one right under the prop where no light gets in, which
   *  is what makes it sit with its weight on the shelf. `dxMh` shifts both (a toppled dummy's middle
   *  is to the right of its stand). */
  protected drawShadow(ctx: CanvasRenderingContext2D, size: number, strength = 1, dxMh = 0): void {
    const common = this.env.common.get(this.env.canvas);
    if (!common) return;
    const v = this.env.view;
    const lift = clamp01((this.home.y - this.y) / v.hToY / 0.22);
    if (lift >= 1) return;
    const k = 1 - lift;
    const foot = this.dims.foot * v.pxPerMh * size;
    const x = this.baseX() + dxMh * v.pxPerMh;
    const y = this.shelfY();
    ctx.save();
    const w = foot * (1.4 + 0.5 * lift);
    const h = Math.min(w * 0.16, foot * 0.26);
    ctx.globalAlpha = 0.55 * k * k * strength;
    ctx.drawImage(common.shadow.canvas, x - w * 0.36, y - h * 0.5, w, h);
    if (lift < 0.5) {
      const cw = foot * 0.94;
      const ch = Math.min(cw * 0.1, foot * 0.13);
      ctx.globalAlpha = 0.8 * (1 - lift * 2) * strength;
      ctx.drawImage(common.shadow.canvas, x - cw * 0.48, y - ch * 0.6, cw, ch);
    }
    ctx.restore();
  }
}
