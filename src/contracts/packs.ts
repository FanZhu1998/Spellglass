// contracts/packs.ts
//
// Packs are data only: no scripts, no markup (Section 9.2). Readers are tolerant: unknown
// fields are kept and ignored, unknown effect steps are skipped. JSON Schemas for these
// shapes live in contracts/schemas and are the source of truth for validation.
//
// v1 packs carry no asset files: the audio module synthesizes every cue and the stage draws every
// prop procedurally, so "a short list of allowed asset types" (Section 9.2) is empty for now.
// Strings from packs are untrusted: render them as text (textContent, fillText), never as HTML.
// Colors are '#rgb', '#rrggbb' or '#rrggbbaa'; font names are letters, digits, spaces and hyphens.

/** A point in a unit square with equal units on both axes (isotropic), so a circle is round:
 *  x left to right, y top to bottom, as seen in the mirror. Strokes in caster space are converted
 *  with x × aspect and fitted into the unit square before they are stored as a path. */
export type Point = [number, number];

export type FlickDirection = 'up' | 'down' | 'left' | 'right';

/** Named part of a gesture, used to phrase hints ("The downstroke stopped short"). Parts apply to
 *  every path of the gesture, as fractions of that path's own length. */
export interface GesturePart {
  /** End of this part as a fraction of the path's length, 0..1. Parts are in order. */
  until: number;
  /** Sentence-case noun phrase: 'the circle', 'the downstroke'. */
  name: string;
  /** Hint when the stroke ends inside this part. Default: "{Name} stopped short: carry it through." */
  short_hint?: string;
  /** Hint when this part strays most. Default: "{Name} wandered: keep it closer to the guide." */
  stray_hint?: string;
}

interface GestureCommon {
  parts?: GesturePart[];
  /** Duration of the whole gesture at the intended pace. Default: path length (isotropic, unit
   *  square) × DEFAULT_PACE_MS_PER_UNIT, or FLICK_PACE_MS for flicks. The practice guide's pace dot
   *  and the engine's tempo score both use it. */
  pace_ms?: number;
}

export type Gesture =
  | ({ flick: FlickDirection } & GestureCommon)
  /** Appendix B form: one path, resampled to 64 points on load. */
  | ({ path: Point[]; any_start?: boolean; start_points?: number } & GestureCommon)
  /** Section 9.2 form: several templates for one spell. */
  | ({ paths: Point[][]; any_start?: boolean; start_points?: number } & GestureCommon);

/** Closed shapes with any_start expand into this many start points unless start_points says otherwise. */
export const DEFAULT_START_POINTS = 4;
/** Intended pace: milliseconds per unit of isotropic path length (a unit-square side). */
export const DEFAULT_PACE_MS_PER_UNIT = 700;
export const FLICK_PACE_MS = 350;

/** Where an effect step happens.
 *  tip: the live filtered tip, or its last known position, or aim. Held steps at the tip follow it;
 *       one-shot steps take its position when the effect blooms.
 *  aim: SpellCast.aim (the stroke's end).
 *  target: the prop SpellCast.targetId names; falls back to aim.
 *  center: (0.5, 0.5).
 *  caster: the player's head, approximated in v1 as (0.5, 0.38). */
export type Anchor = 'tip' | 'aim' | 'target' | 'center' | 'caster';

/** One step of a spell's effect, built from a fixed set of primitives (see contracts/effects.ts). */
export interface EffectStep {
  use: string;
  at?: Anchor;
  /** Counted from the bloom: the moment the cast is received plus CAST_SEQUENCE.bloomDelayMs. */
  delay_ms?: number;
  duration_ms?: number;
  /** Keep the step running until the spell ends (spell.ended). Makes the spell "active". */
  hold?: boolean;
  [param: string]: unknown;
}

export interface Effect {
  steps: EffectStep[];
  /** Built-in effect played when no step can run. 'sparkle' is always available. */
  fallback?: string;
}

export interface Variant {
  when: { power_min?: number; power_max?: number; quality_min?: number };
  label: string;
  effect_scale?: number;
}

