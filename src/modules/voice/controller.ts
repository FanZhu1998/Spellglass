// The voice controller: when to listen, how, and what to tell the player (Section 7.6, 7.9, 11.2).
//
// States (VoiceStatus.state) and how each is reached:
//   off             'voice.enabled' is false, the module is stopped, or a check is under way.
//   unavailable     no speech recognition at all, the language is not supported, or on-device
//                   recognition is unavailable and the player has not allowed the online service.
//                   `cloud` says whether that service could be used if the player opts in.
//   needs-download  on-device recognition needs a language pack (available() says 'downloadable').
//                   The shell offers a button that asks 'voice.install'.
//   downloading     install() is running, or available() says 'downloading' (checked again every few s).
//   ready           about to listen.
//   listening       a recognition session is running (also across its quick automatic restarts).
//   error           the microphone is blocked or missing, the online service cannot be reached, or
//                   recognition keeps stopping. Recovers on its own where it can.
//
// Privacy (Section 11.2): on-device first. processLocally is set whenever available() confirms the
// language pack; the browser's server-based service is used only when on-device recognition is
// unavailable and 'voice.allowCloud' is true, and then the status says local: false. Phrase biasing is
// on-device only, so a cloud session gets no phrases (else start() fails 'phrases-not-supported').
//
// Lifecycle rules (contracts/module.ts): start() never waits for available(), a download or the
// microphone; that work runs in the background, and stop() cancels it (a generation counter makes
// every late answer harmless).

import type { Incantation, Spellbook, VoiceStatus } from '../../contracts';
import { describeError, logger, newId } from '../../kernel';
import { spellForms, type SpellForms } from './fuzzy';
import { decideIncantation, UtteranceTracker } from './heard';
import { snapshotResults, type SpeechApi, type SpeechErrorEventLike, type SpeechQuality, type SpeechRecognitionLike, type SpeechResultEventLike } from './speech';

const log = logger('voice');

export interface VoiceSettings {
  enabled: boolean;
  allowCloud: boolean;
  lang: string;
  minConf: number;
  /** Already clamped to 0..10. */
  phraseBoost: number;
  quality: SpeechQuality;
}

export interface VoiceEnv {
  now(): number;
  speech(): SpeechApi | null;
  settings(): VoiceSettings;
  spellbook(): Spellbook | null;
  status(s: VoiceStatus): void;
  incantation(i: Incantation): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Call fn once the microphone permission becomes 'granted'. Returns unsubscribe, or null. */
  watchMicrophone?(fn: () => void): (() => void) | null;
  /** Call fn when audio devices change (a microphone plugged in). Returns unsubscribe, or null. */
  watchDevices?(fn: () => void): (() => void) | null;
}

/** Plain sentences for the status area (Section 10.5: instructions stay plain). */
export const VOICE_TEXT = {
  noRecognition: 'Voice recognition is not available in this browser.',
  noLocal: 'On-device voice recognition is not available in this browser, so voice stays off.',
  noLocalCloud: "On-device voice recognition is not available in this browser, so voice stays off. You can allow the browser's online speech service instead.",
  language: 'Voice recognition does not support this language.',
  needsDownload: 'Voice needs a one-time download of the speech pack for this language.',
  downloading: 'Downloading the speech pack.',
  downloadFailed: 'The speech pack could not be downloaded. Try again later.',
  downloadNeedsClick: 'The download has to start from a click. Choose the download button again.',
  cannotDownload: 'This browser cannot download speech packs.',
  listeningLocal: 'Listening on this device.',
  listeningCloud: "Listening through the browser's online speech service.",
  micBlocked: 'Microphone is blocked. Allow microphone access in the address bar, then turn voice on again.',
  noMicrophone: 'No microphone found. Connect one and voice starts again.',
  network: 'The online speech service cannot be reached. Voice tries again shortly.',
  cloudRefused: "The browser's online speech service is not allowed here.",
  startFailed: 'Voice could not start on this device. Turn voice off and on to try again.',
  keepsStopping: 'Voice keeps stopping. Turn voice off and on to try again.',
} as const;

