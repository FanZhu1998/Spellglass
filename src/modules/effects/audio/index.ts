// Sound (effect.audio): every sound in Spellglass, synthesized with Web Audio (Section 7.8 "Sound
// and text", Section 12: no library, no files). Implements the audio.cue and audio.muffle steps.
//
//  - Spell sounds: on 'spell.cast' the director (director.ts) plays the spell's audio steps from the
//    bloom, so they land with the picture (CAST_SEQUENCE), and publishes effect.start/effect.end.
//  - Interface sounds: 'fizzle' at once on spell.fizzle (not for 'steering' or 'ignored'), a very soft
//    'arm-tick' when the segmenter arms, 'unlock-tier' on progress.changed with unlockedTier; the
//    shell asks for 'page-turn' and 'shutter' through 'audio.play'.
//  - Captions (Section 10.6): every cue played publishes 'audio.caption', from the theme pack's
//    captions, also while muted or while the browser keeps audio suspended.
//  - The AudioContext is created once the page is idle after start (idleWarmUp: making it costs the
//    main thread 30 to 60 ms, which must not land on the first stroke), or else on 'audio.unlock'
//    (the shell calls it on the first click or key press), on another request, or for a cue once the
//    page has had a user gesture. Browsers keep
//    audio suspended until a gesture, so while it is suspended cues are dropped, never queued to burst
//    out later; start() never waits for resume(). Without Web Audio the module still captions and
//    keeps its books, and never throws.
//  - Clip sound: 'audio.capture.start' hands out a stream of the master bus after the muffle (never
//    the microphone).
//
// Inputs:   spell.cast, spell.ended, spell.fizzle, segmenter.state, progress.changed, effect.start
//           (the stage's effects.end); sticky spellbook.changed; settings audio.volume, audio.muted,
//           access.reducedMotion.
// Outputs:  effect.start, effect.end, audio.caption.
// Requests: audio.unlock, audio.play, audio.capture.start, audio.capture.stop.

import type { AudioCue, Kernel, Module, ModuleManifest, RequestPayload, RequestResult, Spellbook, SpellbookEntry, ThemePack } from '../../../contracts';
import { CAST_SEQUENCE } from '../../../contracts';
import { describeError, emit, isReducedMotion, KernelError, lastPayload, logger, on, serve, setting, watchReducedMotion, watchSettings } from '../../../kernel';
import { buildRecipe, captionFor, recipeLength, resolveCue } from './cues';
import { AudioDirector, MAX_STEP_GAIN, timeScaleFor, type CuePlayback } from './director';
import { Scheduler, type Timers } from './scheduler';
import { AudioGraph, type Sounding } from './synth';

const log = logger('audio');

export const MANIFEST: ModuleManifest = {
  id: 'effect.audio',
  kind: 'effect',
  title: 'Sound',
  version: '1.0.0',
  contract: '^1.1',
  provides: ['audio@1'],
  requires: ['platform.audio'],
  effects: ['audio.cue', 'audio.muffle'],
};

/** Interface cues may not repeat faster than this (a flickering arm state, a burst of fizzles). */
const RETRIGGER_MS: Partial<Record<AudioCue, number>> = { 'arm-tick': 150, fizzle: 150 };
const DEFAULT_RETRIGGER_MS = 50;
/** The fanfare waits until the spell's own sound has had its moment. */
export const UNLOCK_DELAY_MS = 700;
/** Sound is scheduled this far past ctx.currentTime, so its first samples are not cut off. */
const LOOKAHEAD_S = 0.01;
/** A resume() asked for inside a click takes a few ms; cues asked for in that moment still play. */
const RESUME_GRACE_MS = 500;
/** At most this many cues sound at once; the oldest fades out to make room. */
const MAX_SOUNDING = 24;
/** Fizzles that were never casts (contracts/v1.ts FizzleReason): no cue. */
const SILENT_FIZZLES = new Set<string>(['steering', 'ignored']);

/** Test seams. The app uses the defaults. */
export interface AudioModuleDeps {
  /** Make the AudioContext; null when there is none. Default: AudioContext or webkitAudioContext. */
  createContext?: () => AudioContext | null;
  /** The page has had a user gesture (default: navigator.userActivation.hasBeenActive, else true). */
  hasBeenActive?: () => boolean;
  /** A user gesture is under way right now (default: navigator.userActivation.isActive, else true). */
  isActive?: () => boolean;
  timers?: Timers;
  /** Run `make` once the page is idle after start, and return a cancel. The app passes one (see
   *  createAudioModule); without it the context is made on the first request or gesture. */
  warmUp?: (make: () => void) => () => void;
}

