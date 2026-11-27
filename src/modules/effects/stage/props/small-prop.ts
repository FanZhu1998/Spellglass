// The five small props (candle, feather, box, teacup, plant) share everything that moves them:
// prop.levitate, prop.pull, prop.push, prop.scale (grow, shrink, shatter) and mending what Reducto broke
// (task brief, "Every prop"). Each subclass adds its own state (a flame, a lid, a crack) and art.
//
// Shattering (prop.scale factor 0, Reducto) bursts the prop to dust, leaves a faint outline at home and
// gives it only the tags 'prop.any' and 'prop.mendable' until prop.mend restores it (contracts/scene.ts
// PROP_START). The prop's own state lives on underneath (a box may relock meanwhile), so mending
// restores the prop as it is now, not as it was.

import { PROP_TAGS, type PropId } from '../../../../contracts';
import type { FrameInfo, Layers, PropAction, StageServices } from '../types';
import { bool, durationOf, effectScale, handleOf, num, pick } from './actions';
import { drawSprite, makeOutline, type Sprite, type SpriteBank } from './art/canvas';
import { PAL } from './art/paint';
import { PropBase, REVEAL_MIN, type PropEnv, type Pt } from './base';
import { MH, SHELF_TOP } from './geometry';
import {
  Levitate, Pull, PushAway, PushFollow, clamp01, easeOut, easeOutBack, lerp,
  type Body, type GlideStyle, type Motion, type MotionEnv,
} from './motion';

const T = PROP_TAGS;

/** How long a prop takes to gather itself back from dust (Reparo after Reducto). */
export const RESTORE_MS = 650;
/** By this long after shattering, its heap of dust and faint outline have fully appeared (drawRemains). */
const REMAINS_MS = 950;

/** Sprites every small prop has. (The faint outline a shattered prop leaves, and a wreck where the prop
 *  has one, are made when first needed: most props are never shattered.) */
export interface SmallArt {
  body: Sprite;
  /** The hidden detail as ink on the body (shade layer, Revelio), or null when the prop draws its own. */
  ink: Sprite | null;
  /** The hidden detail's own light (light layer), or null where light would not show (white surfaces). */
  hidden: Sprite | null;
  /** The heap of dust it leaves when shattered, or null for a prop that leaves a wreck (buildWreck). */
  heap: Sprite | null;
}

/** Where a prop's hidden detail is, in its body frame (mH from the base), how wide its halo is, and
 *  how strong (weaker over bright brass or china, which a halo would only wash out). */
export interface Secret {
  x: number;
  y: number;
  halo: number;
  haloAlpha?: number;
}

export abstract class SmallProp<A extends SmallArt> extends PropBase implements Body {
  vx = 0;
  vy = 0;
  rot = 0;
  vrot = 0;

  protected motion: Motion | null = null;
  protected shattered = false;
  /** Local ms since the prop was shattered. */
  protected shatterAge = 0;
  /** Local ms since it was restored from dust; RESTORE_MS or more when not restoring. */
  protected restoreAge = RESTORE_MS;
  protected readonly pt: Pt = { x: 0, y: 0 };
  private readonly menv: MotionEnv;
  /** How much finer than normal the sprites are painted while the prop is enlarged. */
  private sharp = 1;
  /** The outline made from `outlineOf` (a body sprite), kept until the art is repainted. */
  private outlineSprite: Sprite | null = null;
  private outlineOf: Sprite | null = null;
  /** The wreck painted for `wreckOf` (a body sprite), likewise. */
  private wreckSprite: Sprite | null = null;
  private wreckOf: Sprite | null = null;

  /** 0..1, how much it rocks in the air. */
  protected abstract readonly sway: number;
  protected abstract readonly glideStyle: GlideStyle;
  /** Lower-case noun for labels: 'shattered ' + noun. */
  protected abstract readonly noun: string;
  /** Colors of its dust when shattered. */
  protected abstract readonly dust: readonly string[];
  protected abstract readonly bank: SpriteBank<A>;
  /** Its hidden detail (Revelio). */
  protected abstract readonly secret: Secret;
  /** services.revealAlpha() for the frame being drawn. */
  protected reveal = 0;

