// contracts/effects.ts
//
// The effect primitives packs may use (Section 7.8). Packs never contain code: a spell's effect
// is a list of steps, each naming one of these. Every step also accepts the common fields in
// EffectStep (at, delay_ms, duration_ms, hold). Unknown params are ignored; unknown `use` names are
// skipped by the pack loader.
//
// UNITS. Sizes and distances are fractions of the mirror's height. Colors are CSS hex strings.
// Multipliers default to 1. Durations are milliseconds.
//
// WHO PLAYS WHAT. Each effect module runs only the steps whose `use` it lists in manifest.effects,
// looking the steps up in the sticky spellbook (SpellbookEntry.spell.effect.steps) when it receives
// 'spell.cast'. Step delays count from the bloom (CAST_SEQUENCE). Every module publishes
// 'effect.start' and 'effect.end' for its own steps.
//  - The stage writes the cast's incantation (or the variant label) across the glass on every cast,
//    as part of fx.text@1, not as a step. text.inscribe is for extra text.
//  - Fallback 'sparkle' (a spell with no runnable steps): the stage bursts stars at the tip (24) and
//    the audio module plays 'chime'; each publishes effect.start with use 'fallback:sparkle'.
//  - 'log.fade' is listed by the stage, which draws nothing for it and only publishes effect.start
//    and effect.end; the shell fades its session log on that effect.start.
//  - 'scene.dim' darkens the reflection in the mirror only, never the shell around it.
//
// ENDING. Held steps (hold: true) end on 'spell.ended' for their cast, and every ongoing step of
// every other cast ends on effect.start with use 'effects.end' and scope 'all'. When the cast that
// ended a spell has a step acting on the same thing (light.snuff for an orb or a dim, prop.douse for
// a fire, prop.mend for a break), the held step is released by that step at its delay, so Nox's snuff
// and Aguamenti's water do the job instead of the light simply vanishing; otherwise it ends at once.
// A recast of the same spell hands each held step over to the new cast's step of the same use (on the
// same prop for prop actions), so a second Lumos or an Incendio on a lit candle never blinks out.
//
// SAFETY. EFFECT_LIMITS apply to every pack, including imported ones (Section 10.6, 11.3), after
// effectScale: flashes are capped at three per second and never fill the screen; bolts and large
// dimming changes count toward the same flash budget; shake is short, small, and off with reduced motion.
// @since 1.1 Quick changes of a light.orb (its bloom, fade or snuff, and the hole it cuts in a dimmed
// room) count toward the flash budget too; once it is spent they happen slowly, under the dimming
// rate. Saturated red orbs are capped like red flashes (redFlashMaxIntensity).

import type { Anchor } from './packs';

export type ParticlePreset = 'sparks' | 'embers' | 'water' | 'mist' | 'stars' | 'dust' | 'smoke';
export const PARTICLE_PRESETS: readonly ParticlePreset[] = ['sparks', 'embers', 'water', 'mist', 'stars', 'dust', 'smoke'];

export interface EffectParams {
  // Light (capability fx.light@1)
  /** radius: fraction of mirror height (default about 0.06); intensity 0..1. */
  'light.orb': { at?: Anchor; hold?: boolean; color?: string; radius?: number; intensity?: number };
  /** radius: fraction of mirror height, capped at EFFECT_LIMITS.flashMaxRadius; intensity 0..1. */
  'light.flash': { at?: Anchor; color?: string; radius?: number; intensity?: number; duration_ms?: number };
  /** Puts out light orbs (all, or those of one spell) with a wisp of smoke. */
  'light.snuff': { spell?: string; smoke?: boolean };
  /** Darkens the reflection. amount 0..EFFECT_LIMITS.dimMax; fade_ms at least dimMinFadeMs. */
  'scene.dim': { amount: number; hold?: boolean; duration_ms?: number; fade_ms?: number };

