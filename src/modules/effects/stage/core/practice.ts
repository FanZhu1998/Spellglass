// The practice guide (Section 10.3): "Practice puts a faint guide stroke on the mirror, with a dot
// that shows the pace." The template is drawn faintly in the middle of the glass with a start dot;
// a pace dot travels along it at the gesture's intended pace (gesturePaceMs, the same pace the
// engine grades tempo against) and loops. "Show me slowly" runs it at half pace (twice as long).
// Each attempt briefly lays the player's own stroke over the guide, brightly, with the part that
// strayed most drawn dashed (so it differs by shape, not by color alone: Section 10.6).

import type { Point } from '../../../../contracts';
import { geometry } from '../../../../kernel';
import { type Arcana, circleFor, drawStencil, emblemLike } from './arcane';
import { pointAlong } from './morph';
import type { Sprites } from './sprites';
import type { View } from './view';

/** Pause at the start dot before the pace dot sets off, and at the end before it loops. */
export const GUIDE_REST_START_MS = 550;
export const GUIDE_REST_END_MS = 750;
const ATTEMPT_SHOW_MS = 1700;
/** The stencil behind the guide: faint, so the guide and the pace dot stay what you look at. */
const GUIDE_STENCIL_ALPHA = 0.2;
const ATTEMPT_FADE_MS = 450;
const DASH: number[] = [];

/**
 * Where the pace dot is, as a fraction of the path's length, `elapsed` ms into the loop.
 * phase: 'start' (waiting at the start dot), 'moving', or 'end' (resting at the end).
 * The motion eases in and out a little, like a hand, but keeps the intended total duration.
 */
export function paceFraction(elapsed: number, paceMs: number): { f: number; phase: 'start' | 'moving' | 'end' } {
  const pace = Math.max(1, paceMs);
  const cycle = GUIDE_REST_START_MS + pace + GUIDE_REST_END_MS;
  const t = ((elapsed % cycle) + cycle) % cycle;
  if (t < GUIDE_REST_START_MS) return { f: 0, phase: 'start' };
  if (t >= GUIDE_REST_START_MS + pace) return { f: 1, phase: 'end' };
  const k = (t - GUIDE_REST_START_MS) / pace;
  const smooth = k * k * (3 - 2 * k);
  return { f: 0.5 * k + 0.5 * smooth, phase: 'moving' };
}

interface Attempt {
  points: Point[];
  /** geometry.arcFractions(points), computed once. */
  fractions: number[];
  stray?: { from: number; to: number };
  start: number;
}

export class PracticeGuide {
  spellId: string | null = null;
  path: Point[] | null = null;
  private fractions: number[] = [];
  paceMs = 1000;
  slow = false;
  startedAt = 0;
  attempt: Attempt | null = null;
  /** Where the stencil goes, for the path and aspect it was worked out for. */
  private stencil: { x: number; y: number; radius: number } | null = null;
  private stencilPath: Point[] | null = null;
  private stencilAspect = 0;
  /** Scratch points, so drawing every frame allocates nothing. */
  private readonly a = { x: 0, y: 0 };
  private readonly b = { x: 0, y: 0 };

  /** Show (or replace) the guide. paceMs is the gesture's intended pace. */
  show(spellId: string, path: Point[] | null, paceMs: number, now: number): void {
    const changed = spellId !== this.spellId;
    this.spellId = spellId;
    this.path = path && path.length >= 2 ? path : null;
    this.fractions = this.path ? geometry.arcFractions(this.path) : [];
    this.paceMs = Math.max(150, paceMs);
    if (changed) {
      this.slow = false;
      this.startedAt = now;
      this.attempt = null;
    }
  }

  /** "Show me slowly" (or back to the normal pace); the dot starts again from the start. */
  setSlow(slow: boolean, now: number): void {
    this.slow = slow;
    this.startedAt = now;
  }

  showAttempt(points: Point[], stray: { from: number; to: number } | undefined, now: number): void {
    if (points.length < 2) return;
    this.attempt = { points, fractions: geometry.arcFractions(points), ...(stray ? { stray } : {}), start: now };
  }

  clear(): void {
    this.spellId = null;
    this.path = null;
    this.fractions = [];
    this.attempt = null;
    this.slow = false;
  }

  /** Effective duration of one pass of the pace dot. */
  get passMs(): number {
    return this.slow ? this.paceMs * 2 : this.paceMs;
  }

