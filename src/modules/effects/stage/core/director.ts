// The director runs a spell's effect steps (Section 7.8 "Effects are data") and keeps the books:
// what each cast started, what is still going, and when each effect.start gets its effect.end.
//
// It knows nothing about drawing. Each `use` maps to a StepDef: prepare() applies effectScale and
// the safety limits (limits.ts), run() starts the picture and returns an Ongoing handle for
// anything that lasts. That split keeps the bookkeeping testable in Node.
//
// Rules it follows (contracts/effects.ts WHO PLAYS WHAT and ENDING):
//  - Steps run in pack order at bloom + delay_ms, where bloom is the moment 'spell.cast' arrived
//    plus CAST_SEQUENCE.bloomDelayMs (reducedMotionBloomDelayMs under reduced motion).
//  - 'audio.*' steps belong to the audio module and are skipped here.
//  - A spell with no steps left plays the built-in fallback, 'fallback:sparkle' (Section 9.1 rule 3).
//  - Instant steps get effect.end straight after effect.start; timed and held ones when they finish.
//  - 'spell.ended' ends what that cast started. A held step whose ending cast has a step acting on
//    the same thing (light.snuff for an orb or a dim, prop.douse for a fire, prop.mend for a break)
//    is released by that step at its delay, so Nox's snuff does the job; otherwise it ends at once.
//  - effects.end (scope all) ends every ongoing effect of earlier casts, but not the current cast's.

import type { EffectEvent, EffectStep, SpellbookEntry, SpellCast, SpellEnded } from '../../../../contracts';
import { CAST_SEQUENCE, EFFECT_LIMITS } from '../../../../contracts';
import { logger } from '../../../../kernel';
import type { PrepareContext } from './limits';

const log = logger('stage');

export type EndReason = NonNullable<EffectEvent['reason']>;

/** What an ongoing effect acts on, so a later cast's step can release it. */
export type Acts = 'light' | 'dim' | 'fire' | 'break';

/** The step uses that release a held effect acting on each thing (contracts/effects.ts ENDING). */
const RELEASED_BY: Record<Acts, readonly string[]> = {
  light: ['light.snuff'],
  dim: ['light.snuff'],
  fire: ['prop.douse'],
  break: ['prop.mend'],
};

export const FALLBACK_USE = 'fallback:sparkle';

/** A running effect, as the director sees it. */
export interface Ongoing {
  /** Runs until its spell ends (spell.ended) or effects.end; has no natural end. */
  readonly held: boolean;
  /** Natural length of a timed effect (reported as effect.start durationMs). */
  readonly durationMs?: number;
  readonly acts?: Acts;
  /** The prop a prop.* action runs on. */
  readonly propId?: string;
  /** A follow-the-tip action: while it runs the stage publishes 'stage.steering'. */
  readonly steering?: boolean;
  /** Polled every tick: true once it has finished on its own. */
  finished(now: number): boolean;
  /** End it now (the picture fades out on its own). */
  stop(reason: EndReason): void;
}

export interface RunContext {
  cast: SpellCast;
  entry: SpellbookEntry | null;
  step: EffectStep;
  index: number;
  /** The prepared params; runners may annotate them (e.g. a flash that was softened). */
  params: Record<string, unknown>;
  scale: number;
  now: number;
  /** For effects that finish on their own and want their effect.end out at once (PropAction.done). */
  done(): void;
}

export interface StepDef {
  prepare(step: EffectStep, ctx: PrepareContext): object;
  /** Start the effect. Return null for an instant step. */
  run(ctx: RunContext): Ongoing | null;
}

export interface DirectorEnv {
  now(): number;
  reducedMotion(): boolean;
  entry(spellId: string): SpellbookEntry | null;
  emit(type: 'effect.start' | 'effect.end', payload: EffectEvent): void;
  /** Implemented step uses. */
  steps: Readonly<Record<string, StepDef>>;
  /** The built-in sparkle for a spell with no steps. Returns the params it ran with. */
  fallback(cast: SpellCast): Record<string, unknown>;
  schedule(at: number, fn: () => void): () => void;
  /** The steering cast changed (null: nothing steers). */
  onSteering(castId: string | null, spellId?: string): void;
}