/** A session that ends this soon without a result counts as a failure (backoff grows). */
export const HEALTHY_SESSION_MS = 3000;
/** Restart delay after a healthy session; doubles from FIRST_BACKOFF_MS per quick failure. */
export const RESTART_MS = 50;
export const FIRST_BACKOFF_MS = 250;
export const MAX_BACKOFF_MS = 15000;
/** After this many quick failures in a row the status says so (restarts go on, slowly). */
export const FAILURES_BEFORE_ERROR = 5;
/** available() said 'downloading': ask again this often. */
export const DOWNLOAD_POLL_MS = 3000;
/** An available() that has not answered by then counts as 'unavailable'. */
export const CHECK_TIMEOUT_MS = 8000;
/** Without a microphone, try again this often (and at once when devices change). */
export const NO_MICROPHONE_RETRY_MS = 10000;
/** How long to wait for an aborted session's 'end' before starting the next one anyway. */
const RETIRE_WAIT_MS = 600;
/** Alternatives asked of the recognizer; the fuzzy matcher reads them all. */
const MAX_ALTERNATIVES = 3;

interface Session {
  id: string;
  rec: SpeechRecognitionLike;
  local: boolean;
  startedAt: number;
  /** Kernel time of 'audiostart': zero on the session audio timeline. */
  audioAt?: number;
  results: number;
  error: string | null;
  tracker: UtteranceTracker;
  /** Phrase hints it was started with (to know when they went stale). */
  hintsKey: string;
  /** Asked to stop so that new phrase hints apply: restart at once. */
  refreshing: boolean;
  healthyTimer: unknown;
}

export class VoiceController {
  private running = false;
  /** Bumped whenever earlier async work must be ignored. */
  private gen = 0;
  /** Settings the current listening attempt was prepared for. */
  private configKey = '';
  private local = true;
  private cloud: VoiceStatus['cloud'];
  private wanted = false;
  private session: Session | null = null;
  private retiring: SpeechRecognitionLike | null = null;
  private retireTimer: unknown = null;
  private openPending = false;
  private restartTimer: unknown = null;
  private pollTimer: unknown = null;
  private quickFails = 0;
  private phrasesOff = false;
  private serviceRetries = 0;
  /** Set by an error that only the player can fix: the microphone blocked, the language refused.
   *  No restarts until the settings change or the microphone is allowed. */
  private blocked: 'not-allowed' | 'language' | null = null;
  /** The last session failed: hold the error status until a session proves healthy. */
  private trouble: string | null = null;
  private installing = false;
  private sessions = 0;
  private readonly prefix = newId('voice');
  private book: Spellbook | null | undefined = undefined;
  private table: SpellForms[] = [];
  private hints: string[] = [];
  private lastStatus = '';
  private unwatch: (() => void)[] = [];

  constructor(private readonly env: VoiceEnv) {}

  // ------------------------------------------------------------------------------- public

  start(): void {
    if (this.running) return;
    this.running = true;
    this.configKey = '';
    this.sync();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.halt();
    this.publish({ state: 'off', local: true, lang: this.env.settings().lang });
  }

  /** Settings or the spellbook changed (or the module started): do what they now ask for. */
  sync(): void {
    this.refreshSpells();
    const s = this.env.settings();
    if (!this.running || !s.enabled) {
      this.halt();
      this.configKey = '';
      if (this.running) this.publish({ state: 'off', local: true, lang: s.lang });
      return;
    }
    const key = [s.lang, s.quality, s.allowCloud].join('|');
    if (key !== this.configKey) {
      this.configKey = key;
      this.cloud = undefined; // known again after this configuration's check
      this.phrasesOff = false;
      this.blocked = null;
      this.trouble = null;
      this.quickFails = 0;
      this.serviceRetries = 0;
      this.halt();
      this.prepare();
      return;
    }
    // Same configuration: a running on-device session may need the new phrase hints.
    const sess = this.session;
    if (sess && sess.local && !sess.refreshing && sess.hintsKey !== this.hintsKey(s)) {
      sess.refreshing = true;
      try {
        sess.rec.stop(); // ends gracefully; onEnd starts the next session with the new hints
      } catch {
        this.closeSession(sess);
        this.retire(sess.rec);
        this.openSession(); // waits for the retired recognizer to end
      }
    }
  }

