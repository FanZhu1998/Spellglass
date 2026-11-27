// One StepDef per primitive the stage implements (contracts/effects.ts EffectParams). Each prepares
// its params (effectScale, then EFFECT_LIMITS) and starts the picture, returning an Ongoing handle
// for anything that lasts so the director can end it and send effect.end.

import type { Anchor, EffectStep, SpellCast } from '../../../../contracts';
import { EFFECT_LIMITS, PROP_TAGS } from '../../../../contracts';
import { logger } from '../../../../kernel';
import type { PropAction, PropView, StageServices } from '../types';
import { CASTER_ANCHOR, type XY } from './anchors';
import { Creature } from './creature';
import type { Director, Ongoing, RunContext, StepDef } from './director';
import type { InkLayer } from './ink';
import { type LightLayer, softGlowMs } from './light';
import {
  type BoltParams, type BurstParams, type CreatureParams, type DimParams, type EffectsEndParams, type FlashParams,
  type OrbParams, type RevealParams, type ShakeParams, type ShieldParams, type SlowParams, type SnuffParams,
  type StreamParams, type TextParams,
  PRESET_AIM, prepareBolt, prepareBurst, prepareCreature, prepareDim, prepareEffectsEnd, prepareFlash, prepareOrb,
  prepareReveal, prepareShake, prepareShield, prepareSlow, prepareSnuff, prepareStream, prepareText, scaleParticleCount,
  stepDuration, wrapText,
} from './limits';
import type { ParticleSystem } from './particles';
import type { RevealControl, ShakeControl, TimeControl } from './scene-fx';
import { Bolt, BOLT_TRAVEL_MS, Shield } from './shapes';
import { HIDDEN_INK_COLOR, HIDDEN_INK_POSITION, inscriptionSpan, type TextLayer } from './text';

const log = logger('stage');

/** What the step definitions need from the stage. */
export interface StageWorld {
  now(): number;
  reducedMotion(): boolean;
  /** Width ÷ height of caster space. */
  aspect(): number;
  /** Where an anchor is for this cast, right now. */
  at(anchor: Anchor | undefined, cast: SpellCast, fallback: Anchor): XY;
  /** The tip this cast's effects follow, or null: the replay's tip for the cast a replay is playing,
   *  the live tip for every other cast. */
  tipOf(cast: SpellCast): XY | null;
  targetOf(cast: SpellCast): PropView | null;
  props(): readonly PropView[];
  services: StageServices;
  light: LightLayer;
  particles: ParticleSystem;
  shields: Shield[];
  bolts: Bolt[];
  creatures: Creature[];
  time: TimeControl;
  shake: ShakeControl;
  reveal: RevealControl;
  text: TextLayer;
  ink: InkLayer;
  director(): Director;
  markProps(): void;
  /** A line of hidden ink from the theme (or a built-in one). */
  hiddenInkLine(): string;
  /** The theme's Candle color, with the accent applied. */
  candle(): string;
  /** A small star burst (count before the reduced-motion factor). */
  sparkle(at: XY, count: number): void;
}

/** Extra time a prop action may take past its stated duration before the stage assumes it is over. */
const PROP_GRACE_MS = 1500;

/** Follow-the-tip actions: while one runs the stage publishes 'stage.steering' and draws no ink.
 *  prop.pull counts for its whole run (the flight to the tip is short; the hover is the point). */
export function isSteering(use: string, params: Record<string, unknown>): boolean {
  return (use === 'prop.levitate' && params.follow_tip === true) || (use === 'prop.push' && params.mode === 'follow') || use === 'prop.pull' || use === 'prop.mimic';
}

/** Prop steps that last: held, timed, or a steering action. The rest end with their effect.start. */
export function isOngoingPropStep(use: string, params: Record<string, unknown>): boolean {
  return params.hold === true || typeof params.duration_ms === 'number' || typeof params.hold_ms === 'number' || isSteering(use, params) || use === 'prop.levitate';
}

/** The step as run for a prop action: its params with durations capped and steering defaults filled.
 *  A held step (hold: true) keeps running until its spell ends (contracts/packs.ts EffectStep.hold),
 *  so it has no duration of its own, neither given nor default; the props treat it as unlimited too
 *  (props/actions.ts durationOf). */
