// Light (fx.light@1): light.orb, light.flash, light.snuff and scene.dim.
//
// "You cast Lumos and the tip of your real wand lights up in the mirror while the room darkens
// around it" (Section 7.8). The dim is a dark veil over the reflection with soft holes cut where
// orbs burn, so the light seems to fall on the room.
//
// For photosensitive players (Section 10.6, imported packs included) every flash goes through the
// FlashLimiter and every dimming change is rate-limited (limits.ts). An orb's light never jumps: a
// fade or a snuff starts from wherever its bloom had got to. A quick change in it (a bloom, a fade,
// a snuff) counts against the same flash budget; once the budget is spent the change is made
// softly instead, the way a refused flash becomes a soft glow. Everything that changes softly (the
// room's dimming, orbs changing softly, the soft glow of refused flashes) shares one allowance, so
// however many change at once, and wherever they overlap, they cannot add up to a flash either.
// Nor can an orb's flicker add to them: it waits while a light changes softly (Orb.flickerClock).

import { EFFECT_LIMITS } from '../../../../contracts';
import type { BoltParams, DimParams, FlashParams, OrbParams } from './limits';
import { FlashLimiter, MAX_DIM_RATE_PER_MS, ORB_BLOOM_MS, stepDim } from './limits';
import type { XY } from './anchors';
import type { Sprites } from './sprites';
import type { View } from './view';

export type LightState = 'lit' | 'snuffing' | 'fading' | 'out';

/** A quick fade (its spell ended) and a quick snuff (light.snuff) take this long from full. */
const ORB_FADE_MS = 380;
const ORB_SNUFF_MS = 200;
/** A quick bloom grows to full size over a little longer than it brightens. */
const ORB_GROW_MS = 420;

// An orb is drawn as four sprites added together ('lighter'), each at this alpha per unit of its
// brightness: soft rays, a wide halo, a glow and a white core (drawLight).
const RAYS = 0.38;
const HALO = 0.32;
const GLOW = 0.8;
const CORE = 1;
/** The flicker of a lit tip: two slow waves this strong (Section 10.6 allows a candle's flicker). */
const FLICKER_A = 0.035;
const FLICKER_B = 0.025;
const FLICKER_TOP = 1 + FLICKER_A + FLICKER_B;

/**
 * The most an orb can change the picture at any point, per unit of its intensity × level: its four
 * sprites add up (each peaks at 1; the flicker can lift them by FLICKER_TOP, the rays a little more),
 * and the pool it clears in the room's dimming lets up to 0.92 × dimMax more of the room through.
 */
export const ORB_GAIN = FLICKER_TOP * (RAYS * (0.92 + 1.6 * (FLICKER_TOP - 1)) + HALO + GLOW + CORE) + 0.92 * EFFECT_LIMITS.dimMax;

/** How fast an orb that changes softly may change in its share of the soft allowance
 *  (LightLayer.update), in intensity × level per ms: the picture then changes no faster than dimming
 *  may, under 0.1 per 100 ms, which is not a flash. */
export const SOFT_ORB_RATE = MAX_DIM_RATE_PER_MS / ORB_GAIN;

/** A refused flash glows at this share of its intensity, with the ordinary glow sprite. */
const SOFT_GLOW = 0.35;

/** How fast a soft glow may change in its share of the soft allowance, in intensity × level per ms.
 *  The glow sprite peaks at 1, so at its centre the picture then changes no faster than dimming may. */
export const SOFT_GLOW_RATE = MAX_DIM_RATE_PER_MS;

export class Orb {
  x: number;
  y: number;
  state: LightState = 'lit';
  /** When the current state began. */
  stateAt: number;
  /** Brightness, 0..1. It moves and never jumps (LightLayer.update moves it). */
  level = 0;
  /** The change under way (the bloom, or going out) was allowed by the flash budget and runs at its
   *  own pace. Otherwise it runs softly, sharing LightLayer's soft allowance. */
  quick: boolean;
  /** Size as a fraction of full. A quick bloom grows it; going out keeps it, so it never jumps. A
   *  soft bloom is full size from the start: only its brightness rises. */
  size: number;
  /** The flicker's own clock. It stands still while any light changes softly (this orb, another or
   *  a soft glow), so that a soft change and the flicker never add up: each alone changes the picture
   *  under 0.1 per 100 ms, but where they overlap they can go over it together. The room's dimming
   *  leaves it running. The flicker moves the orb's light by a few percent of itself, and dimming
   *  shows only as far as the light is not full, so where one is strong the other is weak: between
   *  them they change the picture no faster than dimming alone may. */
  flickerClock: number;
  /** Level when the current state began: a quick change is timed from it. */
  private from = 0;

