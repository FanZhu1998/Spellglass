// Shapes (fx.shapes@1): shield.dome (Protego) and bolt.cast. The creature lives in creature.ts.
//
// Protego is a ward, not a soap bubble: a rose window of light laid on the dome and lit toward its
// rim, a band of runes round the rim (arcane.ts), a front of light that runs out across the tracery
// as it is raised, and the rim itself, which wobbles a little as if it were liquid light. A bolt is a
// white-hot core in a sheath of its color with two filaments twisting round it; a ring of runes
// stands at the wand as it leaves, and another bursts where it lands.

import type { BoltParams, ShieldParams } from './limits';
import type { XY } from './anchors';
import { type Arcana, constructBrightness, drawLayer, restingTurn, RING_OUTER, type RingDesign } from './arcane';
import { mixRgb, parseColor, rgba } from './color';
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
  /** Taken over by a ward raised after it (Shield.renews): drawn no more, and gone at once. */
  replaced = false;
  /** When its look began: when it was raised, or when the ward it took over was. */
  readonly look: number;
  private bright = -1;

  constructor(
    readonly castId: string,
    readonly params: ShieldParams,
    /** Centre, caster space. */
    readonly center: XY,
    readonly born: number,
    look?: number,
    /** The spell that raised it: only that spell cast again renews it. */
    readonly spellId = '',
  ) {
    this.look = look ?? born;
  }

  /** When its time is up; a held dome (hold: true) stays until its spell ends. */
  get until(): number {
    return this.params.duration_ms !== undefined ? this.born + this.params.duration_ms : Number.POSITIVE_INFINITY;
  }

  /** How bright its ward may be: a saturated red is kept dimmer (constructBrightness). */
  get brightness(): number {
    if (this.bright < 0) this.bright = constructBrightness(this.params.color);
    return this.bright;
  }

  /** Fully up: not ending, not fading, not taken over. */
  up(now: number): boolean {
    return !this.replaced && this.endedAt === null && now < this.until;
  }

  /**
   * Whether a ward raised now by `spellId` with `params` takes this one over. Protego cast again
   * renews its ward rather than raising a second: the new one carries on this one's look (no second
   * rise, no wave of light, no dip as one fades while the other comes up), so a quick recast never
   * flashes. Only the same spell renews (the engine ends the earlier cast by the later one, so this
   * one is going anyway), and only with a ward that lasts at least as long: a short one raised over
   * a held one would leave nothing when it ends, while the held one's spell still lasts.
   */
  renews(params: ShieldParams, center: XY, now: number, spellId = ''): boolean {
    const until = params.duration_ms !== undefined ? now + params.duration_ms : Number.POSITIVE_INFINITY;
    return (
      this.up(now) && spellId === this.spellId && until >= this.until &&
      params.color === this.params.color && params.radius === this.params.radius && center.x === this.center.x && center.y === this.center.y
    );
  }

  end(now: number): void {
    if (this.endedAt === null) this.endedAt = Math.min(now, this.until);
  }

  /** Fully gone (its fade-out finished, or another ward took it over). */
  gone(now: number): boolean {
    if (this.replaced) return true;
    const end = this.endedAt ?? this.until;
    return now > end + SHIELD_FADE_MS;
  }
}

const SHIELD_FADE_MS = 520;
/** The ward's details come up more slowly than its body, so raising it is never a flash. */
const WARD_RISE_MS = 480;
/** The front of light that runs out across the tracery as the ward is raised. */
const WARD_WAVE_MS = 950;
/** The rim's band of runes (a mirror-sized layer: painted up to the big bucket). */
const WARD_RING: RingDesign = { seed: 4111, runes: 48, ticks: 192, band: [0.835, 0.885], inner: false, big: true };
/** The tracery's rim, as a fraction of the dome's: inside the band of runes (its inner edge is at
 *  0.835 / RING_OUTER = 0.888 of the dome), so the arches and spokes never cut through the runes. */
const TRACERY_AT = 0.86;
const TAU = Math.PI * 2;
const ease = (t: number): number => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;

/** The ward's layers are painted at the dome's full size (it overshoots a little as it is raised),
 *  so they are never painted again: their sizes in px, for a dome of `radius` mirror heights. */