export function prepareProp(step: EffectStep): Record<string, unknown> {
  const { use, ...rest } = step;
  const out: Record<string, unknown> = { ...rest };
  if (out.hold === true) {
    delete out.duration_ms;
    delete out.hold_ms;
  } else {
    if (typeof out.duration_ms === 'number') out.duration_ms = stepDuration(out.duration_ms, 0, 0);
    if (typeof out.hold_ms === 'number') out.hold_ms = stepDuration(out.hold_ms, 0, 0);
    if (use === 'prop.levitate' && out.duration_ms === undefined) out.duration_ms = 6000;
    if (use === 'prop.push' && out.mode === 'follow' && out.duration_ms === undefined) out.duration_ms = 5000;
    if (use === 'prop.pull' && out.hold_ms === undefined) out.hold_ms = 3000;
    if (use === 'prop.mimic' && out.duration_ms === undefined) out.duration_ms = 5000;
  }
  if (use === 'prop.scale' && typeof out.factor === 'number') out.factor = Math.min(3, Math.max(0, out.factor));
  return out;
}

/** Direction and cone for a burst: 'up', 'down', 'out', or 'aim' (outward from the caster through the anchor). */
export function burstAim(p: BurstParams, at: XY, aspect: number): { directionDeg: number; spreadDeg: number } {
  const preset = PRESET_AIM[p.preset];
  const dir = p.direction ?? preset.direction;
  if (dir === 'out') return { directionDeg: -90, spreadDeg: 360 };
  const spread = p.spread_deg ?? (p.direction ? 70 : preset.spread);
  if (dir === 'up') return { directionDeg: -90, spreadDeg: spread };
  if (dir === 'down') return { directionDeg: 90, spreadDeg: spread };
  const dx = (at.x - CASTER_ANCHOR.x) * aspect, dy = at.y - CASTER_ANCHOR.y;
  if (Math.hypot(dx, dy) < 0.02) return { directionDeg: -90, spreadDeg: 360 };
  return { directionDeg: (Math.atan2(dy, dx) * 180) / Math.PI, spreadDeg: p.spread_deg ?? 60 };
}

const instant = null;