  /**
   * Request 'voice.install': download the on-device language pack. install() is called first,
   * before anything is awaited, because it needs the click's user activation.
   */
  install(): Promise<{ ok: boolean; message?: string }> {
    const api = this.env.speech();
    const s = this.env.settings();
    if (!api || typeof api.Recognition.install !== 'function') return Promise.resolve({ ok: false, message: VOICE_TEXT.cannotDownload });
    let pending: Promise<boolean>;
    try {
      pending = Promise.resolve(api.Recognition.install({ langs: [s.lang], processLocally: true, quality: s.quality }));
    } catch (err) {
      return Promise.resolve(this.installFailed(err));
    }
    this.installing = true;
    if (this.running && s.enabled && !this.session) this.publish({ state: 'downloading', local: true, lang: s.lang, cloud: this.cloud, message: VOICE_TEXT.downloading });
    return pending.then(
      (ok) => {
        this.installing = false;
        if (ok === true) {
          // Check again: available() now answers truthfully for this site, and listening begins.
          this.configKey = '';
          this.sync();
          return { ok: true };
        }
        return this.installFailed(null);
      },
      (err) => {
        this.installing = false;
        return this.installFailed(err);
      },
    );
  }

  /** Phrase hints in force (for tests and diagnostics). */
  phraseHints(): readonly string[] {
    return this.hints;
  }

  // ------------------------------------------------------------------------------- checking

  private prepare(): void {
    const gen = ++this.gen;
    const s = this.env.settings();
    const api = this.env.speech();
    if (!api) {
      this.publish({ state: 'unavailable', local: true, cloud: 'unavailable', lang: s.lang, message: VOICE_TEXT.noRecognition });
      return;
    }
    if (!api.onDevice) {
      // No way to ask for (or verify) on-device recognition: the browser's own service is all there
      // is, so voice runs only if the player has allowed it (Section 11.2).
      this.cloud = 'available';
      if (s.allowCloud) this.listen(gen, false);
      else this.publish({ state: 'unavailable', local: true, cloud: 'available', lang: s.lang, message: VOICE_TEXT.noLocalCloud });
      return;
    }
    // Checking: voice counts as off until the answer comes (the engine then plays by gesture rules).
    this.publish({ state: 'off', local: true, lang: s.lang });
    void this.check(api, gen);
  }

  private async check(api: SpeechApi, gen: number): Promise<void> {
    const s = this.env.settings();
    const local = await this.availability(api, s, true);
    if (gen !== this.gen || !this.running) return;
    if (local === 'available') {
      this.listen(gen, true);
      return;
    }
    if (local === 'downloading') {
      this.publish({ state: 'downloading', local: true, lang: s.lang, cloud: this.cloud, message: VOICE_TEXT.downloading });
      this.pollTimer = this.env.setTimer(() => {
        this.pollTimer = null;
        if (gen === this.gen && this.running) void this.check(api, gen);
      }, DOWNLOAD_POLL_MS);
      return;
    }
    const cloud = (await this.availability(api, s, false)) === 'available' ? 'available' : 'unavailable';
    if (gen !== this.gen || !this.running) return;
    this.cloud = cloud;
    if (local === 'downloadable') {
      if (this.installing) this.publish({ state: 'downloading', local: true, cloud, lang: s.lang, message: VOICE_TEXT.downloading });
      else this.publish({ state: 'needs-download', local: true, cloud, lang: s.lang, message: VOICE_TEXT.needsDownload });
      return;
    }
    if (s.allowCloud && cloud === 'available') {
      this.listen(gen, false);
      return;
    }
    this.publish({ state: 'unavailable', local: true, cloud, lang: s.lang, message: cloud === 'available' ? VOICE_TEXT.noLocalCloud : VOICE_TEXT.noLocal });
  }

  /** available(), answered 'unavailable' when it fails or does not answer within CHECK_TIMEOUT_MS. */
  private availability(api: SpeechApi, s: VoiceSettings, processLocally: boolean): Promise<string> {
    return new Promise<string>((resolve) => {
      let settled = false;
      let timer: unknown = null;
      const finish = (answer: string) => {
        if (settled) return;
        settled = true;
        if (timer !== null) this.env.clearTimer(timer);
        resolve(answer);
      };
      timer = this.env.setTimer(() => {
        log.info('speech availability check did not answer');
        finish('unavailable');
      }, CHECK_TIMEOUT_MS);
      try {
        Promise.resolve(api.Recognition.available?.({ langs: [s.lang], processLocally, quality: s.quality })).then(
          (r) => finish(typeof r === 'string' ? r : 'unavailable'),
          (err) => {
            log.info('speech availability check failed', describeError(err).name);
            finish('unavailable');
          },
        );
      } catch (err) {
        log.info('speech availability check failed', describeError(err).name);
        finish('unavailable');
      }
    });
  }

