// Safety and access limits (Section 10.6, 11.3), enforced here for every pack, imported ones
// included. Each step's params are first multiplied by the cast's effectScale (Lumos Maxima 1.6)
// and then clamped to EFFECT_LIMITS (contracts/effects.ts: "applied after effectScale").
//
// The prepared objects keep the pack's param names (radius, duration_ms, ...) because they are
// also what effect.start reports as `params`: "the step as run, after limits".

import type { Anchor, EffectStep, ParticlePreset } from '../../../../contracts';
import { EFFECT_LIMITS, PARTICLE_PRESETS } from '../../../../contracts';
import { isColor, isSaturatedRed, parseColor } from './color';

type Limits = typeof EFFECT_LIMITS;

// ------------------------------------------------------------------ flash budget

/**
 * The shared flash budget: light.flash, bright bolts and quick changes in an orb's light (an orb
 * blooming or going out, light.ts) draw from one rolling budget of EFFECT_LIMITS.flashesPerSecond
 * per flashWindowMs, and at most one flash shows at a time (maxConcurrentFlashes is 1).
 *
 * A request that arrives while a flash is showing waits for it to finish when that is soon
 * (Stupefy's flash follows its bolt by 160 ms); otherwise, or when the budget is spent, it is
 * refused and the caller shows a soft glow instead, which is not a flash.
 *
 * Dimming never draws from the budget: scene.dim is rate-limited below 0.1 per 100 ms
 * (see MAX_DIM_RATE_PER_MS), so it never counts as a flash. Nor does an orb that changes softly, or
 * the soft glow of a refused flash: all of them share that rate between them (light.ts
 * LightLayer.update), so together they stay under it too.
 */
export class FlashLimiter {
  private starts: number[] = [];
  private busyUntil = -Infinity;

  constructor(private readonly limits: Pick<Limits, 'flashesPerSecond' | 'flashWindowMs'> = EFFECT_LIMITS) {}

  /** Returns when the flash may start (now, or a little later), or null when it must not flash. */
  request(now: number, durationMs: number, maxWaitMs = 120): number | null {
    const at = Math.max(now, this.busyUntil);
    if (at - now > maxWaitMs) return null;
    const windowStart = at - this.limits.flashWindowMs;
    // Starts are monotonic (each starts after the previous one ended), so counting the window that
    // ends at `at` is enough to keep every rolling window within budget.
    while (this.starts.length && this.starts[0] <= windowStart) this.starts.shift();
    if (this.starts.length >= this.limits.flashesPerSecond) return null;
    this.starts.push(at);
    this.busyUntil = at + Math.max(0, durationMs);
    return at;
  }

  /**
   * A quick change in steady light: an orb blooming or going out. It counts against the budget like
   * a flash, but it never waits and holds no other flash back (an orb's bloom is gentler than a
   * flash, and Lumos then Stupefy should keep its bright bolt). Refused while a flash is showing or
   * when the budget is spent: the caller then makes the change softly, which is not a flash.
   */
  change(now: number): boolean {
    return this.request(now, 0, 0) !== null;
  }

  /** Flashes started within the window ending at `now` (diagnostics and tests). */
  recent(now: number): number {
    return this.starts.filter((t) => t > now - this.limits.flashWindowMs && t <= now).length;
  }

  reset(): void {
    this.starts = [];
    this.busyUntil = -Infinity;
  }
}

/** Fastest the room dimming may change: 0.1 per 100 ms is where a dimming change starts to count
 *  as a flash (EFFECT_LIMITS), so stay just under it. Everything that changes softly shares this
 *  rate, the dimming included (light.ts). */
export const MAX_DIM_RATE_PER_MS = 0.0009;

/** Move the displayed dim toward its target without ever exceeding the safe rate. */
export function stepDim(current: number, target: number, dtMs: number, ratePerMs: number): number {
  const rate = Math.min(MAX_DIM_RATE_PER_MS, Math.max(1e-6, ratePerMs));
  const max = rate * Math.max(0, dtMs);
  const d = target - current;
  if (Math.abs(d) <= max) return target;
  return current + Math.sign(d) * max;
}

// ------------------------------------------------------------------ particles

/** Particle count after the reduced-motion factor (Section 10.6: "particle counts drop"). */
export function scaleParticleCount(count: number, reducedMotion: boolean, limits: Pick<Limits, 'reducedMotionParticleFactor'> = EFFECT_LIMITS): number {
  if (!(count > 0)) return 0;
  const n = reducedMotion ? count * limits.reducedMotionParticleFactor : count;
  return Math.max(1, Math.round(n));
}

/** One burst never takes more than this share of the pool, so one pack cannot starve the rest. */
export const MAX_BURST = 400;