interface PlannedStep {
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
  bloomAt: number;
  steps: PlannedStep[];
  ended: boolean;
}

export interface Active {
  id: string;
  castId: string;
  spellId: string;
  use: string;
  step: number;
  params: Record<string, unknown>;
  ongoing: Ongoing;
  startedAt: number;
  castT0: number;
  /** Released by that cast's step instead of ending at once. */
  releaseBy?: { castId: string; index: number };
  ended: boolean;
}

/** Plans are kept this long after their last activity, for spell.ended lookups. */
const PLAN_KEEP_MS = 15_000;

export class Director {
  private plans = new Map<string, Plan>();
  private actives: Active[] = [];
  private steeringKey: string | null = null;
  private sweptAt = -Infinity;

  constructor(private readonly env: DirectorEnv) {}

  /** Plan and schedule a cast's steps. Returns the bloom time. */
  onCast(cast: SpellCast): number {
    const now = this.env.now();
    const reduced = this.env.reducedMotion();
    const bloomAt = now + (reduced ? CAST_SEQUENCE.reducedMotionBloomDelayMs : CAST_SEQUENCE.bloomDelayMs);
    const entry = this.env.entry(cast.spellId);
    const plan: Plan = { cast, entry, t0: now, bloomAt, steps: [], ended: false };
    this.plans.set(cast.id, plan);

    const steps = Array.isArray(entry?.spell.effect?.steps) ? entry!.spell.effect.steps : [];
    if (!entry || steps.length === 0) {
      // Section 9.1 rule 3: nothing left to run, so the fallback plays. 'sparkle' is the only
      // built-in fallback (FALLBACK_EFFECTS); any other name falls back to it too.
      this.plan(plan, { index: -1, step: { use: FALLBACK_USE }, use: FALLBACK_USE, at: bloomAt });
      return bloomAt;
    }
    steps.forEach((step, index) => {
      if (!step || typeof step.use !== 'string') return;
      if (step.use.startsWith('audio.')) return; // the audio module plays these
      if (!this.env.steps[step.use]) return; // some other effect module's step
      const delay = typeof step.delay_ms === 'number' && Number.isFinite(step.delay_ms) ? step.delay_ms : 0;
      const at = bloomAt + Math.min(EFFECT_LIMITS.maxStepMs, Math.max(0, delay));
      this.plan(plan, { index, step, use: step.use, at });
    });
    return bloomAt;
  }

  /** 'spell.ended': end what that cast started, or hand held effects to the ending cast's step. */
  onEnded(ended: SpellEnded): void {
    const plan = this.plans.get(ended.castId);
    if (plan) {
      plan.ended = true;
      for (const ps of plan.steps) this.cancelStep(ps);
    }
    const by = ended.byCastId ? this.plans.get(ended.byCastId) : undefined;
    for (const a of this.actives.filter((x) => x.castId === ended.castId && !x.ended)) {
      const releaser = by && by.cast.id !== ended.castId ? this.findReleaser(by, a) : null;
      if (releaser) a.releaseBy = { castId: by!.cast.id, index: releaser.index };
      else this.end(a, 'spell-ended', false);
    }
  }

  /**
   * End every ongoing effect except the current cast's (effects.end scope 'all', or stage.reset),
   * and cancel steps not yet started by casts made before it.
   */
  endAll(exceptCastId: string | null, reason: EndReason): void {
    const current = exceptCastId ? this.plans.get(exceptCastId) : undefined;
    const before = current ? current.t0 : Infinity;
    for (const plan of this.plans.values()) {
      if (plan.cast.id === exceptCastId || plan.t0 > before) continue;
      for (const ps of plan.steps) this.cancelStep(ps);
    }
    for (const a of [...this.actives]) {
      if (a.ended || a.castId === exceptCastId || a.castT0 > before) continue;
      this.end(a, reason, false);
    }
  }

