// creature.summon (Expecto Patronum): "A silver creature bursts out and circles the frame"
// (Section 8). An original silver hare of light, drawn procedurally (Section 10.7: original art, no
// assets). It bursts from the tip, runs a loop round the frame that reads as circling in depth
// (larger and brighter along the bottom, smaller along the top), trails silver particles, and
// leaps away in a shower of stars when its time is up.
//
// Motion runs on the stage's scaled clock, so Arresto Momentum freezes the hare mid-stride.

import { scaleParticleCount, type CreatureParams } from './limits';
import type { XY } from './anchors';
import { mixRgb, parseColor, rgba } from './color';
import type { ParticleSystem } from './particles';
import { makeCanvas } from './sprites';
import type { View } from './view';

const ENTRY_MS = 750;
const EXIT_MS = 850;
const LAP_MS = 3600;
const STRIDE_MS = 340;
/** Body length as a fraction of the mirror height, at the front of the loop. */
const BODY = 0.2;

export interface Pose {
  /** Caster space. */
  x: number;
  y: number;
  /** Size multiplier (depth). */
  scale: number;
  alpha: number;
}

export class Creature {
  /** Scaled time since it appeared. */
  clock = 0;
  endedAt: number | null = null;
  /** Scaled clock when the exit began. */
  private exitClock: number | null = null;
  private exitFrom: Pose | null = null;
  private exitVel: XY = { x: 0, y: 0 };
  private trailAcc = 0;
  private burstDone = false;
  /** Loop angle where the hare joins the run (set on first placement, from the tip). */
  private phase0 = Math.PI / 2;
  private phaseSet = false;
  pose: Pose = { x: 0, y: 0, scale: 0.3, alpha: 0 };
  facing = 1;
  tilt = 0;

  constructor(
    readonly castId: string,
    readonly params: CreatureParams,
    /** Where it bursts out (the tip), caster space. */
    readonly from: XY,
    readonly born: number,
  ) {}

  /** When its time is up; a held creature (hold: true) stays until its spell ends. */
  get until(): number {
    return this.params.duration_ms !== undefined ? this.born + this.params.duration_ms : Number.POSITIVE_INFINITY;
  }

  end(now: number): void {
    if (this.endedAt === null) this.endedAt = Math.min(now, this.until);
  }

  gone(): boolean {
    return this.exitClock !== null && this.clock - this.exitClock >= EXIT_MS;
  }

  /** Where the loop puts the hare after `t` ms of running (isotropic units, y down). */
  static loop(t: number, aspect: number, phase0: number): { x: number; y: number; depth: number } {
    // Counter-clockwise on screen: along the bottom it runs to the right, toward you.
    const theta = phase0 - (t / LAP_MS) * Math.PI * 2;
    const cx = 0.5 * aspect, cy = 0.5;
    const rx = 0.34 * aspect, ry = 0.2;
    return { x: cx + Math.cos(theta) * rx, y: cy + Math.sin(theta) * ry, depth: Math.sin(theta) };
  }

  /** Position (caster space), scale and alpha at scaled time t, before any exit. */
  private place(t: number, aspect: number): Pose {
    if (!this.phaseSet) {
      // Join the loop at the point nearest the tip, so the burst flows straight into the run.
      const cx = 0.5 * aspect, cy = 0.5, rx = 0.34 * aspect, ry = 0.2;
      this.phase0 = Math.atan2((this.from.y - cy) / ry, (this.from.x * aspect - cx) / rx);
      this.phaseSet = true;
    }
    const p = Creature.loop(t, aspect, this.phase0);
    const loopScale = 0.78 + 0.26 * p.depth;
    const loopAlpha = 0.72 + 0.28 * (0.5 + 0.5 * p.depth);
    if (t >= ENTRY_MS) return { x: p.x / aspect, y: p.y, scale: loopScale, alpha: loopAlpha };
    const k = t / ENTRY_MS;
    const e = k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
    const tx = this.from.x * aspect, ty = this.from.y;
    const x = tx + (p.x - tx) * e;
    const y = ty + (p.y - ty) * e - 0.14 * Math.sin(Math.PI * e);
    return { x: x / aspect, y, scale: 0.3 + (loopScale - 0.3) * e, alpha: Math.min(1, k * 2.5) * loopAlpha };
  }

