// The shell's view of the app: reactive state fed by kernel events, plus actions that go
// through kernel requests. The shell talks to the kernel only (Section 5); it never imports modules.

import type {
  AudioCaption, CameraReady, CameraStatus, ModuleManifest, ModuleState, PlayArea, PracticeAttempt, ProgressChanged, ReplayState,
  SceneProps, SegmenterStatus, SettingKey, SettingsMap, Spellbook, SpellbookEntry, SpellCast, SpellFizzle, StageSteering,
  StorageStatus, TrackerStatus, VoiceStatus,
} from '../contracts';
import { DEFAULT_SETTINGS } from '../contracts';
import type { KernelHost } from '../kernel';
import { ask, gradeFor, lastPayload, on, watchReducedMotion } from '../kernel';
import { isSeated, sameArea, SEATED_AREA, WHOLE_VIEW } from './components/tools/play-area';

export type Screen = 'threshold' | 'mirror' | 'spellbook' | 'practice' | 'tuning' | 'keepsakes' | 'workshop' | 'replay';

export interface LogEntry {
  id: string;
  kind: 'cast' | 'fizzle';
  t: number;
  spellId?: string;
  /** Incantation (cast) or nearest spell's incantation (fizzle). */
  name: string;
  grade: string;
  quality: number;
  hint?: string;
  via?: SpellCast['via'];
  variant?: string;
  practice?: boolean;
  replay?: boolean;
}

export interface ShellOptions {
  /** The mirror element the stage draws into; the shell places it in the layout. */
  mirror: HTMLElement;
  /** Applies a waiting app update (service worker), when there is one. */
  applyUpdate?: () => Promise<void>;
  /** Starts the kernel's modules (deferred on first run until the Threshold screen is done). */
  startModules: () => Promise<void>;
  /** The web address that hands the app on (the QR code, "Share Spellglass"); '' when there is none
   *  (the desktop app built without one), and the shell leaves those out. Default: where it is served. */
  appUrl?: string;
  /** The desktop app (desktop/main.mjs): no address bar, no browser prompts, no voice. */
  desktop?: boolean;
}

/** A tier of spells has opened (Section 8: "Practice mode unlocks spells in stages"). */
export interface Celebration {
  id: number;
  tier: number;
  spellIds: string[];
  /** "New spells to learn: Alohomora, Accio and Expelliarmus." */
  text: string;
}

const BANNER_MS = 4200;
/** Fizzles a rule caused rather than the shape: they carry no grade. */
const RULE_FIZZLES = new Set<SpellFizzle['reason']>(['unavailable', 'needs-active', 'cooldown', 'strict-mismatch', 'no-candidates']);
const LOG_LIMIT = 30;
const CELEBRATION_MS = 9000;
/** Screens that open as a modal dialog over the room (Section 10.3: the book from the left edge, the
 *  drawers from the right). */
const MODAL_SCREENS: ReadonlySet<Screen> = new Set(['spellbook', 'tuning', 'keepsakes', 'workshop']);

/** The stage's candle is burning (contracts/scene.ts: the candle's state.lit; it starts unlit). */
const candleLitIn = (scene: SceneProps | null | undefined): boolean =>
  scene?.props.find((p) => p.id === 'candle')?.state.lit === true;

export class AppState {
  readonly kernel: KernelHost;
  readonly mirror: HTMLElement;
  readonly options: ShellOptions;

  screen = $state<Screen>('mirror');
  /** Spell the Spellbook page or Practice screen is about. */
  selectedSpellId = $state<string | null>(null);

  // Large or frequently replaced objects are raw state: replaced whole, never deep-proxied, so they
  // can be passed to kernel requests and IndexedDB as they are.
  spellbook = $state.raw<Spellbook | null>(null);
  settings = $state.raw<SettingsMap>({ ...DEFAULT_SETTINGS });
  tracker = $state.raw<TrackerStatus | null>(null);
  /** Sticky camera summary (camera.status). */
  camera = $state.raw<CameraStatus | null>(null);
  /** The open camera, for its aspect ratio and stream. */
  cameraReady = $state.raw<CameraReady | null>(null);
  segmenter = $state.raw<SegmenterStatus | null>(null);
  replay = $state.raw<ReplayState>({ playing: false });
  steering = $state.raw<StageSteering>({ castId: null });
  voice = $state.raw<VoiceStatus>({ state: 'off', local: true });
  storage = $state.raw<StorageStatus | null>(null);
  modules = $state.raw<{ manifest: ModuleManifest; state: ModuleState; reason?: string }[]>([]);