export function createStepDefs(w: StageWorld): Record<string, StepDef> {
  const defs: Record<string, StepDef> = {
    'light.orb': {
      prepare: (step, ctx) => prepareOrb(step, ctx),
      run(c) {
        const p = c.params as unknown as OrbParams;
        const at = w.at(p.at, c.cast, 'tip');
        // Held orbs at the tip follow it (a replay's own orb, the replay's tip); at a target they
        // ride along with the prop.
        const follow = p.hold && p.at === 'tip' ? () => w.tipOf(c.cast) : p.at === 'target' ? () => propPosition(w.targetOf(c.cast)) : null;
        const orb = w.light.addOrb(c.cast.id, c.cast.spellId, p, at, follow, c.now);
        // Over the flash budget it blooms softly; say so in the step as run.
        if (!orb.quick) c.params.softened = true;
        return {
          held: p.hold, durationMs: p.duration_ms, acts: 'light',
          finished: () => orb.state !== 'lit',
          stop: () => w.light.fadeOrb(orb, w.now()),
        };
      },
    },

    'light.flash': {
      prepare: (step, ctx) => prepareFlash(step, ctx),
      run(c) {
        const p = c.params as unknown as FlashParams;
        const f = w.light.addFlash(p, w.at(p.at, c.cast, 'tip'), c.now);
        if (f.soft) {
          // Over the flash budget the flash becomes a soft glow, or joins the one showing; say so in
          // the step as run. Sharing the soft allowance (light.ts) can slow a glow down, so the step
          // is over when its glow has faded out.
          c.params.softened = true;
          return { held: false, durationMs: softGlowMs(f), finished: () => !w.light.flashes.includes(f), stop: () => {} };
        }
        return { held: false, durationMs: f.duration, finished: (t) => t >= f.start + f.duration, stop: () => {} };
      },
    },

    'light.snuff': {
      prepare: (step) => prepareSnuff(step),
      run(c) {
        const p = c.params as unknown as SnuffParams;
        const out = w.light.snuff(p.spell, c.now);
        // Over the flash budget the light goes out softly.
        if (out.some((o) => !o.quick)) c.params.softened = true;
        // "Puts out light orbs with a curl of smoke"; the room comes back with them.
        for (const o of out) {
          for (const d of w.light.dims) if (d.castId === o.castId) w.light.endDim(d);
          if (p.smoke) smoke(w, { x: o.x, y: o.y - 0.01 }, 16);
        }
        if (!out.length && p.smoke) smoke(w, w.at('tip', c.cast, 'aim'), 6);
        return instant;
      },
    },

    'scene.dim': {
      prepare: (step, ctx) => prepareDim(step, ctx),
      run(c) {
        const p = c.params as unknown as DimParams;
        const d = w.light.addDim(c.cast.id, p, c.now);
        return { held: p.hold, durationMs: p.duration_ms, acts: 'dim', finished: () => !d.active, stop: () => w.light.endDim(d) };
      },
    },

    'particles.burst': {
      prepare: (step, ctx) => prepareBurst(step, ctx),
      run(c) {
        const p = c.params as unknown as BurstParams;
        const at = w.at(p.at, c.cast, 'tip');
        const aim = burstAim(p, at, w.aspect());
        w.particles.spawn({
          preset: p.preset, x: at.x, y: at.y, count: p.count, speed: p.speed, spreadDeg: aim.spreadDeg, directionDeg: aim.directionDeg,
          ...(p.color ? { color: p.color } : {}), ...(p.life_ms ? { lifeMs: p.life_ms } : {}),
          size: Math.min(1.4, Math.sqrt(c.scale)), floorY: Math.min(0.985, at.y + 0.12),
        });
        return instant;
      },
    },

    'particles.stream': {
      prepare: (step, ctx) => prepareStream(step, ctx),
      run(c) {
        const p = c.params as unknown as StreamParams;
        // A held stream flows until its spell ends.
        const handle = w.particles.addStream({
          preset: p.preset, durationMs: p.duration_ms ?? Number.POSITIVE_INFINITY, rate: p.rate, arc: p.arc, ...(p.color ? { color: p.color } : {}),
          resolve: () => ({ from: w.at(p.from, c.cast, 'tip'), to: w.at(p.to, c.cast, 'target') }),
        }, c.now);
        return { held: p.hold, durationMs: p.duration_ms, finished: (t) => handle.finished(t), stop: () => handle.stop() };
      },
    },

    'shield.dome': {
      prepare: (step, ctx) => prepareShield(step, ctx),
      run(c) {
        const p = c.params as unknown as ShieldParams;
        // Around the caster: centred a little below the head so it holds head and shoulders.
        const center = { x: CASTER_ANCHOR.x, y: CASTER_ANCHOR.y + 0.08 };
        // A ward already up is renewed, not raised again (Shield.renews): the old one goes at once
        // and the new one carries on its look, so the picture holds steady.
        const prev = w.shields.find((o) => o.renews(p, center, c.now, c.cast.spellId));
        const s = new Shield(c.cast.id, p, center, c.now, prev?.look, c.cast.spellId);
        if (prev) prev.replaced = true;
        w.shields.push(s);
        return { held: p.hold, durationMs: p.duration_ms, finished: (t) => t >= s.until || s.endedAt !== null, stop: () => s.end(w.now()) };
      },
    },

    'bolt.cast': {
      prepare: (step, ctx) => prepareBolt(step, ctx),
      run(c) {
        const p = c.params as unknown as BoltParams;
        const bright = w.light.boltFlash(p, c.now, BOLT_TRAVEL_MS);
        if (!bright) c.params.softened = true;
        const b = new Bolt(c.cast.id, p, w.at(p.from, c.cast, 'tip'), w.at(p.to, c.cast, 'target'), c.now, bright, Math.floor(w.services.random() * 1e6));
        w.bolts.push(b);
        return { held: false, durationMs: b.duration, finished: (t) => b.done(t), stop: () => {} };
      },
    },

    'creature.summon': {
      prepare: (step, ctx) => prepareCreature(step, ctx),
      run(c) {
        const p = c.params as unknown as CreatureParams;
        const creature = new Creature(c.cast.id, p, w.at('tip', c.cast, 'aim'), c.now);
        w.creatures.push(creature);
        return {
          held: p.hold, durationMs: p.duration_ms,
          // At its time it leaps away by itself (Creature.update); ended sooner, it goes then.
          finished: (t) => t >= creature.until || creature.endedAt !== null,
          stop: () => creature.end(w.now()),
        };
      },
    },

    'time.slow': {
      prepare: (step) => prepareSlow(step),
      run(c) {
        const p = c.params as unknown as SlowParams;
        let propId: string | null = null;
        if (p.scope === 'target') {
          const target = w.targetOf(c.cast);
          if (!target) {
            // Nothing to slow: a sparkle says the spell landed on nothing.
            w.sparkle(w.at('aim', c.cast, 'aim'), 10);
            c.params.sparkle = true;
            return instant;
          }
          propId = target.id;
        }
        const s = w.time.add(c.cast.id, p, propId, c.now);
        return { held: p.hold, durationMs: p.duration_ms, finished: (t) => w.time.expired(s, t), stop: () => w.time.end(s, w.now()) };
      },
    },

    'screen.shake': {
      prepare: (step, ctx) => prepareShake(step, ctx),
      run(c) {
        const p = c.params as unknown as ShakeParams;
        w.shake.add(p, c.now);
        const start = c.now;
        return { held: false, durationMs: p.duration_ms, finished: (t) => t - start >= p.duration_ms, stop: () => {} };
      },
    },

    'effects.end': {
      prepare: (step) => prepareEffectsEnd(step),
      run(c) {
        const p = c.params as unknown as EffectsEndParams;
        if (p.scope === 'trails') {
          // Obliviate: the trails fade away, and the glass forgets the old ones too.
          w.ink.forgetAll(c.now);
          return instant;
        }
        endEverything(w, c);
        return instant;
      },
    },

    'scene.reveal': {
      prepare: (step) => prepareReveal(step),
      run(c) {
        const p = c.params as unknown as RevealParams;
        const r = w.reveal.add(c.cast.id, p.duration_ms, c.now);
        return { held: p.hold, durationMs: p.duration_ms, finished: (t) => t >= r.until || r.endedAt !== null, stop: () => w.reveal.end(r, w.now()) };
      },
    },

    // The shell fades its session log on this effect.start; the stage draws nothing.
    'log.fade': { prepare: () => ({}), run: () => instant },

    'text.inscribe': {
      prepare: (step) => prepareText(step),
      run(c) {
        const p = c.params as unknown as TextParams;
        const hidden = p.style === 'hidden-ink';
        // Hidden ink defaults to a line of the theme's, never the incantation (contracts/effects.ts).
        const text = p.text ?? (hidden ? w.hiddenInkLine() : c.entry?.spell.known_as ?? '');
        const lines = wrapText(text, EFFECT_LIMITS.maxTextChars, hidden ? 2 : 1);
        if (!lines.length) return instant;
        if (!p.text) c.params.text = lines.join(' ');
        const at = p.at ? w.at(p.at, c.cast, 'center') : hidden ? HIDDEN_INK_POSITION : { x: 0.5, y: 0.58 };
        // Held text stays on the glass until its spell ends.
        const ins = w.text.inscribe(lines, p.style, at, hidden ? HIDDEN_INK_COLOR : w.candle(), c.now, p.duration_ms ?? Number.POSITIVE_INFINITY, w.reducedMotion());
        const shown = inscriptionSpan(ins) - ins.outMs;
        return {
          held: p.hold, ...(p.hold ? {} : { durationMs: shown }),
          finished: (t) => t >= ins.start + shown || ins.endedAt !== null, stop: () => w.text.fadeOut(ins, w.now()),
        };
      },
    },
  };

  const propDef: StepDef = { prepare: (step) => prepareProp(step), run: (c) => runProp(w, c) };
  for (const use of PROP_USES) defs[use] = propDef;
  return defs;
}