  update(now: number, dt: number, aspect: number, particles: ParticleSystem, reducedMotion: boolean): void {
    this.clock += dt;
    const t = this.clock;
    // It leaps away when it is ended, or when its time is up: then the director has already sent its
    // effect.end ('done') and will not end it again, so nothing else would ever send it off.
    if (this.exitClock === null && now >= (this.endedAt ?? this.until)) {
      this.exitClock = t;
      this.exitFrom = this.place(t, aspect);
      const ahead = this.place(t + 60, aspect);
      this.exitVel = { x: (ahead.x - this.exitFrom.x) / 60, y: (ahead.y - this.exitFrom.y) / 60 };
    }
    const prev = this.pose;
    let next: Pose;
    if (this.exitClock !== null && this.exitFrom) {
      // The leap away: carry on, rise, shrink and fade.
      const k = Math.min(1, (t - this.exitClock) / EXIT_MS);
      const s = t - this.exitClock;
      next = {
        x: this.exitFrom.x + this.exitVel.x * s,
        y: this.exitFrom.y + this.exitVel.y * s - 0.25 * k * k,
        scale: this.exitFrom.scale * (1 - 0.35 * k),
        alpha: this.exitFrom.alpha * (1 - k) ** 1.5,
      };
      if (!this.burstDone) {
        this.burstDone = true;
        particles.spawn({
          preset: 'stars', x: this.exitFrom.x, y: this.exitFrom.y, count: scaleParticleCount(40, reducedMotion), color: this.params.color, speed: 1.2,
        });
      }
    } else {
      next = this.place(t, aspect);
    }
    // Facing and tilt follow the direction of travel; the hare flips rather than running upside down.
    const vx = (next.x - prev.x) * aspect, vy = next.y - prev.y;
    if (Math.abs(vx) > 1e-5) this.facing = vx < 0 ? -1 : 1;
    if (Math.abs(vx) + Math.abs(vy) > 1e-5) {
      const tilt = Math.atan2(vy, Math.abs(vx));
      this.tilt += (Math.max(-0.45, Math.min(0.45, tilt)) - this.tilt) * Math.min(1, dt / 90);
    }
    this.pose = next;

    // A trail of silver light behind it.
    if (dt > 0 && next.alpha > 0.05) {
      this.trailAcc += (dt / 1000) * (reducedMotion ? 12 : 38);
      while (this.trailAcc >= 1) {
        this.trailAcc -= 1;
        const back = -this.facing * BODY * 0.35 * next.scale;
        particles.spawn({
          preset: 'stars', x: next.x + back / aspect, y: next.y + BODY * 0.05 * next.scale, count: 1,
          color: this.params.color, speed: 0.25, size: 0.7 + next.scale * 0.4, lifeMs: 900,
        });
      }
    }
  }
}

/**
 * Draws hares onto the light layer. The hare is drawn sharp into a small offscreen canvas, then
 * blurred into a second one for its glow: with the canvas blur filter where the browser has it,
 * else by scaling down in two steps (one big step aliases into blocks).
 */
export class CreatureRenderer {
  private sharp: HTMLCanvasElement | null = null;
  private soft: HTMLCanvasElement | null = null;
  private mid: HTMLCanvasElement | null = null;
  private filters: boolean | null = null;

  draw(ctx: CanvasRenderingContext2D, c: Creature, view: View): void {
    const H = view.height * view.dpr;
    const L = BODY * H * c.pose.scale * c.params.size;
    if (c.pose.alpha <= 0.01 || L < 2) return;
    const S = Math.ceil(L * 2.4);
    if (!this.sharp || this.sharp.width < S || this.sharp.width > S * 2) {
      this.sharp = makeCanvas(S, S);
      this.soft = makeCanvas(Math.max(8, Math.ceil(S / 2)), Math.max(8, Math.ceil(S / 2)));
      this.mid = makeCanvas(Math.max(8, Math.ceil(S / 3)), Math.max(8, Math.ceil(S / 3)));
    }
    const sharp = this.sharp, soft = this.soft, mid = this.mid;
    const sctx = sharp?.getContext('2d');
    const gctx = soft?.getContext('2d');
    if (!sharp || !soft || !mid || !sctx || !gctx) return;
    const size = sharp.width;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, size, size);
    sctx.translate(size / 2, size / 2);
    sctx.rotate(c.tilt * c.facing);
    sctx.scale(c.facing * L, L);
    drawHare(sctx, (c.clock / STRIDE_MS) % 1, c.params.color);