  constructor(id: PropId, env: PropEnv) {
    super(id, env);
    this.menv = {
      dt: 0, tipX: 0, tipY: 0, hasTip: false, reduced: false,
      homeX: this.home.x, homeY: this.home.y, hToX: 9 / 16, hToY: 1, sway: 0, hang: 0,
      complete: (h) => this.complete(h),
    };
  }

  /** Height of the tilt pivot above the base, mH: the middle of the body. */
  protected get pivot(): number {
    return this.dims.height / 2;
  }

  // ---------------------------------------------------------------- what the core reads

  label(): string {
    return this.shattered ? `shattered ${this.noun}` : this.ownLabel();
  }

  tags(): string[] {
    return this.shattered ? [T.any, T.mendable] : this.ownTags();
  }

  state(): Record<string, boolean | number | string> {
    const s = this.ownState();
    if (this.shattered) s.shattered = true;
    const motion = this.motion?.name;
    if (motion) s.motion = motion;
    const scale = this.scaleState();
    if (scale !== undefined) s.scale = scale;
    return s;
  }

  protected abstract ownLabel(): string;
  protected abstract ownTags(): string[];
  /** A fresh object each call (state() adds to it). */
  protected abstract ownState(): Record<string, boolean | number | string>;

  /** True while the tip steers this prop (for tests and the dev harness). */
  get steering(): boolean {
    return this.motion?.following ?? false;
  }

  // ---------------------------------------------------------------- actions

  apply(use: string, action: PropAction, services: StageServices): boolean {
    this.bind(services, services.now());
    if (this.shattered) {
      if (use === 'prop.mend') {
        this.restore();
        return true;
      }
      // Water on dust changes nothing, but it is not a failure worth a sparkle.
      return use === 'prop.douse';
    }
    const step = action.step;
    switch (use) {
      case 'prop.levitate': {
        const follow = bool(step.follow_tip, false);
        const lift = num(step.height, 0.25, 0.03, 0.75);
        this.setMotion(new Levitate(handleOf(action), follow, lift, durationOf(action, 6000), this.glideStyle));
        return true;
      }
      case 'prop.pull': {
        const hold = durationOf(action, 3000, 'hold_ms');
        const aim = action.cast.aim;
        this.setMotion(new Pull(handleOf(action), hold, num(aim?.x, 0.5), num(aim?.y, 0.5)));
        return true;
      }
      case 'prop.push': {
        if (pick(step.mode, ['away', 'follow'] as const, 'away') === 'follow') {
          this.setMotion(new PushFollow(handleOf(action), durationOf(action, 5000)));
        } else {
          const dir = this.x >= num(action.cast.aim?.x, 0.5) ? 1 : -1;
          const dist = num(step.distance, 0.2, 0, 0.8) * effectScale(action);
          this.setMotion(new PushAway(handleOf(action), dir, dist, durationOf(action, 3000)));
        }
        return true;
      }
      case 'prop.scale': {
        const factor = num(step.factor, 1, 0, 10);
        const mode = pick(step.mode, ['grow', 'shrink', 'shatter'] as const, factor <= 0.05 ? 'shatter' : 'grow');
        if (mode === 'shatter' || factor <= 0.05) return this.shatter(action, services);
        return this.startScale(action);
      }
      default:
        return this.applyOwn(use, action, services);
    }
  }

  /** The prop's own primitives. By default every prop takes water without complaint (Aguamenti aims at
   *  'prop.any' when nothing burns) and refuses anything else, so the core plays its sparkle. */
  protected applyOwn(use: string, _action: PropAction, _services: StageServices): boolean {
    return use === 'prop.douse';
  }