  /** Recent casts and fizzles, newest first (the session log). */
  log = $state.raw<LogEntry[]>([]);
  /** Obliviate fades the log away. */
  logFading = $state(false);
  /** The latest result, shown under the mirror for a few seconds. */
  banner = $state<LogEntry | null>(null);
  captions = $state<{ id: number; text: string }[]>([]);
  practiceAttempts = $state.raw<PracticeAttempt[]>([]);
  updateWaiting = $state(false);
  started = $state(false);
  /** A replay link opened the app. */
  replayHash = $state<string | null>(null);
  toast = $state<{ id: number; text: string; tone?: 'ok' | 'warn' } | null>(null);
  /** A tier of spells just opened; the shell celebrates it for a few seconds. */
  celebration = $state.raw<Celebration | null>(null);
  /** A cast (not a replay) succeeded this session: the Mirror's first-cast coach line goes away. */
  castSucceeded = $state(false);
  /** Reduced motion, from the setting or the system (Section 10.6). For JS-driven transitions. */
  reducedMotion = $state(false);
  /** The screen whose drawer is folded down to its bar on the frame while a flow needs the mirror
   *  (drawing a gesture, recording, watching a replay), or null. Workshop and Keepsakes keep it
   *  current; naming the screen means a drawer still flying out can never fold another one. */
  foldedDrawer = $state<Screen | null>(null);
  /** The spell whose gesture the spell guide has drawn faintly on the glass, or null. It is the
   *  stage's practice guide shown without practice: casting stays ordinary casting meanwhile. */
  glassGuideId = $state<string | null>(null);
  /** The candle on the mantel is lit: the room's candlelight burns and flickers only while it is, so
   *  the light on the wall always has its flame (Incendio lights it, Aguamenti puts it out). */
  candleLit = $state(false);
  /** The app's own address, without a fragment: the QR code on the Mirror hands it on (Section 11.1).
   *  '' when it has none to give (the desktop app built without SPELLGLASS_WEB_URL). */
  readonly appUrl: string;
  /** Running as the desktop app: words about the address bar and the browser change, voice is absent. */
  readonly desktop: boolean;

  private bannerTimer: ReturnType<typeof setTimeout> | null = null;
  private celebrationTimer: ReturnType<typeof setTimeout> | null = null;
  private captionId = 0;
  private toastId = 0;
  /** A play area chosen here (Seated play) and not yet stored with a camera. Each open writes that
   *  camera's stored play area back (contracts/requests.ts, 'camera.profile.save'), which would undo
   *  a choice made while no camera was on: it is set again, and stored, on the next camera.ready, as
   *  Wand tuning does with a route. */
  private areaToKeep: PlayArea | null = null;
  /** The play area Seated play took the place of this session, and the camera it was in use with
   *  (null: none was on), so turning seated play off gives it back. */
  private areaBeforeSeated: { area: PlayArea; camera: string | null } | null = null;

  constructor(kernel: KernelHost, options: ShellOptions) {
    this.kernel = kernel;
    this.mirror = options.mirror;
    this.options = options;
    this.appUrl = options.appUrl ?? appAddress();
    this.desktop = options.desktop === true;
    this.settings = { ...DEFAULT_SETTINGS, ...(kernel.settings.all() as Partial<SettingsMap>) };
    this.spellbook = lastPayload(kernel, 'spellbook.changed') ?? null;
    this.tracker = lastPayload(kernel, 'tracker.status') ?? null;
    this.camera = lastPayload(kernel, 'camera.status') ?? null;
    this.cameraReady = lastPayload(kernel, 'camera.ready') ?? null;
    // Storage reports its status while packs load, before the shell exists: read the sticky value.
    this.storage = lastPayload(kernel, 'storage.status') ?? null;
    this.voice = lastPayload(kernel, 'voice.status') ?? this.voice;
    this.segmenter = lastPayload(kernel, 'segmenter.state') ?? null;
    this.candleLit = candleLitIn(lastPayload(kernel, 'scene.props'));
    this.modules = kernel.modules();
    watchReducedMotion(kernel, (reduced) => (this.reducedMotion = reduced));
    this.subscribe();
  }

