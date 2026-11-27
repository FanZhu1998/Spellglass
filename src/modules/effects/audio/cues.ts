// The sound cues (contracts/effects.ts AUDIO_CUES), as data. Every cue is synthesized from
// oscillators, noise, filters and envelopes: no sound files, so every sound is original (Section
// 10.7) and the first download stays small. A recipe is a list of voices; synth.ts turns it into
// Web Audio nodes. Keeping recipes as plain data lets tests check every cue without a browser.
//
// Character, per the brief: chimes and swells for charms, crackles and booms for jinxes and curses,
// whooshes for movement, and small, soft interface sounds. Levels are set so that a cue peaks around
// 0.4 to 0.8 before the master level, pleasant at moderate volume; the master bus limits the rest.
//
// Every cue has a caption (Section 10.6): the theme pack's, else DEFAULT_CAPTIONS.

import type { AudioCue, ThemePack } from '../../../contracts';
import { AUDIO_CUES } from '../../../contracts';

export type Wave = 'sine' | 'triangle' | 'square' | 'sawtooth';
export type NoiseColor = 'white' | 'pink' | 'brown';
export type FilterKind = 'lowpass' | 'highpass' | 'bandpass';

/** Times in seconds; levels as fractions of the voice's peak gain. */
export interface Envelope {
  /** From silence to the peak (linear). */
  attack: number;
  /** Held at the peak. */
  hold?: number;
  /** From the peak down to the sustain level (exponential). */
  decay: number;
  /** Level after the decay, as a fraction of the peak; 0 decays to silence. */
  sustain?: number;
  /** The final fade to silence. */
  release?: number;
}

export interface Filter {
  type: FilterKind;
  /** Hz at the voice's start. */
  freq: number;
  /** Hz to sweep to (exponentially) over `sweep` seconds, default the voice's length. */
  to?: number;
  sweep?: number;
  /** Bandpass: the usual Q. Lowpass and highpass: resonance in dB (Web Audio's convention). */
  q?: number;
}

interface VoiceBase {
  /** Start, seconds after the cue starts. */
  at: number;
  /** Length in seconds, release included. */
  dur: number;
  /** Peak gain, linear. */
  gain: number;
  env: Envelope;
  filter?: Filter;
  /** Stereo position, -1 (left) to 1 (right). */
  pan?: number;
  /** Amplitude wobble: rate in Hz, depth 0..1. */
  tremolo?: { rate: number; depth: number };
}

export interface ToneVoice extends VoiceBase {
  kind: 'tone';
  wave: Wave;
  freq: number;
  /** Hz to glide to (exponentially) over `glide` seconds, default the voice's length. */
  to?: number;
  glide?: number;
  /** Cents. */
  detune?: number;
  /** Pitch wobble: rate in Hz, depth in cents. */
  vibrato?: { rate: number; depth: number };
}

export interface NoiseVoice extends VoiceBase {
  kind: 'noise';
  color: NoiseColor;
}

export type Voice = ToneVoice | NoiseVoice;

export interface Recipe {
  voices: Voice[];
  /** Share sent to the room reverb, 0..1. */
  reverb: number;
}

/** A recipe from a random source (crackles and sparkles scatter their grains; seeded, so repeatable). */
export type RecipeBuilder = (random: () => number) => Recipe;

// ------------------------------------------------------------------------------- helpers

const RELEASE = 0.03;
/** Partials above this are left out: inaudible to most, and they alias near the Nyquist limit. */
export const MAX_HZ = 16000;

const env = (attack: number, decay: number, more: Omit<Envelope, 'attack' | 'decay'> = {}): Envelope => ({ attack, decay, ...more });

export function envelopeLength(e: Envelope): number {
  return e.attack + (e.hold ?? 0) + e.decay + (e.release ?? RELEASE);
}

type ToneExtra = Partial<Omit<ToneVoice, 'kind' | 'wave' | 'freq' | 'at' | 'gain' | 'env'>>;
type NoiseExtra = Partial<Omit<NoiseVoice, 'kind' | 'color' | 'at' | 'gain' | 'env' | 'filter'>>;

