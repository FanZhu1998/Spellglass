// The sound half of a cast: runs a spell's audio.cue and audio.muffle steps and keeps the books, the
// way the stage's director does for pictures (effects/stage/core/director.ts), so picture and sound
// follow the same rules (contracts/effects.ts WHO PLAYS WHAT and ENDING):
//  - Steps run in pack order at bloom + delay_ms. The bloom is the moment 'spell.cast' arrived plus
//    CAST_SEQUENCE.bloomDelayMs (reducedMotionBloomDelayMs under reduced motion), so a cue lands with
//    its picture. Delays are capped at EFFECT_LIMITS.maxStepMs.
//  - A spell with no steps at all plays the built-in fallback: the audio module's part of 'sparkle'
//    is a chime, published as effect.start with use 'fallback:sparkle' (step -1).
//  - effect.start when a step starts; effect.end when it finishes ('done'), when its spell ends
//    ('spell-ended'), on effects.end scope 'all' ('effects-end'), or when the module stops ('reset').
//  - 'spell.ended' ends what that cast started. A muffle whose ending cast has its own audio.muffle
//    step is handed over to that step at its delay (Muffliato cast again stays muffled throughout),
//    and a held cue of a spell cast again is handed to the new cast's step playing the same cue, so
//    a second cast never drops out (ENDING: "A recast of the same spell hands each held step over").
//  - effects.end (scope all) ends the ongoing sound of every earlier cast, not the current cast's
//    and not casts made after it.
//
// It knows nothing about Web Audio: `play` and `muffle` come from the module, so this is tested in
// Node with a stand-in player.

import type { AudioCue, EffectEvent, EffectStep, SpellbookEntry, SpellCast, SpellEnded } from '../../../contracts';
import { EFFECT_LIMITS } from '../../../contracts';
import { logger } from '../../../kernel';

const log = logger('audio');

export type EndReason = NonNullable<EffectEvent['reason']>;

export const FALLBACK_USE = 'fallback:sparkle';
/** A muffle step with neither hold nor a duration, on a spell that does not last: this long. */
export const DEFAULT_MUFFLE_MS = 5000;
/** A step's gain is a multiplier; this is the most it may ask for. */
export const MAX_STEP_GAIN = 2;
/** Detune, cents, either way. */
export const MAX_DETUNE = 1200;
/** Held or timed cues repeat; never faster than this. */
const MIN_REPEAT_MS = 400;
/** Fade when a sound is cut short. */
const CUT_FADE_MS = 150;
/** Plans are kept this long after their cast, for spell.ended lookups. */
const PLAN_KEEP_MS = 15_000;

/** One cue as the module played it. */
export interface CuePlayback {
  /** The cue that sounds: unknown names play 'chime'. */
  played: AudioCue;
  durationMs: number;
  /** Nothing could be heard (no audio, or the context is suspended); the caption still went out. */
  silent: boolean;
  /** Fade it out now. */
  stop(fadeMs?: number): void;
}

export interface AudioDirectorEnv {
  now(): number;
  bloomDelayMs(): number;
  entry(spellId: string): SpellbookEntry | null;
  emit(type: 'effect.start' | 'effect.end', payload: EffectEvent): void;
  schedule(at: number, fn: () => void): () => void;
  /** Play a cue now (and caption it). */
  play(cue: string, opts: { gain: number; detune: number; scale: number }): CuePlayback;
  /** Close (true) or open the muffle on the master bus. The director counts muffles. */
  muffle(on: boolean): void;
}