  draw(ctx: CanvasRenderingContext2D, view: View, sprites: Sprites, now: number, candle: string, vellum: string, arcana?: Arcana): void {
    const path = this.path;
    if (!path) return;
    const H = view.height * view.dpr;
    const { f, phase } = paceFraction(now - this.startedAt, this.passMs);
    // The spell's own circle, faint and still, behind the guide (arcane.ts drawStencil).
    if (arcana && this.spellId) {
      if (this.stencilPath !== path || this.stencilAspect !== view.casterAspect) {
        // A shape that would make an emblem inside a ring has none (arcane.ts emblemLike).
        this.stencil = emblemLike(path, view.casterAspect) ? null : circleFor(path, view.casterAspect);
        this.stencilPath = path;
        this.stencilAspect = view.casterAspect;
      }
      if (this.stencil) drawStencil(ctx, arcana, view, this.stencil, this.spellId, vellum, GUIDE_STENCIL_ALPHA);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // The faint guide.
    ctx.strokeStyle = vellum;
    ctx.globalAlpha = 0.24;
    ctx.lineWidth = Math.max(1, 0.011 * H);
    this.trace(ctx, view, 0, 1);

    // The part the pace dot has already travelled glows a little more.
    if (f > 0) {
      ctx.strokeStyle = candle;
      ctx.globalAlpha = phase === 'end' ? 0.3 : 0.4;
      ctx.lineWidth = Math.max(1, 0.008 * H);
      this.trace(ctx, view, 0, f);
    }

    // An arrowhead at the end shows the direction.
    const n = path.length;
    const [ex, ey] = path[n - 1];
    pointAlong(path, this.fractions, 1 - 0.06, this.b);
    const ax = view.px(ex), ay = view.py(ey);
    const dx = ax - view.px(this.b.x), dy = ay - view.py(this.b.y);
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const s = 0.022 * H;
    ctx.strokeStyle = vellum;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = Math.max(1, 0.006 * H);
    ctx.beginPath();
    ctx.moveTo(ax - ux * s - uy * s * 0.6, ay - uy * s + ux * s * 0.6);
    ctx.lineTo(ax, ay);
    ctx.lineTo(ax - ux * s + uy * s * 0.6, ay - uy * s - ux * s * 0.6);
    ctx.stroke();

    // The start dot: a ring with a centre.
    const [sx, sy] = path[0];
    const px = view.px(sx), py = view.py(sy);
    ctx.strokeStyle = candle;
    ctx.fillStyle = candle;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = Math.max(1, 0.004 * H);
    ctx.beginPath();
    ctx.arc(px, py, 0.017 * H, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px, py, 0.0065 * H, 0, Math.PI * 2);
    ctx.fill();

    // The pace dot.
    pointAlong(path, this.fractions, f, this.a);
    const dxp = this.a.x, dyp = this.a.y;
    const R = 0.03 * H;
    const fade = phase === 'end' ? 0.55 : 1;
    ctx.globalAlpha = 0.9 * fade;
    ctx.drawImage(sprites.glow(candle), view.px(dxp) - R, view.py(dyp) - R, R * 2, R * 2);
    const r = 0.009 * H;
    ctx.globalAlpha = fade;
    ctx.drawImage(sprites.glow('#FFFFFF'), view.px(dxp) - r, view.py(dyp) - r, r * 2, r * 2);

    this.drawAttempt(ctx, view, now, H);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawAttempt(ctx: CanvasRenderingContext2D, view: View, now: number, H: number): void {
    const a = this.attempt;
    if (!a) return;
    const age = now - a.start;
    if (age > ATTEMPT_SHOW_MS + ATTEMPT_FADE_MS) {
      this.attempt = null;
      return;
    }
    const alpha = age < ATTEMPT_SHOW_MS ? 1 : 1 - (age - ATTEMPT_SHOW_MS) / ATTEMPT_FADE_MS;
    const pts = a.points;
    const fr = a.fractions;
    const stray = a.stray;
    ctx.strokeStyle = '#FFF3D6';
    ctx.lineWidth = Math.max(1, 0.0075 * H);
    ctx.globalAlpha = 0.9 * alpha;
    ctx.beginPath();
    let open = false;
    for (let i = 0; i < pts.length; i++) {
      const inStray = !!stray && fr[i] > stray.from && fr[i] < stray.to;
      if (inStray) {
        open = false;
        continue;
      }
      const x = view.px(pts[i][0]), y = view.py(pts[i][1]);
      if (!open) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      open = true;
    }
    ctx.stroke();
    if (stray && stray.to > stray.from) {
      // The stretch that strayed most: dashed, so it reads without relying on color.
      if (DASH.length === 0) DASH.push(0.012 * H, 0.012 * H);
      DASH[0] = DASH[1] = Math.max(2, 0.012 * H);
      ctx.setLineDash(DASH);
      ctx.strokeStyle = '#FFB38A';
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < pts.length; i++) {
        if (fr[i] < stray.from || fr[i] > stray.to) continue;
        const x = view.px(pts[i][0]), y = view.py(pts[i][1]);
        if (!started) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
        started = true;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** Stroke the path between two length fractions. */
  private trace(ctx: CanvasRenderingContext2D, view: View, from: number, to: number): void {
    const path = this.path!;
    const fr = this.fractions;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < path.length; i++) {
      if (fr[i] < from) continue;
      if (fr[i] > to) {
        pointAlong(path, fr, to, this.b);
        if (started) ctx.lineTo(view.px(this.b.x), view.py(this.b.y));
        break;
      }
      const x = view.px(path[i][0]), y = view.py(path[i][1]);
      if (!started) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      started = true;
    }
    ctx.stroke();
  }
}