  /** Replace the current motion. One that was still running ends here without the core asking, so its
   *  done() is sent (or the core would keep steering for a prop that has flown elsewhere). */
  protected setMotion(m: Motion | null): void {
    if (this.motion) this.complete(this.motion.handle);
    this.motion = m;
    this.changed();
  }

  private shatter(action: PropAction, services: StageServices): boolean {
    const v = this.env.view;
    // Dust bursts from where the prop is now, in its own colors.
    const cx = this.x;
    const cy = this.y + this.baseOffY - this.pivot * MH * v.hToY * this.scaler.value;
    this.setMotion(null);
    if (this.scaler.handle) this.complete(this.scaler.handle);
    this.scaler.reset();
    this.onShatter();
    const n = this.count(30, action);
    this.dust.forEach((color, i) => {
      services.particles.burst({
        preset: 'dust', x: cx, y: cy, color, count: i === 0 ? n : Math.ceil(n / 3),
        speed: 1.1, spreadDeg: 360, size: 1.25, lifeMs: 1200,
      });
    });
    this.shattered = true;
    this.shatterAge = 0;
    this.restoreAge = RESTORE_MS;
    // What is left gathers at home, so Reparo finds it on the shelf.
    this.x = this.home.x;
    this.y = this.home.y;
    this.vx = this.vy = this.rot = this.vrot = 0;
    this.changed();
    return true;
  }

  private restore(): void {
    this.shattered = false;
    this.restoreAge = 0;
    this.changed();
  }

  /** A shattered prop loses what it was doing (the candle's flame). */
  protected onShatter(): void {}

  end(castId: string): void {
    if (this.motion?.handle?.matches(castId)) {
      this.motion = this.motion.release();
      this.changed();
    }
    this.endScale(castId);
    this.endOwn(castId);
  }

  protected endOwn(_castId: string): void {}

  reset(): void {
    this.motion?.handle?.drop();
    this.motion = null;
    this.scaler.reset();
    this.shattered = false;
    this.shatterAge = 0;
    this.restoreAge = RESTORE_MS;
    this.x = this.home.x;
    this.y = this.home.y;
    this.vx = this.vy = this.rot = this.vrot = 0;
    this.timeScale = 1;
    this.clearDone();
    this.resetOwn();
    this.changed();
  }

  protected resetOwn(): void {}

  /** Not in flight (a glide home included), not changing size, not gathering back from dust, its
   *  remains fully shown, and its own animation done (types.ts PropView.settled). */
  override settled(): boolean {
    return super.settled() && this.motion === null && this.restoreAge >= RESTORE_MS &&
      (!this.shattered || this.shatterAge >= REMAINS_MS) && this.ownSettled();
  }

  /** The prop's own animation (a flame, a lid, a crack) has finished. */
  protected ownSettled(): boolean {
    return true;
  }

  // ---------------------------------------------------------------- frames

  protected advance(dt: number, frame: FrameInfo, services: StageServices): void {
    if (this.shattered) this.shatterAge += dt;
    if (this.restoreAge < RESTORE_MS) this.restoreAge += dt;
    if (this.motion) {
      const v = this.env.view;
      const env = this.menv;
      // The tip of the motion's own cast: a replayed Leviosa follows the replay, a live one the wand.
      const tip = services.tip(this.motion.handle?.castId);
      env.dt = dt;
      env.reduced = this.reduced;
      env.hToX = v.hToX;
      env.hToY = v.hToY;
      env.sway = this.sway;
      env.hang = (this.pivot + 18) * MH * v.hToY;
      env.hasTip = !!tip && Number.isFinite(tip.x) && Number.isFinite(tip.y);
      env.tipX = env.hasTip && tip ? tip.x : 0;
      env.tipY = env.hasTip && tip ? tip.y : 0;
      const before = this.motion.name;
      this.motion = this.motion.step(this, env);
      if ((this.motion?.name ?? null) !== before) this.changed();
    }
    this.advanceOwn(dt, frame, services);
  }