function tone(wave: Wave, freq: number, at: number, gain: number, e: Envelope, extra: ToneExtra = {}): ToneVoice {
  return { kind: 'tone', wave, freq, at, gain, env: e, dur: envelopeLength(e), ...extra };
}

function noise(color: NoiseColor, at: number, gain: number, e: Envelope, filter?: Filter, extra: NoiseExtra = {}): NoiseVoice {
  return { kind: 'noise', color, at, gain, env: e, dur: envelopeLength(e), ...(filter ? { filter } : {}), ...extra };
}

/** A struck glass bell (an original recipe): a fundamental and a few partials, the higher ones
 *  quieter and shorter, slightly inharmonic so it rings like glass rather than an organ. */
function bell(freq: number, at: number, gain: number, decay = 1.1, pan?: number): ToneVoice[] {
  const partials: [number, number, number][] = [[1, 1, 1], [2.005, 0.3, 0.55], [3.01, 0.12, 0.4], [4.17, 0.06, 0.28], [5.43, 0.035, 0.18]];
  const out: ToneVoice[] = [];
  for (const [ratio, g, d] of partials) {
    if (freq * ratio > MAX_HZ) continue;
    out.push(tone('sine', freq * ratio, at, gain * g, env(0.002, Math.max(0.05, decay * d)), pan !== undefined ? { pan } : {}));
  }
  return out;
}

/** `count` grains at random times in [from, from + span), sorted by time. */
function scatter(random: () => number, count: number, from: number, span: number, make: (at: number, x: number, i: number) => Voice): Voice[] {
  const out: Voice[] = [];
  for (let i = 0; i < count; i++) out.push(make(from + random() * span, random(), i));
  return out.sort((a, b) => a.at - b.at);
}

const pick = <T>(random: () => number, list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(random() * list.length))];

// Equal-tempered pitches (A4 = 440 Hz).
const G3 = 196, A3 = 220, C4 = 261.63, E4 = 329.63, G4 = 392, A4 = 440;
const C5 = 523.25, E5 = 659.25, G5 = 783.99, A5 = 880;
const C6 = 1046.5, D6 = 1174.66, E6 = 1318.51, G6 = 1567.98, A6 = 1760;
const C7 = 2093, D7 = 2349.32, E7 = 2637.02, G7 = 3135.96;

// ------------------------------------------------------------------------------- the recipes