  constructor(
    readonly castId: string,
    readonly spellId: string,
    readonly params: OrbParams,
    at: XY,
    readonly follow: (() => XY | null) | null,
    readonly born: number,
    quick: boolean,
  ) {
    this.x = at.x;
    this.y = at.y;
    this.stateAt = born;
    this.flickerClock = born;
    this.quick = quick;
    this.size = quick ? 0 : 1;
  }

  /** Timed orbs end on their own; held ones wait for their spell to end. */
  get until(): number | null {
    return this.params.duration_ms !== undefined ? this.born + this.params.duration_ms : null;
  }

  /** The level the current state is heading for. */
  get target(): number {
    return this.state === 'lit' ? 1 : 0;
  }

  /** Going out ('fading': its spell ended; 'snuffing': light.snuff, which flares as it goes when it
   *  is quick), from the level it has now. A snuff may cut a fade short. */
  goOut(state: 'fading' | 'snuffing', now: number, quick: boolean): void {
    this.advanceQuick(now);
    this.state = state;
    this.stateAt = now;
    this.from = this.level;
    this.quick = quick;
  }

  /** Brings a quick change up to `now`: its level, and while it blooms its size. A soft change moves
   *  only in LightLayer.update. */
  advanceQuick(now: number): void {
    if (!this.quick) return;
    const t = Math.max(0, now - this.stateAt);
    if (this.state === 'lit') {
      this.level = Math.min(1, this.from + t / ORB_BLOOM_MS);
      this.size = easeOutBack((now - this.born) / ORB_GROW_MS);
    } else if (this.state === 'fading') {
      this.level = Math.max(0, this.from - t / ORB_FADE_MS);
    } else if (this.state === 'snuffing') {
      this.level = Math.max(0, this.from - t / ORB_SNUFF_MS);
    }
  }
}

export interface Flash {
  x: number;
  y: number;
  color: string;
  radius: number;
  intensity: number;
  start: number;
  duration: number;
  /** Over the flash budget: a gentle glow instead, which is not a flash. */
  soft: boolean;
  /** A soft glow's brightness, 0..1. LightLayer.update moves it up to 1 and back down, no faster than
   *  its own pace (softGlowMs) or its share of the soft allowance. A real flash leaves it at 0. */
  level: number;
  /** A soft glow on its way back down. */
  falling: boolean;
}

export interface Dim {
  castId: string;
  amount: number;
  ratePerMs: number;
  active: boolean;
  until: number | null;
}

/** How long a soft glow takes to swell and fade at its own pace: at least half a second, half of it
 *  rising and half falling, in straight lines (a curve would rise faster at first). Sharing the soft
 *  allowance can make it take longer. */
export function softGlowMs(f: Pick<Flash, 'duration'>): number {
  return Math.max(600, f.duration * 2);
}

/** Envelope of a flash at time `now`, 0..1. A real flash rises in 35 ms and decays; a soft glow is
 *  wherever LightLayer.update has brought it. */
export function flashEnvelope(f: Flash, now: number): number {
  if (f.soft) return f.level;
  const t = now - f.start;
  if (t < 0 || t >= f.duration) return 0;
  if (t < 35) return t / 35;
  const k = (t - 35) / (f.duration - 35);
  return (1 - k) * (1 - k);
}

/** A flash that has finished showing, or a soft glow that has faded out. */
function flashOver(f: Flash, now: number): boolean {
  return f.soft ? f.falling && f.level <= 0 : now >= f.start && now - f.start >= f.duration;
}

function easeOutBack(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  const c = 1.4;
  return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
}

export class LightLayer {
  orbs: Orb[] = [];
  flashes: Flash[] = [];
  dims: Dim[] = [];
  /** The dim as shown, eased toward the target at a safe rate. */
  dim = 0;
  private dimRate = MAX_DIM_RATE_PER_MS;

  constructor(readonly limiter: FlashLimiter = new FlashLimiter()) {}

  /** A new orb. Its bloom is a quick change in light: within the flash budget it blooms at its own
   *  pace, otherwise softly (orb.quick says which). */
  addOrb(castId: string, spellId: string, params: OrbParams, at: XY, follow: (() => XY | null) | null, now: number): Orb {
    const orb = new Orb(castId, spellId, params, at, follow, now, this.limiter.change(now));
    this.orbs.push(orb);
    return orb;
  }

  /** Let a lit orb go out because its spell ended or its time is up: quickly within the flash
   *  budget, otherwise softly. */
  fadeOrb(o: Orb, now: number): void {
    if (o.state !== 'lit') return;
    o.goOut('fading', now, this.limiter.change(now));
  }