    if (this.filters === null) {
      gctx.filter = 'blur(2px)';
      this.filters = gctx.filter === 'blur(2px)';
      gctx.filter = 'none';
    }
    gctx.setTransform(1, 0, 0, 1, 0, 0);
    gctx.clearRect(0, 0, soft.width, soft.height);
    gctx.imageSmoothingEnabled = true;
    if (this.filters) {
      gctx.filter = `blur(${Math.max(1.5, soft.width * 0.035).toFixed(1)}px)`;
      gctx.drawImage(sharp, 0, 0, soft.width, soft.height);
      gctx.filter = 'none';
    } else {
      const mctx = mid.getContext('2d');
      if (!mctx) return;
      mctx.clearRect(0, 0, mid.width, mid.height);
      mctx.drawImage(sharp, 0, 0, mid.width, mid.height);
      gctx.drawImage(mid, 0, 0, Math.ceil(soft.width / 3), Math.ceil(soft.height / 3));
      gctx.drawImage(soft, 0, 0, Math.ceil(soft.width / 3), Math.ceil(soft.height / 3), 0, 0, soft.width, soft.height);
    }

    const cx = view.px(c.pose.x), cy = view.py(c.pose.y);
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    // A wide faint aura, a close glow, then the creature itself.
    ctx.globalAlpha = Math.min(1, 0.45 * c.pose.alpha);
    ctx.drawImage(soft, cx - size * 0.8, cy - size * 0.8, size * 1.6, size * 1.6);
    ctx.globalAlpha = Math.min(1, 0.9 * c.pose.alpha);
    ctx.drawImage(soft, cx - size * 0.55, cy - size * 0.55, size * 1.1, size * 1.1);
    ctx.globalAlpha = Math.min(1, 0.85 * c.pose.alpha);
    ctx.drawImage(sharp, 0, 0, size, size, cx - size / 2, cy - size / 2, size, size);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** A tapered limb from (x0, y0) through a bend to (x1, y1). */
function limb(ctx: CanvasRenderingContext2D, x0: number, y0: number, bx: number, by: number, x1: number, y1: number, w0: number, w1: number): void {
  // Two strokes approximate a taper: thick near the body, fine at the paw.
  ctx.lineWidth = w0;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(bx, by, (bx + x1) / 2, (by + y1) / 2);
  ctx.stroke();
  ctx.lineWidth = w1;
  ctx.beginPath();
  ctx.moveTo((x0 + bx) / 2, (y0 + by) / 2);
  ctx.quadraticCurveTo(bx, by, x1, y1);
  ctx.stroke();
}

/** One ear: a long leaf from its base to its tip. */
function ear(ctx: CanvasRenderingContext2D, bx: number, by: number, tx: number, ty: number, width: number): void {
  const dx = tx - bx, dy = ty - by;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * width, ny = (dx / len) * width;
  ctx.moveTo(bx - nx * 0.6, by - ny * 0.6);
  ctx.quadraticCurveTo(bx + dx * 0.55 - nx, by + dy * 0.55 - ny, tx, ty);
  ctx.quadraticCurveTo(bx + dx * 0.55 + nx, by + dy * 0.55 + ny, bx + nx * 0.6, by + ny * 0.6);
  ctx.closePath();
}

/**
 * The hare in local units (body length 1, facing +x, y down), at gallop phase 0..1.
 * Extension (phase 0): front paws reach forward, hind feet push far back, body long and low.
 * Gather (phase 0.5): hind feet swing forward past the front paws, back arched, body short.
 */
export function drawHare(ctx: CanvasRenderingContext2D, phase: number, color: string): void {
  const g = 0.5 + 0.5 * Math.cos(phase * Math.PI * 2); // 1 extended, 0 gathered
  const bob = -0.045 * Math.cos(phase * Math.PI * 4);
  const arch = 1 - g;
  ctx.translate(0, bob);
  const base = parseColor(color, '#DDE8FF');
  // Made of light: brightest along the back and ears, thinning toward the paws.
  const body = ctx.createLinearGradient(0, -0.6, 0, 0.3);
  body.addColorStop(0, rgba(mixRgb(base, { r: 255, g: 255, b: 255 }, 0.7), 0.95));
  body.addColorStop(0.55, rgba(base, 0.72));
  body.addColorStop(1, rgba(base, 0.42));
  ctx.fillStyle = body;
  ctx.strokeStyle = rgba(base, 1);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  // Far-side legs first, dimmer, a little out of phase.
  ctx.globalAlpha = 0.45;
  const g2 = 0.5 + 0.5 * Math.cos((phase + 0.09) * Math.PI * 2);
  limb(ctx, 0.17, 0.04, lerp(0.08, 0.42, g2), lerp(0.17, 0.16, g2), lerp(-0.06, 0.56, g2), lerp(0.24, 0.17, g2), 0.06, 0.032);
  limb(ctx, -0.25, 0.06, lerp(-0.02, -0.46, g2), lerp(0.2, 0.22, g2), lerp(0.2, -0.7, g2), lerp(0.24, 0.12, g2), 0.075, 0.035);

  ctx.globalAlpha = 1;
  ctx.beginPath();
  // Torso, haunch, chest and head, filled as one silhouette.
  ctx.ellipse(0, -0.02 - 0.05 * arch, 0.33 + 0.05 * g, 0.145 - 0.012 * g, -0.06 - 0.1 * arch, 0, Math.PI * 2);
  ctx.ellipse(-0.2 + 0.03 * arch, 0.0 - 0.02 * arch, 0.2, 0.18, 0.35, 0, Math.PI * 2);
  ctx.ellipse(0.2, -0.03, 0.15, 0.135, -0.2, 0, Math.PI * 2);
  ctx.ellipse(0.31, -0.12, 0.08, 0.07, -0.6, 0, Math.PI * 2); // neck
  ctx.ellipse(0.43 + 0.02 * g, -0.17 - 0.015 * g, 0.125, 0.082, 0.42, 0, Math.PI * 2);
  ctx.moveTo(-0.37 + 0.06, -0.09);
  ctx.arc(-0.37, -0.09, 0.065, 0, Math.PI * 2); // tail
  // Ears swept back by the run, lifting a little in the gather.
  ear(ctx, 0.38, -0.22, lerp(0.17, 0.1, g), lerp(-0.55, -0.5, g), 0.05);
  ear(ctx, 0.35, -0.21, lerp(0.07, 0.0, g), lerp(-0.5, -0.43, g), 0.045);
  ctx.fill();

  // Near-side legs.
  ctx.globalAlpha = 0.75;
  limb(ctx, 0.2, 0.05, lerp(0.1, 0.44, g), lerp(0.18, 0.16, g), lerp(-0.02, 0.6, g), lerp(0.25, 0.18, g), 0.065, 0.034);
  limb(ctx, -0.22, 0.08, lerp(0.02, -0.44, g), lerp(0.22, 0.23, g), lerp(0.24, -0.7, g), lerp(0.25, 0.13, g), 0.085, 0.038);

  // Highlights: the line of the back, the ear edges, an eye.
  ctx.globalAlpha = 0.9;
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 0.018;
  ctx.beginPath();
  ctx.moveTo(-0.36, -0.12);
  ctx.quadraticCurveTo(-0.05, -0.24 - 0.06 * arch, 0.28, -0.16);
  ctx.stroke();
  ctx.lineWidth = 0.012;
  ctx.beginPath();
  ctx.moveTo(0.37, -0.23);
  ctx.quadraticCurveTo(0.3, -0.42, lerp(0.17, 0.1, g), lerp(-0.55, -0.5, g));
  ctx.stroke();
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(0.47, -0.19, 0.016, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
}
