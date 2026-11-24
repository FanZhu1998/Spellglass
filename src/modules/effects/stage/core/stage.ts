// The stage core (effect.stage): the mirror's picture. It owns the elements inside the mirror, the
// animation frame, every renderer and the director, and speaks to the rest of the app only through
// events and requests (Section 5).
//
// Order of drawing each frame (both layers are cleared first):
//   shade (normal blend): room dimming, vignette and glass sheen, the shelf and its props, dust and
//          smoke, dull ink, text shadows
//   light (screen blend): the ink trail, the tip, orbs and flashes, particles, bolts, the shield,
//          the creature, revealed traces, inscriptions, the practice guide
//
// Headless mode (no DOM, no timers) lets Node tests drive the same code through tick().

import type {
  Anchor, CameraReady, CameraStatus, EffectEvent, Kernel, Module, ModuleManifest, Point, PracticeAttempt, PracticeFocus,
  PracticeGuide as PracticeGuideEvent, RecognitionDetail, RequestPayload, RequestResult, SceneProps, SegmenterStatus,
  SpellbookEntry, SpellCast, SpellEnded, SpellFizzle, Spellbook, SpellPending, StageSurface, Stroke, ThemePack, TipSample,
} from '../../../../contracts';
import { CAST_SEQUENCE, EFFECT_LIMITS } from '../../../../contracts';
import {
  ask, describeError, emit, gesturePaceMs, geometry, KernelError, lastPayload, logger, newId, on, serve, setting,
  watchReducedMotion, watchSettings,
} from '../../../../kernel';
import type { FrameInfo, Layers, PropView, Shelf, StageServices } from '../types';
import { resolveAnchor, type AnchorContext, type XY } from './anchors';
import { ClipCompositor } from './capture';
import { isColor } from './color';
import { Creature, CreatureRenderer } from './creature';
import { Director } from './director';
import { createStageDom, exposureFilter, type StageDom } from './dom';
import { paintGlass, reflectionFilter } from './glass';
import { InkLayer, type InkStroke, type InkStyle } from './ink';
import { LightLayer } from './light';
import { cleanText, scaleParticleCount, wrapText } from './limits';
import { guidePath, pointAlong, settleTarget, toCurrentAspect } from './morph';
import { ParticleSystem } from './particles';
import { PracticeGuide } from './practice';
import { createRandom, pick, type Random } from './random';
import { cleanReplayPoints, pointAtIndex, REPLAY_MAX_EFFECT_MS, REPLAY_TAIL_MS, replayIndex } from './replay';
import { createStepDefs, type StageWorld } from './runners';
import { RevealControl, ShakeControl, TimeControl } from './scene-fx';
import { buildSceneProps, scenePropsDiffer } from './scene-props';
import { Scheduler } from './scheduler';
import { Bolt, drawBolt, drawShield, Shield } from './shapes';
import { makeCanvas, Sprites } from './sprites';
import { BUILT_IN_HIDDEN_INK, TextLayer } from './text';
import { TipView } from './tip';
import { pixelRatioFor, View, type StageQuality } from './view';

const log = logger('stage');

export const STAGE_ID = 'effect.stage';
const DEFAULT_CANDLE = '#F2B84B';
const DEFAULT_VELLUM = '#E9DFC7';

export interface StageOptions {
  /** The mirror element; null in tests. */
  host: HTMLElement | null;
  shelf: Shelf;
  seed?: number;
  /** No DOM, no animation frames and no timers: tests drive it with tick(). */
  headless?: boolean;
}

interface ReplaySession {
  inkId: string;
  spellId: string;
  points: Point[];
  durationMs: number;
  start: number;
  plain: boolean;
  /** Last whole point added to the ink. */
  fed: number;
  /** The replay's tip, which stands in for the live one for the replay's own cast. */
  tip: XY | null;
  /** The cast the replay plays (spell.cast with replay: true), once the engine has made it. */
  castId: string | null;
  aborted: boolean;
}

/** Both layers start every frame clear and in a known state (types.ts Layers). */
function clearLayer(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, width, height);
}

/** Inverse of replayIndex's ease: when the replayed tip passes point `index`. */
export function replayTimeAt(index: number, durationMs: number, count: number): number {
  if (count <= 1) return 0;
  const u = Math.min(1, Math.max(0, index / (count - 1)));
  return (Math.acos(1 - 2 * u) / Math.PI) * durationMs;
}

export class StageCore implements StageWorld {
  kernel: Kernel | null = null;
  running = false;
  readonly view = new View();
  readonly sprites = new Sprites();
  readonly random: Random;
  readonly particles: ParticleSystem;
  readonly ink: InkLayer;
  readonly light = new LightLayer();
  shields: Shield[] = [];
  bolts: Bolt[] = [];
  creatures: Creature[] = [];
  readonly time = new TimeControl();
  readonly shake: ShakeControl;
  readonly reveal = new RevealControl();
  readonly text = new TextLayer();
  readonly guide = new PracticeGuide();
  readonly tip = new TipView();
  readonly scheduler = new Scheduler();
  readonly services: StageServices;
  readonly frame: FrameInfo = { now: 0, dt: 0, rawDt: 0, timeScale: 1, reducedMotion: false, quality: 'high' };
  readonly clips = new ClipCompositor();
  private readonly creatureRenderer = new CreatureRenderer();
  private readonly directorInstance: Director;
  private readonly shelf: Shelf;
  private dom: StageDom | null = null;
  private overlay: HTMLCanvasElement | null = null;
  /** Reused every frame, so drawing allocates nothing (Section 13 budget: 60 fps on integrated graphics). */
  private layers: Layers | null = null;
  private readonly inkStyle: InkStyle = { highContrast: false, reducedMotion: false, quality: 'high' };
  private readonly revealPoint: XY = { x: 0, y: 0 };

  // Settings, cached (read in hot paths).
  private reduced = false;
  private highContrast = false;
  private quality: StageQuality = 'auto';
  private adaptiveLow = false;
  private drawCost = 0;
  private lostMs = 200;
  private flipX = true;
  private candleColor = DEFAULT_CANDLE;
  private vellumColor = DEFAULT_VELLUM;