  /** End the ongoing effects that match (stage.reset ends prop actions this way). */
  endWhere(match: (a: Active) => boolean, reason: EndReason): void {
    for (const a of [...this.actives]) if (!a.ended && match(a)) this.end(a, reason, false);
  }

  /** Finish ongoing effects that ended on their own; release orphans; drop old plans. */
  tick(now: number): void {
    if (this.actives.length) {
      // A copy: ending one effect publishes effect.end, and a listener may end others in response.
      for (const a of [...this.actives]) {
        if (a.ended) continue;
        if (a.ongoing.finished(now)) this.end(a, 'done', true);
        else if (!a.ongoing.held && now - a.startedAt > EFFECT_LIMITS.maxStepMs) this.end(a, 'done', false);
        else if (a.releaseBy && !this.isPending(a.releaseBy)) this.end(a, 'spell-ended', false);
      }
    }
    // Old plans go about once a second; nothing depends on them leaving sooner.
    if (now - this.sweptAt < 1000) return;
    this.sweptAt = now;
    for (const [id, plan] of this.plans) {
      if (now - plan.t0 < PLAN_KEEP_MS) continue;
      if (plan.steps.some((s) => s.state === 'pending')) continue;
      if (this.actives.some((a) => a.castId === id || a.releaseBy?.castId === id)) continue;
      this.plans.delete(id);
    }
  }

  /** Stop everything (module stop). */
  clear(reason: EndReason): void {
    for (const plan of this.plans.values()) for (const ps of plan.steps) this.cancelStep(ps);
    for (const a of [...this.actives]) if (!a.ended) this.end(a, reason, false);
    this.plans.clear();
  }

  /** Ongoing effects of a cast (or all). */
  ongoing(castId?: string): readonly Active[] {
    return castId ? this.actives.filter((a) => a.castId === castId) : this.actives;
  }

  /** True while a cast has steps waiting or effects running. */
  busy(castId: string): boolean {
    const plan = this.plans.get(castId);
    return !!plan?.steps.some((s) => s.state === 'pending') || this.actives.some((a) => a.castId === castId);
  }

  bloomOf(castId: string): number | undefined {
    return this.plans.get(castId)?.bloomAt;
  }

  // ---------------------------------------------------------------- internals

  private plan(plan: Plan, s: Omit<PlannedStep, 'state' | 'cancel'>): void {
    const ps: PlannedStep = { ...s, state: 'pending', cancel: () => {} };
    ps.cancel = this.env.schedule(s.at, () => this.runStep(plan, ps));
    plan.steps.push(ps);
  }

  private cancelStep(ps: PlannedStep): void {
    if (ps.state !== 'pending') return;
    ps.state = 'cancelled';
    ps.cancel();
  }

  private isPending(ref: { castId: string; index: number }): boolean {
    return !!this.plans.get(ref.castId)?.steps.some((s) => s.index === ref.index && s.state === 'pending');
  }

