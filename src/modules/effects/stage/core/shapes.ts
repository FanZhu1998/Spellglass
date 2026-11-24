// Shapes (fx.shapes@1): shield.dome (Protego) and bolt.cast. The creature lives in creature.ts.

import type { BoltParams, ShieldParams } from './limits';
import type { XY } from './anchors';
import { createRandom } from './random';
import type { Sprites } from './sprites';
import type { View } from './view';

const easeOutBack = (t: number): number => {
  const x = Math.min(1, Math.max(0, t));
  const c = 1.2;
  return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
};

// ------------------------------------------------------------------ shield

/** "A rippling dome holds for five seconds" (Section 8): a lit bubble around the caster's head and shoulders. */
export class Shield {
  endedAt: number | null = null;
  constructor(
    readonly castId: string,
    readonly params: ShieldParams,
    /** Centre, caster space. */
    readonly center: XY,
    readonly born: number,
  ) {}

  /** When its time is up; a held dome (hold: true) stays until its spell ends. */
  get until(): number {
    return this.params.duration_ms !== undefined ? this.born + this.params.duration_ms : Number.POSITIVE_INFINITY;
  }

  end(now: number): void {
    if (this.endedAt === null) this.endedAt = Math.min(now, this.until);
  }

  /** Fully gone (its fade-out finished). */
  gone(now: number): boolean {
    const end = this.endedAt ?? this.until;
    return now > end + SHIELD_FADE_MS;
  }
}

const SHIELD_FADE_MS = 520;