  // Particles (fx.particles@1)
  /** count: particles (scaled down under reduced motion); speed: multiplier; spread_deg: cone width. */
  'particles.burst': {
    preset: ParticlePreset; at?: Anchor; count?: number; speed?: number;
    spread_deg?: number; direction?: 'up' | 'down' | 'aim' | 'out'; color?: string; life_ms?: number;
  };
  /** rate: particles per second; arc: 0 is a straight line, 0.3 a gentle arc. */
  'particles.stream': {
    preset: ParticlePreset; from?: Anchor; to?: Anchor; duration_ms?: number; rate?: number;
    arc?: number; color?: string;
  };

  // Props (fx.props@1). All act on the cast's target prop (SpellCast.targetId).
  /** height: fraction of mirror height to lift (default about 0.25). */
  'prop.levitate': { follow_tip?: boolean; height?: number; duration_ms?: number };
  'prop.pull': { hold_ms?: number };
  /** distance: fraction of mirror height (mode 'away'); 'follow' slides wherever the tip points. */
  'prop.push': { mode?: 'away' | 'follow'; distance?: number; duration_ms?: number };
  'prop.unlock': Record<string, never>;
  'prop.mend': Record<string, never>;
  'prop.ignite': { hold?: boolean };
  /** Puts out burning props: the target, or every burning prop when all is true. */
  'prop.douse': { all?: boolean };
  'prop.freeze': { topple?: boolean; duration_ms?: number; tint?: string };
  /** factor 0 with mode 'shatter' bursts the prop to dust until mended. */
  'prop.scale': { factor: number; mode?: 'grow' | 'shrink' | 'shatter'; duration_ms?: number };
  'prop.costume': { costume?: 'hat' | 'ruff' | 'bow' | 'random' };
  /** @since 1.1 The dummy staggers back. intensity 0..1. */
  'prop.reel': { intensity?: number };
  /** @since 1.1 The dummy's wand spins away. */
  'prop.disarm': Record<string, never>;
  /** @since 1.1 The dummy copies the wand's movement. */
  'prop.mimic': { duration_ms?: number };
  /** @since 1.1 The dummy drops to the floor, then rights itself later. */
  'prop.topple': { duration_ms?: number };

  // Shapes (fx.shapes@1)
  'shield.dome': { duration_ms?: number; color?: string; radius?: number };
  /** width: multiplier of the default bolt thickness, clamped to 0.25..2 (and boltMaxWidth). */
  'bolt.cast': { from?: Anchor; to?: Anchor; color?: string; width?: number; jagged?: boolean };
  'creature.summon': { kind?: 'hare' | 'random'; duration_ms?: number; color?: string };

  // Whole scene (fx.scene@1)
  /** Slows the target (or everything) to factor speed; to_stop eases all motion to a halt. */
  'time.slow': { factor?: number; duration_ms?: number; scope?: 'target' | 'all'; to_stop?: boolean };
  /** intensity: 0..1 of EFFECT_LIMITS.shakeMaxPx; duration capped at shakeMaxMs; never held. */
  'screen.shake': { intensity?: number; duration_ms?: number };
  /** Ends every ongoing effect ('all') or only the ink trails ('trails'). */
  'effects.end': { scope?: 'all' | 'trails' };
  /** @since 1.1 Hidden ink and hidden objects shimmer into view, then fade. */
  'scene.reveal': { duration_ms?: number };
  /** @since 1.1 The session log fades away (the shell listens for effect.start with this use). */
  'log.fade': Record<string, never>;

  // Sound and text (audio@1, fx.text@1)
  /** gain: multiplier; detune: cents. */
  'audio.cue': { cue: string; gain?: number; detune?: number };
  /** Muffles every sound until the spell ends. */
  'audio.muffle': { hold?: boolean };
  /** Writes extra text across the glass. style 'hidden-ink' writes faint silver script; its default
   *  text is a line from ThemePack.hidden_ink (or a built-in line), never the incantation. */
  'text.inscribe': { text?: string; style?: 'incantation' | 'hidden-ink'; at?: Anchor };
}

export type EffectUse = keyof EffectParams;