export interface Spell {
  id: string;                    // permanent; never reused with another meaning
  incantation: string;
  known_as?: string;             // 'Wand-lighting charm'
  gesture_text?: string;         // 'Flick straight up.'
  /** Gesture text for left-handed casters, when mirroring changes the words. */
  gesture_text_mirrored?: string;
  description?: string;          // what happens on screen
  basis?: 'story' | 'park' | 'list' | 'app';
  heard_as?: string[];           // mishearings for the fuzzy voice matcher
  gesture: Gesture;
  effect: Effect;
  needs?: string[];              // capabilities this spell needs beyond its pack's
  needs_active?: string[];       // spells that must be active first (Nox needs Lumos)
  ends?: string[];               // active spells this one ends; '*' ends every active spell
  ended_by?: string[];           // spells that end this one
  /** Prop tags this spell acts on, in order of preference: the engine picks the prop nearest the
   *  aim among those carrying the first listed tag that any prop has. 'prop.any' matches every prop.
   *  When nothing matches the spell is still cast, without a target. */
  targets?: string[];
  variants?: Variant[];
  cooldown_ms?: number;
  /** Spell stays active for this long (Protego: 5000). Steps with `hold` make it active until ended. */
  duration_ms?: number;
  tier?: number;                 // unlock stage, 1 first; absent means 1
  [k: string]: unknown;
}

export interface SpellPack {
  schema: 'spellpack/1';
  id: string;
  version: string;
  engine: string;                // range, e.g. '>=1.0 <2.0'
  title: string;
  description?: string;
  needs: string[];
  /** Packs are on unless this is false (the restricted section ships off). */
  default_enabled?: boolean;
  /** A sentence shown beside the pack in the Workshop. */
  notice?: string;
  spells: Spell[];
  [k: string]: unknown;
}

/** The pre-release format, kept so the migration chain is real and tested (Section 9.1 rule 4,
 *  Section 13 "Legacy packs"). Migration to spellpack/1: name → title, words → incantation,
 *  shape → gesture, effect (a bare step list) → { steps, fallback: 'sparkle' }, engine (absent)
 *  → '>=1.0 <2.0', needs (absent) → the capabilities of the steps used. */
export interface SpellPackV0 {
  schema: 'spellpack/0';
  id: string;
  version: string;
  name: string;
  spells: {
    id: string;
    words: string;
    shape: Gesture;
    effect: EffectStep[];
    needs_active?: string[];
    ends?: string[];
    ended_by?: string[];
    targets?: string[];
    tier?: number;
    [k: string]: unknown;
  }[];
  [k: string]: unknown;
}

export interface Grade { min: number; label: string }

export interface ThemePack {
  schema: 'themepack/1';
  id: string;
  version: string;
  title?: string;
  tokens: Record<string, string>;
  /** Optional accent pairs that restyle Candle and Oxblood ('crimson-gold' and so on). */
  accents?: Record<string, { label: string; candle: string; oxblood: string }>;
  fonts: { display: string; text: string };
  grades: { cast: Grade[]; fizzle: Grade[] };
  /** Caption for every sound cue (Section 10.6: every sound cue has a caption). */
  captions?: Record<string, string>;
  /** Lines of hidden ink that Revelio reveals (text.inscribe with style 'hidden-ink'). */
  hidden_ink?: string[];
  [k: string]: unknown;
}

/** A player's redrawn gestures, exported from the Workshop as one file (Section 11.1). Imported
 *  gesture packs are layers: the player's own drawings win, then enabled gesture packs (newest
 *  first), then the spell pack's gesture. */
export interface GesturePack {
  schema: 'gesturepack/1';
  id: string;
  version: string;
  title: string;
  gestures: Record<string, Gesture>;
  [k: string]: unknown;
}

export type PackKind = 'spellpack' | 'themepack' | 'gesturepack';

export interface PackIndexEntry {
  id: string;
  kind: PackKind;
  version: string;
  path: string;                  // relative to the index file
  sha256: string;                // hex digest of the file's bytes
}

export interface PackIndex {
  schema: 'packindex/1';
  packs: PackIndexEntry[];
}