  private installFailed(err: unknown): { ok: false; message: string } {
    const name = err ? describeError(err).name : '';
    const message = name === 'NotAllowedError' ? VOICE_TEXT.downloadNeedsClick : VOICE_TEXT.downloadFailed;
    const s = this.env.settings();
    if (this.running && s.enabled && !this.session) this.publish({ state: 'needs-download', local: true, cloud: this.cloud, lang: s.lang, message });
    return { ok: false, message };
  }

  // ------------------------------------------------------------------------------- sessions

  private listen(gen: number, local: boolean): void {
    if (gen !== this.gen || !this.running) return;
    this.local = local;
    this.wanted = true;
    const s = this.env.settings();
    if (this.lastState() !== 'listening') this.publish(this.statusOf('ready', s));
    this.openSession();
  }

  private openSession(): void {
    if (!this.wanted || !this.running || this.session) return;
    if (this.retiring) {
      // The previous session is still shutting down; Chrome runs one recognition at a time.
      this.openPending = true;
      return;
    }
    const api = this.env.speech();
    const s = this.env.settings();
    if (!api) return;
    let rec: SpeechRecognitionLike;
    try {
      rec = new api.Recognition();
    } catch (err) {
      log.warn('could not create a speech recognizer', describeError(err));
      this.failQuickly();
      return;
    }
    rec.lang = s.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = MAX_ALTERNATIVES;
    if ('processLocally' in rec) rec.processLocally = this.local;
    let hintsKey = '';
    if (this.local && !this.phrasesOff) hintsKey = this.applyPhrases(rec, api, s);
    const id = `${this.prefix}.${++this.sessions}`;
    const session: Session = {
      id, rec, local: this.local, startedAt: this.env.now(), results: 0, error: null,
      tracker: new UtteranceTracker(id), hintsKey, refreshing: false, healthyTimer: null,
    };
    this.session = session;
    rec.onstart = () => this.onStart(session);
    rec.onaudiostart = () => {
      if (this.session === session) session.audioAt = this.env.now();
    };
    rec.onresult = (ev) => this.onResult(session, ev);
    rec.onerror = (ev) => this.onError(session, ev);
    rec.onend = () => this.onEnd(session);
    try {
      rec.start();
    } catch (err) {
      log.warn('speech recognition did not start', describeError(err));
      this.closeSession(session);
      this.failQuickly();
    }
  }

  private applyPhrases(rec: SpeechRecognitionLike, api: SpeechApi, s: VoiceSettings): string {
    if (!api.Phrase || !('phrases' in rec)) return '';
    const Phrase = api.Phrase;
    try {
      // Invented words are favored over near-sounding English (Section 7.6).
      rec.phrases = this.hints.map((p) => new Phrase(p, s.phraseBoost));
      return this.hintsKey(s);
    } catch (err) {
      log.once('voice.phrases', 'phrase hints could not be set; the fuzzy matcher carries on alone', describeError(err));
      return '';
    }
  }

  private hintsKey(s: VoiceSettings): string {
    return this.phrasesOff ? '' : `${s.phraseBoost}|${this.hints.join('|')}`;
  }

  private onStart(session: Session): void {
    if (this.session !== session) return;
    const s = this.env.settings();
    if (!this.trouble) {
      this.publish(this.statusOf('listening', s));
      return;
    }
    // After a failure, say "listening" only once the session has lasted (or heard something).
    session.healthyTimer = this.env.setTimer(() => {
      session.healthyTimer = null;
      if (this.session === session) this.recovered(session);
    }, HEALTHY_SESSION_MS);
  }

  private recovered(session: Session): void {
    this.quickFails = 0;
    if (this.trouble) {
      this.trouble = null;
      if (this.session === session) this.publish(this.statusOf('listening', this.env.settings()));
    }
  }