/** Every prop.* primitive (contracts/effects.ts); the shelf's props decide what each does. */
export const PROP_USES = [
  'prop.levitate', 'prop.pull', 'prop.push', 'prop.unlock', 'prop.mend', 'prop.ignite', 'prop.douse', 'prop.freeze',
  'prop.scale', 'prop.costume', 'prop.reel', 'prop.disarm', 'prop.mimic', 'prop.topple',
] as const;

function propPosition(p: PropView | null): XY | null {
  return p ? { x: p.x, y: p.y } : null;
}

function smoke(w: StageWorld, at: XY, count: number): void {
  w.particles.spawn({ preset: 'smoke', x: at.x, y: at.y, count: scaleParticleCount(count, w.reducedMotion()), spreadDeg: 50, directionDeg: -90, speed: 1 });
}

/**
 * prop.* steps go to the target prop's apply(); prop.douse with all: true goes to every burning
 * prop. When no prop can do it (no target, or apply() returns false) a small sparkle plays there.
 */
function runProp(w: StageWorld, c: RunContext): Ongoing | null {
  const use = c.step.use;
  const all = use === 'prop.douse' && c.params.all === true;
  const target = w.targetOf(c.cast);
  const targets = all ? w.props().filter((p) => safeTags(p).includes(PROP_TAGS.burning)) : target ? [target] : [];
  if (!targets.length) {
    w.sparkle(w.at(typeof c.step.at === 'string' ? (c.step.at as Anchor) : 'target', c.cast, 'aim'), 10);
    c.params.sparkle = true;
    return null;
  }
  let finished = false;
  const action: PropAction = {
    cast: c.cast,
    step: { ...c.params, use } as EffectStep,
    scale: c.scale,
    done: () => {
      if (finished) return;
      finished = true;
      c.done();
    },
  };
  const applied: PropView[] = [];
  for (const p of targets) {
    let ok = false;
    try {
      ok = p.apply(use, action, w.services);
    } catch (err) {
      log.warn(`prop ${p.id} failed on ${use}`, err);
    }
    if (ok) applied.push(p);
    else w.sparkle({ x: p.x, y: p.y }, 10);
  }
  if (!applied.length) {
    c.params.sparkle = true;
    return null;
  }
  w.markProps();
  if (!isOngoingPropStep(use, c.params)) return null;
  const held = c.params.hold === true;
  const duration = typeof c.params.duration_ms === 'number' ? c.params.duration_ms : typeof c.params.hold_ms === 'number' ? c.params.hold_ms : undefined;
  const started = c.now;
  const breaks = use === 'prop.scale' && (c.params.mode === 'shatter' || c.params.factor === 0);
  return {
    held,
    ...(duration !== undefined ? { durationMs: duration } : {}),
    ...(use === 'prop.ignite' ? { acts: 'fire' as const } : breaks ? { acts: 'break' as const } : {}),
    propId: applied[0].id,
    steering: isSteering(use, c.params),
    finished: (t) => finished || (!held && duration !== undefined && t - started > duration + PROP_GRACE_MS),
    stop: () => {
      for (const p of applied) {
        try {
          p.end(c.cast.id);
        } catch (err) {
          log.warn(`prop ${p.id} could not end ${use}`, err);
        }
      }
      w.markProps();
    },
  };
}

function safeTags(p: PropView): string[] {
  try {
    return p.tags();
  } catch {
    return [];
  }
}

/**
 * effects.end, scope 'all' (Finite Incantatem): every ongoing effect of earlier casts ends, props'
 * ongoing actions included. A prop on which this cast itself has an action keeps that one: its
 * other casts are ended one by one; every other prop gets end('*').
 */
function endEverything(w: StageWorld, c: RunContext): void {
  const director = w.director();
  const mine = new Set(director.ongoing(c.cast.id).map((a) => a.ongoing.propId).filter((id): id is string => !!id));
  director.endAll(c.cast.id, 'effects-end');
  for (const p of w.props()) {
    if (mine.has(p.id)) continue;
    try {
      p.end('*');
    } catch (err) {
      log.warn(`prop ${p.id} could not end its actions`, err);
    }
  }
  w.markProps();
}