  /** Put out orbs: all, or those of one spell. They go out together, one change for the flash
   *  budget. Returns the orbs it snuffed. */
  snuff(spellId: string | undefined, now: number): Orb[] {
    const out = this.orbs.filter((o) => (o.state === 'lit' || o.state === 'fading') && (!spellId || o.spellId === spellId));
    if (!out.length) return out;
    const quick = this.limiter.change(now);
    for (const o of out) o.goOut('snuffing', now, quick);
    return out;
  }

  /** A flash, if the budget allows; otherwise a soft glow. A flash refused while a soft glow shows
   *  joins that glow instead of adding another, so refused flashes never pile up into a bright light
   *  that would take long to fade softly. Returns the flash as shown. */
  addFlash(params: FlashParams, at: XY, now: number): Flash {
    const start = this.limiter.request(now, params.duration_ms);
    const soft = start === null;
    const glowing = soft ? this.flashes.find((g) => g.soft && !flashOver(g, now)) : undefined;
    if (glowing) return glowing;
    const f: Flash = {
      x: at.x, y: at.y, color: params.color, radius: params.radius,
      intensity: soft ? params.intensity * SOFT_GLOW : params.intensity, start: start ?? now, duration: params.duration_ms, soft,
      level: 0, falling: false,
    };
    this.flashes.push(f);
    return f;
  }

  /** A bolt's impact flare draws from the same budget. Returns whether it may be bright. */
  boltFlash(_params: BoltParams, now: number, travelMs: number): boolean {
    return this.limiter.request(now, travelMs, 0) !== null;
  }

  addDim(castId: string, params: DimParams, now: number): Dim {
    const d: Dim = {
      castId, amount: params.amount, ratePerMs: Math.min(MAX_DIM_RATE_PER_MS, params.amount / params.fade_ms), active: true,
      until: params.duration_ms !== undefined ? now + params.duration_ms : null,
    };
    this.dims.push(d);
    this.dimRate = d.ratePerMs || MAX_DIM_RATE_PER_MS;
    return d;
  }

  endDim(d: Dim): void {
    if (!d.active) return;
    d.active = false;
    this.dimRate = d.ratePerMs || MAX_DIM_RATE_PER_MS;
  }

  /** Target dim: the deepest active dim (dims do not add up), capped by its own limit already. */
  dimTarget(): number {
    let t = 0;
    for (const d of this.dims) if (d.active && d.amount > t) t = d.amount;
    return t;
  }

  update(now: number, rawDt: number, followDt: number): void {
    for (const d of this.dims) if (d.active && d.until !== null && now >= d.until) this.endDim(d);
    // The lists are rebuilt only when something has gone, so an ordinary frame allocates nothing.
    if (this.dims.some((d) => !d.active)) this.dims = this.dims.filter((d) => d.active);
    const dt = Math.max(0, rawDt);
    const dimTarget = this.dimTarget();

    // Quick changes follow their own clock. Whatever changes softly is counted, to share the
    // allowance below: the lights (orbs changing softly and the soft glow) and the room's dimming.
    let softLights = 0;
    for (const o of this.orbs) {
      if (o.state === 'lit' && o.until !== null && now >= o.until) this.fadeOrb(o, now);
      if (o.quick) o.advanceQuick(now);
      else if (o.level !== o.target) softLights++;
    }
    for (const f of this.flashes) if (f.soft) softLights++;
    const soft = softLights + (this.dim !== dimTarget ? 1 : 0);
    // Each gets an equal share of the frame and changes in it no faster than its own soft rate, at
    // which it would change the picture as fast as dimming may. So however many change softly at
    // once, and wherever they overlap, between them they change the picture under 0.1 per 100 ms.
    const share = soft ? dt / soft : 0;
    this.dim = stepDim(this.dim, dimTarget, share, this.dimRate);
    for (const f of this.flashes) {
      if (!f.soft) continue;
      // A glow on its own goes up in half its length and down in the other half.
      const pace = (2 * dt) / softGlowMs(f);
      const d = f.intensity > 0 ? Math.min(pace, (SOFT_GLOW_RATE * share) / f.intensity) : pace;
      if (f.falling) {
        f.level = Math.max(0, f.level - d);
      } else {
        f.level = Math.min(1, f.level + d);
        if (f.level >= 1) f.falling = true;
      }
    }
    const k = 1 - Math.exp(-followDt / 45);
    for (const o of this.orbs) {
      if (!o.quick && o.level !== o.target) {
        const d = o.params.intensity > 0 ? (SOFT_ORB_RATE * share) / o.params.intensity : 1;
        o.level = o.target > o.level ? Math.min(o.target, o.level + d) : Math.max(o.target, o.level - d);
      } else if (!softLights) {
        // Every flicker waits while a light changes softly (Orb.flickerClock).
        o.flickerClock += dt;
      }
      // A light on the wand stays on it until it is out, however slowly it goes.
      if (o.follow && o.state !== 'out') {
        const p = o.follow();
        if (p) {
          o.x += (p.x - o.x) * k;
          o.y += (p.y - o.y) * k;
        }
      }
      if (o.state !== 'lit' && o.level <= 0) o.state = 'out';
    }
    if (this.orbs.some((o) => o.state === 'out')) this.orbs = this.orbs.filter((o) => o.state !== 'out');
    if (this.flashes.some((f) => flashOver(f, now))) this.flashes = this.flashes.filter((f) => !flashOver(f, now));
  }