/** audio.cue params after the cast's effectScale and the limits (what effect.start reports). */
export interface CueParams {
  cue: string;
  gain: number;
  detune: number;
  hold: boolean;
  duration_ms?: number;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** effectScale 1.6 (Lumos Maxima) sounds louder but not 1.6 times: loudness follows the square root. */
export function scaleGain(scale: number): number {
  return Math.sqrt(clamp(Number.isFinite(scale) ? scale : 1, 0.25, 2.5));
}

/** Holds and decays stretch a little with effectScale (synth.ts applies it). */
export function timeScaleFor(scale: number): number {
  return clamp(1 + 0.3 * ((Number.isFinite(scale) ? scale : 1) - 1), 0.8, 1.5);
}

/** The cue an audio.cue step asks for. */
function cueOf(step: EffectStep): string {
  return typeof step.cue === 'string' ? step.cue : 'chime';
}

export function prepareCue(step: EffectStep, scale: number): CueParams {
  const gain = clamp(num(step.gain) ?? 1, 0, MAX_STEP_GAIN) * scaleGain(scale);
  const detune = clamp(num(step.detune) ?? 0, -MAX_DETUNE, MAX_DETUNE);
  const duration = num(step.duration_ms);
  const params: CueParams = { cue: cueOf(step), gain: Math.round(gain * 1000) / 1000, detune, hold: step.hold === true };
  if (!params.hold && duration !== undefined && duration > 0) params.duration_ms = clamp(duration, 50, EFFECT_LIMITS.maxStepMs);
  return params;
}

interface Planned {
  index: number;
  step: EffectStep;
  use: string;
  at: number;
  state: 'pending' | 'done' | 'cancelled';
  cancel: () => void;
}

interface Plan {
  cast: SpellCast;
  entry: SpellbookEntry | null;
  t0: number;
  /** Order of arrival. "Earlier than Finite" is decided by this, not by time: two casts can share a
   *  timestamp, but one always arrived first. */
  seq: number;
  bloomAt: number;
  steps: Planned[];
  ended: boolean;
}

interface Active {
  id: string;
  castId: string;
  spellId: string;
  use: string;
  index: number;
  params: Record<string, unknown>;
  held: boolean;
  durationMs?: number;
  castSeq: number;
  ended: boolean;
  isMuffle: boolean;
  /** The cue its step asked for (audio.cue), to find the same cue in a recast. */
  cue?: string;
  /** Called once when it ends; natural: it finished by itself (nothing to cut). */
  finish(natural: boolean): void;
  releaseBy?: { castId: string; index: number };
}

export class AudioDirector {
  private plans = new Map<string, Plan>();
  private actives: Active[] = [];
  private muffles = 0;
  private casts = 0;

  constructor(private readonly env: AudioDirectorEnv) {}

  /** spell.cast: plan its sound steps from the bloom. */
  onCast(cast: SpellCast): void {
    if (!cast || typeof cast.id !== 'string' || typeof cast.spellId !== 'string') return;
    const now = this.env.now();
    this.prune(now);
    const bloomAt = now + Math.max(0, this.env.bloomDelayMs());
    const entry = this.env.entry(cast.spellId);
    const plan: Plan = { cast, entry, t0: now, seq: ++this.casts, bloomAt, steps: [], ended: false };
    this.plans.set(cast.id, plan);
    const steps = Array.isArray(entry?.spell?.effect?.steps) ? entry!.spell.effect.steps : [];
    if (!entry || steps.length === 0) {
      // Section 9.1 rule 3: nothing left to run, so the fallback plays (the stage sparkles).
      this.plan(plan, { index: -1, step: { use: FALLBACK_USE }, use: FALLBACK_USE, at: bloomAt });
      return;
    }
    steps.forEach((step, index) => {
      if (!step || (step.use !== 'audio.cue' && step.use !== 'audio.muffle')) return;
      const delay = num(step.delay_ms) ?? 0;
      this.plan(plan, { index, step, use: step.use, at: bloomAt + clamp(delay, 0, EFFECT_LIMITS.maxStepMs) });
    });
  }

  /** spell.ended: end what that cast started, or hand it to the ending cast's step that takes it over. */
  onEnded(ended: SpellEnded): void {
    if (!ended || typeof ended.castId !== 'string') return;
    const plan = this.plans.get(ended.castId);
    if (plan) {
      plan.ended = true;
      for (const ps of plan.steps) this.cancelStep(ps);
    }
    const by = ended.byCastId ? this.plans.get(ended.byCastId) : undefined;
    for (const a of this.actives.filter((x) => x.castId === ended.castId && !x.ended)) {
      const releaser = by && by.cast.id !== ended.castId ? this.findReleaser(by, a) : undefined;
      if (releaser) a.releaseBy = { castId: by!.cast.id, index: releaser.index };
      else this.end(a, 'spell-ended', false);
    }
  }

  /** The step of the ending cast `by` that takes `a` over when it runs (it then ends `a`, or ends it
   *  at once if that step is cancelled): any audio.muffle for a muffle; for a held cue, when the
   *  same spell is cast again, its step playing the same cue (the stage's director does the same). */
  private findReleaser(by: Plan, a: Active): Planned | undefined {
    if (a.isMuffle) return by.steps.find((s) => s.state === 'pending' && s.use === 'audio.muffle');
    if (!a.held || by.cast.spellId !== a.spellId) return undefined;
    return by.steps.find((s) => s.state === 'pending' && s.use === a.use && cueOf(s.step) === a.cue);
  }