/** Capability each primitive belongs to; packs list these in `needs`. */
export const EFFECT_CAPABILITY: Record<EffectUse, string> = {
  'light.orb': 'fx.light@1', 'light.flash': 'fx.light@1', 'light.snuff': 'fx.light@1', 'scene.dim': 'fx.light@1',
  'particles.burst': 'fx.particles@1', 'particles.stream': 'fx.particles@1',
  'prop.levitate': 'fx.props@1', 'prop.pull': 'fx.props@1', 'prop.push': 'fx.props@1', 'prop.unlock': 'fx.props@1',
  'prop.mend': 'fx.props@1', 'prop.ignite': 'fx.props@1', 'prop.douse': 'fx.props@1', 'prop.freeze': 'fx.props@1',
  'prop.scale': 'fx.props@1', 'prop.costume': 'fx.props@1', 'prop.reel': 'fx.props@1', 'prop.disarm': 'fx.props@1',
  'prop.mimic': 'fx.props@1', 'prop.topple': 'fx.props@1',
  'shield.dome': 'fx.shapes@1', 'bolt.cast': 'fx.shapes@1', 'creature.summon': 'fx.shapes@1',
  'time.slow': 'fx.scene@1', 'screen.shake': 'fx.scene@1', 'effects.end': 'fx.scene@1', 'scene.reveal': 'fx.scene@1',
  'log.fade': 'fx.scene@1',
  'audio.cue': 'audio@1', 'audio.muffle': 'audio@1',
  'text.inscribe': 'fx.text@1',
};

/** Built-in fallback effects, always available (Section 9.1 rule 3). */
export const FALLBACK_EFFECTS = ['sparkle'] as const;

/** Sound cues the audio module synthesizes. Packs may name others; unknown cues play 'chime'.
 *  Interface cues: the audio module plays 'fizzle' on spell.fizzle (not 'steering' or 'ignored'),
 *  'arm-tick' when the segmenter arms, and 'unlock-tier' on progress.changed with unlockedTier;
 *  the shell asks for 'page-turn' and 'shutter' through the 'audio.play' request. */
export const AUDIO_CUES = [
  'chime', 'chime-rise', 'snuff', 'swish-lift', 'latch', 'whoosh-in', 'bolt', 'stun', 'shield',
  'patronus', 'mend', 'fire', 'water', 'bind', 'slow', 'honk', 'reveal', 'dispel', 'forget',
  'blast', 'buzz', 'slide', 'grow', 'shrink', 'curse-hum', 'crackle', 'doom',
  // interface cues
  'fizzle', 'arm-tick', 'page-turn', 'unlock-tier', 'shutter',
] as const;
export type AudioCue = (typeof AUDIO_CUES)[number];

/** The casting moment (Section 10.1): the ink settles into the gesture's shape, the incantation is
 *  written, then the effect blooms. Every effect module counts step delays from the moment it
 *  receives 'spell.cast' plus bloomDelayMs (reducedMotionBloomDelayMs under reduced motion), so
 *  picture and sound stay together. Fizzle cues play at once. */
export const CAST_SEQUENCE = {
  settleMs: 250,
  inscribeMs: 700,
  bloomDelayMs: 250,
  reducedMotionBloomDelayMs: 0,
} as const;

/** Limits every effect obeys, whatever a pack asks for (Section 10.6), applied after effectScale. */
export const EFFECT_LIMITS = {
  /** Rolling budget shared by light.flash, bright bolts, and dimming changes larger than 0.1 within 100 ms. */
  flashesPerSecond: 3,
  flashWindowMs: 1000,
  maxConcurrentFlashes: 1,
  flashMaxRadius: 0.35,
  flashMaxIntensity: 0.7,
  /** Saturated red flashes are capped lower (WCAG's red-flash rule). */
  redFlashMaxIntensity: 0.45,
  boltMaxWidth: 0.02,
  shakeMaxPx: 8,
  shakeMaxMs: 600,
  dimMax: 0.8,
  dimMinFadeMs: 300,
  particlesMax: 1500,
  reducedMotionParticleFactor: 0.3,
  /** Steps without hold end by this long at the latest. */
  maxStepMs: 30000,
  maxTextChars: 40,
} as const;