  protected advanceOwn(_dt: number, _frame: FrameInfo, _services: StageServices): void {}

  // ---------------------------------------------------------------- drawing

  /** Sprites, painted finer while the prop is enlarged so Engorgio stays crisp: as fine as it is
   *  growing to (up to twice), held for the whole growth and the ease back so they are painted once. */
  protected art(now: number): A | null {
    const s = this.scaler;
    if (s.target > 1.1) this.sharp = Math.min(2, Math.max(1.25, s.target));
    else if (s.value <= 1.1) this.sharp = 1;
    return this.bank.get(this.env.canvas, this.env.view.pxPerMh * this.sharp, now, this.env.repaints);
  }

  /** The faint outline of the body, made the first time it is drawn for these sprites. */
  private outline(art: A): Sprite | null {
    if (this.outlineOf !== art.body) {
      this.outlineOf = art.body;
      this.outlineSprite = makeOutline(this.env.canvas, art.body, PAL.vellum, Math.max(1, art.body.res * 1.1));
    }
    return this.outlineSprite;
  }

  /** What Reducto leaves of the prop: its broken pieces on the shelf, in mH round its home with y = 0 on
   *  the shelf line, painted as finely as `art`. Null leaves only the heap of dust. */
  protected buildWreck(_art: A): Sprite | null {
    return null;
  }

  /** The wreck for these sprites, painted the first time it is drawn. */
  private wreck(art: A): Sprite | null {
    if (this.wreckOf !== art.body) {
      this.wreckOf = art.body;
      this.wreckSprite = this.buildWreck(art);
    }
    return this.wreckSprite;
  }

  draw(layers: Layers, frame: FrameInfo, services: StageServices): void {
    this.bind(services, frame.now);
    const reveal = services.revealAlpha();
    this.reveal = Number.isFinite(reveal) ? clamp01(reveal) : 0;
    const art = this.art(frame.now);
    if (!art) return;
    if (this.shattered) {
      this.drawRemains(layers, art);
      return;
    }
    let size = this.scaler.value;
    let alpha = 1;
    const restoring = this.restoreAge < RESTORE_MS;
    const u = this.restoreAge / RESTORE_MS;
    if (restoring) {
      alpha = this.reduced ? clamp01(this.restoreAge / 200) : easeOut(u);
      if (!this.reduced) size *= lerp(0.86, 1, easeOutBack(u, 1.6));
      // The pieces fade from the shelf as the whole gathers back over them.
      const left = 1 - (this.reduced ? clamp01(this.restoreAge / 200) : clamp01(u / 0.55));
      if (left > 0 && this.wreckOf === art.body && this.wreckSprite) this.drawOnShelf(layers.shade, this.wreckSprite, left);
    }
    this.drawShadow(layers.shade, size, alpha);
    this.drawBody(layers, frame, services, art, size, alpha);
    if (restoring) this.drawRestoring(layers.light, art, u, size);
  }

  /** The body on the shade layer, and any light of its own. */
  protected drawBody(layers: Layers, _frame: FrameInfo, _services: StageServices, art: A, size: number, alpha: number): void {
    const ctx = layers.shade;
    this.beginBody(ctx, size);
    if (alpha < 1) ctx.globalAlpha = alpha;
    drawSprite(ctx, art.body);
    this.drawInk(ctx, art.ink, alpha);
    ctx.restore();
  }

  /** The hidden detail's ink, in the body's transform, while Revelio shows it. */
  protected drawInk(ctx: CanvasRenderingContext2D, ink: Sprite | null, alpha: number): void {
    if (!ink || this.reveal <= REVEAL_MIN) return;
    ctx.globalAlpha = this.reveal * alpha;
    drawSprite(ctx, ink);
    ctx.globalAlpha = alpha;
  }