  private onResult(session: Session, ev: SpeechResultEventLike): void {
    if (this.session !== session || !ev) return;
    const now = this.env.now();
    let updates;
    try {
      updates = session.tracker.update(snapshotResults(ev.results), ev.resultIndex, now);
    } catch (err) {
      log.warn('could not read a speech result', err);
      return;
    }
    if (!updates.length) return;
    session.results++;
    if (this.trouble || this.quickFails) this.recovered(session);
    const minConf = this.env.settings().minConf;
    for (const u of updates) {
      const inc = decideIncantation(u, this.table, { minConf, audioStartAt: session.audioAt, floor: session.startedAt });
      this.env.incantation(inc);
    }
  }

  private onError(session: Session, ev: SpeechErrorEventLike): void {
    if (this.session !== session) return;
    const code = typeof ev?.error === 'string' ? ev.error : 'unknown';
    session.error = code;
    const s = this.env.settings();
    switch (code) {
      case 'not-allowed':
        this.blocked = 'not-allowed';
        this.wanted = false;
        this.publish({ ...this.statusOf('error', s), message: VOICE_TEXT.micBlocked });
        this.watchOnce(this.env.watchMicrophone, () => this.retryFresh());
        break;
      case 'language-not-supported':
        this.blocked = 'language';
        this.wanted = false;
        this.publish({ state: 'unavailable', local: true, cloud: this.cloud, lang: s.lang, message: VOICE_TEXT.language });
        break;
      case 'phrases-not-supported':
        // Biasing is a bonus: carry on without it.
        this.phrasesOff = true;
        break;
      case 'audio-capture':
        this.trouble = code;
        this.publish({ ...this.statusOf('error', s), message: VOICE_TEXT.noMicrophone });
        this.watchOnce(this.env.watchDevices, () => {
          if (this.wanted && !this.session) {
            this.cancelRestart();
            this.openSession();
          }
        });
        break;
      case 'network':
        this.trouble = code;
        this.publish({ ...this.statusOf('error', s), message: VOICE_TEXT.network });
        break;
      default:
        // 'no-speech' and 'aborted' are part of normal continuous listening; 'service-not-allowed'
        // is decided when the session ends.
        break;
    }
  }

