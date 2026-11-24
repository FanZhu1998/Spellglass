// Internal interface of the stage module (effects/stage). It splits the stage into a core
// (loop, layers, trail, text, light, particles, shapes, scene effects, practice guide) and the
// shelf of props (props/). Both halves live inside one module, so they may import this file
// and each other's exports through it; nothing outside effects/stage may import any of it.

import type { EffectStep, ParticlePreset, PropId, SpellCast } from '../../../contracts';

/** Mapping between caster space and the stage's canvases. */
export interface StageView {
  /** Mirror size in CSS pixels. */
  readonly width: number;
  readonly height: number;
  /** Canvas pixels per CSS pixel (devicePixelRatio, capped by quality). */
  readonly dpr: number;
  /** width ÷ height. */
  readonly aspect: number;
  /** Caster space (0..1, 0..1) to canvas pixels. */
  toPx(x: number, y: number): [number, number];
  /** Canvas pixels to caster space. */
  fromPx(px: number, py: number): [number, number];
  /** A fraction of the mirror's height, in canvas pixels. Use this for every size. */
  size(fraction: number): number;
}

/** The two drawing layers. Both are cleared by the core every frame before anything draws. */
export interface Layers {
  /** Normal blending, drawn over the camera video: room dimming, props, the shelf, dull ink. */
  shade: CanvasRenderingContext2D;
  /** Composited with mix-blend-mode: screen over everything: glows, trails, particles, flames, bolts. */
  light: CanvasRenderingContext2D;
}

export interface FrameInfo {
  /** Kernel clock, ms. */
  now: number;
  /** Ms since the last frame, multiplied by the global time scale (Arresto Momentum). */
  dt: number;
  /** Ms since the last frame, unscaled. */
  rawDt: number;
  /** Global time scale, 1 normally. */
  timeScale: number;
  reducedMotion: boolean;
  quality: 'high' | 'low';
}

export interface BurstOptions {
  preset: ParticlePreset;
  /** count (below) is used as given: callers apply EFFECT_LIMITS.reducedMotionParticleFactor
   *  themselves (props through FrameInfo.reducedMotion), so the factor is never applied twice. */
  /** Caster space. */
  x: number;
  y: number;
  count?: number;
  /** Multiplier on the preset's speed. */
  speed?: number;
  spreadDeg?: number;
  /** Degrees, 0 = right, -90 = up (screen coordinates). */
  directionDeg?: number;
  color?: string;
  lifeMs?: number;
  /** Multiplier on particle size. */
  size?: number;
}

export interface ParticleApi {
  burst(opts: BurstOptions): void;
  /** Number of live particles (the core enforces EFFECT_LIMITS.particlesMax). */
  readonly count: number;
}

/** What the core lends to props. */
export interface StageServices {
  readonly view: StageView;
  readonly particles: ParticleApi;
  /** The filtered wand tip in caster space, or null when it is not in view. Pass the cast of the
   *  action that follows it: while a replay plays, its own cast follows the replay's tip, and every
   *  other cast the live one. */
  tip(castId?: string): { x: number; y: number } | null;
  /** A cached soft round glow sprite in this color, for drawImage on the light layer. */
  glow(color: string): CanvasImageSource;
  now(): number;
  /** Seeded random in [0, 1): deterministic in tests. */
  random(): number;
  /** Call after a prop's position, tags or state change; the core republishes 'scene.props'. */
  propsChanged(): void;
  /** True while a 'scene.reveal' is showing hidden things; 0..1 fade. */
  revealAlpha(): number;
}

/** Context for one prop.* effect step applied to one prop. */
export interface PropAction {
  cast: SpellCast;
  step: EffectStep;
  /** cast.effectScale, default 1. */
  scale: number;
  /** Call once when an action with a duration finishes on its own (the core sends 'effect.end'). */
  done(): void;
}

/** One object on the shelf. Props own their art (drawn procedurally: original, no assets) and their state machine. */
export interface PropView {
  readonly id: PropId;
  /** Lower-case display label that follows state: 'locked box' / 'open box'. */
  label(): string;
  /** Where the prop rests (caster space), from SHELF_LAYOUT. */
  readonly home: { x: number; y: number };
  /** Current centre (caster space). Changes while levitated, pulled, pushed. */
  x: number;
  y: number;
  /** Hit radius in caster-x units. */
  readonly radius: number;
  /** Local time scale (Impedimenta), multiplied with the global one. Set by the core. */
  timeScale: number;
  /** Current tags (contracts/scene.ts PROP_TAGS), reflecting state. */
  tags(): string[];
  /** Display-only state, published in scene.props. */
  state(): Record<string, boolean | number | string>;
  /** Advance animations. Use frame.dt * this.timeScale. */
  update(frame: FrameInfo, services: StageServices): void;
  /** Draw the body on layers.shade and any light (flame, magic outline) on layers.light. */
  draw(layers: Layers, frame: FrameInfo, services: StageServices): void;
  /** Optional hidden detail drawn while Revelio shows hidden things (alpha 0..1). */
  drawHidden?(layers: Layers, frame: FrameInfo, services: StageServices, alpha: number): void;
  /** Apply one prop.* primitive. Return false when this prop cannot do it; the core then plays a sparkle at the prop. */
  apply(use: string, action: PropAction, services: StageServices): boolean;
  /** End ongoing actions started by this cast id, or every ongoing action for '*'. */
  end(castId: string): void;
  /** Back to the starting state, at home. */
  reset(): void;
  /** False while the prop is still showing what was done to it: a lid swinging open, a crack
   *  knitting, a wand in flight, a flight home. A replay waits for this before the shelf resets.
   *  Ambient motion (the candle's flicker) does not count. Absent means always settled. */
  settled?(): boolean;
}

/** The props half exports this from props/index.ts. */
export interface Shelf {
  props: PropView[];
  /** Draw the wooden ledge the props stand on (shade layer), before the props. */
  drawShelf(layers: Layers, frame: FrameInfo, services: StageServices): void;
}

export type CreateShelf = () => Shelf;