  /** Origin at the base on the shelf, units of mH × size, tilted about the middle. Pair with restore(). */
  protected beginBody(ctx: CanvasRenderingContext2D, size: number): void {
    const v = this.env.view;
    const m = v.pxPerMh * size;
    ctx.save();
    ctx.translate(this.baseX(), this.baseY());
    if (this.rot !== 0) {
      const p = this.pivot * m;
      ctx.translate(0, -p);
      ctx.rotate(this.rot);
      ctx.translate(0, p);
    }
    ctx.scale(m, m);
  }

  /** A point of the body (mH from the base) in canvas pixels, following beginBody's transform. */
  protected localToPx(lx: number, ly: number, size: number, out: Pt): Pt {
    const m = this.env.view.pxPerMh * size;
    const c = Math.cos(this.rot);
    const s = Math.sin(this.rot);
    const py = ly + this.pivot;
    out.x = this.baseX() + m * (lx * c - py * s);
    out.y = this.baseY() + m * (lx * s + py * c - this.pivot);
    return out;
  }

  /** The same point in caster space (for particles). */
  protected localToCaster(lx: number, ly: number, size: number, out: Pt): Pt {
    const v = this.env.view;
    this.localToPx(lx, ly, size, out);
    out.x = (out.x - v.ox) / v.sx;
    out.y = (out.y - v.oy) / v.sy;
    return out;
  }

  /** A sprite authored round the prop's home on the shelf (a heap, a wreck), at `alpha`. */
  private drawOnShelf(shade: CanvasRenderingContext2D, sprite: Sprite, alpha: number): void {
    const v = this.env.view;
    shade.save();
    shade.translate(v.px(this.home.x), v.py(SHELF_TOP));
    shade.scale(v.pxPerMh, v.pxPerMh);
    shade.globalAlpha = alpha;
    drawSprite(shade, sprite);
    shade.restore();
  }

  /** Its wreck, or a heap of dust, on the shelf, and a faint outline where the prop stood: barely there
   *  over a wreck, which shows well enough what it was. */
  private drawRemains(layers: Layers, art: A): void {
    const wreck = this.wreck(art);
    const rest = wreck ?? art.heap;
    if (rest) this.drawOnShelf(layers.shade, rest, clamp01(this.shatterAge / 400));
    const a = (wreck ? 0.04 : 0.32) * clamp01((this.shatterAge - 250) / 700);
    if (a <= 0) return;
    const outline = this.outline(art);
    if (!outline) return;
    const light = layers.light;
    this.beginBody(light, 1);
    light.globalAlpha = a;
    drawSprite(light, outline);
    light.restore();
  }

  /** Reparo on dust: the outline flares and fades as the body returns, with a glint at its heart. */
  private drawRestoring(light: CanvasRenderingContext2D, art: A, u: number, size: number): void {
    this.beginBody(light, size);
    const outline = this.outline(art);
    light.globalAlpha = 0.7 * (1 - u);
    if (outline) drawSprite(light, outline);
    const common = this.env.common.get(this.env.canvas);
    if (common && u > 0.25) {
      const k = Math.sin(Math.PI * clamp01((u - 0.25) / 0.75));
      light.globalAlpha = k;
      light.translate(0, -this.pivot);
      light.scale(1.3 * k + 0.01, 1.3 * k + 0.01);
      drawSprite(light, common.glint);
    }
    light.restore();
  }

  /** Revelio's light: the detail's own glow where it shows, then a halo and a glint around it. */
  drawHidden(layers: Layers, frame: FrameInfo, services: StageServices, alpha: number): void {
    if (this.shattered || !(alpha > REVEAL_MIN)) return;
    this.bind(services, frame.now);
    const art = this.art(frame.now);
    if (!art) return;
    const light = layers.light;
    this.beginBody(light, this.scaler.value);
    if (art.hidden) {
      light.globalAlpha = clamp01(alpha * this.shimmer(frame));
      drawSprite(light, art.hidden);
    }
    const s = this.secret;
    this.drawSecretLight(light, frame, services, alpha, s.x, s.y, s.halo, s.haloAlpha);
    light.restore();
  }
}