  private onEnd(session: Session): void {
    if (this.session !== session) return;
    this.closeSession(session);
    const s = this.env.settings();
    if (!this.running || !s.enabled || !this.wanted || this.blocked) return;

    if (session.error === 'service-not-allowed') {
      if (session.local && this.serviceRetries++ === 0) {
        // The language pack went missing after all: check again (needs-download or unavailable).
        this.wanted = false;
        this.configKey = '';
        this.sync();
        // sync() resets the retry count with the new configuration; keep it so this happens once.
        this.serviceRetries = 1;
      } else {
        this.wanted = false;
        this.publish(session.local ? { ...this.statusOf('error', s), message: VOICE_TEXT.startFailed } : { state: 'unavailable', local: true, cloud: 'unavailable', lang: s.lang, message: VOICE_TEXT.cloudRefused });
      }
      return;
    }

    const lived = this.env.now() - session.startedAt;
    let delay: number;
    if (session.refreshing || session.error === 'phrases-not-supported') delay = 0;
    else if (session.results > 0 || lived >= HEALTHY_SESSION_MS) {
      this.quickFails = 0;
      delay = RESTART_MS;
    } else {
      this.quickFails++;
      delay = Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** (this.quickFails - 1));
      if (this.quickFails >= FAILURES_BEFORE_ERROR && !this.trouble) {
        this.trouble = 'keeps-stopping';
        this.publish({ ...this.statusOf('error', s), message: VOICE_TEXT.keepsStopping });
      }
    }
    if (session.error === 'audio-capture') delay = Math.max(delay, NO_MICROPHONE_RETRY_MS);
    this.scheduleRestart(delay);
  }

  private failQuickly(): void {
    this.quickFails++;
    const s = this.env.settings();
    if (this.quickFails >= FAILURES_BEFORE_ERROR && !this.trouble) {
      this.trouble = 'keeps-stopping';
      this.publish({ ...this.statusOf('error', s), message: VOICE_TEXT.keepsStopping });
    }
    this.scheduleRestart(Math.min(MAX_BACKOFF_MS, FIRST_BACKOFF_MS * 2 ** (this.quickFails - 1)));
  }

  private scheduleRestart(delay: number): void {
    this.cancelRestart();
    this.restartTimer = this.env.setTimer(() => {
      this.restartTimer = null;
      this.openSession();
    }, delay);
  }

  private cancelRestart(): void {
    if (this.restartTimer !== null) this.env.clearTimer(this.restartTimer);
    this.restartTimer = null;
  }

  /** The microphone was allowed again: start over with the same settings. */
  private retryFresh(): void {
    if (!this.running || !this.env.settings().enabled) return;
    this.configKey = '';
    this.sync();
  }

  private watchOnce(watch: VoiceEnv['watchMicrophone'], fn: () => void): void {
    if (!watch) return;
    let off: (() => void) | null = null;
    try {
      off = watch.call(this.env, () => {
        off?.();
        this.unwatch = this.unwatch.filter((u) => u !== off);
        fn();
      });
    } catch {
      off = null;
    }
    if (off) this.unwatch.push(off);
  }

  /** Detach a session's handlers and stop listening to it. */
  private closeSession(session: Session): void {
    if (session.healthyTimer !== null) this.env.clearTimer(session.healthyTimer);
    session.healthyTimer = null;
    const rec = session.rec;
    rec.onstart = rec.onaudiostart = rec.onresult = rec.onerror = rec.onend = null;
    if (this.session === session) this.session = null;
  }

  /** Stop everything: the session (aborted), timers and watchers. */
  private halt(): void {
    this.gen++;
    this.wanted = false;
    this.cancelRestart();
    if (this.pollTimer !== null) this.env.clearTimer(this.pollTimer);
    this.pollTimer = null;
    for (const off of this.unwatch) off();
    this.unwatch = [];
    const sess = this.session;
    if (sess) {
      this.closeSession(sess);
      this.retire(sess.rec);
    }
  }

  /** Abort a recognizer and wait (briefly) for its 'end' before another may start. */
  private retire(rec: SpeechRecognitionLike): void {
    this.retiring = rec;
    const done = () => {
      if (this.retiring !== rec) return;
      rec.onend = null;
      this.retiring = null;
      if (this.retireTimer !== null) this.env.clearTimer(this.retireTimer);
      this.retireTimer = null;
      if (this.openPending) {
        this.openPending = false;
        this.openSession();
      }
    };
    rec.onend = done;
    this.retireTimer = this.env.setTimer(done, RETIRE_WAIT_MS);
    try {
      rec.abort();
    } catch {
      done();
    }
  }

  // ------------------------------------------------------------------------------- spells

  private refreshSpells(): void {
    const book = this.env.spellbook();
    if (book === this.book) return;
    this.book = book;
    const entries = book?.spells ?? [];
    // Every available spell is matched, locked ones too: a locked spell's incantation is then heard
    // as itself (the engine answers "not open yet") instead of being mistaken for an open one.
    this.table = entries
      .filter((e) => e?.available === true && typeof e.spell?.id === 'string' && typeof e.spell.incantation === 'string')
      .map((e) => spellForms(e.spell.id, e.spell.incantation, Array.isArray(e.spell.heard_as) ? e.spell.heard_as : []));
    // Phrase hints favor what can be cast right now: the enabled spells (Section 7.6).
    const hints: string[] = [];
    for (const e of entries) {
      const text = e?.enabled === true && typeof e.spell?.incantation === 'string' ? e.spell.incantation.trim() : '';
      if (text && !hints.includes(text)) hints.push(text);
    }
    this.hints = hints;
  }

  // ------------------------------------------------------------------------------- status

  private statusOf(state: 'ready' | 'listening' | 'error', s: VoiceSettings): VoiceStatus {
    const status: VoiceStatus = { state, local: this.local, lang: s.lang };
    if (this.cloud) status.cloud = this.cloud;
    if (state === 'listening') status.message = this.local ? VOICE_TEXT.listeningLocal : VOICE_TEXT.listeningCloud;
    return status;
  }

  private lastState(): VoiceStatus['state'] | null {
    if (!this.lastStatus) return null;
    try {
      return (JSON.parse(this.lastStatus) as VoiceStatus).state;
    } catch {
      return null;
    }
  }

  /** Publish a status when it differs from the last one (without fields left undefined). */
  private publish(s: VoiceStatus): void {
    const clean = Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined)) as unknown as VoiceStatus;
    const key = JSON.stringify(clean);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.env.status(clean);
  }
}