// ------------------------------------------------------------------ text

/**
 * Lines of text for the glass. EFFECT_LIMITS.maxTextChars caps each line; longer text wraps at
 * word boundaries into at most `maxLines` lines, and what still does not fit ends with an
 * ellipsis. Interpretation: the theme's own first hidden-ink line is 43 characters, so a strict
 * 40-character total would cut it mid-sentence; wrapping keeps it whole on two short lines while
 * still bounding how much of the glass any text can cover.
 */
export function wrapText(input: string, maxChars: number = EFFECT_LIMITS.maxTextChars, maxLines = 2): string[] {
  const words = cleanText(input).split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  let i = 0;
  for (; i < words.length; i++) {
    let w = words[i];
    if (w.length > maxChars) w = w.slice(0, maxChars);
    const next = line ? `${line} ${w}` : w;
    if (next.length <= maxChars) {
      line = next;
      continue;
    }
    lines.push(line);
    line = w;
    if (lines.length === maxLines) break;
  }
  if (lines.length < maxLines && line) {
    lines.push(line);
    line = '';
    i = words.length;
  }
  if (i < words.length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = (last.length >= maxChars ? last.slice(0, maxChars - 1).trimEnd() : last) + '…';
  }
  return lines;
}

/** Collapse whitespace and drop control characters: pack strings are untrusted and drawn with fillText. */
export function cleanText(input: unknown): string {
  if (typeof input !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

// ------------------------------------------------------------------ params

const ANCHORS: readonly Anchor[] = ['tip', 'aim', 'target', 'center', 'caster'];

export function anchorOr(value: unknown, fallback: Anchor): Anchor {
  return typeof value === 'string' && (ANCHORS as readonly string[]).includes(value) ? (value as Anchor) : fallback;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function colorOr(value: unknown, fallback: string): string {
  return isColor(value) ? value.trim() : fallback;
}

/** Duration of a step that does not hold, capped at EFFECT_LIMITS.maxStepMs. */
export function stepDuration(value: unknown, fallback: number, min = 0): number {
  return clamp(num(value) ?? fallback, min, EFFECT_LIMITS.maxStepMs);
}

/** How long a step that lasts runs. A held step (hold: true) runs until its spell ends
 *  (contracts/packs.ts EffectStep.hold), so it has no duration of its own; any other gets its
 *  duration, or the default, capped. */
export function lasting(step: EffectStep, fallback: number, min: number): { hold: boolean; duration_ms?: number } {
  return step.hold === true ? { hold: true } : { hold: false, duration_ms: stepDuration(step.duration_ms, fallback, min) };
}

/** Context every preparation needs. */
export interface PrepareContext {
  /** SpellCast.effectScale, default 1. */
  scale: number;
  reducedMotion: boolean;
  /** SpellbookEntry.lasts: whether the spell stays active (so 'spell.ended' will come). */
  lasts: 'until-ended' | number | null;
}

export interface OrbParams { at: Anchor; hold: boolean; color: string; radius: number; intensity: number; duration_ms?: number }
export interface FlashParams { at: Anchor; color: string; radius: number; intensity: number; duration_ms: number; red: boolean }
export interface SnuffParams { spell?: string; smoke: boolean }
export interface DimParams { amount: number; hold: boolean; duration_ms?: number; fade_ms: number }
export interface BurstParams {
  preset: ParticlePreset; at: Anchor; count: number; speed: number; spread_deg?: number;
  direction?: 'up' | 'down' | 'aim' | 'out'; color?: string; life_ms?: number;
}
// Steps that last have `hold` and, when they do not hold, `duration_ms` (lasting()).
export interface StreamParams { preset: ParticlePreset; from: Anchor; to: Anchor; hold: boolean; duration_ms?: number; rate: number; arc: number; color?: string }
export interface ShieldParams { hold: boolean; duration_ms?: number; color: string; radius: number }
export interface BoltParams { from: Anchor; to: Anchor; color: string; width: number; jagged: boolean; red: boolean }
export interface CreatureParams { kind: 'hare'; hold: boolean; duration_ms?: number; color: string; size: number }
export interface SlowParams { factor: number; hold: boolean; duration_ms?: number; scope: 'target' | 'all'; to_stop: boolean }
/** Never held (contracts/effects.ts): short whatever a pack asks. */
export interface ShakeParams { intensity: number; duration_ms: number; px: number }
export interface EffectsEndParams { scope: 'all' | 'trails' }
export interface RevealParams { hold: boolean; duration_ms?: number }
export interface TextParams { text?: string; style: 'incantation' | 'hidden-ink'; at?: Anchor; hold: boolean; duration_ms?: number }

/** Default bolt thickness, a fraction of the mirror height; `width` multiplies it. */
export const BOLT_BASE_WIDTH = 0.008;

export const DEFAULT_ORB_COLOR = '#FFE7B3';
export const DEFAULT_FLASH_COLOR = '#FFF4DA';
export const DEFAULT_SHIELD_COLOR = '#BFE3FF';
export const DEFAULT_BOLT_COLOR = '#FFE9A8';
export const DEFAULT_CREATURE_COLOR = '#DDE8FF';

/** How long an orb takes to bloom to full brightness when the flash budget allows (light.ts). A
 *  timed orb lasts at least this long, so it never starts going out before it has bloomed. */
export const ORB_BLOOM_MS = 400;

export function prepareOrb(step: EffectStep, ctx: PrepareContext, limits: Limits = EFFECT_LIMITS): OrbParams {
  const hold = step.hold === true;
  const color = colorOr(step.color, DEFAULT_ORB_COLOR);
  // A saturated red light is kept as dim as a red flash (WCAG's red-flash rule): a quick change in an
  // orb counts as a flash (light.ts), so it obeys the same cap.
  const red = isSaturatedRed(parseColor(color, DEFAULT_ORB_COLOR));
  return {
    at: anchorOr(step.at, 'tip'),
    hold,
    color,
    // Its blooming and going out draw from the flash budget (light.ts). Kept well inside the flash
    // radius cap anyway.
    radius: clamp((num(step.radius) ?? 0.06) * ctx.scale, 0.01, 0.15),
    intensity: clamp((num(step.intensity) ?? 1) * ctx.scale, 0, red ? limits.redFlashMaxIntensity : 1),
    ...(hold ? {} : { duration_ms: stepDuration(step.duration_ms, 2000, ORB_BLOOM_MS) }),
  };
}

export function prepareFlash(step: EffectStep, ctx: PrepareContext, limits: Limits = EFFECT_LIMITS): FlashParams {
  const color = colorOr(step.color, DEFAULT_FLASH_COLOR);
  const red = isSaturatedRed(parseColor(color, DEFAULT_FLASH_COLOR));
  const maxIntensity = red ? limits.redFlashMaxIntensity : limits.flashMaxIntensity;
  return {
    at: anchorOr(step.at, 'tip'),
    color,
    radius: clamp((num(step.radius) ?? 0.2) * ctx.scale, 0.02, limits.flashMaxRadius),
    intensity: clamp((num(step.intensity) ?? 0.5) * ctx.scale, 0, maxIntensity),
    duration_ms: clamp(num(step.duration_ms) ?? 220, 80, 1000),
    red,
  };
}

export function prepareSnuff(step: EffectStep): SnuffParams {
  return { ...(typeof step.spell === 'string' ? { spell: step.spell } : {}), smoke: step.smoke !== false };
}

export function prepareDim(step: EffectStep, ctx: PrepareContext, limits: Limits = EFFECT_LIMITS): DimParams {
  const amount = clamp((num(step.amount) ?? 0.3) * ctx.scale, 0, limits.dimMax);
  const fade = Math.max(limits.dimMinFadeMs, num(step.fade_ms) ?? 450);
  const duration = num(step.duration_ms);
  // "scene.dim (amount, held until spell.ended)": a dim without a duration holds while its spell is
  // active. An instant spell never sends spell.ended, so there it gets a modest default instead.
  const hold = step.hold === true || (duration === undefined && ctx.lasts !== null);
  return { amount, hold, fade_ms: fade, ...(hold ? {} : { duration_ms: stepDuration(duration, 2500, fade) }) };
}

/** Per-preset defaults when a step leaves direction or spread out. */
export const PRESET_AIM: Record<ParticlePreset, { direction: 'up' | 'down' | 'out'; spread: number }> = {
  sparks: { direction: 'out', spread: 360 },
  embers: { direction: 'up', spread: 80 },
  water: { direction: 'up', spread: 70 },
  mist: { direction: 'out', spread: 360 },
  stars: { direction: 'out', spread: 360 },
  dust: { direction: 'out', spread: 360 },
  smoke: { direction: 'up', spread: 40 },
};

export function presetOr(value: unknown, fallback: ParticlePreset): ParticlePreset {
  return typeof value === 'string' && (PARTICLE_PRESETS as readonly string[]).includes(value) ? (value as ParticlePreset) : fallback;
}

export function prepareBurst(step: EffectStep, ctx: PrepareContext): BurstParams {
  const preset = presetOr(step.preset, 'sparks');
  const dir = step.direction;
  const raw = clamp((num(step.count) ?? 24) * ctx.scale, 0, MAX_BURST);
  return {
    preset,
    at: anchorOr(step.at, 'tip'),
    count: Math.min(MAX_BURST, scaleParticleCount(raw, ctx.reducedMotion)),
    speed: clamp(num(step.speed) ?? 1, 0.1, 3),
    ...(num(step.spread_deg) !== undefined ? { spread_deg: clamp(num(step.spread_deg)!, 0, 360) } : {}),
    ...(dir === 'up' || dir === 'down' || dir === 'aim' || dir === 'out' ? { direction: dir } : {}),
    ...(isColor(step.color) ? { color: step.color.trim() } : {}),
    ...(num(step.life_ms) !== undefined ? { life_ms: clamp(num(step.life_ms)!, 100, 5000) } : {}),
  };
}

/** Particles per second when a stream step names no rate: dense enough that water reads as a stream. */
export const STREAM_RATE: Record<ParticlePreset, number> = { water: 150, stars: 45, sparks: 90, embers: 60, mist: 24, dust: 60, smoke: 20 };

export function prepareStream(step: EffectStep, ctx: PrepareContext): StreamParams {
  const preset = presetOr(step.preset, 'sparks');
  const rate = clamp((num(step.rate) ?? STREAM_RATE[preset]) * ctx.scale, 1, MAX_BURST);
  return {
    preset,
    from: anchorOr(step.from, 'tip'),
    to: anchorOr(step.to, 'target'),
    ...lasting(step, 1000, 100),
    rate: ctx.reducedMotion ? Math.max(1, rate * EFFECT_LIMITS.reducedMotionParticleFactor) : rate,
    arc: clamp(num(step.arc) ?? 0.2, -1, 1),
    ...(isColor(step.color) ? { color: step.color.trim() } : {}),
  };
}

export function prepareShield(step: EffectStep, ctx: PrepareContext): ShieldParams {
  return {
    ...lasting(step, 5000, 300),
    color: colorOr(step.color, DEFAULT_SHIELD_COLOR),
    radius: clamp((num(step.radius) ?? 0.42) * ctx.scale, 0.1, 0.6),
  };
}

export function prepareBolt(step: EffectStep, ctx: PrepareContext, limits: Limits = EFFECT_LIMITS): BoltParams {
  const color = colorOr(step.color, DEFAULT_BOLT_COLOR);
  const multiplier = clamp((num(step.width) ?? 1) * ctx.scale, 0.25, 2);
  return {
    from: anchorOr(step.from, 'tip'),
    to: anchorOr(step.to, 'target'),
    color,
    // width is a multiplier of the default thickness (contracts/effects.ts); boltMaxWidth caps the result.
    width: Math.min(limits.boltMaxWidth, BOLT_BASE_WIDTH * multiplier),
    jagged: step.jagged === true,
    red: isSaturatedRed(parseColor(color, DEFAULT_BOLT_COLOR)),
  };
}

export function prepareCreature(step: EffectStep, ctx: PrepareContext): CreatureParams {
  // 'random' picks among the creatures the stage can draw; version 1 draws one, the hare.
  return {
    kind: 'hare',
    ...lasting(step, 7000, 1000),
    color: colorOr(step.color, DEFAULT_CREATURE_COLOR),
    size: clamp(ctx.scale, 0.5, 1.6),
  };
}

export function prepareSlow(step: EffectStep): SlowParams {
  const toStop = step.to_stop === true;
  return {
    factor: toStop ? 0 : clamp(num(step.factor) ?? 0.3, 0, 1),
    ...lasting(step, 5000, 200),
    scope: step.scope === 'all' ? 'all' : 'target',
    to_stop: toStop,
  };
}

export function prepareShake(step: EffectStep, ctx: PrepareContext, limits: Limits = EFFECT_LIMITS): ShakeParams {
  // intensity is a fraction of shakeMaxPx; the shake is short, never held, and off with reduced motion.
  const intensity = ctx.reducedMotion ? 0 : clamp((num(step.intensity) ?? 0.5) * ctx.scale, 0, 1);
  return {
    intensity,
    duration_ms: clamp(num(step.duration_ms) ?? 300, 0, limits.shakeMaxMs),
    px: intensity * limits.shakeMaxPx,
  };
}

export function prepareEffectsEnd(step: EffectStep): EffectsEndParams {
  return { scope: step.scope === 'trails' ? 'trails' : 'all' };
}

export function prepareReveal(step: EffectStep): RevealParams {
  return lasting(step, 6000, 500);
}

export function prepareText(step: EffectStep): TextParams {
  const text = cleanText(step.text);
  return {
    ...(text ? { text } : {}),
    style: step.style === 'hidden-ink' ? 'hidden-ink' : 'incantation',
    ...(typeof step.at === 'string' ? { at: anchorOr(step.at, 'center') } : {}),
    ...lasting(step, 4500, 800),
  };
}
