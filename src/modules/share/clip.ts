// Clips (Section 11.1: "a clip of five to ten seconds. The clip records the effects layer. Your camera
// image is left out unless you tick 'Include my camera'").
//
// The picture comes from the stage ('stage.capture.start': the composited mirror, the camera only when
// includeCamera) and the sound from the audio module ('audio.capture.start': the effect sound, never
// the microphone). Without the audio module the clip is silent. The tracks are merged into one
// MediaStream and recorded with MediaRecorder in the best type the browser offers: MP4 (H.264 and AAC)
// first, since phones and messengers play it everywhere, then WebM. Recording stops at maxMs, when
// the tab is hidden (the stage stops painting in a background tab, so the rest would be a frozen
// frame), when share.clip.stop asks, or, for a keepsake's replay, when the replay is over.
//
// Only the module's own requests are used; MediaRecorder and MediaStream come in through ClipEnv, so
// tests can stand in for them.

import type { ClipState, Kernel } from '../../contracts';
import { KernelError, ask, describeError, emit, type Logger } from '../../kernel';

export interface ClipResult {
  blob: Blob;
  filename: string;
  mime: string;
}

type RecorderClass = {
  new (stream: MediaStream, options?: MediaRecorderOptions): MediaRecorder;
  isTypeSupported?(type: string): boolean;
};

export interface ClipEnv {
  MediaRecorder: RecorderClass;
  MediaStream: new (tracks?: MediaStreamTrack[]) => MediaStream;
  document?: {
    visibilityState?: string;
    addEventListener(type: 'visibilitychange', fn: () => void): void;
    removeEventListener(type: 'visibilitychange', fn: () => void): void;
  } | null;
}

/** The browser's recorder, or null when it has none. Looked up at call time. */
export function browserClipEnv(): ClipEnv | null {
  const g = globalThis as { MediaRecorder?: RecorderClass; MediaStream?: ClipEnv['MediaStream']; document?: ClipEnv['document'] };
  if (typeof g.MediaRecorder !== 'function' || typeof g.MediaStream !== 'function') return null;
  return { MediaRecorder: g.MediaRecorder, MediaStream: g.MediaStream, document: g.document ?? null };
}