export const RECIPES: Record<AudioCue, RecipeBuilder> = {
  // Charms: bells and swells.
  chime: () => ({ reverb: 0.35, voices: [...bell(C6, 0, 0.32, 1.3)] }),

  'chime-rise': () => ({
    reverb: 0.4,
    voices: [
      ...bell(G5, 0, 0.2, 0.9, -0.2), ...bell(C6, 0.11, 0.22, 1.0, 0), ...bell(E6, 0.22, 0.24, 1.3, 0.2),
      tone('sine', C5, 0.05, 0.08, env(0.35, 1.0)),
      tone('sine', E5, 0.05, 0.06, env(0.35, 1.0)),
      tone('triangle', E7, 0.3, 0.025, env(0.25, 0.8), { vibrato: { rate: 6, depth: 8 } }),
    ],
  }),

  snuff: () => ({
    reverb: 0.15,
    voices: [
      noise('pink', 0, 0.45, env(0.006, 0.22), { type: 'lowpass', freq: 1200, to: 400, q: 0 }),
      tone('sine', 150, 0, 0.22, env(0.004, 0.12), { to: 70, glide: 0.12 }),
      noise('white', 0.03, 0.05, env(0.02, 0.35), { type: 'highpass', freq: 3500 }),
    ],
  }),

  'swish-lift': () => ({
    reverb: 0.3,
    voices: [
      noise('white', 0, 0.32, env(0.18, 0.45), { type: 'bandpass', freq: 500, to: 3200, sweep: 0.55, q: 1.1 }),
      tone('sine', 520, 0.05, 0.06, env(0.25, 0.4), { to: 940, glide: 0.5, vibrato: { rate: 5, depth: 15 } }),
      ...bell(G6, 0.42, 0.12, 0.7),
    ],
  }),

  latch: () => ({
    reverb: 0.2,
    voices: [
      noise('white', 0, 0.3, env(0.001, 0.028), { type: 'highpass', freq: 2200 }),
      tone('sine', 2300, 0, 0.14, env(0.001, 0.04)),
      noise('white', 0.12, 0.3, env(0.001, 0.055), { type: 'bandpass', freq: 1300, q: 2.2 }),
      tone('triangle', A5, 0.12, 0.2, env(0.002, 0.08)),
      tone('sawtooth', 170, 0.2, 0.05, env(0.06, 0.28), { to: 240, glide: 0.3, filter: { type: 'bandpass', freq: 900, q: 4 } }),
      ...bell(C7, 0.24, 0.06, 0.5),
    ],
  }),

  'whoosh-in': () => ({
    reverb: 0.25,
    voices: [
      noise('pink', 0, 0.5, env(0.38, 0.28), { type: 'bandpass', freq: 3200, to: 380, sweep: 0.66, q: 0.9 }),
      tone('sine', 95, 0.05, 0.14, env(0.35, 0.3), { to: 58, glide: 0.65 }),
    ],
  }),

  bolt: (r) => ({
    reverb: 0.25,
    voices: [
      tone('sawtooth', 1800, 0, 0.2, env(0.002, 0.34), { to: 120, glide: 0.34, filter: { type: 'lowpass', freq: 3200, to: 600, q: 1 } }),
      tone('sine', 110, 0.02, 0.3, env(0.004, 0.2), { to: 52, glide: 0.2 }),
      ...scatter(r, 14, 0, 0.42, (at, x) => noise('white', at, 0.18 + 0.3 * x, env(0.001, 0.008 + 0.02 * x), { type: 'highpass', freq: 1600 + 2000 * x }, { pan: x * 1.2 - 0.6 })),
    ],
  }),

  stun: () => ({
    reverb: 0.25,
    voices: [
      noise('white', 0, 0.4, env(0.001, 0.075), { type: 'highpass', freq: 1100 }),
      tone('square', A5, 0, 0.09, env(0.002, 0.18), { to: 220, glide: 0.15, filter: { type: 'lowpass', freq: 2500 } }),
      tone('sine', 95, 0, 0.26, env(0.003, 0.24), { to: 45, glide: 0.22 }),
    ],
  }),

  shield: () => ({
    reverb: 0.35,
    voices: [
      tone('sine', 110, 0, 0.16, env(0.25, 0.8, { hold: 0.6 })),
      tone('sine', 110.9, 0, 0.13, env(0.25, 0.8, { hold: 0.6 })),
      tone('sine', 220, 0, 0.07, env(0.3, 0.7, { hold: 0.5 })),
      tone('triangle', A6, 0.08, 0.035, env(0.3, 0.7, { hold: 0.5 }), { tremolo: { rate: 7, depth: 0.8 } }),
      ...bell(E6, 0, 0.12, 1.0),
    ],
  }),

  patronus: () => {
    // A bright major chord swelling in, gently detuned like a choir, with high bells over the top.
    const voices: Voice[] = [];
    [C4, G4, C5, E5, G5].forEach((f, i) => {
      for (const cents of [-7, 7]) {
        voices.push(tone('sawtooth', f, 0, 0.035, env(0.6, 1.2, { hold: 0.55 }), {
          detune: cents, vibrato: { rate: 5 + i * 0.3, depth: 6 }, filter: { type: 'lowpass', freq: 1800, to: 3600, sweep: 0.9 },
        }));
      }
    });
    voices.push(noise('pink', 0, 0.035, env(0.6, 1.0, { hold: 0.4 }), { type: 'bandpass', freq: 900, q: 1.5 }));
    voices.push(...bell(C7, 0.5, 0.07, 0.9, -0.3), ...bell(E7, 0.7, 0.06, 0.9, 0.3), ...bell(G7, 0.9, 0.05, 1.0, 0));
    return { reverb: 0.5, voices };
  },

  mend: () => ({
    reverb: 0.4,
    voices: [C6, D6, E6, G6, A6, C7].flatMap((f, i) => bell(f, i * 0.075, 0.16 - i * 0.012, 0.55, -0.4 + i * 0.16)),
  }),

  fire: (r) => ({
    reverb: 0.2,
    voices: [
      noise('brown', 0, 0.55, env(0.35, 0.9, { hold: 0.35 }), { type: 'lowpass', freq: 280, to: 1300, sweep: 0.6, q: 0 }),
      noise('pink', 0.05, 0.14, env(0.3, 0.8, { hold: 0.3 }), { type: 'bandpass', freq: 1500, q: 0.7 }),
      tone('sine', 72, 0, 0.28, env(0.08, 0.5), { to: 48, glide: 0.5 }),
      ...scatter(r, 18, 0.15, 1.5, (at, x) => noise('white', at, 0.12 + 0.25 * x, env(0.001, 0.005 + 0.012 * x), { type: 'highpass', freq: 2400 + 2500 * x }, { pan: x - 0.5 })),
    ],
  }),

  water: (r) => ({
    reverb: 0.3,
    voices: [
      noise('pink', 0, 0.38, env(0.2, 0.6, { hold: 0.8 }), { type: 'bandpass', freq: 1100, q: 0.8 }, { tremolo: { rate: 9, depth: 0.35 } }),
      noise('white', 0, 0.07, env(0.2, 0.6, { hold: 0.7 }), { type: 'highpass', freq: 3600 }),
      // Bubbles: short sine chirps that rise.
      ...scatter(r, 10, 0.1, 1.3, (at, x) => tone('sine', 480 + 700 * x, at, 0.07 + 0.08 * x, env(0.004, 0.05 + 0.04 * x), { to: (480 + 700 * x) * 1.7, glide: 0.06 })),
    ],
  }),

  bind: () => ({
    reverb: 0.2,
    voices: [
      noise('white', 0, 0.38, env(0.001, 0.04), { type: 'highpass', freq: 1500 }),
      tone('sine', 220, 0, 0.28, env(0.002, 0.12), { to: 180, glide: 0.1 }),
      tone('triangle', A4, 0, 0.13, env(0.002, 0.06)),
      tone('sawtooth', 96, 0.06, 0.07, env(0.02, 0.35), { filter: { type: 'lowpass', freq: 600 }, tremolo: { rate: 25, depth: 0.6 } }),
    ],
  }),

  slow: () => ({
    reverb: 0.3,
    voices: [
      tone('sawtooth', A4, 0, 0.12, env(0.02, 0.9, { hold: 0.3 }), { to: 70, glide: 1.1, filter: { type: 'lowpass', freq: 2000, to: 300, sweep: 1.1 } }),
      tone('sine', A3, 0, 0.18, env(0.02, 0.9, { hold: 0.3 }), { to: 36, glide: 1.1 }),
      noise('pink', 0, 0.1, env(0.1, 0.9, { hold: 0.2 }), { type: 'lowpass', freq: 800, to: 200, sweep: 1.1 }),
    ],
  }),

  honk: () => ({
    // Two nasal honks, the second lower: a sawtooth through a narrow band with a wobble.
    reverb: 0.15,
    voices: [
      tone('sawtooth', 233, 0, 0.45, env(0.012, 0.09, { hold: 0.08 }), { to: 220, glide: 0.18, vibrato: { rate: 12, depth: 30 }, filter: { type: 'bandpass', freq: 900, q: 3 } }),
      tone('square', 466, 0, 0.075, env(0.012, 0.09, { hold: 0.08 }), { to: 440, glide: 0.18, filter: { type: 'bandpass', freq: 1200, q: 2 } }),
      tone('sawtooth', 196, 0.23, 0.48, env(0.012, 0.12, { hold: 0.1 }), { to: 182, glide: 0.24, vibrato: { rate: 12, depth: 35 }, filter: { type: 'bandpass', freq: 800, q: 3 } }),
      tone('square', 392, 0.23, 0.075, env(0.012, 0.12, { hold: 0.1 }), { to: 364, glide: 0.24, filter: { type: 'bandpass', freq: 1100, q: 2 } }),
    ],
  }),

  reveal: (r) => ({
    reverb: 0.45,
    voices: [
      ...scatter(r, 16, 0, 1.0, (at, x, i) => tone('sine', pick(r, [C7, D7, E7, G7, 3520, 4186]), at, 0.05 + 0.05 * x, env(0.002, 0.22 + 0.1 * x), { pan: ((i % 5) - 2) * 0.3 })),
      tone('triangle', C5, 0, 0.05, env(0.4, 0.8)),
      tone('triangle', G5, 0, 0.04, env(0.4, 0.8)),
      noise('white', 0, 0.025, env(0.3, 0.8), { type: 'highpass', freq: 5000 }),
    ],
  }),

  dispel: () => ({
    reverb: 0.4,
    voices: [
      ...[A3, E4, A4, C5].map((f) => tone('triangle', f, 0, 0.07, env(0.35, 1.2), { filter: { type: 'lowpass', freq: 3000, to: 400, sweep: 1.5 } })),
      noise('pink', 0, 0.14, env(0.3, 1.0), { type: 'bandpass', freq: 2000, to: 300, sweep: 1.3, q: 0.9 }),
      tone('sine', A6, 0.1, 0.035, env(0.2, 1.0), { to: A5, glide: 1.2 }),
    ],
  }),

  forget: () => ({
    reverb: 0.4,
    voices: [
      noise('pink', 0, 0.28, env(0.4, 1.0, { hold: 0.2 }), { type: 'bandpass', freq: 2500, to: 1200, sweep: 1.6, q: 0.6 }),
      noise('white', 0, 0.045, env(0.4, 0.9, { hold: 0.1 }), { type: 'highpass', freq: 6000 }),
      tone('sine', G3, 0.1, 0.05, env(0.5, 1.0), { to: 147, glide: 1.4 }),
    ],
  }),

  // Jinxes and curses: crackles and booms.
  blast: (r) => ({
    reverb: 0.3,
    voices: [
      noise('white', 0, 0.4, env(0.002, 0.55), { type: 'lowpass', freq: 6000, to: 300, sweep: 0.5 }),
      noise('brown', 0, 0.4, env(0.003, 0.85), { type: 'lowpass', freq: 420 }),
      tone('sine', 82, 0, 0.34, env(0.003, 0.7), { to: 34, glide: 0.4 }),
      ...scatter(r, 10, 0.08, 0.7, (at, x) => noise('white', at, 0.05 + 0.1 * x, env(0.001, 0.01 + 0.02 * x), { type: 'highpass', freq: 2000 + 3000 * x }, { pan: x * 1.4 - 0.7 })),
    ],
  }),

  buzz: () => ({
    reverb: 0.15,
    voices: [
      tone('sawtooth', 147, 0, 0.14, env(0.15, 0.6, { hold: 0.6 }), { filter: { type: 'bandpass', freq: 600, q: 1.5 }, tremolo: { rate: 22, depth: 0.5 }, vibrato: { rate: 3, depth: 20 } }),
      tone('sawtooth', 148.6, 0, 0.11, env(0.15, 0.6, { hold: 0.6 }), { filter: { type: 'bandpass', freq: 650, q: 1.5 }, tremolo: { rate: 23, depth: 0.5 } }),
      tone('square', 294, 0.05, 0.03, env(0.15, 0.5, { hold: 0.5 }), { filter: { type: 'lowpass', freq: 1200 } }),
    ],
  }),

  slide: () => ({
    reverb: 0.2,
    voices: [
      noise('pink', 0, 0.46, env(0.05, 0.25, { hold: 0.4 }), { type: 'bandpass', freq: 700, to: 560, sweep: 0.7, q: 2.5 }, { tremolo: { rate: 31, depth: 0.5 } }),
      noise('white', 0, 0.09, env(0.05, 0.25, { hold: 0.4 }), { type: 'bandpass', freq: 2600, q: 3 }),
      tone('triangle', 110, 0, 0.05, env(0.05, 0.3, { hold: 0.35 })),
    ],
  }),

  grow: () => ({
    reverb: 0.3,
    voices: [
      tone('triangle', G3, 0, 0.2, env(0.05, 0.4, { hold: 0.5 }), { to: C5, glide: 0.8, vibrato: { rate: 6, depth: 40 } }),
      tone('sine', 98, 0, 0.12, env(0.05, 0.4, { hold: 0.5 }), { to: C4, glide: 0.8 }),
      ...bell(C6, 0.8, 0.09, 0.6),
    ],
  }),

  shrink: () => ({
    reverb: 0.25,
    voices: [
      tone('sine', 1600, 0, 0.18, env(0.01, 0.38), { to: 500, glide: 0.35, vibrato: { rate: 14, depth: 50 } }),
      tone('triangle', 3200, 0, 0.04, env(0.01, 0.3), { to: 1000, glide: 0.35 }),
      noise('white', 0.38, 0.14, env(0.001, 0.02), { type: 'highpass', freq: 2000 }),
    ],
  }),

  'curse-hum': () => ({
    // A minor second beating low, a thin whine above: unsettling, never loud.
    reverb: 0.4,
    voices: [
      tone('sine', 98, 0, 0.17, env(0.4, 0.9, { hold: 0.6 })),
      tone('sine', 103.8, 0, 0.13, env(0.4, 0.9, { hold: 0.6 })),
      tone('sine', 1244.5, 0.2, 0.025, env(0.4, 0.8, { hold: 0.4 }), { vibrato: { rate: 4.5, depth: 35 } }),
      tone('sawtooth', 49, 0, 0.06, env(0.4, 0.9, { hold: 0.5 }), { filter: { type: 'lowpass', freq: 220 } }),
    ],
  }),

  crackle: (r) => ({
    reverb: 0.2,
    voices: [
      ...scatter(r, 32, 0, 0.9, (at, x) => noise('white', at, 0.14 + 0.32 * x, env(0.001, 0.004 + 0.014 * x), { type: 'highpass', freq: 1800 + 3000 * x }, { pan: x * 1.6 - 0.8 })),
      tone('sawtooth', 82, 0, 0.08, env(0.02, 0.8), { filter: { type: 'lowpass', freq: 1500 }, tremolo: { rate: 47, depth: 0.9 } }),
    ],
  }),

  doom: () => ({
    reverb: 0.45,
    voices: [
      tone('sine', 55, 0, 0.55, env(0.005, 1.8), { to: 32, glide: 1.2 }),
      noise('brown', 0, 0.38, env(0.01, 1.4), { type: 'lowpass', freq: 260, to: 80, sweep: 1.4 }),
      tone('triangle', 110, 0, 0.12, env(0.005, 0.8), { to: 65, glide: 0.8 }),
    ],
  }),

  // Interface cues: short and soft.
  fizzle: () => ({
    reverb: 0.15,
    voices: [
      noise('white', 0, 0.26, env(0.005, 0.34), { type: 'bandpass', freq: 3000, to: 500, sweep: 0.36, q: 1.2 }),
      tone('sine', 520, 0, 0.11, env(0.005, 0.3), { to: 180, glide: 0.3 }),
      noise('white', 0.02, 0.05, env(0.01, 0.24), { type: 'highpass', freq: 4200 }),
    ],
  }),

  'arm-tick': () => ({
    reverb: 0.1,
    voices: [
      tone('sine', A6, 0, 0.12, env(0.001, 0.025)),
      noise('white', 0, 0.04, env(0.001, 0.01), { type: 'highpass', freq: 4000 }),
    ],
  }),

  'page-turn': () => ({
    reverb: 0.15,
    voices: [
      noise('pink', 0, 0.22, env(0.04, 0.12), { type: 'bandpass', freq: 2200, q: 0.9 }),
      noise('pink', 0.1, 0.28, env(0.03, 0.2), { type: 'bandpass', freq: 1600, to: 3000, sweep: 0.23, q: 0.9 }),
      noise('brown', 0.3, 0.12, env(0.003, 0.05), { type: 'lowpass', freq: 400 }),
    ],
  }),

  'unlock-tier': () => {
    // A rising arpeggio, then the chord held under a bell.
    const notes = [C5, E5, G5, C6];
    const voices: Voice[] = notes.flatMap((f, i) => [
      tone('square', f, i * 0.11, 0.06, env(0.015, 0.35), { filter: { type: 'lowpass', freq: 2500 } }),
      tone('triangle', f, i * 0.11, 0.1, env(0.015, 0.35)),
    ]);
    for (const f of notes) voices.push(tone('triangle', f, 0.48, 0.065, env(0.02, 0.9, { hold: 0.3 })));
    voices.push(...bell(C7, 0.48, 0.08, 1.0), tone('sine', E7, 0.55, 0.02, env(0.2, 0.8), { vibrato: { rate: 6, depth: 10 } }));
    return { reverb: 0.4, voices };
  },

  shutter: () => ({
    reverb: 0.1,
    voices: [
      noise('white', 0, 0.28, env(0.0005, 0.015), { type: 'highpass', freq: 2500 }),
      tone('sine', 3000, 0, 0.08, env(0.0005, 0.01)),
      noise('white', 0.07, 0.24, env(0.0005, 0.03), { type: 'bandpass', freq: 1800, q: 1.5 }),
      tone('sine', 600, 0.07, 0.13, env(0.001, 0.03)),
    ],
  }),
};