  // ------------------------------------------------------------------ derived

  /** A cast is in progress: hold the update prompt and other interruptions (Section 9.1 rule 10). */
  get casting(): boolean {
    if (this.replay.playing) return true;
    const s = this.segmenter?.state;
    return s === 'armed' || s === 'tracing' || s === 'evaluating';
  }

  get selectedEntry(): SpellbookEntry | null {
    return this.spellbook?.spells.find((e) => e.spell.id === this.selectedSpellId) ?? null;
  }

  entry(spellId: string | undefined | null): SpellbookEntry | null {
    if (!spellId) return null;
    return this.spellbook?.spells.find((e) => e.spell.id === spellId) ?? null;
  }

  spellName(spellId: string | undefined | null): string {
    return this.entry(spellId)?.spell.incantation ?? spellId ?? '';
  }

  grade(quality: number, kind: 'cast' | 'fizzle'): string {
    return gradeFor(quality, kind, this.spellbook?.theme);
  }

  /** The Mirror shows its first-cast coach line until the player's first successful cast. */
  get firstCastPending(): boolean {
    if (this.castSucceeded) return false;
    return !(this.spellbook?.spells.some((e) => e.accepted > 0) ?? false);
  }

  /** The next spell to learn: the first open spell that can be cast now. */
  get nextSpell(): SpellbookEntry | null {
    return this.spellbook?.spells.find((e) => e.status === 'open' && e.enabled) ?? null;
  }

  /** A modal dialog covers the room: the Spellbook, or a drawer that is not folded down to its bar.
   *  The room behind it then takes no input and leaves the accessibility tree, as the dialog's
   *  aria-modal promises (Section 10.6). A folded drawer gives the room back, since its flow needs the
   *  mirror. */
  get roomInert(): boolean {
    return MODAL_SCREENS.has(this.screen) && this.foldedDrawer !== this.screen;
  }

  /** The spell guide is open beside the mirror (setting 'shell.spellGuide'; on unless turned off). */
  get spellGuideOpen(): boolean {
    return this.settings['shell.spellGuide'] !== false;
  }

  // ------------------------------------------------------------------ actions

  go(screen: Screen, spellId?: string | null): void {
    if (spellId !== undefined) this.selectedSpellId = spellId;
    if (this.screen === 'practice' && screen !== 'practice') this.endPractice();
    // The guide's drawing belongs to the mirror at home: a replay or the first run starts clear.
    if (screen === 'replay' || screen === 'threshold') this.clearGlassGuide();
    this.screen = screen;
  }

  /** Open or close the spell guide; it stays as chosen across reloads. */
  async setSpellGuide(open: boolean): Promise<void> {
    await this.set('shell.spellGuide', open);
  }

  /**
   * The spell guide's card was chosen: draw that spell's gesture faintly on the glass, or take it
   * away when it is the one drawn. The spell becomes the selected one, so the Mirror bar's Practice
   * and the Spellbook open at it. The drawing is the stage's practice guide ('practice.guide', which
   * only the stage reads); 'practice.focus' is never sent with a spell from here, since that is what
   * turns casting into practice (the engine grades attempts and marks casts as practice).
   */
  toggleGlassGuide(spellId: string): void {
    if (this.glassGuideId === spellId) {
      this.clearGlassGuide();
      return;
    }
    this.selectedSpellId = spellId;
    this.glassGuideId = spellId;
    this.kernel.emit('practice.guide', { spellId, slow: false }, 'shell');
  }

  /** Take the guide's drawing off the glass. The stage clears its guide on 'practice.focus' with no
   *  spell; outside Practice the engine's focus is already none, so nothing else changes. */
  clearGlassGuide(): void {
    if (this.glassGuideId === null) return;
    this.glassGuideId = null;
    if (this.screen !== 'practice') this.kernel.emit('practice.focus', { spellId: null }, 'shell');
  }