  /** effects.end scope 'all' from cast `exceptCastId`: end every earlier cast's sound. A cast this
   *  module never saw counts as the newest: everything known so far ends. */
  endAll(exceptCastId: string | null, reason: EndReason): void {
    const current = exceptCastId ? this.plans.get(exceptCastId) : undefined;
    const before = current ? current.seq : Infinity;
    for (const plan of this.plans.values()) {
      if (plan.cast.id === exceptCastId || plan.seq > before) continue;
      for (const ps of plan.steps) this.cancelStep(ps);
    }
    for (const a of [...this.actives]) {
      if (a.ended || a.castId === exceptCastId || a.castSeq > before) continue;
      this.end(a, reason, false);
    }
  }

  /** Stop everything (the module stops). */
  clear(reason: EndReason): void {
    for (const plan of this.plans.values()) for (const ps of plan.steps) this.cancelStep(ps);
    for (const a of [...this.actives]) if (!a.ended) this.end(a, reason, false);
    this.plans.clear();
  }

  /** Muffles in force. */
  get muffleCount(): number {
    return this.muffles;
  }

  // ---------------------------------------------------------------- internals

  private plan(plan: Plan, s: Omit<Planned, 'state' | 'cancel'>): void {
    const ps: Planned = { ...s, state: 'pending', cancel: () => {} };
    ps.cancel = this.env.schedule(s.at, () => this.runStep(plan, ps));
    plan.steps.push(ps);
  }

  private cancelStep(ps: Planned): void {
    if (ps.state !== 'pending') return;
    ps.state = 'cancelled';
    ps.cancel();
    // Whatever was waiting to be handed to this step (a muffle, a held cue) ends now instead.
    for (const a of [...this.actives]) if (a.releaseBy && this.refersTo(a.releaseBy, ps)) this.end(a, 'spell-ended', false);
  }

  private refersTo(ref: { castId: string; index: number }, ps: Planned): boolean {
    const plan = this.plans.get(ref.castId);
    return !!plan && plan.steps.includes(ps) && ps.index === ref.index;
  }

  private event(plan: Plan, ps: { index: number; use: string }, extra: Partial<EffectEvent>): EffectEvent {
    return {
      spellId: plan.cast.spellId,
      castId: plan.cast.id,
      use: ps.use,
      t: this.env.now(),
      id: `${plan.cast.id}#${ps.index}`,
      step: ps.index,
      ...extra,
    };
  }

  private scale(plan: Plan): number {
    const s = plan.cast.effectScale;
    return typeof s === 'number' && s > 0 ? s : 1;
  }

  private runStep(plan: Plan, ps: Planned): void {
    if (ps.state !== 'pending') return;
    ps.state = 'done';
    if (plan.ended) return;
    try {
      if (ps.use === FALLBACK_USE) this.runFallback(plan, ps);
      else if (ps.use === 'audio.cue') this.runCue(plan, ps);
      else this.runMuffle(plan, ps);
    } catch (err) {
      log.warn(`sound step ${ps.use} failed`, err);
    }
    // What other casts handed to this step (a muffle, a held cue of the same spell) ends now.
    for (const a of [...this.actives]) {
      if (a.releaseBy && a.releaseBy.castId === plan.cast.id && a.releaseBy.index === ps.index) this.end(a, 'spell-ended', false);
    }
  }

  private runFallback(plan: Plan, ps: Planned): void {
    const playback = this.env.play('chime', { gain: 1, detune: 0, scale: this.scale(plan) });
    const params: Record<string, unknown> = { cue: playback.played, ...(playback.silent ? { silent: true } : {}) };
    this.startOneShot(plan, ps, params, playback);
  }