const traceryPx = (radius: number, H: number): number => radius * H * 1.1 * TRACERY_AT * 2;
const wardRingPx = (radius: number, H: number): number => ((radius * H * 1.1) / RING_OUTER) * 2;

/** A ward's layers, wanted ahead (Arcana.prewarm): the ones drawShield will ask for. */
export function prewarmWard(arcana: Arcana, color: string, radius: number, H: number): void {
  if (traceryPx(radius, H) < 8) return;
  arcana.tracery(color, traceryPx(radius, H), true);
  arcana.ring(WARD_RING, color, wardRingPx(radius, H), true);
}

export function drawShield(ctx: CanvasRenderingContext2D, s: Shield, view: View, sprites: Sprites, now: number, reducedMotion: boolean, arcana?: Arcana): void {
  if (s.replaced) return;
  // Its look (rise, turn, ripples) runs from when it was first raised; its time from its own cast.
  const age = now - s.look;
  const end = s.endedAt ?? s.until;
  const H = view.height * view.dpr;
  let alpha = Math.min(1, age / (reducedMotion ? 150 : 260));
  let grow = reducedMotion ? 1 : easeOutBack(age / 420);
  if (now > end) {
    const k = Math.min(1, (now - end) / SHIELD_FADE_MS);
    alpha *= 1 - k;
    if (!reducedMotion) grow *= 1 + 0.06 * k;
  }
  if (alpha <= 0.01) return;
  // Red light is kept dimmer (WCAG's red-flash rule), as a red cast circle or bolt is: the whole
  // ward, dome and rim and every layer of it.
  alpha *= s.brightness;
  const R = s.params.radius * H * Math.max(0.2, grow);
  const cx = view.px(s.center.x), cy = view.py(s.center.y);
  ctx.globalCompositeOperation = 'lighter';

  ctx.globalAlpha = 0.8 * alpha;
  ctx.drawImage(sprites.dome(s.params.color), cx - R, cy - R, R * 2, R * 2);
  const t = now / 1000;

  if (arcana) {
    const rise = alpha * Math.min(1, age / (reducedMotion ? 300 : WARD_RISE_MS));
    // The tracery, lit toward its rim, inside the band of runes. It drifts round very slowly while
    // the ward holds. A layer is asked for only once it shows (a paint on the first, invisible
    // frames would buy nothing).
    const lattice = 0.6 * rise > 0.004 ? arcana.tracery(s.params.color, traceryPx(s.params.radius, H)) : null;
    const drift = reducedMotion ? 0 : restingTurn(age, 0.04, 5000);
    const Rt = R * TRACERY_AT;
    if (lattice) {
      drawLayer(ctx, lattice, cx, cy, Rt / 0.985, drift, 0.6 * rise);
      // Raising it: a front of light runs out from the middle and lights the tracery it crosses.
      if (!reducedMotion && age < WARD_WAVE_MS) {
        const k = age / WARD_WAVE_MS;
        const front = Rt * (0.08 + 0.94 * ease(k));
        const width = Rt * 0.16;
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, front + width * 0.15, 0, TAU);
        ctx.moveTo(cx + Math.max(0, front - width), cy);
        ctx.arc(cx, cy, Math.max(0, front - width), 0, TAU, true);
        ctx.clip();
        drawLayer(ctx, lattice, cx, cy, Rt / 0.985, drift, 1.4 * alpha * (1 - k) ** 1.2);
        ctx.restore();
      }
    }
    // The band of runes round the rim, turning slowly one way.
    const half = R / RING_OUTER;
    const ring = 0.8 * rise > 0.004 ? arcana.ring(WARD_RING, s.params.color, wardRingPx(s.params.radius, H)) : null;
    const turn = reducedMotion ? 0 : restingTurn(age, 0.11, 5000);
    if (ring) drawLayer(ctx, ring, cx, cy, half, turn, 0.8 * rise);
    // Six bright nodes on the rim, where the ward is anchored.
    const star = sprites.star(s.params.color);
    const nodeR = 0.018 * H;
    ctx.globalAlpha = 0.75 * rise;
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i / 6) * TAU + turn;
      const nx = cx + Math.cos(a) * R * 0.985, ny = cy + Math.sin(a) * R * 0.985;
      ctx.drawImage(star, nx - nodeR * 2, ny - nodeR * 2, nodeR * 4, nodeR * 4);
    }
  }

  // The rim wobbles a little, as if the dome were liquid light.
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
  private tintCss: string | null = null;

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

  /** Its filaments' color: a lighter tint of its own (worked out once). */
  get tint(): string {
    if (this.tintCss === null) this.tintCss = rgba(mixRgb(parseColor(this.params.color, '#FFFFFF'), { r: 255, g: 255, b: 255 }, 0.55), 1);
    return this.tintCss;
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

/** The ring of runes at the wand as a bolt leaves it, and the one that bursts where it lands. */
const MUZZLE_RING: RingDesign = { seed: 9203, runes: 14, ticks: 56, band: [0.7, 0.86], inner: true };
const IMPACT_RING: RingDesign = { seed: 3307, runes: 18, ticks: 72, band: [0.72, 0.87], inner: true };
/** Filaments: twists per mirror height along the beam, and how fast they run (radians per ms). */
const FILAMENT_TWISTS = 16;
const FILAMENT_RUN = 0.022;

export function drawBolt(ctx: CanvasRenderingContext2D, b: Bolt, view: View, sprites: Sprites, now: number, reducedMotion: boolean, arcana?: Arcana): void {
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

  // Two filaments twist round the beam, in a lighter tint of its color, running toward the target.
  const twists = (len / H) * FILAMENT_TWISTS;
  // A dozen points to each twist, so each half of it is a smooth curve (fewer, and a long beam's
  // filaments become a chain of straight links).
  const steps = Math.max(8, Math.min(400, Math.ceil(twists * (last / (BOLT_POINTS - 1)) * 12)));
  ctx.strokeStyle = b.tint;
  ctx.lineWidth = Math.max(1, W * 0.32);
  for (let strand = 0; strand < 2; strand++) {
    const phase = strand * Math.PI;
    ctx.globalAlpha = 0.6 * fade * bright;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const f = (i / steps) * (last / (BOLT_POINTS - 1));
      const at = f * (BOLT_POINTS - 1);
      const j = Math.min(BOLT_POINTS - 2, Math.floor(at));
      const base = offsets ? (offsets[j] + (offsets[j + 1] - offsets[j]) * (at - j)) * len : 0;
      // Fine at the wand and at the head, widest between.
      const taper = Math.min(1, f / 0.08) * Math.min(1, (head - f + 0.02) / 0.1);
      const off = base + Math.sin(f * twists * TAU - (reducedMotion ? 0 : t * FILAMENT_RUN) + phase) * W * 1.6 * Math.max(0, taper);
      const x = x0 + dx * f + nx * off, y = y0 + dy * f + ny * off;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

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
  // A ring of runes stands at the wand as the bolt leaves, seen edge on across the beam, and
  // another bursts open where it lands.
  if (arcana) {
    const angle = Math.atan2(dy, dx);
    const spin = reducedMotion ? 0 : t * 0.004;
    const muzzleHalf = 0.05 * H * (reducedMotion ? 1 : 0.8 + 0.35 * ease(t / 260));
    const muzzleAlpha = 0.85 * fade * bright * Math.min(1, t / 90);
    const muzzle = muzzleAlpha > 0.004 ? arcana.ring(MUZZLE_RING, b.params.color, 0.05 * H * 1.15 * 2) : null;
    if (muzzle) drawLayer(ctx, muzzle, x0, y0, muzzleHalf, spin, muzzleAlpha, 0.42, angle);
    if (head >= 1) {
      const k = (t - BOLT_TRAVEL_MS) / (BOLT_HOLD_MS + BOLT_FADE_MS);
      const impactHalf = H * (reducedMotion ? 0.07 : 0.03 + 0.07 * ease(k * 1.4));
      const impact = k < 1 ? arcana.ring(IMPACT_RING, b.params.color, 0.1 * H * 2) : null;
      if (impact) drawLayer(ctx, impact, x1, y1, impactHalf, -spin, 0.9 * bright * (1 - k) ** 1.3, 0.62, angle);
    }
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