  private findReleaser(by: Plan, a: Active): PlannedStep | null {
    // A recast of the same spell (the engine ends the earlier cast with by = the same spell id) hands
    // each held effect over to the new cast's step of the same use, on the same prop for prop actions:
    // the new step runs first, then releases the old one, so a second Lumos or an Incendio on a lit
    // candle never blinks out before the new cast blooms.
    if (by.cast.spellId === a.spellId && by.cast.id !== a.castId) {
      const same = by.steps.find((ps) => ps.state === 'pending' && ps.use === a.use && (!a.ongoing.propId || by.cast.targetId === a.ongoing.propId));
      if (same) return same;
    }
    const acts = a.ongoing.acts;
    if (!acts) return null;
    const uses = RELEASED_BY[acts];
    return (
      by.steps.find((ps) => {
        if (ps.state !== 'pending' || !uses.includes(ps.use)) return false;
        if (ps.use === 'light.snuff') return typeof ps.step.spell !== 'string' || ps.step.spell === a.spellId;
        if (ps.use === 'prop.douse') return ps.step.all === true || by.cast.targetId === a.ongoing.propId;
        if (ps.use === 'prop.mend') return by.cast.targetId === a.ongoing.propId;
        return true;
      }) ?? null
    );
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

  private runStep(plan: Plan, ps: PlannedStep): void {
    if (ps.state !== 'pending') return;
    ps.state = 'done';
    if (plan.ended) return;
    const now = this.env.now();

    if (ps.use === FALLBACK_USE) {
      const params = this.env.fallback(plan.cast);
      this.env.emit('effect.start', this.event(plan, ps, { params, durationMs: 0 }));
      this.env.emit('effect.end', this.event(plan, ps, { params, durationMs: 0, reason: 'done' }));
      return;
    }

    const def = this.env.steps[ps.use];
    const scale = typeof plan.cast.effectScale === 'number' && plan.cast.effectScale > 0 ? plan.cast.effectScale : 1;
    let params: Record<string, unknown>;
    try {
      params = { ...def.prepare(ps.step, { scale, reducedMotion: this.env.reducedMotion(), lasts: plan.entry?.lasts ?? null }) };
    } catch (err) {
      log.warn(`could not prepare ${ps.use}`, err);
      return;
    }

    let active: Active | null = null;
    let doneEarly = false;
    let ongoing: Ongoing | null = null;
    try {
      ongoing = def.run({
        cast: plan.cast, entry: plan.entry, step: ps.step, index: ps.index, params, scale, now,
        done: () => {
          if (active) this.end(active, 'done', true);
          else doneEarly = true;
        },
      });
    } catch (err) {
      log.warn(`effect ${ps.use} failed`, err);
      ongoing = null;
    }

    const durationMs = ongoing ? (ongoing.held ? undefined : ongoing.durationMs) : 0;
    this.env.emit('effect.start', this.event(plan, ps, { params, ...(durationMs !== undefined ? { durationMs } : {}) }));
    if (!ongoing || doneEarly) {
      this.env.emit('effect.end', this.event(plan, ps, { params, ...(durationMs !== undefined ? { durationMs } : {}), reason: 'done' }));
    } else {
      active = {
        id: `${plan.cast.id}#${ps.index}`, castId: plan.cast.id, spellId: plan.cast.spellId, use: ps.use, step: ps.index,
        params, ongoing, startedAt: now, castT0: plan.t0, ended: false,
      };
      this.actives.push(active);
      if (ongoing.steering) this.updateSteering();
    }
    // Held effects of other casts that this step was to release (Nox's snuff puts out Lumos).
    for (const a of [...this.actives]) {
      if (a.releaseBy && a.releaseBy.castId === plan.cast.id && a.releaseBy.index === ps.index) this.end(a, 'spell-ended', false);
    }
  }

  private end(a: Active, reason: EndReason, natural: boolean): void {
    if (a.ended) return;
    a.ended = true;
    if (!natural) {
      try {
        a.ongoing.stop(reason);
      } catch (err) {
        log.warn(`could not stop ${a.use}`, err);
      }
    }
    const i = this.actives.indexOf(a);
    if (i >= 0) this.actives.splice(i, 1);
    const durationMs = a.ongoing.held ? undefined : a.ongoing.durationMs;
    const payload: EffectEvent = {
      spellId: a.spellId, castId: a.castId, use: a.use, t: this.env.now(), id: a.id, step: a.step, params: a.params,
      ...(durationMs !== undefined ? { durationMs } : {}), reason,
    };
    this.env.emit('effect.end', payload);
    if (a.ongoing.steering) this.updateSteering();
  }

  private updateSteering(): void {
    const steering = [...this.actives].reverse().find((a) => a.ongoing.steering && !a.ended);
    const key = steering ? steering.castId : null;
    if (key === this.steeringKey) return;
    this.steeringKey = key;
    this.env.onSteering(key, steering?.spellId);
  }
}