  private runCue(plan: Plan, ps: Planned): void {
    const scale = this.scale(plan);
    const p = prepareCue(ps.step, scale);
    const playback = this.env.play(p.cue, { gain: p.gain, detune: p.detune, scale });
    const params: Record<string, unknown> = { cue: playback.played, gain: p.gain, detune: p.detune };
    if (playback.played !== p.cue) params.requested = p.cue;
    if (p.hold) params.hold = true;
    if (p.duration_ms !== undefined) params.duration_ms = p.duration_ms;
    if (playback.silent) params.silent = true;
    if (!p.hold && p.duration_ms === undefined) {
      this.startOneShot(plan, ps, params, playback);
      return;
    }
    // Held (until the spell ends) or timed: the cue repeats until then.
    const now = this.env.now();
    let current = playback;
    let cancelRepeat: (() => void) | null = null;
    let cancelEnd: (() => void) | null = null;
    let active: Active | null = null;
    const repeat = () => {
      cancelRepeat = this.env.schedule(this.env.now() + Math.max(MIN_REPEAT_MS, current.durationMs), () => {
        if (!active || active.ended) return;
        current = this.env.play(p.cue, { gain: p.gain, detune: p.detune, scale });
        repeat();
      });
    };
    active = this.track(plan, ps, params, p.hold, p.duration_ms, false, (natural) => {
      cancelRepeat?.();
      cancelEnd?.();
      // A timed cue that reaches its time still fades: it would otherwise ring past it.
      if (!natural || p.duration_ms !== undefined) current.stop(CUT_FADE_MS);
    });
    active.cue = p.cue;
    repeat();
    if (p.duration_ms !== undefined) {
      cancelEnd = this.env.schedule(now + p.duration_ms, () => {
        if (active && !active.ended) this.end(active, 'done', true);
      });
    }
  }

  private runMuffle(plan: Plan, ps: Planned): void {
    const step = ps.step;
    const lasts = plan.entry?.lasts ?? null;
    const duration = num(step.duration_ms);
    // Section 8: "Sound is muffled until Finite". Held when the step holds, or when it says nothing
    // and the spell lasts until ended; otherwise for its duration, the spell's, or a default.
    const held = step.hold === true || (step.hold === undefined && duration === undefined && lasts === 'until-ended');
    const durationMs = held ? undefined : clamp(duration ?? (typeof lasts === 'number' ? lasts : DEFAULT_MUFFLE_MS), 100, EFFECT_LIMITS.maxStepMs);
    const params: Record<string, unknown> = { hold: held, ...(durationMs !== undefined ? { duration_ms: durationMs } : {}) };
    this.muffles++;
    if (this.muffles === 1) this.env.muffle(true);
    let cancelEnd: (() => void) | null = null;
    const active = this.track(plan, ps, params, held, durationMs, true, () => {
      cancelEnd?.();
      this.muffles = Math.max(0, this.muffles - 1);
      if (this.muffles === 0) this.env.muffle(false);
    });
    if (durationMs !== undefined) {
      cancelEnd = this.env.schedule(this.env.now() + durationMs, () => {
        if (!active.ended) this.end(active, 'done', true);
      });
    }
  }

  /** A cue that plays once: effect.end when it has finished sounding. */
  private startOneShot(plan: Plan, ps: Planned, params: Record<string, unknown>, playback: CuePlayback): void {
    let cancelEnd: (() => void) | null = null;
    const active = this.track(plan, ps, params, false, playback.durationMs, false, (natural) => {
      cancelEnd?.();
      if (!natural) playback.stop(CUT_FADE_MS);
    });
    cancelEnd = this.env.schedule(this.env.now() + playback.durationMs, () => {
      if (!active.ended) this.end(active, 'done', true);
    });
  }

  /** Record an ongoing step and publish its effect.start. */
  private track(
    plan: Plan, ps: Planned, params: Record<string, unknown>, held: boolean, durationMs: number | undefined, isMuffle: boolean,
    finish: (natural: boolean) => void,
  ): Active {
    const active: Active = {
      id: `${plan.cast.id}#${ps.index}`, castId: plan.cast.id, spellId: plan.cast.spellId, use: ps.use, index: ps.index,
      params, held, durationMs: held ? undefined : durationMs, castSeq: plan.seq, ended: false, isMuffle, finish,
    };
    this.actives.push(active);
    this.env.emit('effect.start', this.event(plan, ps, { params, ...(active.durationMs !== undefined ? { durationMs: active.durationMs } : {}) }));
    return active;
  }

  private end(a: Active, reason: EndReason, natural: boolean): void {
    if (a.ended) return;
    a.ended = true;
    try {
      a.finish(natural);
    } catch (err) {
      log.warn(`could not stop ${a.use}`, err);
    }
    const i = this.actives.indexOf(a);
    if (i >= 0) this.actives.splice(i, 1);
    this.env.emit('effect.end', {
      spellId: a.spellId, castId: a.castId, use: a.use, t: this.env.now(), id: a.id, step: a.index, params: a.params,
      ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}), reason,
    });
  }

  private prune(now: number): void {
    for (const [id, plan] of this.plans) {
      if (now - plan.t0 < PLAN_KEEP_MS) continue;
      if (plan.steps.some((s) => s.state === 'pending')) continue;
      if (this.actives.some((a) => a.castId === id || a.releaseBy?.castId === id)) continue;
      this.plans.delete(id);
    }
  }
}