export function drawShield(ctx: CanvasRenderingContext2D, s: Shield, view: View, sprites: Sprites, now: number, reducedMotion: boolean): void {
  const age = now - s.born;
  const end = s.endedAt ?? s.until;
  const H = view.height * view.dpr;
  let alpha = Math.min(1, age / (reducedMotion ? 150 : 260));
  let grow = reducedMotion ? 1 : easeOutBack(age / 420);
  if (now > end) {
    const k = Math.min(1, (now - end) / SHIELD_FADE_MS);
    alpha *= 1 - k;
    grow *= 1 + 0.06 * k;
  }
  if (alpha <= 0.01) return;
  const R = s.params.radius * H * Math.max(0.2, grow);
  const cx = view.px(s.center.x), cy = view.py(s.center.y);
  ctx.globalCompositeOperation = 'lighter';

  ctx.globalAlpha = 0.95 * alpha;
  ctx.drawImage(sprites.dome(s.params.color), cx - R, cy - R, R * 2, R * 2);

  // The rim wobbles a little, as if the dome were liquid light.
  const t = now / 1000;
  ctx.strokeStyle = s.params.color;
  ctx.lineWidth = Math.max(1, 0.0032 * H);
  ctx.globalAlpha = 0.6 * alpha;
  ctx.beginPath();
  const steps = 96;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const wob = reducedMotion ? 0 : 0.012 * Math.sin(5 * a + t * 2.3) + 0.008 * Math.sin(9 * a - t * 3.1);
    const r = R * (0.985 + wob);
    const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  if (!reducedMotion) {
    // A highlight sweeping round the rim, and ripples running outward from the middle.
    const a0 = t * 1.25;
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = Math.max(1, 0.006 * H);
    ctx.globalAlpha = 0.3 * alpha;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.97, a0, a0 + 0.9);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, 0.0028 * H);
    ctx.strokeStyle = s.params.color;
    for (let k = 0; k < 2; k++) {
      const phase = ((age / 1300 + k / 2) % 1 + 1) % 1;
      ctx.globalAlpha = 0.32 * alpha * (1 - phase) * Math.min(1, age / 500);
      ctx.beginPath();
      ctx.arc(cx, cy, R * (0.3 + 0.68 * phase), 0, Math.PI * 2);
      ctx.stroke();
    }
  } else {
    ctx.globalAlpha = 0.18 * alpha;
    ctx.lineWidth = Math.max(1, 0.0028 * H);
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.72, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

// ------------------------------------------------------------------ bolt

/** "A beam that travels from the tip to the target in about 150 ms." */
export const BOLT_TRAVEL_MS = 150;
const BOLT_HOLD_MS = 110;
const BOLT_FADE_MS = 240;
const BOLT_POINTS = 33;
/** The alpha of a bolt refused by the flash budget: a trace under a tenth of full light. */
const REFUSED_BOLT_ALPHA = 0.09;

export class Bolt {
  /** Jagged path (fractions along the beam, perpendicular offsets), regenerated for the crackle. */
  private offsets = new Float32Array(BOLT_POINTS);
  private bucket = -1;

  constructor(
    readonly castId: string,
    readonly params: BoltParams,
    readonly from: XY,
    readonly to: XY,
    readonly born: number,
    /** Within the flash budget: full brightness and an impact flare. */
    readonly bright: boolean,
    readonly seed: number,
  ) {}

  get duration(): number {
    return BOLT_TRAVEL_MS + BOLT_HOLD_MS + BOLT_FADE_MS;
  }

  done(now: number): boolean {
    return now - this.born >= this.duration;
  }

  /** Midpoint displacement: big kinks in the middle, none at the ends. */
  jag(now: number, reducedMotion: boolean): Float32Array {
    const bucket = reducedMotion ? 0 : Math.floor((now - this.born) / 48);
    if (bucket === this.bucket) return this.offsets;
    this.bucket = bucket;
    const rand = createRandom(this.seed * 7919 + bucket * 104729);
    const o = this.offsets;
    o.fill(0);
    const split = (lo: number, hi: number, amp: number) => {
      if (hi - lo < 2) return;
      const mid = (lo + hi) >> 1;
      o[mid] = (o[lo] + o[hi]) / 2 + (rand() - 0.5) * amp;
      split(lo, mid, amp * 0.55);
      split(mid, hi, amp * 0.55);
    };
    split(0, BOLT_POINTS - 1, 0.22);
    return o;
  }
}

export function drawBolt(ctx: CanvasRenderingContext2D, b: Bolt, view: View, sprites: Sprites, now: number, reducedMotion: boolean): void {
  const t = now - b.born;
  if (t < 0 || b.done(now)) return;
  const H = view.height * view.dpr;
  const head = Math.min(1, t / BOLT_TRAVEL_MS);
  const fade = t < BOLT_TRAVEL_MS + BOLT_HOLD_MS ? 1 : Math.max(0, 1 - (t - BOLT_TRAVEL_MS - BOLT_HOLD_MS) / BOLT_FADE_MS);
  // Red light is kept dimmer (WCAG's red-flash rule).
  const bright = b.params.red ? 0.75 : 1;
  const x0 = view.px(b.from.x), y0 = view.py(b.from.y), x1 = view.px(b.to.x), y1 = view.py(b.to.y);
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const offsets = b.params.jagged ? b.jag(now, reducedMotion) : null;
  const W = Math.max(1, b.params.width * H);
  const last = Math.max(1, Math.round(head * (BOLT_POINTS - 1)));

  const trace = () => {
    ctx.beginPath();
    for (let i = 0; i <= last; i++) {
      const f = i / (BOLT_POINTS - 1);
      let off = 0;
      if (offsets) off = offsets[i] * len;
      else if (!reducedMotion) off = Math.sin(f * Math.PI * 3 + now * 0.03) * W * 0.6 * Math.sin(f * Math.PI);
      const x = x0 + dx * f + nx * off, y = y0 + dy * f + ny * off;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = b.params.color;
  if (!b.bright) {
    // Over the flash budget (Section 10.6, contracts/effects.ts SAFETY): a faint trace and nothing
    // else, no glow around it, no head and no flare. All it draws adds up to under a tenth of full
    // light at any point, so however many come at once and however often, none of them is a flash.
    ctx.globalAlpha = REFUSED_BOLT_ALPHA * fade;
    ctx.lineWidth = Math.max(1, W * 1.2);
    trace();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    return;
  }
  ctx.globalAlpha = 0.22 * fade * bright;
  ctx.lineWidth = W * 5;
  trace();
  ctx.globalAlpha = 0.85 * fade * bright;
  ctx.lineWidth = W * 1.7;
  trace();
  ctx.strokeStyle = '#FFFFFF';
  ctx.globalAlpha = 0.9 * fade * bright;
  ctx.lineWidth = Math.max(1, W * 0.6);
  trace();

  // The head of the beam, then a small flare where it lands. The bolt shares the flash budget,
  // so the flare stays small (a hand's width) and dim: a spell's own light.flash, which follows
  // at its delay, is the one bright event.
  const f = last / (BOLT_POINTS - 1);
  const hx = x0 + dx * f, hy = y0 + dy * f;
  const glow = sprites.glow(b.params.color);
  ctx.globalAlpha = 0.9 * fade * bright;
  ctx.drawImage(glow, hx - W * 5, hy - W * 5, W * 10, W * 10);
  if (head >= 1) {
    const k = Math.max(0, 1 - (t - BOLT_TRAVEL_MS) / 260);
    const r = 0.055 * H;
    ctx.globalAlpha = (b.params.red ? 0.42 : 0.6) * k;
    ctx.drawImage(glow, x1 - r, y1 - r, r * 2, r * 2);
  }
  // Where the beam has landed: a few sparks of its color at the point of impact, while it holds.
  if (head >= 1 && t < BOLT_TRAVEL_MS + BOLT_HOLD_MS + BOLT_FADE_MS * 0.5) {
    const star = sprites.star(b.params.color);
    const s = 0.016 * H;
    ctx.globalAlpha = 0.85 * fade * bright;
    ctx.drawImage(star, x1 - s * 2.6, y1 - s * 2.6, s * 5.2, s * 5.2);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}