  async set<K extends SettingKey>(key: K, value: SettingsMap[K]): Promise<void> {
    // A play area set any other way (the box in Wand tuning) takes the place of one waiting for a camera.
    if (key === 'playArea' && this.areaToKeep && !sameArea(value as PlayArea, this.areaToKeep)) this.areaToKeep = null;
    await ask(this.kernel, 'settings.set', { key, value });
  }

  /**
   * Seated play on or off (Section 10.6): the play area fitted to a seated reach (play-area.ts), or, off,
   * the area it took the place of when that was in use with the same camera, else the whole view. The
   * area is stored with the camera, at once or when the camera next opens. Resolves with the area now
   * in use.
   */
  async setSeated(on: boolean): Promise<PlayArea> {
    const camera = this.cameraInUse();
    if (on) {
      const now = this.settings.playArea;
      if (!isSeated(now)) this.areaBeforeSeated = { area: { ...now }, camera };
      return this.keepPlayArea(SEATED_AREA);
    }
    const before = this.areaBeforeSeated;
    this.areaBeforeSeated = null;
    const back = { ...(before && before.camera === camera ? before.area : WHOLE_VIEW) };
    if (camera === null && this.areaToKeep && isSeated(this.areaToKeep)) {
      // It never reached a camera: undo it here only, and each camera keeps the area it has stored.
      // (With a camera on, the area given back is stored after any seated save still on its way.)
      this.areaToKeep = null;
      await this.set('playArea', back);
      return back;
    }
    return this.keepPlayArea(back);
  }

  /** Set the play area and store it with the camera: at once while one is on, else on the next
   *  camera.ready (onCameraOpen). */
  private async keepPlayArea(area: Readonly<PlayArea>): Promise<PlayArea> {
    const kept = { ...area };
    this.areaToKeep = kept;
    await this.set('playArea', kept);
    if (this.camera?.state === 'on') this.storePlayArea(kept);
    return { ...kept };
  }

  private storePlayArea(area: PlayArea): void {
    void ask(this.kernel, 'camera.profile.save', { playArea: area }).then(
      () => {
        if (this.areaToKeep === area) this.areaToKeep = null;
      },
      // The camera closed meanwhile: the next camera.ready stores it.
      () => undefined,
    );
  }

  /** The camera that is on ('' when it hides its id), or null. */
  private cameraInUse(): string | null {
    return this.camera?.state === 'on' ? (this.camera.deviceId ?? this.cameraReady?.deviceId ?? '') : null;
  }

  /** Begin practising a spell: the engine grades attempts, the stage shows the guide. */
  startPractice(spellId: string): void {
    this.selectedSpellId = spellId;
    this.practiceAttempts = [];
    this.kernel.emit('practice.focus', { spellId }, 'shell');
    this.screen = 'practice';
  }

  endPractice(): void {
    this.kernel.emit('practice.focus', { spellId: null }, 'shell');
    this.practiceAttempts = [];
  }

  showGuide(slow: boolean): void {
    if (this.selectedSpellId) this.kernel.emit('practice.guide', { spellId: this.selectedSpellId, slow }, 'shell');
  }

  /** The Mirror's Practice button: practise the selected spell directly, or open the Spellbook at
   *  the next spell to learn. */
  practiceNext(): void {
    const selected = this.selectedEntry;
    if (selected?.enabled) {
      this.startPractice(selected.spell.id);
      return;
    }
    const next = this.nextSpell ?? this.spellbook?.spells.find((e) => e.enabled) ?? null;
    this.go('spellbook', next ? next.spell.id : undefined);
  }

  /** Leave a replay link behind: drop '#cast=...' so a reload opens the app, not the replay again. */
  clearReplayLink(): void {
    this.replayHash = null;
    if (typeof location !== 'undefined' && typeof history !== 'undefined' && location.hash) {
      history.replaceState(history.state, '', location.pathname + location.search);
    }
  }

  dismissCelebration(): void {
    if (this.celebrationTimer) clearTimeout(this.celebrationTimer);
    this.celebrationTimer = null;
    this.celebration = null;
  }

  async startModules(): Promise<void> {
    if (this.started) return;
    await this.options.startModules();
    this.started = true;
  }