/**
 * Build the AudioContext while the app is still starting, not on the first press. Constructing it
 * starts the browser's audio service, which holds the main thread for 60 to 170 ms (measured in
 * Chrome), now and then far longer: on the press that begins the first stroke, that was the one long
 * task while casting (Section 13: none over 50 ms). Done within a moment of start, it lands among the
 * other start-up work, before anyone can cast: waiting for the page to go idle is no good, since the
 * stage draws every frame and the idle deadline then fell seconds later, into the first casts. Made
 * before any gesture, the context starts suspended (Chrome notes this in the console); the first click
 * or key press then only resumes it ('audio.unlock'), which is quick.
 */
function idleWarmUp(make: () => void): () => void {
  const w = globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(make, { timeout: 300 });
    return () => w.cancelIdleCallback?.(id);
  }
  const id = setTimeout(make, 100);
  return () => clearTimeout(id);
}

export function createAudioModule(): Module {
  return new SoundModule({ warmUp: idleWarmUp }).module();
}

export function createAudioModuleWith(deps: AudioModuleDeps = {}): Module {
  return new SoundModule(deps).module();
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

class SoundModule {
  private kernel: Kernel | null = null;
  private running = false;
  private subs: (() => void)[] = [];
  /** Cancels the idle-time warm-up of the context while it is still waiting. */
  private cancelWarmUp: (() => void) | null = null;
  private ctx: AudioContext | null = null;
  private graph: AudioGraph | null = null;
  private failed = false;
  private resumingUntil = 0;
  private reduced = false;
  private watchingMotion = false;
  private volume = 0.8;
  private muted = false;
  private muffled = false;
  private book: Spellbook | null = null;
  private entries = new Map<string, SpellbookEntry>();
  private segState: string | null = null;
  private lastPlayed = new Map<string, number>();
  private sounding: Sounding[] = [];
  private captureBy = new Set<string>();
  private seed = 1;
  private readonly scheduler: Scheduler;
  private readonly director: AudioDirector;

  constructor(private readonly deps: AudioModuleDeps) {
    this.scheduler = new Scheduler(() => this.now(), deps.timers);
    this.director = new AudioDirector({
      now: () => this.now(),
      bloomDelayMs: () => (this.isReduced() ? CAST_SEQUENCE.reducedMotionBloomDelayMs : CAST_SEQUENCE.bloomDelayMs),
      entry: (id) => this.entry(id),
      emit: (type, payload) => {
        if (this.kernel) emit(this.kernel, MANIFEST.id, type, payload);
      },
      schedule: (at, fn) => this.scheduler.at(at, fn),
      play: (cue, o) => this.play(cue, o, false),
      muffle: (on) => {
        this.muffled = on;
        this.graph?.setMuffled(on);
      },
    });
  }

  module(): Module {
    return {
      manifest: MANIFEST,
      init: async (k) => this.init(k),
      start: async () => this.start(),
      stop: async () => this.stop(),
    };
  }

  // ---------------------------------------------------------------- lifecycle

  private init(k: Kernel): void {
    this.kernel = k;
    this.readVolume();
    serve(k, 'audio.unlock', () => this.unlock());
    serve(k, 'audio.play', (p) => this.playRequest(p));
    serve(k, 'audio.capture.start', (p) => this.captureStart(p));
    serve(k, 'audio.capture.stop', (p) => this.captureStop(p));
  }

  /** Subscribes and returns: no AudioContext yet (it is warmed up once the page is idle, see
   *  idleWarmUp), and nothing waits for resume(). */
  private start(): void {
    const k = this.kernel;
    if (!k || this.running) return;
    this.running = true;
    if (this.deps.warmUp && !this.ctx) {
      this.cancelWarmUp = this.deps.warmUp(() => {
        this.cancelWarmUp = null;
        if (this.running) this.context(true);
      });
    }
    this.segState = lastPayload(k, 'segmenter.state')?.state ?? null;
    this.subs.push(
      on(k, 'spell.cast', (c) => this.director.onCast(c)),
      on(k, 'spell.ended', (e) => this.director.onEnded(e)),
      on(k, 'spell.fizzle', (f) => {
        if (f && !SILENT_FIZZLES.has(f.reason)) this.playInterface('fizzle');
      }),
      on(k, 'segmenter.state', (s) => this.onSegmenter(s?.state)),
      on(k, 'progress.changed', (p) => {
        if (typeof p?.unlockedTier === 'number') this.scheduler.at(this.now() + UNLOCK_DELAY_MS, () => this.playInterface('unlock-tier'));
      }),
      on(k, 'effect.start', (e, envelope) => {
        // Finite Incantatem: the stage runs effects.end; the sound of every earlier cast ends with it.
        if (envelope.source === MANIFEST.id || e?.use !== 'effects.end') return;
        const scope = (e.params as { scope?: unknown } | undefined)?.scope;
        if (scope === 'trails') return;
        this.director.endAll(typeof e.castId === 'string' ? e.castId : null, 'effects-end');
      }),
      watchReducedMotion(k, (r) => {
        this.reduced = r;
      }),
      watchSettings(k, ['audio.volume', 'audio.muted'], () => this.readVolume()),
    );
    this.watchingMotion = true;
  }

  /** Ends every sound and opens the muffle. The AudioContext is kept: a new one would need another
   *  user gesture before it could make a sound, and an idle context costs next to nothing. */
  private stop(): void {
    if (!this.running) return;
    this.running = false;
    this.cancelWarmUp?.();
    this.cancelWarmUp = null;
    for (const off of this.subs) off();
    this.subs = [];
    this.watchingMotion = false;
    this.director.clear('reset');
    this.scheduler.clear();
    const t = this.ctx?.currentTime ?? 0;
    for (const s of this.sounding) s.stop(t, 0.05);
    this.sounding = [];
    this.segState = null;
  }

  // ---------------------------------------------------------------- state

  private now(): number {
    if (this.kernel) return this.kernel.now();
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  private isReduced(): boolean {
    if (this.watchingMotion) return this.reduced;
    return this.kernel ? isReducedMotion(this.kernel) : false;
  }

  private entry(spellId: string): SpellbookEntry | null {
    const k = this.kernel;
    if (!k) return null;
    const book = lastPayload(k, 'spellbook.changed') ?? null;
    if (book !== this.book) {
      this.book = book;
      this.entries = new Map((book?.spells ?? []).filter((e) => typeof e?.spell?.id === 'string').map((e) => [e.spell.id, e]));
    }
    return this.entries.get(spellId) ?? null;
  }

  private theme(): ThemePack | null {
    return this.kernel ? lastPayload(this.kernel, 'spellbook.changed')?.theme ?? null : null;
  }

  private readVolume(): void {
    const k = this.kernel;
    if (!k) return;
    const v = setting(k, 'audio.volume');
    this.volume = typeof v === 'number' && Number.isFinite(v) ? clamp(v, 0, 1) : 0.8;
    this.muted = setting(k, 'audio.muted') === true;
    this.graph?.setVolume(this.volume, this.muted);
  }

  private onSegmenter(state: string | undefined): void {
    // One soft tick as the tip turns gold (Section 7.4), not one per status while armed.
    if (state === 'armed' && this.segState !== 'armed') this.playInterface('arm-tick');
    this.segState = state ?? null;
  }

  // ---------------------------------------------------------------- playing

  private playInterface(cue: AudioCue): void {
    const now = this.now();
    const last = this.lastPlayed.get(cue);
    if (last !== undefined && now - last < (RETRIGGER_MS[cue] ?? DEFAULT_RETRIGGER_MS)) return;
    this.lastPlayed.set(cue, now);
    this.play(cue, { gain: 1, detune: 0, scale: 1 }, false);
  }

  /** Caption a cue and, when audio can be heard, play it now. */
  private play(name: string, o: { gain: number; detune: number; scale: number }, fromRequest: boolean): CuePlayback {
    const cue = resolveCue(name);
    if (this.kernel) emit(this.kernel, MANIFEST.id, 'audio.caption', { cue, text: captionFor(cue, this.theme()), t: this.now() });
    const seed = this.seed++;
    const recipe = buildRecipe(cue, seed);
    const timeScale = timeScaleFor(o.scale);
    const durationMs = Math.round(recipeLength(recipe) * timeScale * 1000);
    let sounding: Sounding | null = null;
    const ctx = this.context(fromRequest || this.hasBeenActive());
    if (ctx && this.graph && this.audible(ctx)) {
      try {
        sounding = this.graph.play(recipe, ctx.currentTime + LOOKAHEAD_S, { gain: o.gain, detune: o.detune, timeScale, seed });
        this.keep(sounding, ctx);
      } catch (err) {
        log.once(`audio.play.${cue}`, `could not play ${cue}`, describeError(err));
        sounding = null;
      }
    }
    return {
      played: cue,
      durationMs,
      silent: !sounding,
      stop: (fadeMs = 150) => {
        const c = this.ctx;
        if (sounding && c) sounding.stop(c.currentTime, fadeMs / 1000);
      },
    };
  }

  private keep(s: Sounding, ctx: AudioContext): void {
    const now = ctx.currentTime;
    this.sounding = this.sounding.filter((x) => x.endsAt > now);
    this.sounding.push(s);
    while (this.sounding.length > MAX_SOUNDING) this.sounding.shift()!.stop(now, 0.05);
  }

  /** Audio can be heard now, or within the grace of a resume asked for from a click. */
  private audible(ctx: AudioContext): boolean {
    return ctx.state === 'running' || this.now() < this.resumingUntil;
  }

  // ---------------------------------------------------------------- the context

  private context(allowCreate: boolean): AudioContext | null {
    if (this.ctx && this.ctx.state === 'closed') {
      this.ctx = null;
      this.graph = null;
    }
    if (this.ctx) return this.ctx;
    if (!allowCreate || this.failed) return null;
    let ctx: AudioContext | null = null;
    try {
      ctx = (this.deps.createContext ?? defaultContext)();
    } catch (err) {
      log.warn('sound is unavailable:', describeError(err).message);
    }
    if (!ctx) {
      this.failed = true;
      return null;
    }
    try {
      this.graph = new AudioGraph(ctx, { volume: this.volume, muted: this.muted, muffled: this.muffled });
    } catch (err) {
      log.warn('the sound graph could not be built', describeError(err));
      this.failed = true;
      try {
        void ctx.close().catch(() => {});
      } catch {
        /* nothing to close */
      }
      return null;
    }
    this.ctx = ctx;
    ctx.onstatechange = () => {
      if (ctx.state === 'running') this.resumingUntil = 0;
    };
    return ctx;
  }

  /** Ask the context to run. From a click, cues played in the next moment are kept (see audible). */
  private resume(fromGesture: boolean): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    if (fromGesture) this.resumingUntil = this.now() + RESUME_GRACE_MS;
    try {
      void Promise.resolve(ctx.resume()).catch(() => {});
    } catch {
      /* not allowed yet: the next gesture tries again */
    }
  }

  private hasBeenActive(): boolean {
    if (this.deps.hasBeenActive) return this.deps.hasBeenActive();
    const ua = userActivation();
    return ua?.hasBeenActive !== false;
  }

  private isActive(): boolean {
    if (this.deps.isActive) return this.deps.isActive();
    const ua = userActivation();
    return ua?.isActive !== false;
  }

  // ---------------------------------------------------------------- requests

  private unlock(): RequestResult<'audio.unlock'> {
    const ctx = this.context(true);
    if (!ctx) return { state: 'unavailable' };
    this.resume(this.isActive());
    return { state: ctx.state };
  }

  private playRequest(p: RequestPayload<'audio.play'>): void {
    if (!p || typeof p.cue !== 'string') throw new KernelError('invalid-payload', 'audio.play needs a cue name.');
    const ctx = this.context(true);
    if (ctx && ctx.state !== 'running') this.resume(this.isActive());
    const gain = typeof p.gain === 'number' && Number.isFinite(p.gain) ? clamp(p.gain, 0, MAX_STEP_GAIN) : 1;
    this.play(p.cue, { gain, detune: 0, scale: 1 }, true);
  }

  private captureStart(p: RequestPayload<'audio.capture.start'>): RequestResult<'audio.capture.start'> {
    if (!p || typeof p.requester !== 'string' || !p.requester) throw new KernelError('invalid-payload', 'audio.capture.start needs a requester.');
    const ctx = this.context(true);
    let stream = ctx && this.graph ? this.graph.startCapture() : null;
    if (!stream) {
      // No Web Audio: an empty stream lets a clip record without sound instead of failing.
      if (typeof MediaStream !== 'function') throw new KernelError('not-supported', 'Sound cannot be recorded in this browser.');
      stream = new MediaStream();
    }
    this.captureBy.add(p.requester);
    if (ctx && ctx.state !== 'running') this.resume(this.isActive());
    return { stream };
  }

  private captureStop(p: RequestPayload<'audio.capture.stop'>): void {
    if (p && typeof p.requester === 'string') this.captureBy.delete(p.requester);
    if (this.captureBy.size === 0) this.graph?.stopCapture();
  }
}

function defaultContext(): AudioContext | null {
  const g = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  return typeof Ctor === 'function' ? new Ctor({ latencyHint: 'interactive' }) : null;
}

function userActivation(): { hasBeenActive?: boolean; isActive?: boolean } | undefined {
  try {
    const nav = (globalThis as { navigator?: { userActivation?: { hasBeenActive?: boolean; isActive?: boolean } } }).navigator;
    return nav?.userActivation;
  } catch {
    return undefined;
  }
}