// ------------------------------------------------------------------------------- names and captions

const KNOWN = new Set<string>(AUDIO_CUES);

/** The cue that plays for a name: unknown names play 'chime' (contracts/effects.ts). */
export function resolveCue(name: unknown): AudioCue {
  return typeof name === 'string' && KNOWN.has(name) ? (name as AudioCue) : 'chime';
}

/** Small, repeatable random numbers (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildRecipe(cue: AudioCue, seed: number): Recipe {
  return RECIPES[cue](seededRandom(seed));
}

/** Seconds from the cue's start until its last voice has ended. */
export function recipeLength(recipe: Recipe): number {
  let end = 0;
  for (const v of recipe.voices) end = Math.max(end, v.at + v.dur);
  return end;
}

/** Captions used when the theme has none for a cue (Section 10.6: every sound cue has a caption). */
export const DEFAULT_CAPTIONS: Record<AudioCue, string> = {
  chime: 'Chime',
  'chime-rise': 'Rising chime',
  snuff: 'Soft puff of air',
  'swish-lift': 'Airy swish',
  latch: 'Latch clicks open',
  'whoosh-in': 'Whoosh toward you',
  bolt: 'Crackling bolt',
  stun: 'Sharp crack',
  shield: 'Low shimmering hum',
  patronus: 'Bright choral swell',
  mend: 'Tinkling chimes',
  fire: 'Flames roar up',
  water: 'Rushing water',
  bind: 'Stiff snap',
  slow: 'Sound slows and deepens',
  honk: 'Silly honk',
  reveal: 'Glittering shimmer',
  dispel: 'A swell that fades away',
  forget: 'Airy hush',
  blast: 'Blast',
  buzz: 'Low buzzing',
  slide: 'Scraping slide',
  grow: 'Rising stretch',
  shrink: 'Falling squeak',
  'curse-hum': 'Eerie hum',
  crackle: 'Harsh crackle',
  doom: 'Deep boom',
  fizzle: 'Fizzle',
  'arm-tick': 'Soft tick',
  'page-turn': 'Page turns',
  'unlock-tier': 'Bright fanfare',
  shutter: 'Shutter click',
};

const MAX_CAPTION = 80;

/** 'chime-rise' → 'Chime rise': a readable name for a cue nobody captioned. */
export function readableCue(name: string): string {
  const words = name.replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Sound';
}

/**
 * The caption for a cue that plays: the theme pack's text (untrusted: plain text, trimmed and
 * shortened), else the built-in one, else a readable name. It describes the sound actually heard,
 * so a pack's unknown cue name, which plays 'chime', is captioned as a chime.
 */
export function captionFor(cue: AudioCue, theme: ThemePack | null | undefined): string {
  const fromTheme = theme?.captions?.[cue];
  if (typeof fromTheme === 'string') {
    const text = fromTheme.replace(/\s+/g, ' ').trim().slice(0, MAX_CAPTION);
    if (text) return text;
  }
  return DEFAULT_CAPTIONS[cue] ?? readableCue(cue);
}