  async applyUpdate(): Promise<void> {
    this.updateWaiting = false;
    await this.options.applyUpdate?.();
  }

  /** A short message at the top of the window. tone 'ok' marks a success, 'warn' a problem; without a
   *  tone it is neutral. */
  notify(text: string, tone?: 'ok' | 'warn'): void {
    this.toast = { id: ++this.toastId, text, tone };
    const id = this.toast.id;
    setTimeout(() => {
      if (this.toast?.id === id) this.toast = null;
    }, 3200);
  }

  /** Resume audio on the first click or tap (browsers require a user gesture). */
  unlockAudio(): void {
    void ask(this.kernel, 'audio.unlock').catch(() => {});
  }

  // ------------------------------------------------------------------ events

  private subscribe(): void {
    const k = this.kernel;
    on(k, 'spellbook.changed', (b) => {
      this.spellbook = b;
      // The stage draws a guide for any spell it knows, open or not: a spell that can no longer be
      // cast (its pack turned off) leaves the glass with its card.
      const shown = this.glassGuideId;
      if (shown && !b.spells.some((e) => e.spell.id === shown && e.enabled)) this.clearGlassGuide();
    });
    on(k, 'settings.changed', ({ key, value }) => {
      this.settings = { ...this.settings, [key]: value ?? (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key] };
      // The guide's drawing goes with the guide, however it was closed.
      if (key === 'shell.spellGuide' && !this.spellGuideOpen) this.clearGlassGuide();
    });
    // Any other focus (Practice starting or ending) replaces or clears the stage's guide.
    on(k, 'practice.focus', () => (this.glassGuideId = null));
    on(k, 'tracker.status', (s) => (this.tracker = s));
    on(k, 'camera.status', (c) => {
      const before = this.camera;
      this.camera = c;
      // Section 7.9: a lower capture size (or a dim room slowing the camera) is said in the status area.
      if (c.state === 'on' && c.message && c.message !== before?.message) this.notify(sentence(c.message));
    });
    on(k, 'camera.ready', (c) => {
      this.cameraReady = c;
      this.onCameraOpen(c);
    });
    on(k, 'camera.stopped', () => (this.cameraReady = null));
    on(k, 'replay.state', (r) => (this.replay = r));
    on(k, 'stage.steering', (st) => (this.steering = st));
    on(k, 'segmenter.state', (s) => (this.segmenter = s));
    on(k, 'voice.status', (v) => (this.voice = v));
    on(k, 'storage.status', (s) => (this.storage = s));
    on(k, 'module.status', () => (this.modules = k.modules()));
    on(k, 'app.update-ready', () => (this.updateWaiting = true));
    on(k, 'spell.cast', (c) => this.onCast(c));
    on(k, 'spell.fizzle', (f) => this.onFizzle(f));
    on(k, 'practice.attempt', (a) => (this.practiceAttempts = [...this.practiceAttempts, a]));
    on(k, 'audio.caption', (c) => this.onCaption(c));
    on(k, 'effect.start', (e) => {
      if (e.use === 'log.fade') this.fadeLog();
    });
    on(k, 'progress.changed', (p) => this.onProgress(p));
    // Up to once a frame while a prop moves: only a change of the flame reaches the room.
    on(k, 'scene.props', (s) => {
      const lit = candleLitIn(s);
      if (lit !== this.candleLit) this.candleLit = lit;
    });
  }

  /** A camera opened, and capture has already written its stored values into the settings: a play
   *  area waiting for a camera goes back over the camera's own, and is stored with it. */
  private onCameraOpen(c: CameraReady): void {
    const area = this.areaToKeep;
    if (!area) return;
    const own = this.settings.playArea;
    if (isSeated(area) && !isSeated(own)) this.areaBeforeSeated = { area: { ...own }, camera: c.deviceId ?? '' };
    if (!sameArea(own, area)) void this.set('playArea', area).catch(() => undefined);
    this.storePlayArea(area);
  }