/** Best first. The brief's preference: MP4 with H.264 and AAC, else WebM with VP9 or VP8 and Opus. */
export const CLIP_TYPES = {
  withAudio: ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'],
  videoOnly: ['video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.42E01E', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'],
} as const;

/** The best type the recorder supports, or null to let the browser choose. */
export function pickClipType(isTypeSupported: ((type: string) => boolean) | undefined, withAudio: boolean): string | null {
  if (typeof isTypeSupported !== 'function') return null;
  for (const type of withAudio ? CLIP_TYPES.withAudio : CLIP_TYPES.videoOnly) {
    try {
      if (isTypeSupported(type)) return type;
    } catch {
      /* treated as unsupported */
    }
  }
  return null;
}

/** 'video/mp4;codecs=…' → 'video/mp4'. What the file is, for the Blob, the File and sharing. */
export function baseType(mime: string | null | undefined): string {
  const base = (mime ?? '').split(';')[0].trim().toLowerCase();
  return base || 'video/webm';
}

export function clipExtension(mime: string): string {
  return baseType(mime) === 'video/mp4' ? 'mp4' : 'webm';
}

export function clipFilename(spellId: string | undefined, mime: string, now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `spellglass-${spellId ?? 'mirror'}-${stamp}.${clipExtension(mime)}`;
}

export const CLIP_MESSAGES = {
  unsupported: 'This browser cannot record clips.',
  busy: 'A clip is already being recorded.',
  none: 'No clip has been recorded yet.',
  empty: 'The clip came out empty. Try recording again.',
  failed: 'The clip could not be recorded.',
  noStage: 'Clips need the mirror, and it is not running yet.',
} as const;

/** Why a clip stopped (ClipState.reason when state is 'stopped'); errors carry a sentence instead. */
export type StopReason = 'requested' | 'time-limit' | 'hidden' | 'replay-finished' | 'module-stopped';

export const DEFAULT_CLIP_MS = 10_000;
const MIN_CLIP_MS = 1000;
const MAX_CLIP_MS = 60_000;
const TICK_MS = 500;
/** The recorder gets this long to start before a replay begins anyway. */
const START_WAIT_MS = 300;
/** And this long to hand over its last data after stop(). */
const STOP_WAIT_MS = 3000;
const VIDEO_BITS_PER_SECOND = 2_500_000;
const AUDIO_BITS_PER_SECOND = 128_000;

export interface ClipHost {
  kernel: Kernel;
  /** Module id: the requester for the capture requests and the source of 'share.clip.state'. */
  source: string;
  env(): ClipEnv | null;
  /** Check that a keepsake's replay can play and return how to start it; throws a KernelError.
   *  includeCamera: the replay plays over the live camera instead of the plain backdrop, or the
   *  camera the player asked for would never be in the picture. */
  prepareReplay(castId: string, includeCamera: boolean): Promise<{ spellId: string; play(): Promise<unknown> }>;
  log: Logger;
}

type Phase = 'idle' | 'starting' | 'recording' | 'finishing';

interface Session {
  recorder: MediaRecorder;
  chunks: Blob[];
  mime: string;
  /** Kernel clock, for elapsed times. */
  startedAt: number;
  /** Wall clock, for the file name: a clip is named after the moment it began. */
  startedOn: Date;
  castId?: string;
  spellId?: string;
  maxTimer: ReturnType<typeof setTimeout> | null;
  tickTimer: ReturnType<typeof setInterval> | null;
  onVisibility: (() => void) | null;
  doc: ClipEnv['document'];
}

export class ClipRecorder {
  private phase: Phase = 'idle';
  private session: Session | null = null;
  private starting: Promise<void> | null = null;
  private finishing: Promise<void> | null = null;
  /** The last finished clip, or why it failed; kept until the next clip starts. */
  private outcome: { clip: ClipResult } | { error: KernelError } | null = null;

  constructor(private readonly host: ClipHost) {}

  get recording(): boolean {
    return this.phase === 'recording';
  }

  /** 'share.clip.start'. Resolves once recording has begun. */
  start(p: { includeCamera?: boolean; maxMs?: number; castId?: string }): Promise<void> {
    if (this.phase !== 'idle') return Promise.reject(new KernelError('invalid-payload', CLIP_MESSAGES.busy));
    this.phase = 'starting';
    const run = this.begin(p).catch((err) => {
      this.phase = 'idle';
      throw err;
    });
    this.starting = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** 'share.clip.stop': stops a clip in progress, or returns the one that stopped on its own. */
  async stop(): Promise<ClipResult> {
    if (this.phase === 'starting') await this.starting;
    if (this.phase === 'recording') await this.finish({ reason: 'requested' });
    else if (this.phase === 'finishing') await this.finishing;
    const outcome = this.outcome;
    if (!outcome) throw new KernelError('invalid-payload', CLIP_MESSAGES.none);
    if ('error' in outcome) throw outcome.error;
    if (outcome.clip.blob.size === 0) throw new KernelError('not-supported', CLIP_MESSAGES.empty);
    return outcome.clip;
  }

  /** Module stop: end a clip in progress and let go of the capture streams. */
  async shutdown(): Promise<void> {
    if (this.phase === 'starting') await this.starting;
    if (this.phase === 'recording') await this.finish({ reason: 'module-stopped' });
    else if (this.phase === 'finishing') await this.finishing;
  }

  // -------------------------------------------------------------------------------------- internals

  private async begin(p: { includeCamera?: boolean; maxMs?: number; castId?: string }): Promise<void> {
    const { kernel, source } = this.host;
    const env = this.host.env();
    if (!env || !kernel.has('platform.media-recorder')) throw new KernelError('not-supported', CLIP_MESSAGES.unsupported);
    const maxMs = Math.min(MAX_CLIP_MS, Math.max(MIN_CLIP_MS, typeof p.maxMs === 'number' && Number.isFinite(p.maxMs) ? p.maxMs : DEFAULT_CLIP_MS));
    const replay = typeof p.castId === 'string' ? await this.host.prepareReplay(p.castId, p.includeCamera === true) : null;

    let video: MediaStream;
    try {
      video = (await ask(kernel, 'stage.capture.start', { requester: source, includeCamera: p.includeCamera === true, fps: 30 })).stream;
    } catch (err) {
      if (err instanceof KernelError && err.code === 'no-handler') throw new KernelError('not-supported', CLIP_MESSAGES.noStage, err);
      throw err;
    }
    // The effect sound is welcome but optional: without it the clip is silent.
    let audio: MediaStream | null = null;
    try {
      audio = (await ask(kernel, 'audio.capture.start', { requester: source })).stream;
    } catch (err) {
      this.host.log.info('recording a silent clip', describeError(err).message);
    }

    let recorder: MediaRecorder;
    let mime: string;
    try {
      const audioTracks = audio?.getAudioTracks() ?? [];
      const stream = new env.MediaStream([...video.getVideoTracks(), ...audioTracks]);
      const chosen = pickClipType(env.MediaRecorder.isTypeSupported?.bind(env.MediaRecorder), audioTracks.length > 0);
      recorder = new env.MediaRecorder(stream, {
        ...(chosen ? { mimeType: chosen } : {}),
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
        ...(audioTracks.length ? { audioBitsPerSecond: AUDIO_BITS_PER_SECOND } : {}),
      });
      mime = recorder.mimeType || chosen || '';
    } catch (err) {
      await this.release();
      throw new KernelError('not-supported', CLIP_MESSAGES.unsupported, err);
    }

    const session: Session = {
      recorder, chunks: [], mime, startedAt: kernel.now(), startedOn: new Date(), castId: p.castId, spellId: replay?.spellId,
      maxTimer: null, tickTimer: null, onVisibility: null, doc: env.document ?? null,
    };
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) session.chunks.push(e.data);
    };
    recorder.onerror = (e: Event) => {
      this.host.log.warn('the clip recorder failed', (e as { error?: unknown }).error ?? e);
      void this.finish({ error: CLIP_MESSAGES.failed });
    };
    const started = new Promise<void>((resolve) => {
      recorder.addEventListener('start', () => resolve(), { once: true });
      setTimeout(resolve, START_WAIT_MS);
    });
    try {
      recorder.start(1000);
    } catch (err) {
      await this.release();
      throw new KernelError('not-supported', CLIP_MESSAGES.unsupported, err);
    }

    this.session = session;
    this.outcome = null;
    this.phase = 'recording';
    this.publish('recording');
    session.maxTimer = setTimeout(() => void this.finish({ reason: 'time-limit' }), maxMs);
    session.tickTimer = setInterval(() => this.publish('recording'), TICK_MS);
    if (session.doc && typeof session.doc.addEventListener === 'function') {
      const doc = session.doc;
      session.onVisibility = () => {
        if (doc.visibilityState === 'hidden') void this.finish({ reason: 'hidden' });
      };
      doc.addEventListener('visibilitychange', session.onVisibility);
    }

    if (replay) {
      void started.then(() => {
        if (this.session !== session || this.phase !== 'recording') return;
        replay.play().then(
          () => {
            if (this.session === session) void this.finish({ reason: 'replay-finished' });
          },
          (err: unknown) => {
            if (this.session === session) void this.finish({ error: describeError(err).message || CLIP_MESSAGES.failed });
          },
        );
      });
    }
  }

  /** Stop recording, gather the data and let go of the streams. Runs once per clip. */
  private finish(how: { reason: StopReason } | { error: string }): Promise<void> {
    if (this.finishing) return this.finishing;
    const session = this.session;
    if (!session || this.phase !== 'recording') return Promise.resolve();
    this.phase = 'finishing';
    if (session.maxTimer !== null) clearTimeout(session.maxTimer);
    if (session.tickTimer !== null) clearInterval(session.tickTimer);
    if (session.onVisibility && session.doc) session.doc.removeEventListener('visibilitychange', session.onVisibility);
    const run = (async () => {
      const recorder = session.recorder;
      if (recorder.state !== 'inactive') {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, STOP_WAIT_MS);
          recorder.addEventListener('stop', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
          try {
            recorder.stop();
          } catch {
            clearTimeout(timer);
            resolve();
          }
        });
      }
      await this.release();
      const elapsedMs = Math.max(0, Math.round(this.host.kernel.now() - session.startedAt));
      const mime = baseType(recorder.mimeType || session.mime);
      if ('error' in how) {
        this.outcome = { error: new KernelError('not-supported', how.error) };
        this.publish('error', how.error, elapsedMs, session);
      } else {
        const blob = new Blob(session.chunks, { type: mime });
        this.outcome = { clip: { blob, filename: clipFilename(session.spellId, mime, session.startedOn), mime } };
        this.publish('stopped', how.reason, elapsedMs, session);
      }
    })();
    this.finishing = run.finally(() => {
      this.finishing = null;
      this.session = null;
      this.phase = 'idle';
    });
    return this.finishing;
  }

  private async release(): Promise<void> {
    const { kernel, source } = this.host;
    await Promise.all([
      ask(kernel, 'stage.capture.stop', { requester: source }).catch(() => undefined),
      ask(kernel, 'audio.capture.stop', { requester: source }).catch(() => undefined),
    ]);
  }

  private publish(state: ClipState['state'], reason?: string, elapsed?: number, session: Session | null = this.session): void {
    const elapsedMs = elapsed ?? (session ? Math.max(0, Math.round(this.host.kernel.now() - session.startedAt)) : 0);
    const payload: ClipState = { state, elapsedMs, ...(session?.castId ? { castId: session.castId } : {}), ...(reason ? { reason } : {}) };
    emit(this.host.kernel, this.host.source, 'share.clip.state', payload);
  }
}