  clear(): void {
    this.orbs = [];
    this.flashes = [];
    this.dims = [];
    this.dim = 0;
  }

  /** Shade layer: the dark veil, with pools of light around each orb. */
  drawShade(ctx: CanvasRenderingContext2D, view: View, sprites: Sprites, now: number): void {
    if (this.dim <= 0.002) return;
    const w = view.pixelWidth, h = view.pixelHeight, H = view.height * view.dpr;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = this.dim;
    ctx.fillStyle = '#03050b';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-out';
    const hole = sprites.glow('#000000');
    for (const o of this.orbs) {
      const level = o.level * o.params.intensity;
      if (level <= 0.01) continue;
      const r = o.params.radius * H * 7;
      ctx.globalAlpha = Math.min(1, 0.92 * level);
      ctx.drawImage(hole, view.px(o.x) - r, view.py(o.y) - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /** Light layer: orbs and flashes (additive). */
  drawLight(ctx: CanvasRenderingContext2D, view: View, sprites: Sprites, now: number, reducedMotion: boolean): void {
    const H = view.height * view.dpr;
    ctx.globalCompositeOperation = 'lighter';
    for (const o of this.orbs) {
      const level = o.level;
      if (level <= 0.005) continue;
      // A quick snuff shrinks and flares as it goes (a counted flash); a soft one only dims.
      const snuffing = o.state === 'snuffing' && o.quick;
      const shrink = snuffing ? Math.max(0, 1 - (now - o.stateAt) / ORB_SNUFF_MS) : 1;
      // The only ambient motion allowed is a candle's flicker (Section 10.6); a lit tip is one.
      const t = o.flickerClock;
      const flicker = reducedMotion ? 1 : 1 + FLICKER_A * Math.sin(t * 0.0091) + FLICKER_B * Math.sin(t * 0.0137 + 1.3);
      const flare = snuffing ? 1 + 0.5 * shrink : 1;
      const I = o.params.intensity * level * flicker;
      const R = o.params.radius * H * o.size * (snuffing ? 0.3 + 0.7 * shrink : 1);
      const x = view.px(o.x), y = view.py(o.y);
      if (R <= 0.5) continue;
      // Soft rays, as a bright point of light throws in a lens. They hold still (they move only
      // with the tip) and breathe with the flicker: Section 10.6 allows no ambient motion but a
      // candle's flicker, and a lit tip is one. The sprite is drawn pre-turned a little so its
      // longest spokes are not exactly vertical.
      const rays = sprites.rays(o.params.color);
      const raySize = R * 9.5;
      ctx.globalAlpha = Math.min(1, RAYS * I * (reducedMotion ? 1 : 0.92 + 1.6 * (flicker - 1)));
      ctx.drawImage(rays, x - raySize / 2, y - raySize / 2, raySize, raySize);
      const glow = sprites.glow(o.params.color);
      ctx.globalAlpha = Math.min(1, HALO * I);
      ctx.drawImage(glow, x - R * 5, y - R * 5, R * 10, R * 10);
      ctx.globalAlpha = Math.min(1, GLOW * I * flare);
      ctx.drawImage(glow, x - R * 2, y - R * 2, R * 4, R * 4);
      const white = sprites.glow('#FFFFFF');
      ctx.globalAlpha = Math.min(1, CORE * I * flare);
      ctx.drawImage(white, x - R * 0.9, y - R * 0.9, R * 1.8, R * 1.8);
    }
    for (const f of this.flashes) {
      const e = flashEnvelope(f, now);
      if (e <= 0.005) continue;
      const R = f.radius * H;
      ctx.globalAlpha = Math.min(1, f.intensity * e);
      // A flash is a disc of light with a soft edge (Sprites.flash): its peak is `intensity` and it
      // ends at `radius`, so the caps in limits.ts are exactly what shows. A soft (over-budget)
      // flash uses the ordinary glow, which is dimmer away from its centre.
      const sprite = f.soft ? sprites.glow(f.color) : sprites.flash(f.color);
      ctx.drawImage(sprite, view.px(f.x) - R, view.py(f.y) - R, R * 2, R * 2);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}