  /** A cast opened a new tier: "New spells to learn: ..." (the audio module plays 'unlock-tier'). */
  private onProgress(p: ProgressChanged): void {
    if (!p.unlockedTier || !p.unlockedSpells?.length) return;
    const names = p.unlockedSpells.map((id) => this.spellName(id));
    const item: Celebration = { id: ++this.toastId, tier: p.unlockedTier, spellIds: [...p.unlockedSpells], text: `New spells to learn: ${joinNames(names)}.` };
    this.celebration = item;
    if (this.celebrationTimer) clearTimeout(this.celebrationTimer);
    this.celebrationTimer = setTimeout(() => {
      if (this.celebration?.id === item.id) this.celebration = null;
    }, CELEBRATION_MS);
  }

  private onCast(c: SpellCast): void {
    if (!c.replay) this.castSucceeded = true;
    // The drawing has done its work once its spell is cast: the glass is clear for the next try,
    // and no guide stroke keeps moving on it unasked (Section 10.6).
    if (!c.replay && c.spellId === this.glassGuideId) this.clearGlassGuide();
    const entry: LogEntry = {
      id: c.id, kind: 'cast', t: c.t, spellId: c.spellId,
      name: c.variant ?? c.incantation ?? this.spellName(c.spellId),
      grade: this.grade(c.quality, 'cast'), quality: c.quality, via: c.via, variant: c.variant,
      practice: c.practice, replay: c.replay,
    };
    this.pushLog(entry);
  }

  private onFizzle(f: SpellFizzle): void {
    // Steering a levitated prop is not a failed cast; ignored strokes are not either.
    if (f.reason === 'steering' || f.reason === 'ignored') return;
    const name = f.nearest ? this.spellName(f.nearest.spellId) : '';
    const entry: LogEntry = {
      id: f.id, kind: 'fizzle', t: f.t, spellId: f.nearest?.spellId, name,
      // A rule stopped it (locked, needs another spell, cooldown): no skill grade, just the reason.
      grade: RULE_FIZZLES.has(f.reason) ? '' : this.grade(f.quality, 'fizzle'), quality: f.quality, hint: fizzleText(f, name), practice: f.practice,
    };
    this.pushLog(entry);
  }

  private pushLog(entry: LogEntry): void {
    this.logFading = false;
    this.log = [entry, ...this.log].slice(0, LOG_LIMIT);
    this.banner = entry;
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => {
      if (this.banner?.id === entry.id) this.banner = null;
    }, BANNER_MS);
  }

  private fadeLog(): void {
    this.logFading = true;
    setTimeout(() => {
      if (this.logFading) {
        this.log = [];
        this.logFading = false;
      }
    }, 1600);
  }

  private onCaption(c: AudioCaption): void {
    if (!this.settings['access.captions']) return;
    const item = { id: ++this.captionId, text: c.text };
    this.captions = [...this.captions.slice(-2), item];
    setTimeout(() => (this.captions = this.captions.filter((x) => x.id !== item.id)), 2600);
  }
}

/** "Alohomora, Accio and Expelliarmus" */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** A status fragment as a sentence: capital first letter, full stop at the end. */
function sentence(text: string): string {
  const t = text.trim();
  if (!t) return t;
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** The app's base address (where index.html is served), without any fragment. */
function appAddress(): string {
  if (typeof location === 'undefined') return '';
  try {
    return new URL(import.meta.env?.BASE_URL ?? '/', location.href).href.split('#')[0];
  } catch {
    return location.href.split('#')[0];
  }
}

/** "Close to Alohomora. The downstroke stopped short: carry it through the circle." (Section 10.5) */
export function fizzleText(f: SpellFizzle, nearestName: string): string {
  switch (f.reason) {
    case 'needs-active':
      return f.hint ?? `${nearestName} needs another spell active first.`;
    case 'cooldown':
      return `${nearestName} needs a moment before it can be cast again.`;
    case 'unavailable':
      return f.hint ?? `${nearestName} is not open yet. Learn the spells before it in the Spellbook.`;
    case 'strict-mismatch':
      return f.hint ?? 'Strict mode: say the incantation as you trace it.';
    case 'no-candidates':
      return 'No spells are open. Turn on a pack in the Workshop.';
    default:
      if (!nearestName) return f.hint ?? 'The spell fizzled. Pause, trace, pause.';
      return `Close to ${nearestName}.${f.hint ? ' ' + f.hint : ''}`;
  }
}