  private entries = new Map<string, SpellbookEntry>();
  private theme: ThemePack | null = null;
  private seg: SegmenterStatus | null = null;
  private inkId: string | null = null;
  /** Recent strokes' points by id (stroke.end), for practice overlays and late casts. */
  private strokes = new Map<string, Point[]>();
  private steeringCastId: string | null = null;
  private replaySession: ReplaySession | null = null;
  private ended = new Set<string>();

  private cam = { requested: false, ready: null as CameraReady | null, filter: '' };
  private propsDirty = false;
  private propsRevision = 0;
  private lastProps: SceneProps | undefined;
  private surfaceKey = '';

  private subs: (() => void)[] = [];
  private raf = 0;
  private backup: ReturnType<typeof setInterval> | null = null;
  private lastFrame = 0;
  private lastTickAt = -Infinity;
  private observer: ResizeObserver | null = null;
  private sleepers = new Set<() => void>();
  private errors = new Set<string>();
  private readonly onVisibility = () => this.ensureLoop();
  private readonly onVideoResize = () => this.updateView();

  constructor(private readonly manifest: ModuleManifest, private readonly opts: StageOptions) {
    this.random = createRandom(opts.seed ?? (Date.now() >>> 0));
    this.particles = new ParticleSystem(this.random, () => this.reduced);
    this.ink = new InkLayer(this.random);
    this.shake = new ShakeControl(this.random);
    this.shelf = opts.shelf;
    const self = this;
    this.services = {
      view: this.view,
      particles: this.particles,
      tip: (castId?: string) => self.tipFor(castId),
      glow: (color: string) => self.sprites.glow(isColor(color) ? color : '#ffffff'),
      now: () => self.now(),
      random: this.random,
      propsChanged: () => self.markProps(),
      revealAlpha: () => self.reveal.alpha(self.now()),
    };
    this.directorInstance = new Director({
      now: () => this.now(),
      reducedMotion: () => this.reduced,
      entry: (id) => this.entries.get(id) ?? null,
      emit: (type, payload) => this.emitEffect(type, payload),
      steps: createStepDefs(this),
      fallback: (cast) => this.fallbackSparkle(cast),
      schedule: (at, fn) => {
        const cancel = this.scheduler.at(at, fn);
        this.wake();
        return cancel;
      },
      onSteering: (castId, spellId) => this.onSteering(castId, spellId),
    });
  }

  // ---------------------------------------------------------------- module lifecycle

  module(): Module {
    return {
      manifest: this.manifest,
      init: async (k) => this.init(k),
      start: async () => this.start(),
      stop: async () => this.stop(),
    };
  }

  init(k: Kernel): void {
    this.kernel = k;
    serve(k, 'stage.reset', () => {
      this.resetShelf();
    });
    serve(k, 'stage.replay', (p) => this.playReplay(p));
    serve(k, 'stage.capture.start', (p) => this.startCapture(p));
    serve(k, 'stage.capture.stop', (p) => {
      if (p && typeof p.requester === 'string') this.clips.stop(p.requester);
    });
  }

  start(): void {
    const k = this.kernel;
    if (!k || this.running) return;
    this.running = true;
    if (!this.opts.headless && this.opts.host && !this.dom) {
      this.dom = createStageDom(this.opts.host);
      this.dom?.video.addEventListener('resize', this.onVideoResize);
      this.dom?.video.addEventListener('loadedmetadata', this.onVideoResize);
    }
    this.readSettings();
    // Start loading the display face now; the theme's own face (if any) follows with the spellbook.
    this.text.ensureFont(undefined);
    const book = lastPayload(k, 'spellbook.changed');
    if (book) this.onSpellbook(book);
    this.subscribe(k);
    const focus = lastPayload(k, 'practice.focus');
    if (focus) this.onFocus(focus);
    if (this.dom && typeof ResizeObserver === 'function' && this.opts.host) {
      this.observer = new ResizeObserver(() => this.updateView());
      this.observer.observe(this.opts.host);
    }
    if (!this.opts.headless && typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
    this.updateView();
    this.publishSurface(true);
    this.publishProps(true);
    this.lastFrame = this.now();
    this.ensureLoop();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const off of this.subs) off();
    this.subs = [];
    if (this.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.backup) clearInterval(this.backup);
    this.backup = null;
    this.observer?.disconnect();
    this.observer = null;
    if (!this.opts.headless && typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.replaySession) this.replaySession.aborted = true;
    for (const wake of [...this.sleepers]) wake();
    if (this.cam.requested && this.kernel) {
      this.cam.requested = false;
      void ask(this.kernel, 'camera.stop', { requester: STAGE_ID }).catch(() => {});
    }
    this.unbindCamera();
    this.directorInstance.clear('reset');
    this.scheduler.clear();
    this.clearPictures();
    this.clips.stopAll();
    this.dom?.setShake(0, 0, 1);
    // No more frames will come: leave clear glass, not the last frame frozen on it.
    if (this.dom) {
      clearLayer(this.dom.shadeCtx, this.dom.shade.width, this.dom.shade.height);
      clearLayer(this.dom.lightCtx, this.dom.light.width, this.dom.light.height);
    }
    if (this.steeringCastId && this.kernel) emit(this.kernel, STAGE_ID, 'stage.steering', { castId: null });
    this.steeringCastId = null;
  }

  // ---------------------------------------------------------------- StageWorld