/** Schema ids the loader can read, oldest first. Older ones are migrated forward. */
export const SPELLPACK_SCHEMAS = ['spellpack/0', 'spellpack/1'] as const;
export const THEMEPACK_SCHEMAS = ['themepack/1'] as const;
export const GESTUREPACK_SCHEMAS = ['gesturepack/1'] as const;
export const PACKINDEX_SCHEMA = 'packindex/1';
export const CURRENT_SPELLPACK_SCHEMA = 'spellpack/1';
export const CURRENT_THEMEPACK_SCHEMA = 'themepack/1';

/** Packs larger than this are refused (Section 9.2: "a size limit"). */
export const PACK_SIZE_LIMIT_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------------------------
// The resolved spellbook: what the pack loader publishes as `spellbook.changed`.

export type SpellStatus = 'learned' | 'open' | 'locked';

export interface SpellbookEntry {
  /** The spell as loaded, with the effective gesture (the player's drawing or a gesture pack layer)
   *  and the left-handed mirror applied, and unknown effect steps removed. */
  spell: Spell;
  packId: string;
  packTitle: string;
  /** Pack enabled and every capability need met. */
  available: boolean;
  unavailableReason?: string;
  /** learned: accepted `Spellbook.learnAfter` times (it stays learned). open: may be cast and
   *  practised. locked: a later tier.
   *  @since 1.1 locked never applies to a learned spell, whatever the tier. */
  status: SpellStatus;
  /** A candidate for recognition right now: available and not locked. */
  enabled: boolean;
  /** The gesture comes from the player's own drawing, not the pack. */
  overridden: boolean;
  /** Where the effective gesture came from: 'pack', 'override', or a gesture pack's id. */
  gestureSource: string;
  /** Changes whenever the effective gesture changes (a redraw, a gesture pack, the left-handed
   *  switch). Learned samples carry the key they were learned under; others are stale. */
  gestureKey: string;
  /** The gesture is shown mirrored for a left-handed caster. */
  mirrored: boolean;
  /** Template paths ready to draw or match: 64 points each, in an isotropic unit square.
   *  For `any_start` gestures, only the stored path (start-point expansion is the recognizer's job).
   *  Empty for flicks. */
  templates: Point[][];
  /** How long the spell stays active once cast, computed from the pack's original steps before any
   *  were skipped: a number of ms (duration_ms), 'until-ended' (a step holds), or null (instant).
   *  The engine's rules use this, so they never depend on which effect modules are installed.
   *  A positive duration_ms takes precedence over a held step. */
  lasts: 'until-ended' | number | null;
  /** Effect steps no module implements, which were removed from `spell.effect.steps`. */
  skippedSteps: string[];
  /** Accepted casts so far (progress). */
  accepted: number;
}

export interface SpellbookPack {
  id: string;
  kind: PackKind;
  title: string;
  version: string;
  description?: string;
  enabled: boolean;
  /** true for packs the player imported (stored on the device). */
  user: boolean;
  notice?: string;
  /** Capabilities the pack needs that nothing provides. */
  unmet: string[];
  /** Set when the pack failed its checks and was skipped (Section 7.9). */
  error?: string;
  /** Problems that did not stop the pack: a duplicate spell id dropped, a step skipped. */
  warnings?: string[];
  /** A user pack with a bundled pack's id and a higher version replaces that bundled pack. */
  shadows?: string;
}

export interface Spellbook {
  /** Increments on every rebuild. */
  revision: number;
  packs: SpellbookPack[];
  /** Spells in pack order, then file order. Spells of disabled packs are listed as unavailable. */
  spells: SpellbookEntry[];
  theme: ThemePack | null;
  /** Highest tier the player has opened (staged unlocking). A spell is locked when its tier is above
   *  this, unlockAll is off and it is not learned.
   *  @since 1.1 This is the stored tier (kv 'progress.unlockedTier', which never goes down except
   *  through progress.reset) plus any tiers passed through because nothing in them is available,
   *  such as the tiers of a pack that is turned off. It returns to the stored tier when that pack is
   *  turned on again; learned spells stay open. */
  unlockedTier: number;
  /** Accepted casts that make a spell learned (setting 'spells.learnAfter'). */
  learnAfter: number;
  /** Set when the pack index itself could not be read; the bundled packs are then missing. */
  indexError?: string;
}