  now(): number {
    return this.kernel ? this.kernel.now() : typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  reducedMotion(): boolean {
    return this.reduced;
  }

  aspect(): number {
    return this.view.casterAspect;
  }

  /** The live tip, or null while it is out of view. */
  liveTip(): XY | null {
    return this.tip.inView(this.now(), this.lostMs) ? { x: this.tip.x, y: this.tip.y } : null;
  }

  /** True for the cast a replay is playing while it plays. */
  private replays(castId: string | undefined): boolean {
    return !!castId && !!this.replaySession && this.replaySession.castId === castId;
  }

  /** The tip an effect of cast `castId` follows: the replay's tip stands in for the live one only for
   *  the replay's own cast. Everything else on the glass (a live Lumos, a prop the player steers)
   *  keeps the live tip, so it never traces the replayed stroke. */
  tipFor(castId: string | undefined): XY | null {
    return this.replays(castId) ? this.replaySession!.tip : this.liveTip();
  }

  tipOf(cast: SpellCast): XY | null {
    return this.tipFor(cast.id);
  }

  anchorContext(cast: SpellCast): AnchorContext {
    const target = this.targetOf(cast);
    const replayed = this.replays(cast.id);
    return {
      aim: cast.aim && Number.isFinite(cast.aim.x) && Number.isFinite(cast.aim.y) ? cast.aim : { x: 0.5, y: 0.5 },
      tip: this.tipFor(cast.id),
      lastTip: replayed ? this.replaySession!.tip : this.tip.last(),
      target: target ? { x: target.x, y: target.y } : null,
    };
  }

  at(anchor: Anchor | undefined, cast: SpellCast, fallback: Anchor): XY {
    return resolveAnchor(anchor ?? fallback, this.anchorContext(cast), fallback);
  }

  targetOf(cast: SpellCast): PropView | null {
    return cast.targetId ? this.shelf.props.find((p) => p.id === cast.targetId) ?? null : null;
  }

  props(): readonly PropView[] {
    return this.shelf.props;
  }

  director(): Director {
    return this.directorInstance;
  }

  markProps(): void {
    this.propsDirty = true;
    // No frames coming (hidden tab, tests): publish soon anyway, so the engine targets correctly.
    if (!this.raf) queueMicrotask(() => this.publishProps());
  }

  hiddenInkLine(): string {
    const lines = (this.theme?.hidden_ink ?? []).map(cleanText).filter(Boolean);
    return pick(this.random, lines.length ? lines : BUILT_IN_HIDDEN_INK) ?? BUILT_IN_HIDDEN_INK[0];
  }

  candle(): string {
    return this.candleColor;
  }

  sparkle(at: XY, count: number): void {
    this.particles.spawn({ preset: 'stars', x: at.x, y: at.y, count: scaleParticleCount(count, this.reduced), speed: 0.9 });
  }

  // ---------------------------------------------------------------- events

  private subscribe(k: Kernel): void {
    this.subs.push(
      on(k, 'tip.filtered', (s) => this.onTip(s)),
      on(k, 'tip.lost', () => this.tip.lost(this.now())),
      on(k, 'segmenter.state', (s) => this.onSegmenter(s)),
      on(k, 'stroke.begin', (s) => this.onStrokeBegin(s)),
      on(k, 'stroke.end', (s) => this.onStrokeEnd(s)),
      on(k, 'spell.pending', (p) => this.onPending(p)),
      on(k, 'spell.cast', (c) => this.onCast(c)),
      on(k, 'spell.fizzle', (f) => this.onFizzle(f)),
      on(k, 'spell.ended', (e) => this.onEnded(e)),
      on(k, 'practice.focus', (f) => this.onFocus(f)),
      on(k, 'practice.guide', (g) => this.onGuide(g)),
      on(k, 'practice.attempt', (a) => this.onAttempt(a)),
      on(k, 'spellbook.changed', (b) => this.onSpellbook(b)),
      on(k, 'camera.ready', (c) => this.onCameraReady(c)),
      on(k, 'camera.stopped', () => this.unbindCamera()),
      on(k, 'camera.status', (s) => this.onCameraStatus(s)),
      watchReducedMotion(k, (r) => {
        this.reduced = r;
      }),
      watchSettings(k, ['access.highContrastTrail', 'stage.quality', 'segmenter.lostMs', 'capture.flipX', 'theme.accent'], () => this.readSettings()),
      watchSettings(k, ['capture.consent', 'capture.mirror'], () => this.syncCamera()),
    );
  }

  private readSettings(): void {
    const k = this.kernel;
    if (!k) return;
    this.highContrast = setting(k, 'access.highContrastTrail') === true;
    const q = setting(k, 'stage.quality');
    this.quality = q === 'high' || q === 'low' ? q : 'auto';
    const lost = setting(k, 'segmenter.lostMs');
    this.lostMs = typeof lost === 'number' && lost > 0 ? lost : 200;
    this.flipX = setting(k, 'capture.flipX') !== false;
    this.applyTheme();
    this.applyVideo();
    this.updateView();
    // capture.flipX changes StageSurface.videoMirrored without changing the view, so updateView
    // alone would not republish; the surface key skips the publish when nothing changed.
    this.publishSurface();
  }

  private onTip(s: TipSample): void {
    const now = this.now();
    this.tip.sample(s, now);
    // Replays ignore live input; while something steers, the tip moves it and leaves no ink.
    if (this.replaySession || this.steeringCastId || this.seg?.state !== 'tracing') return;
    const ink = this.currentInk(now);
    if (ink) this.ink.add(ink, s.x, s.y, s.t, this.view.casterAspect);
  }

  /** The ink of the stroke being traced, started if needed. */
  private currentInk(now: number): InkStroke | null {
    const current = this.inkId ? this.ink.get(this.inkId) : undefined;
    if (current && current.state === 'wet') return current;
    const id = this.seg?.strokeId ?? newId('ink');
    this.inkId = id;
    return this.ink.begin(id, now);
  }

  private onSegmenter(st: SegmenterStatus): void {
    const now = this.now();
    const prev = this.seg;
    this.seg = st;
    this.tip.segmenter(st, now);
    if (st.state === 'tracing' && !this.replaySession && !this.steeringCastId) {
      const current = this.inkId ? this.ink.get(this.inkId) : undefined;
      if (st.strokeId && current && current.state === 'wet' && current.id !== st.strokeId) {
        // The ink began before the stroke had its id: take the id, so the cast finds it.
        if (current.id.startsWith('ink-')) current.id = st.strokeId;
        else this.ink.end(current, now);
      }
      if (st.strokeId) this.inkId = st.strokeId;
    }
    if (prev?.state === 'tracing' && st.state !== 'tracing') {
      const current = this.inkId ? this.ink.get(this.inkId) : undefined;
      if (current) this.ink.end(current, now);
    }
    if ((st.discarded || st.captured) && st.strokeId) {
      // Too short, too small, or taken by the Workshop: the ink just fades.
      const ink = this.ink.get(st.strokeId);
      if (ink) this.ink.fade(ink, now);
    }
  }

  private onStrokeBegin(s: Stroke): void {
    if (this.replaySession || this.steeringCastId) return;
    const current = this.inkId ? this.ink.get(this.inkId) : undefined;
    if (current && current.state === 'wet' && current.id.startsWith('ink-')) current.id = s.id;
    this.inkId = s.id;
    // Tracing begins once the tip leaves the arm radius, but the stroke starts where it was held still:
    // seed fresh ink with that lead-in so it does not start a radius late. The stroke's last point
    // arrives next as tip.filtered. (Pen mode strokes begin with no points.)
    const lead = Array.isArray(s.points) ? s.points.slice(0, -1) : [];
    if (!lead.length) return;
    const ink = this.ink.begin(s.id, this.now());
    if (ink.state !== 'wet' || ink.points.length) return;
    for (const p of lead) {
      if (Number.isFinite(p?.x) && Number.isFinite(p?.y)) this.ink.add(ink, p.x, p.y, p.t, this.view.casterAspect);
    }
  }

  private onStrokeEnd(s: Stroke): void {
    if (Array.isArray(s.points) && s.points.length) {
      this.strokes.set(s.id, s.points.map((p) => [p.x, p.y] as Point));
      while (this.strokes.size > 8) this.strokes.delete(this.strokes.keys().next().value as string);
    }
    const ink = this.ink.get(s.id);
    if (ink) this.ink.end(ink, this.now());
  }

  private onPending(p: SpellPending): void {
    const ink = p?.strokeId ? this.ink.get(p.strokeId) : undefined;
    if (ink) this.ink.setPending(ink, true, this.now(), typeof p.until === 'number' ? p.until : undefined);
  }

  private onCast(cast: SpellCast): void {
    if (!cast || typeof cast.id !== 'string' || typeof cast.spellId !== 'string') return;
    const now = this.now();
    const entry = this.entries.get(cast.spellId) ?? null;
    // The replay's own cast: its effects follow the replay's tip (tipFor).
    if (cast.replay && this.replaySession && this.replaySession.castId === null) this.replaySession.castId = cast.id;
    // 1 and 2: the ink settles into the clean shape and brightens.
    this.settleInk(cast, entry, now);
    // 3: the incantation writes itself, once the ink has settled.
    this.writeIncantation(cast, entry, now);
    // 4: the effect blooms (the director counts every delay from the bloom).
    this.directorInstance.onCast(cast);
    this.wake();
  }

  private settleInk(cast: SpellCast, entry: SpellbookEntry | null, now: number): void {
    const aspect = this.view.casterAspect;
    let ink: InkStroke | undefined;
    if (cast.replay && this.replaySession) ink = this.ink.get(this.replaySession.inkId);
    if (!ink && cast.strokeId) ink = this.ink.get(cast.strokeId);
    const points = ink && ink.points.length >= 2 ? ink.asPoints() : cast.strokeId ? this.strokes.get(cast.strokeId) ?? null : null;
    const target = settleTarget(points, cast, entry, aspect);
    if (ink) {
      if (target) this.ink.settle(ink, target, now, aspect, this.reduced);
      else this.ink.fade(ink, now);
    } else if (target) {
      // No ink on the glass (voice only): sketch the gesture's clean shape at the aim.
      this.ink.sketch(`sketch-${cast.id}`, target, now, aspect, this.reduced);
    }
  }

  private writeIncantation(cast: SpellCast, entry: SpellbookEntry | null, now: number): void {
    const raw = cast.variant ?? cast.incantation ?? entry?.spell.incantation ?? cast.spellId;
    const line = wrapText(raw, EFFECT_LIMITS.maxTextChars, 1)[0];
    if (!line) return;
    this.text.writeIncantation(line, this.candleColor, now + (this.reduced ? 0 : CAST_SEQUENCE.settleMs), this.reduced);
  }

  private onFizzle(f: SpellFizzle): void {
    const ink = f?.strokeId ? this.ink.get(f.strokeId) : undefined;
    if (!ink) return;
    // Steering and ignored strokes were never casts: no drip, just a quiet fade.
    const drip = f.reason !== 'steering' && f.reason !== 'ignored';
    this.ink.fizzle(ink, this.now(), drip, this.reduced);
  }

  private onEnded(e: SpellEnded): void {
    if (!e || typeof e.castId !== 'string') return;
    this.ended.add(e.castId);
    if (this.ended.size > 64) this.ended.delete(this.ended.values().next().value as string);
    this.directorInstance.onEnded(e);
    this.wake();
  }

  private onFocus(f: PracticeFocus): void {
    if (!f || !f.spellId) {
      this.guide.clear();
      return;
    }
    this.showGuide(f.spellId);
  }

  private showGuide(spellId: string): void {
    const entry = this.entries.get(spellId) ?? null;
    const path = guidePath(entry, this.view.casterAspect);
    const pace = entry ? gesturePaceMs(entry.spell.gesture) : 1000;
    this.guide.show(spellId, path, pace, this.now());
  }

  private onGuide(g: PracticeGuideEvent): void {
    if (!g || typeof g.spellId !== 'string') return;
    if (this.guide.spellId !== g.spellId) this.showGuide(g.spellId);
    this.guide.setSlow(g.slow === true, this.now());
  }

  private onAttempt(a: PracticeAttempt): void {
    if (!a?.strokeId) return;
    const points = this.strokes.get(a.strokeId) ?? this.ink.get(a.strokeId)?.asPoints();
    if (points && points.length >= 2) this.guide.showAttempt(points, a.stray, this.now());
  }

  private onSpellbook(book: Spellbook): void {
    this.entries = new Map((book?.spells ?? []).map((e) => [e.spell.id, e]));
    this.theme = book?.theme ?? null;
    this.applyTheme();
    this.text.ensureFont(this.theme?.fonts?.display);
    // The guide's template may have changed (a redraw, the left-handed switch).
    if (this.guide.spellId) this.showGuide(this.guide.spellId);
  }

  private applyTheme(): void {
    const tokens = this.theme?.tokens ?? {};
    const accentKey = this.kernel ? setting(this.kernel, 'theme.accent') : 'default';
    const accent = accentKey && accentKey !== 'default' ? this.theme?.accents?.[accentKey] : undefined;
    const candle = accent?.candle ?? tokens.candle;
    this.candleColor = isColor(candle) ? candle : DEFAULT_CANDLE;
    this.vellumColor = isColor(tokens.vellum) ? tokens.vellum : DEFAULT_VELLUM;
  }

  private onSteering(castId: string | null, spellId?: string): void {
    this.steeringCastId = castId;
    if (castId) {
      // Steering draws no ink: the stroke in progress, if any, fades.
      const current = this.inkId ? this.ink.get(this.inkId) : undefined;
      if (current && current.state === 'wet') this.ink.fade(current, this.now());
    }
    if (this.kernel) emit(this.kernel, STAGE_ID, 'stage.steering', castId ? { castId, ...(spellId ? { spellId } : {}) } : { castId: null });
  }

  private emitEffect(type: 'effect.start' | 'effect.end', payload: EffectEvent): void {
    if (this.kernel) emit(this.kernel, STAGE_ID, type, payload);
  }

  private fallbackSparkle(cast: SpellCast): Record<string, unknown> {
    // Section 9.1 rule 3 and contracts/effects.ts: a 24-star burst at the tip (the audio module chimes).
    const at = this.at('tip', cast, 'aim');
    const count = scaleParticleCount(24, this.reduced);
    this.particles.spawn({ preset: 'stars', x: at.x, y: at.y, count, speed: 1.1 });
    return { preset: 'stars', at: 'tip', count };
  }

  // ---------------------------------------------------------------- camera and surface

  private wantCamera(): boolean {
    const k = this.kernel;
    return !!k && this.running && setting(k, 'capture.consent') === true && setting(k, 'capture.mirror') === true;
  }

  /** Ask for the camera while the player wants a reflection, release it otherwise. Never awaited. */
  private syncCamera(): void {
    const k = this.kernel;
    if (!k) return;
    const want = this.wantCamera();
    if (want && !this.cam.requested) {
      this.cam.requested = true;
      ask(k, 'camera.start', { requester: STAGE_ID, exposure: 'auto' }).then(
        (ready) => {
          if (!this.cam.requested || !this.running) {
            void ask(k, 'camera.stop', { requester: STAGE_ID }).catch(() => {});
            return;
          }
          this.bindCamera(ready);
        },
        (err) => {
          // A plain backdrop it is; a later camera.ready (after "Try again") brings the reflection back.
          log.info('the mirror shows no camera:', describeError(err).name);
        },
      );
    } else if (!want && this.cam.requested) {
      this.cam.requested = false;
      void ask(k, 'camera.stop', { requester: STAGE_ID }).catch(() => {});
      this.unbindCamera();
    }
  }

  private onCameraReady(c: CameraReady): void {
    if (this.wantCamera()) this.bindCamera(c);
  }

  private bindCamera(c: CameraReady): void {
    if (!c?.stream) return;
    if (this.cam.ready && this.cam.ready.stream === c.stream && this.cam.ready.generation === c.generation) return;
    this.cam.ready = c;
    this.dom?.setStream(c.stream);
    this.applyVideo();
    this.updateView();
    this.publishSurface(true);
  }

  private unbindCamera(): void {
    if (!this.cam.ready) return;
    this.cam.ready = null;
    this.dom?.setStream(null);
    this.applyVideo();
    this.updateView();
    this.publishSurface(true);
  }

  private onCameraStatus(s: CameraStatus): void {
    // A short manual exposure turns the room nearly black; lift the reflection so it is still the stage.
    this.cam.filter = exposureFilter(s?.exposure);
    this.applyVideo();
  }

  private videoShown(): boolean {
    return !!this.cam.ready && !(this.replaySession && this.replaySession.plain);
  }

  private applyVideo(): void {
    if (!this.dom) return;
    this.dom.setVideoShown(this.videoShown(), this.flipX);
    // The reflection as the glass shows it: the exposure lift, then the old silver's grade (glass.ts),
    // which high contrast leaves off. Clips that include the camera keep only the lift: filtering every
    // recorded frame costs several times the plain copy where canvases are drawn in software.
    this.dom.setVideoFilter(reflectionFilter(this.cam.filter, this.highContrast));
  }

  private cameraAspect(): number | null {
    const c = this.cam.ready;
    if (!c) return null;
    const v = this.dom?.video;
    if (v && v.videoWidth > 0 && v.videoHeight > 0) return v.videoWidth / v.videoHeight;
    return c.width > 0 && c.height > 0 ? c.width / c.height : null;
  }

  private updateView(): void {
    if (!this.dom) {
      // Headless: a nominal 16:9 mirror so geometry and scene.props have an aspect.
      if (this.view.width === 0) this.view.update(1280, 720, 1, this.cameraAspect());
      return;
    }
    const { width, height } = this.dom.measure();
    const dpr = pixelRatioFor(this.quality, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const before = this.view.casterAspect;
    if (!this.view.update(width, height, dpr, this.cameraAspect())) return;
    this.dom.resize(this.view);
    this.renderOverlay();
    this.particles.setAspect(this.view.casterAspect);
    if (this.guide.spellId && Math.abs(before - this.view.casterAspect) > 1e-6) this.showGuide(this.guide.spellId);
    this.publishSurface();
    this.markProps();
  }

  /** Sticky 'stage.surface': republished on resize, camera change and layer change. */
  private publishSurface(force = false): void {
    const k = this.kernel;
    const dom = this.dom;
    if (!k || !dom || !this.opts.host || !this.running) return;
    const v = this.view;
    const shown = this.videoShown();
    const key = [v.width, v.height, v.dpr, v.caster.x, v.caster.y, v.caster.width, v.caster.height, v.casterAspect, shown, this.flipX].join('|');
    if (!force && key === this.surfaceKey) return;
    this.surfaceKey = key;
    const surface: StageSurface = {
      mirror: this.opts.host,
      caster: { ...v.caster },
      aspect: v.casterAspect,
      video: shown ? dom.video : null,
      videoMirrored: this.flipX,
      layers: [
        { canvas: dom.shade, blend: 'normal' },
        { canvas: dom.light, blend: 'screen' },
      ],
      width: v.width,
      height: v.height,
      dpr: v.dpr,
    };
    emit(k, STAGE_ID, 'stage.surface', surface);
  }

  /** Sticky 'scene.props', at most once a frame (and whenever a prop reports a change). */
  private publishProps(force = false): void {
    const k = this.kernel;
    if (!k || !this.running) return;
    if (!force && !this.propsDirty) return;
    this.propsDirty = false;
    const next = buildSceneProps(this.shelf.props, this.propsRevision + 1, this.view.casterAspect);
    if (!force && !scenePropsDiffer(this.lastProps, next)) return;
    this.propsRevision = next.revision;
    this.lastProps = next;
    emit(k, STAGE_ID, 'scene.props', next);
  }

  /** Put every prop back on the shelf (request 'stage.reset', and after a replay). */
  resetShelf(): void {
    this.directorInstance.endWhere((a) => a.use.startsWith('prop.') || (a.use === 'time.slow' && a.params.scope === 'target'), 'reset');
    for (const p of this.shelf.props) {
      try {
        p.reset();
      } catch (err) {
        this.logOnce(`reset:${p.id}`, err);
      }
      p.timeScale = 1;
    }
    this.propsDirty = true;
    this.publishProps(true);
  }

  // ---------------------------------------------------------------- the loop

  /** Keep animation frames coming while visible; a slow backup tick keeps timing when hidden. */
  private ensureLoop(): void {
    if (!this.running || this.opts.headless) return;
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    if (visible && !this.raf && typeof requestAnimationFrame === 'function') {
      this.lastFrame = this.now();
      this.raf = requestAnimationFrame(this.onFrame);
    }
    if (!visible && this.raf && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (!this.backup) {
      this.backup = setInterval(() => {
        const now = this.now();
        if (now - this.lastTickAt > 240) this.tick(now, false);
      }, 250);
    }
  }

  /** Something was scheduled: make sure a tick comes. */
  private wake(): void {
    if (this.opts.headless) return;
    this.ensureLoop();
  }

  private readonly onFrame = () => {
    this.raf = 0;
    if (!this.running) return;
    this.tick(this.now(), true);
    this.ensureLoop();
  };

  /** One step of the stage: run due steps, advance every picture, then draw. Public for tests. */
  tick(now: number, draw = !!this.dom): void {
    try {
      const rawDt = Math.min(100, Math.max(0, now - this.lastFrame));
      this.lastFrame = now;
      this.lastTickAt = now;
      this.time.update(now);
      const timeScale = this.time.global(now);
      const f = this.frame;
      f.now = now;
      f.rawDt = rawDt;
      f.timeScale = timeScale;
      f.dt = rawDt * timeScale;
      f.reducedMotion = this.reduced;
      f.quality = this.quality === 'auto' ? (this.adaptiveLow ? 'low' : 'high') : this.quality;

      this.scheduler.poll(now);
      this.directorInstance.tick(now);
      this.feedReplay(now);

      this.particles.setAspect(this.view.casterAspect);
      this.light.update(now, rawDt, rawDt);
      this.particles.update(f.dt);
      for (const c of this.creatures) c.update(now, f.dt, this.view.casterAspect, this.particles, this.reduced);
      // Rebuild the lists only when something has gone, so an ordinary frame allocates nothing.
      if (this.creatures.some((c) => c.gone())) this.creatures = this.creatures.filter((c) => !c.gone());
      if (this.shields.some((s) => s.gone(now))) this.shields = this.shields.filter((s) => !s.gone(now));
      if (this.bolts.some((b) => b.done(now))) this.bolts = this.bolts.filter((b) => !b.done(now));
      this.reveal.update(now);
      this.shake.update(now);
      this.text.update(now);
      this.ink.update(now);
      for (const p of this.shelf.props) {
        p.timeScale = this.time.forProp(p.id, now);
        try {
          p.update(f, this.services);
        } catch (err) {
          this.logOnce(`update:${p.id}`, err);
        }
      }
      this.publishProps();

      const shake = this.shake.offset(now, this.reduced);
      // The mirror is nudged by the shake and grown just enough that its edges never show; the
      // growth follows the offset, so it eases away as the shake decays (no zoom jump at the end).
      const reach = Math.max(Math.abs(shake.dx), Math.abs(shake.dy));
      this.dom?.setShake(shake.dx, shake.dy, reach > 0 ? 1 + (2 * reach) / Math.max(1, Math.min(this.view.width, this.view.height)) : 1);
      if (draw && this.dom) {
        const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
        this.draw(this.dom, now);
        if (this.clips.active) this.clips.composite(this.dom, this.view, this.videoShown(), this.flipX, this.cam.filter, shake);
        this.measureCost((typeof performance !== 'undefined' ? performance.now() : 0) - t0);
      }
    } catch (err) {
      this.logOnce('tick', err);
    }
  }

  /** 'auto' quality steps down when drawing gets slow, and back up when it recovers. */
  private measureCost(ms: number): void {
    this.drawCost = this.drawCost * 0.95 + ms * 0.05;
    if (!this.adaptiveLow && this.drawCost > 12) this.adaptiveLow = true;
    else if (this.adaptiveLow && this.drawCost < 6) this.adaptiveLow = false;
  }

  private feedReplay(now: number, finish = false): void {
    const r = this.replaySession;
    if (!r || r.points.length < 2) return;
    const ink = this.ink.get(r.inkId);
    if (!ink || ink.state !== 'wet') return;
    const n = r.points.length;
    const idx = finish ? n - 1 : replayIndex(now - r.start, r.durationMs, n);
    const aspect = this.view.casterAspect;
    while (r.fed + 1 <= idx) {
      r.fed++;
      const p = r.points[r.fed];
      this.ink.add(ink, p[0], p[1], r.start + replayTimeAt(r.fed, r.durationMs, n), aspect);
    }
    const head = pointAtIndex(r.points, idx);
    if (idx > r.fed) this.ink.add(ink, head[0], head[1], r.start + replayTimeAt(idx, r.durationMs, n), aspect);
    r.tip = { x: head[0], y: head[1] };
  }

  private clearPictures(): void {
    this.ink.clear();
    this.light.clear();
    this.particles.clear();
    this.shields = [];
    this.bolts = [];
    this.creatures = [];
    this.time.clear();
    this.shake.clear();
    this.reveal.clear();
    this.text.clear();
    for (const p of this.shelf.props) p.timeScale = 1;
  }

  private logOnce(key: string, err: unknown): void {
    if (this.errors.has(key)) return;
    this.errors.add(key);
    log.warn(`stage: ${key} failed`, err);
  }

  // ---------------------------------------------------------------- drawing

  private renderOverlay(): void {
    const w = this.view.pixelWidth, h = this.view.pixelHeight;
    if (!this.overlay) this.overlay = makeCanvas(w, h);
    const c = this.overlay;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    c.width = w;
    c.height = h;
    // Old silvered glass: darker toward the frame, desilvered near the edges, one static sheen
    // (glass.ts). Painted once per size; the shade layer copies it every frame.
    paintGlass(ctx, w, h);
  }

  private draw(dom: StageDom, now: number): void {
    const S = dom.shadeCtx, L = dom.lightCtx;
    const v = this.view;
    clearLayer(S, v.pixelWidth, v.pixelHeight);
    clearLayer(L, v.pixelWidth, v.pixelHeight);
    if (!this.layers || this.layers.shade !== S || this.layers.light !== L) this.layers = { shade: S, light: L };
    const layers = this.layers;
    const f = this.frame;
    const style = this.inkStyle;
    style.highContrast = this.highContrast;
    style.reducedMotion = this.reduced;
    style.quality = f.quality;

    // Shade layer.
    this.light.drawShade(S, v, this.sprites, now);
    if (this.overlay) S.drawImage(this.overlay, 0, 0);
    this.guarded('shelf', layers, () => this.shelf.drawShelf(layers, f, this.services));
    const reveal = this.reveal.alpha(now);
    for (const p of this.shelf.props) {
      this.guarded(`draw:${p.id}`, layers, () => {
        p.draw(layers, f, this.services);
        if (reveal > 0.01 && p.drawHidden) p.drawHidden(layers, f, this.services, reveal);
      });
    }
    this.particles.draw(S, 'shade', v, this.sprites);
    this.ink.drawShade(S, v, now, style);
    this.text.drawShade(S, v, now);
    if (this.highContrast && !this.replaySession) this.tip.drawShade(S, v, now, this.lostMs);

    // Light layer.
    this.ink.drawLight(L, v, now, style, this.sprites);
    if (this.replaySession) this.drawReplayTip(L);
    else this.tip.drawLight(L, v, this.sprites, now, this.lostMs, this.candleColor, this.reduced);
    this.light.drawLight(L, v, this.sprites, now, this.reduced);
    this.particles.draw(L, 'light', v, this.sprites);
    L.globalCompositeOperation = 'source-over';
    for (const b of this.bolts) drawBolt(L, b, v, this.sprites, now, this.reduced);
    for (const s of this.shields) drawShield(L, s, v, this.sprites, now, this.reduced);
    for (const c of this.creatures) this.creatureRenderer.draw(L, c, v);
    this.drawReveal(L, now, reveal);
    this.text.drawLight(L, v, now);
    this.guide.draw(L, v, this.sprites, now, this.candleColor, this.vellumColor);
    L.globalAlpha = 1;
    L.globalCompositeOperation = 'source-over';
  }

  /** Props are drawn by the other half of the stage; one failing never stops the frame. */
  private guarded(key: string, layers: Layers, fn: () => void): void {
    layers.shade.save();
    layers.light.save();
    try {
      fn();
    } catch (err) {
      this.logOnce(key, err);
    } finally {
      layers.shade.restore();
      layers.light.restore();
    }
  }

  /** During a replay the replayed tip leads the ink, in gold. */
  private drawReplayTip(L: CanvasRenderingContext2D): void {
    const r = this.replaySession;
    const ink = r ? this.ink.get(r.inkId) : undefined;
    if (!r?.tip || !ink || ink.state !== 'wet') return;
    const H = this.view.height * this.view.dpr;
    const x = this.view.px(r.tip.x), y = this.view.py(r.tip.y);
    const R = 0.028 * H;
    L.globalCompositeOperation = 'lighter';
    L.globalAlpha = 0.8;
    L.drawImage(this.sprites.glow(this.candleColor), x - R, y - R, R * 2, R * 2);
    L.globalAlpha = 1;
    L.drawImage(this.sprites.glow('#FFFFFF'), x - R * 0.28, y - R * 0.28, R * 0.56, R * 0.56);
    L.globalCompositeOperation = 'source-over';
  }

  /** Revelio: the glass remembers. Recent casts' shapes shimmer faintly into view (with the theme's
   *  hidden ink, which its text.inscribe writes, and the props' hidden details). */
  private drawReveal(L: CanvasRenderingContext2D, now: number, alpha: number): void {
    const history = this.ink.history;
    if (alpha <= 0.01 || !history.length) return;
    const H = this.view.height * this.view.dpr;
    const v = this.view;
    const at = this.revealPoint;
    L.globalCompositeOperation = 'lighter';
    L.lineCap = 'round';
    L.lineJoin = 'round';
    L.strokeStyle = '#C9D7EF';
    L.lineWidth = Math.max(1, 0.004 * H);
    const glow = this.sprites.star('#E6EEFF');
    for (let k = 0; k < history.length; k++) {
      const shape = history[k];
      const age = (history.length - 1 - k) / Math.max(1, history.length);
      L.globalAlpha = alpha * (0.34 - 0.18 * age);
      L.beginPath();
      for (let i = 0; i < shape.length; i++) {
        if (i === 0) L.moveTo(v.px(shape[i][0]), v.py(shape[i][1]));
        else L.lineTo(v.px(shape[i][0]), v.py(shape[i][1]));
      }
      L.stroke();
      if (this.reduced) continue;
      // A few glints travel slowly along each remembered shape.
      const fractions = this.ink.historyFractions[k];
      for (let j = 0; j < 4; j++) {
        const t = (now / 5200 + j / 4 + k * 0.17) % 1;
        pointAlong(shape, fractions, t, at);
        const r = 0.012 * H * (0.7 + 0.3 * Math.sin(now / 300 + j));
        L.globalAlpha = alpha * 0.7;
        L.drawImage(glow, v.px(at.x) - r, v.py(at.y) - r, r * 2, r * 2);
      }
    }
    L.globalAlpha = 1;
    L.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- replays and clips

  /** A timer the module's stop() can cut short. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wake = () => {
        if (timer) clearTimeout(timer);
        this.sleepers.delete(wake);
        resolve();
      };
      this.sleepers.add(wake);
      timer = setTimeout(wake, Math.max(0, ms));
    });
  }

  /**
   * 'stage.replay': the trace is drawn as ink on a plain backdrop (unless backdrop 'camera'), then
   * the cast goes through the engine ('engine.cast', replay: true) so the stage and audio play it the
   * normal way. When the effect is over the shelf resets. Replays never count toward progress; the
   * engine marks the cast as a replay and every module honours that.
   *
   * A replay starts from the shelf's starting state (PROP_START), whatever the live shelf has been
   * through, so it shows what its cast did: Reparo finds the cup cracked, Alohomora the box locked.
   * The live spells end first ('engine.reset', as the Diagnostics reset pairs it with stage.reset),
   * so the engine never counts as active a spell whose prop the reset has put back.
   */
  async playReplay(p: RequestPayload<'stage.replay'>): Promise<RequestResult<'stage.replay'>> {
    const k = this.kernel;
    if (!k || !this.running) throw new KernelError('not-supported', 'The mirror is not ready yet.');
    if (!p || typeof p.spellId !== 'string') throw new KernelError('invalid-payload', 'stage.replay needs a spellId.');
    if (this.replaySession) throw new KernelError('invalid-payload', 'A replay is already playing.');
    const started = this.now();
    const aspect = this.view.casterAspect;
    const points = toCurrentAspect(cleanReplayPoints(p.points), typeof p.aspect === 'number' && p.aspect > 0 ? p.aspect : aspect, aspect);
    const durationMs = points.length >= 2 ? Math.min(8000, Math.max(0, Number(p.durationMs) || 0)) : 0;
    const r: ReplaySession = {
      inkId: newId('replay'), spellId: p.spellId, points, durationMs, start: started, plain: p.backdrop !== 'camera', fed: 0,
      tip: points.length ? { x: points[0][0], y: points[0][1] } : null, castId: null, aborted: false,
    };
    this.replaySession = r;
    // The player's own unfinished ink makes way for the replay.
    const live = this.inkId ? this.ink.get(this.inkId) : undefined;
    if (live && live.state === 'wet') this.ink.fade(live, started);
    emit(k, STAGE_ID, 'replay.state', { playing: true, spellId: p.spellId });
    this.applyVideo();
    this.publishSurface();
    let castId: string | undefined;
    try {
      await this.clearForReplay(k);
      if (points.length >= 2) {
        const ink = this.ink.begin(r.inkId, started, true);
        this.ink.add(ink, points[0][0], points[0][1], started, aspect);
        if (durationMs > 0) await this.sleep(durationMs);
        this.feedReplay(this.now(), true);
        this.ink.end(ink, this.now());
      }
      if (r.aborted) throw new KernelError('not-supported', 'The replay was stopped.');
      const detail = await this.replayDetail(points, aspect, p.spellId);
      const last = points[points.length - 1];
      const cast = await ask(k, 'engine.cast', {
        spellId: p.spellId, via: p.via ?? 'gesture', quality: Number(p.quality) || 0, power: Number(p.power) || 0,
        aim: last ? { x: last[0], y: last[1] } : { x: 0.5, y: 0.5 }, variant: p.variant === true, replay: true,
        ...(typeof p.targetId === 'string' ? { targetId: p.targetId } : {}),
        ...(typeof p.holdMs === 'number' ? { holdMs: p.holdMs } : {}),
        ...(detail ? { detail } : {}),
      });
      castId = cast.id;
      await this.waitForEffects(cast, r);
      if (r.aborted) throw new KernelError('not-supported', 'The replay was stopped.');
      this.resetShelf();
      return { castId: cast.id, durationMs: Math.round(this.now() - started) };
    } catch (err) {
      const ink = this.ink.get(r.inkId);
      if (ink && (ink.state === 'wet' || ink.state === 'waiting')) this.ink.fade(ink, this.now());
      throw err;
    } finally {
      this.replaySession = null;
      this.applyVideo();
      this.publishSurface();
      emit(k, STAGE_ID, 'replay.state', { playing: false, spellId: p.spellId, ...(castId ? { castId } : {}) });
    }
  }

  /** Ask the recognizer how the replayed points line up, so the ink settles as it did live. Optional. */
  private async replayDetail(points: Point[], aspect: number, spellId: string): Promise<RecognitionDetail | undefined> {
    const k = this.kernel;
    if (!k || points.length < 2) return undefined;
    try {
      const scored = await Promise.race([
        ask(k, 'recognizer.score', { points, aspect, spellIds: [spellId] }),
        this.sleep(400).then(() => null),
      ]);
      return scored?.details?.find((d) => d.spellId === spellId && Array.isArray(d.aligned) && d.aligned.length >= 2);
    } catch {
      return undefined;
    }
  }

  /** Before a replay: the live spells end and the shelf goes back to its starting state. */
  private async clearForReplay(k: Kernel): Promise<void> {
    try {
      await ask(k, 'engine.reset');
    } catch (err) {
      // No engine to ask (a test, or the engine stopped): the shelf still resets.
      log.info('the replay could not end the live spells:', describeError(err).name);
    }
    this.resetShelf();
  }

  /** Waits until the replayed cast is over, and its props have finished showing what it did (a lid
   *  swung open, a crack knitted and its seam faded, a wand landed, a prop home again), then a beat. */
  private async waitForEffects(cast: SpellCast, r: ReplaySession): Promise<void> {
    const lasts = this.entries.get(cast.spellId)?.lasts ?? null;
    const deadline = this.now() + REPLAY_MAX_EFFECT_MS;
    while (!r.aborted && this.now() < deadline) {
      const ended = lasts === null || this.ended.has(cast.id);
      const busy = this.directorInstance.busy(cast.id) || this.creatures.some((c) => c.castId === cast.id) || this.shields.some((s) => s.castId === cast.id) ||
        !this.shelfSettled();
      if (ended && !busy) break;
      await this.sleep(100);
    }
    if (!r.aborted) await this.sleep(REPLAY_TAIL_MS);
  }

  /** No prop is in the middle of showing something (types.ts PropView.settled). */
  private shelfSettled(): boolean {
    return this.shelf.props.every((p) => {
      try {
        return p.settled?.() ?? true;
      } catch (err) {
        this.logOnce(`settled:${p.id}`, err);
        return true;
      }
    });
  }

  private startCapture(p: RequestPayload<'stage.capture.start'>): RequestResult<'stage.capture.start'> {
    if (!this.dom || !this.running) throw new KernelError('not-supported', 'The mirror is not on screen.');
    if (!p || typeof p.requester !== 'string') throw new KernelError('invalid-payload', 'stage.capture.start needs a requester.');
    const stream = this.clips.start(p.requester, p.includeCamera === true, typeof p.fps === 'number' ? p.fps : 30, this.view);
    return { stream };
  }
}
