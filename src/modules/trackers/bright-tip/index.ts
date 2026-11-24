// Bright-tip tracker (tracker.bright-tip): follows the glint of the wand tip, lit by a small light beside
// the lens (route A) or by infrared LEDs around it (route C). Blueprint Sections 4 and 7.2.
//
// The main thread only moves frames to the worker, which reads the pixels and runs algorithm.ts. Frames
// come from one of two sources, through one send path:
//  - The fast path (kernel/frame-feed.ts, shared with the hand tracker): where Chromium offers
//    MediaStreamTrackProcessor, frames come straight from the camera track in CameraReady.stream. They
//    are far cheaper to read (frame-feed.ts has the numbers: at 1080p a whole frame costs 1.2 ms instead
//    of 11.8 ms), which is what keeps the tracker inside the 4 ms budget of Section 13.
//  - Otherwise, on each 'camera.frame' the capture module's video is wrapped in a VideoFrame (or an
//    ImageBitmap where VideoFrame is missing). This also takes over if the fast path stops delivering.
// One frame is in flight at a time; a frame that arrives while the worker is busy is dropped rather than
// queued, so a slow frame never delays the trail (Section 5).
//
// Measured stepMs (tracker.status, median per second) on the reference laptop, Chrome 158, the fake
// camera at 1920x1080: 0.7 ms while tracking and 2.8 to 3.2 ms while searching (every frame a full
// survey) on the fast path; 9 to 10 ms on the fallback. At 640x360 both paths stay under 2 ms.
//
// Tip event rules (contracts/events.ts): tracker.status goes out after start() and before any tip
// event, and again whenever the aspect changes; tip.found precedes the sample of the same frame;
// tip.lost carries lastSeen and is sent on stop, when the camera stops and before a camera generation
// changes. Sample times are the camera's capture times, carried through the worker untouched.

import type {
  AutotuneResult, CameraExposureInfo, CameraFrame, CameraReady, Kernel, Module, ModuleManifest, TipSample, TrackerStatus,
} from '../../../contracts';
import {
  ask, browserProcessor, describeError, emit, lastPayload, logger, on, serve, setSetting, setting, startFeed, type Feed, type ProcessorFactory,
} from '../../../kernel';
import { DEFAULT_TIP_CONFIG, INFRARED_DEFAULTS, type TipConfig } from './algorithm';
import { AutotunePlanner, autotuneMessage, type Exposure, type Measure } from './autotune';
import type { FromWorker, ToWorker, WireResult } from './protocol';

export const MANIFEST: ModuleManifest = {
  id: 'tracker.bright-tip',
  kind: 'tracker',
  title: 'Wand tip (light beside the lens)',
  version: '1.0.0',
  contract: '^1.1',
  provides: ['tip.source'],
  // camera.frames@1 is the capture module's capability: without capture there is nothing to track.
  requires: ['platform.camera', 'platform.worker', 'platform.offscreen-canvas', 'camera.frames@1'],
};

const ID = MANIFEST.id;
const log = logger(ID);

/** The worker as the module uses it (a real Worker in the browser, a fake in tests). */
export interface WorkerLike {
  postMessage(message: ToWorker, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  onerror: ((event: ErrorEvent | Event) => void) | null;
}

export interface BrightTipDeps {
  createWorker(): WorkerLike;
  /** The current frame of the capture module's video, ready to transfer; null when there is none yet. */
  grabFrame(video: HTMLVideoElement, t: number): VideoFrame | ImageBitmap | Promise<VideoFrame | ImageBitmap> | null;
  /** MediaStreamTrackProcessor on the camera track, where the browser has it (the fast path,
   *  kernel/frame-feed.ts). Absent or null: frames come from 'camera.frame' only. */
  openProcessor?: ProcessorFactory | null;
}

/** Section 7.9: processing below this rate for STEP_DOWN_AFTER_MS asks capture to step the size down. */
const LOW_FPS = 20;
const STEP_DOWN_AFTER_MS = 2000;
/** Section 7.9: "After 3 s without a tip it shows the 'tip not found' hint." */
const HINT_AFTER_MS = 3000;
const STATUS_EVERY_MS = 500;
/** A frame in flight for longer than this is given up (the worker died or lost it). */
const STALL_MS = 1000;
/** The fast path is given up for the rest of a camera generation when it has delivered nothing for this
 *  long while the worker sat idle and this many 'camera.frame' events arrived. Counting frames, not just
 *  time, matters: after a long main-thread task (the app starting up), the video's queued callback can
 *  run before the processor's queued frame, which proves nothing. */
const FEED_STALL_MS = 1500;
const FEED_STALL_FRAMES = 30;
/** 'too-many-lights' when, over the last 3 s, this many bright blobs show up per survey, or the static
 *  mask covers this share of the frame: the mask cannot settle on what is static. */
const CLUTTER_BLOBS = 4;
const CLUTTER_MASKED = 0.08;
const CONFIG_KEYS = [
  'brightTip.k', 'brightTip.floor', 'brightTip.channel', 'brightTip.minArea', 'brightTip.maxArea', 'brightTip.searchRadius',
  'brightTip.lostAfter', 'brightTip.searchWidth', 'brightTip.staticMask', 'brightTip.profile', 'capture.flipX',
];

export function createBrightTipTracker(): Module {
  return buildBrightTipTracker(browserDeps());
}

function browserDeps(): BrightTipDeps {
  // Chromium: a VideoFrame wraps the video's current frame without a copy, and its Y plane can be read
  // by rectangle in the worker. Elsewhere, an ImageBitmap.
  let useVideoFrame: boolean | null = null;
  return {
    createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'bright-tip' }) as unknown as WorkerLike,
    openProcessor: browserProcessor(),
    grabFrame(video, t) {
      if (useVideoFrame === null) useVideoFrame = typeof VideoFrame === 'function';
      if (useVideoFrame) {
        try {
          // timestamp is in microseconds; the worker never reads it (t travels in the message).
          return new VideoFrame(video, { timestamp: Math.round(t * 1000) });
        } catch (err) {
          // InvalidStateError: the video has no frame yet. Anything else: this browser cannot do it.
          if ((err as { name?: string })?.name === 'InvalidStateError') return null;
          useVideoFrame = false;
        }
      }
      return typeof createImageBitmap === 'function' ? createImageBitmap(video) : null;
    },
  };
}

interface TimedValue {
  t: number;
  v: number;
}

/** The bright-tip module, with its browser dependencies injected (tests pass fakes). */
export function buildBrightTipTracker(deps: BrightTipDeps): Module {
  let kernel: Kernel;
  let run = 0;
  let active = false;
  let worker: WorkerLike | null = null;
  let offs: (() => void)[] = [];
  let configured = false;
  let userKeys = new Set<string>();

  let camera: CameraReady | null = null;
  let boundAt = 0;
  let busy = false;
  let busySince = 0;
  /** The fast path while it runs, when it last delivered a frame, the video frames seen since, and the
   *  generation it failed on. */
  let feed: Feed | null = null;
  let feedSeenAt = 0;
  let framesSinceFeed = 0;
  let feedFailedFor: number | null = null;
  let idleWaiters: (() => void)[] = [];

  let holding = false;
  let lastSeen: number | null = null;
  let lastFrameT: number | null = null;
  let state: TrackerStatus['state'] = 'stopped';
  let message: string | undefined;
  let hint: TrackerStatus['hint'] = null;
  let startedAt = 0;
  let lastConfidentAt: number | null = null;
  let firstResultAt: number | null = null;

  // Rolling measurements (kernel clock).
  let processed: number[] = [];
  let steps: TimedValue[] = [];
  let locks: TimedValue[] = [];
  let clutter: { t: number; blobs: number; masked: number }[] = [];
  let contrast: { t: number; v: number } | null = null;
  let lowFpsSince: number | null = null;
  const stepDownAsked = new Set<number>();

  let debugBitmap: ImageBitmap | null = null;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let relearnId = 0;
  const relearnWaiters = new Map<number, () => void>();
  let tune: TuneSession | null = null;

  const now = () => kernel.now();

  // ------------------------------------------------------------------------------------ config

  function effectiveConfig(): TipConfig {
    const cfg: TipConfig = {
      k: setting(kernel, 'brightTip.k'),
      floor: setting(kernel, 'brightTip.floor'),
      channel: setting(kernel, 'brightTip.channel'),
      minArea: setting(kernel, 'brightTip.minArea'),
      maxArea: setting(kernel, 'brightTip.maxArea'),
      searchRadius: setting(kernel, 'brightTip.searchRadius'),
      lostAfter: setting(kernel, 'brightTip.lostAfter'),
      searchWidth: setting(kernel, 'brightTip.searchWidth'),
      staticMask: setting(kernel, 'brightTip.staticMask'),
      flipX: setting(kernel, 'capture.flipX'),
    };
    // Route C changes the defaults only: a value the player (or a camera profile) set still wins.
    if (setting(kernel, 'brightTip.profile') === 'infrared') {
      for (const [key, value] of Object.entries(INFRARED_DEFAULTS) as [keyof TipConfig, never][]) {
        if (!userKeys.has(`brightTip.${key}`)) cfg[key] = value;
      }
    }
    return sanitize(cfg);
  }

  async function configure(myRun: number): Promise<void> {
    try {
      const user = await ask(kernel, 'settings.user');
      userKeys = new Set(Object.keys(user ?? {}));
    } catch {
      userKeys = new Set();
    }
    if (myRun !== run || !worker) return;
    worker.postMessage({ type: 'config', config: effectiveConfig() }, []);
    configured = true;
  }

  // ------------------------------------------------------------------------------------ camera

  function bind(ready: CameraReady): void {
    if (camera && camera.generation === ready.generation && camera.deviceId === ready.deviceId) return;
    // Rule 3: the tip is lost before the generation changes.
    if (holding) loseTip(lastFrameT ?? now());
    camera = ready;
    boundAt = now();
    // A frame of the old generation still in flight is dropped when it returns.
    setIdle();
    firstResultAt = null;
    contrast = null;
    clutter = [];
    lowFpsSince = null;
    worker?.postMessage({ type: 'reset', run, generation: ready.generation }, []);
    if (message === WAITING) message = undefined;
    // The aspect may have changed: say so before any tip event from this stream.
    publishStatus();
    startProcessorFeed(ready);
  }

  function unbind(): void {
    if (holding) loseTip(lastFrameT ?? now());
    stopFeed();
    camera = null;
    setIdle();
    setState('starting', WAITING);
  }

  /** The fast path: frames straight from the camera track, the newest one whenever the worker is free. */
  function startProcessorFeed(ready: CameraReady): void {
    stopFeed();
    if (!deps.openProcessor || feedFailedFor === ready.generation) return;
    const track = typeof ready.stream?.getVideoTracks === 'function' ? ready.stream.getVideoTracks()[0] : undefined;
    // A one-frame buffer: while the worker is busy the processor keeps only the newest frame.
    const readable = track && track.readyState !== 'ended' ? deps.openProcessor(track, 1) : null;
    if (!readable) return;
    const myRun = run, gen = ready.generation;
    feedSeenAt = now();
    framesSinceFeed = 0;
    const f = startFeed({
      readable,
      now,
      fps: ready.fps,
      waitIdle,
      deliver: ({ frame, t, index, width, height }) => {
        feedSeenAt = now();
        framesSinceFeed = 0;
        if (myRun !== run || feed !== f || !camera || camera.generation !== gen || !worker || !configured || !active) {
          frame.close();
          return;
        }
        send(frame, { t, frame: index, width, height, generation: gen });
      },
    });
    feed = f;
    // When the feed ends on its own (the track ended, the stream failed), 'camera.frame' takes over.
    void f.done.then(() => {
      if (feed === f) feed = null;
    });
  }

  function stopFeed(): void {
    const f = feed;
    feed = null;
    f?.cancel();
  }

  /** 'camera.frame': the fallback source, and the fast path's watchdog. */
  function onFrame(f: CameraFrame): void {
    if (!active || !worker || !configured || !camera || f.generation !== camera.generation) return;
    if (feed) {
      // The capture module's video still gets frames, so the camera is fine: if the processor has gone
      // quiet while the worker waits, give it up for this generation and read the video instead.
      if (busy) return;
      framesSinceFeed++;
      if (framesSinceFeed < FEED_STALL_FRAMES || now() - feedSeenAt < FEED_STALL_MS) return;
      log.warn('the camera track stopped handing frames to the fast path; reading the video instead');
      feedFailedFor = camera.generation;
      stopFeed();
    }
    if (busy) {
      if (now() - busySince < STALL_MS) return; // drop, never queue
      setIdle();
    }
    let source: ReturnType<BrightTipDeps['grabFrame']>;
    try {
      source = deps.grabFrame(f.video, f.t);
    } catch (err) {
      log.warn('could not grab a frame', err);
      return;
    }
    if (!source) return;
    const meta = { t: f.t, frame: f.frame, width: f.width, height: f.height, generation: f.generation };
    if (source instanceof Promise) {
      // createImageBitmap: hold the slot while it resolves, so frames are not grabbed twice.
      busy = true;
      busySince = now();
      const myRun = run;
      source.then(
        (src) => {
          if (myRun === run) send(src, meta);
          else src.close();
        },
        () => {
          if (myRun === run) setIdle();
        },
      );
    } else {
      send(source, meta);
    }
  }

  /** Hand one frame to the worker (transferred). A frame that cannot go is closed at once. */
  function send(src: VideoFrame | ImageBitmap, m: { t: number; frame: number; width: number; height: number; generation: number }): void {
    if (!worker || !active || !camera || camera.generation !== m.generation) {
      src.close();
      setIdle();
      return;
    }
    busy = true;
    busySince = now();
    const msg: ToWorker = {
      type: 'frame', run, generation: m.generation, t: m.t, frame: m.frame, width: m.width, height: m.height,
      source: src, debug: setting(kernel, 'tracker.debug'), survey: tune?.wantsSurvey ?? false,
    };
    try {
      worker.postMessage(msg, [src]);
    } catch (err) {
      src.close();
      setIdle();
      log.warn('could not hand a frame to the worker', err);
    }
  }

  /** The worker is free: let the fast path read its next frame. */
  function setIdle(): void {
    busy = false;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  }

  /** Resolves when the worker is free, or once the frame in flight has been given up after STALL_MS
   *  (the worker died or lost it). Never while a frame is legitimately in flight: one at a time. */
  async function waitIdle(): Promise<void> {
    while (busy) {
      const timedOut = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), STALL_MS);
        idleWaiters.push(() => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      if (timedOut && busy && now() - busySince >= STALL_MS) setIdle();
    }
  }

  // ------------------------------------------------------------------------------------ results

  function onWorker(msg: FromWorker): void {
    switch (msg.type) {
      case 'result':
        if (msg.run !== run || !active) {
          msg.debug?.image.close();
          return;
        }
        if (!camera || msg.generation !== camera.generation) {
          msg.debug?.image.close();
          setIdle();
          return;
        }
        // Record the result first, then free the slot: the fast path's next frame is read only after.
        try {
          onResult(msg);
        } finally {
          setIdle();
        }
        return;
      case 'skipped':
        if (msg.run === run) setIdle();
        return;
      case 'relearned':
        if (msg.run === run) relearnWaiters.get(msg.id)?.();
        return;
      case 'error':
        log.warn('worker error', msg.message);
        return;
    }
  }

  function onResult(msg: Extract<FromWorker, { type: 'result' }>): void {
    const r = msg.result;
    const t = msg.t;
    const k = now();
    lastFrameT = t;
    firstResultAt ??= k;
    processed.push(k);
    steps.push({ t: k, v: msg.stepMs });
    locks.push({ t: k, v: r.sample && r.sample.conf >= 0.5 ? 1 : 0 });
    if (r.survey) clutter.push({ t: k, blobs: r.candidates, masked: r.maskedFraction });
    if (r.contrast !== null) contrast = { t: k, v: contrast && k - contrast.t < 1000 ? 0.8 * contrast.v + 0.2 * r.contrast : r.contrast };
    trim(k);

    if (r.sample) {
      const sample: TipSample = { t, x: r.sample.x, y: r.sample.y, conf: round3(r.sample.conf), src: ID, size: r.sample.size, frame: msg.frame };
      if (!holding) {
        holding = true;
        hint = null;
        setState('tracking');
        emit(kernel, ID, 'tip.found', sample, t);
      }
      lastSeen = t;
      if (r.sample.conf >= 0.5) lastConfidentAt = k;
      emit(kernel, ID, 'tip.sample', sample, t);
    } else if (holding && (r.lost || r.state === 'searching')) {
      loseTip(t);
    } else if (state === 'starting') {
      setState('searching');
    }

    if (msg.debug) publishDebug(msg, r);
    tune?.onResult(r, t);
    checkFrameRate(k);
  }

  function loseTip(t: number): void {
    if (!holding) return;
    holding = false;
    emit(kernel, ID, 'tip.lost', { t, src: ID, lastSeen: lastSeen ?? undefined }, t);
    if (active && camera) setState('searching');
  }

  function publishDebug(msg: Extract<FromWorker, { type: 'result' }>, r: WireResult): void {
    const d = msg.debug!;
    if (!setting(kernel, 'tracker.debug')) {
      d.image.close();
      return;
    }
    const previous = debugBitmap;
    debugBitmap = d.image;
    emit(kernel, ID, 'tracker.debug', {
      tracker: ID, t: msg.t, image: d.image, width: d.width, height: d.height, blobs: r.blobs,
      mean: round3(r.mean), std: round3(r.std), threshold: r.threshold, tipLevel: r.tipLevel ?? undefined,
      backgroundMax: r.backgroundMax, contrast: r.contrast === null ? undefined : round3(r.contrast),
    }, msg.t);
    // The previous view stays valid until this one is out (contracts/events.ts TrackerDebugFrame).
    previous?.close();
  }

  function checkFrameRate(k: number): void {
    if (!camera || stepDownAsked.has(camera.generation)) return;
    const fps = processed.length;
    // Judge only once frames have flowed for a while, so start-up does not count as slow.
    if (fps >= LOW_FPS || k - boundAt < STEP_DOWN_AFTER_MS + 1000) {
      lowFpsSince = null;
      return;
    }
    lowFpsSince ??= k;
    if (k - lowFpsSince < STEP_DOWN_AFTER_MS) return;
    stepDownAsked.add(camera.generation);
    ask(kernel, 'camera.step-down', { requester: ID, fps }).then(
      (size) => log.info(size ? `asked for a smaller capture size: ${size.width}x${size.height}` : 'capture did not step down'),
      (err) => log.warn('step-down failed', err),
    );
  }

  function trim(k: number): void {
    const cut1 = k - 1000, cut3 = k - 3000;
    while (processed.length && processed[0] < cut1) processed.shift();
    while (steps.length && steps[0].t < cut1) steps.shift();
    while (locks.length && locks[0].t < cut1) locks.shift();
    while (clutter.length && clutter[0].t < cut3) clutter.shift();
  }

  // ------------------------------------------------------------------------------------ status

  function setState(next: TrackerStatus['state'], msg?: string): void {
    const changed = next !== state || (msg !== undefined && msg !== message);
    state = next;
    if (msg !== undefined) message = msg;
    if (changed) publishStatus();
  }

  /** Section 7.9: the hint appears 3 s after start() or after the last confident sample. It needs frames:
   *  while the camera is off or blocked, camera.status says so and "tip not found" would mislead. */
  function updateHint(k: number): void {
    const flowing = processed.length > 0 && k - processed[processed.length - 1] < 1000;
    if (!active || holding || !camera || !flowing || firstResultAt === null) {
      hint = null;
      return;
    }
    const since = Math.max(startedAt, firstResultAt, lastConfidentAt ?? -Infinity);
    if (k - since < HINT_AFTER_MS) {
      hint = null;
      return;
    }
    const blobs = clutter.length ? clutter.reduce((s, c) => s + c.blobs, 0) / clutter.length : 0;
    const masked = clutter.length ? clutter.reduce((s, c) => s + c.masked, 0) / clutter.length : 0;
    hint = blobs >= CLUTTER_BLOBS || masked > CLUTTER_MASKED ? 'too-many-lights' : 'tip-not-found';
  }

  function publishStatus(): void {
    const k = now();
    trim(k);
    updateHint(k);
    const exposure = lastPayload(kernel, 'camera.status')?.exposure;
    const median = steps.length ? [...steps.map((s) => s.v)].sort((a, b) => a - b)[steps.length >> 1] : undefined;
    const status: TrackerStatus = {
      tracker: ID,
      state,
      lock: locks.length ? round3(locks.reduce((s, l) => s + l.v, 0) / locks.length) : 0,
      fps: processed.length,
      aspect: aspectOf(camera),
      width: camera?.width,
      height: camera?.height,
      pen: false,
      contrast: contrast && k - contrast.t < 1000 ? round3(contrast.v) : undefined,
      stepMs: median === undefined ? undefined : Math.round(median * 100) / 100,
      source: state === 'stopped' ? undefined : feed ? 'track' : 'video',
      exposure: exposure ? { mode: exposure.mode, time: exposure.time } : undefined,
      hint: state === 'stopped' ? null : hint,
      message,
    };
    emit(kernel, ID, 'tracker.status', status);
  }

  function aspectOf(c: CameraReady | null): number {
    const ready = c ?? lastPayload(kernel, 'camera.ready');
    return ready && ready.width > 0 && ready.height > 0 ? ready.width / ready.height : 16 / 9;
  }

  // ------------------------------------------------------------------------------------ requests

  function relearn(): Promise<void> {
    const id = ++relearnId;
    return new Promise<void>((resolve) => {
      const done = () => {
        relearnWaiters.delete(id);
        clearTimeout(timer);
        resolve();
      };
      // Resolves when the worker says the mask has learned again, or after the warm-up time anyway
      // (no frames are coming, say).
      const timer = setTimeout(done, 2500);
      relearnWaiters.set(id, done);
      worker?.postMessage({ type: 'relearn', run, id }, []);
    });
  }

  async function autotune(): Promise<AutotuneResult> {
    if (tune) return tune.promise;
    if (!camera) return { ok: false, message: 'The camera is not on yet. Turn it on, then tune again.' };
    const session = new TuneSession(camera.exposure, currentExposure(camera), setting(kernel, 'brightTip.floor'));
    tune = session;
    try {
      return await session.promise;
    } finally {
      if (tune === session) tune = null;
    }
  }

  function currentExposure(c: CameraReady): { time?: number; compensation?: number; mode?: string } {
    const live = lastPayload(kernel, 'camera.status')?.exposure;
    return { time: live?.time ?? c.exposure?.time, compensation: live?.compensation, mode: live?.mode ?? c.exposure?.mode };
  }

  /** One autotune run: set an exposure, let it settle, measure a few full frames, repeat. */
  class TuneSession {
    readonly promise: Promise<AutotuneResult>;
    wantsSurvey = true;
    private resolve!: (r: AutotuneResult) => void;
    private planner: AutotunePlanner;
    private measures: Measure[] = [];
    private settleUntil = Infinity;
    private stepTimer: ReturnType<typeof setTimeout> | null = null;
    private finished = false;
    private readonly original: { mode?: string; time?: number; compensation?: number };
    private lastContrast: number | null = null;

    constructor(info: CameraExposureInfo | null, start: { time?: number; compensation?: number; mode?: string }, floor: number) {
      this.original = start;
      this.planner = new AutotunePlanner(info, start, floor);
      this.promise = new Promise((r) => (this.resolve = r));
      void this.apply(this.planner.first());
    }

    /** Called with every worker result while the session runs. */
    onResult(r: WireResult, t: number): void {
      if (this.finished || !r.survey || t < this.settleUntil) return;
      this.measures.push({ mean: r.mean, std: r.std, backgroundMax: r.backgroundMax, tipLevel: r.tipLevel });
      if (r.contrast !== null) this.lastContrast = r.contrast;
      if (this.measures.length < 3) return;
      const m = median3(this.measures);
      this.measures = [];
      const step = this.planner.next(m);
      if (step.kind === 'set') {
        void this.apply(step.exposure);
        return;
      }
      void this.finish(step);
    }

    cancel(): void {
      if (this.finished) return;
      this.finished = true;
      this.clearTimer();
      void this.restore();
      this.resolve({ ok: false, message: 'Tuning stopped.' });
    }

    private async apply(exposure: Exposure | null): Promise<void> {
      this.clearTimer();
      if (exposure) {
        try {
          await ask(kernel, 'camera.exposure', { requester: ID, ...exposure });
        } catch (err) {
          log.warn('autotune could not set the exposure', err);
        }
      }
      // Frames captured before the camera applied the change do not count; a camera takes a few frames.
      this.settleUntil = now() + (exposure ? 300 : 0);
      this.measures = [];
      this.stepTimer = setTimeout(() => this.fail('No frames arrived from the camera while tuning.'), 3000);
    }

    private async finish(step: Extract<ReturnType<AutotunePlanner['next']>, { kind: 'done' }>): Promise<void> {
      this.clearTimer();
      if (this.finished) return;
      this.finished = true;
      this.wantsSurvey = false;
      // The planner may have gone back one step.
      if (step.exposure) await ask(kernel, 'camera.exposure', { requester: ID, ...step.exposure }).catch(() => undefined);
      await setSetting(kernel, 'brightTip.k', step.k).catch(() => undefined);
      await setSetting(kernel, 'brightTip.floor', step.floor).catch(() => undefined);
      // Save what worked for this camera (Section 7.1); storage may be absent.
      await ask(kernel, 'camera.profile.save', { k: step.k, floor: step.floor }).catch(() => undefined);
      const c = step.tipSeen && step.measure.tipLevel !== null ? step.measure.tipLevel / Math.max(1, step.measure.backgroundMax) : this.lastContrast;
      this.resolve({
        ok: true,
        message: autotuneMessage(step, step.tipSeen ? c : null),
        contrast: c === null ? undefined : round3(c),
        exposureTime: step.exposure?.mode === 'manual' ? step.exposure.time : null,
        k: step.k,
      });
    }

    private fail(text: string): void {
      if (this.finished) return;
      this.finished = true;
      this.wantsSurvey = false;
      void this.restore();
      this.resolve({ ok: false, message: text });
    }

    private async restore(): Promise<void> {
      const o = this.original;
      if (this.planner.control === 'none') return;
      const back = o.mode === 'manual' && o.time !== undefined ? { mode: 'manual' as const, time: o.time } : { mode: 'continuous' as const, compensation: o.compensation };
      await ask(kernel, 'camera.exposure', { requester: ID, ...back }).catch(() => undefined);
    }

    private clearTimer(): void {
      if (this.stepTimer) clearTimeout(this.stepTimer);
      this.stepTimer = null;
    }
  }

  // ------------------------------------------------------------------------------------ lifecycle

  return {
    manifest: MANIFEST,

    async init(k) {
      kernel = k;
    },

    async start() {
      if (active) return;
      active = true;
      run++;
      const myRun = run;
      startedAt = now();
      holding = false;
      lastSeen = null;
      lastFrameT = null;
      lastConfidentAt = null;
      firstResultAt = null;
      processed = [];
      steps = [];
      locks = [];
      clutter = [];
      contrast = null;
      hint = null;
      message = WAITING;
      configured = false;
      camera = null;
      feed = null;
      feedFailedFor = null;
      busy = false;

      state = 'starting';
      // Rule 1: status (with aspect and pen) before any tip event.
      publishStatus();

      try {
        worker = deps.createWorker();
        worker.onmessage = (e) => onWorker(e.data);
        worker.onerror = (e) => {
          const text = (e as ErrorEvent)?.message || 'the worker stopped';
          log.error('bright-tip worker failed', e);
          setState('error', `The wand tracker stopped: ${text}`);
        };
      } catch (err) {
        worker = null;
        setState('error', `The wand tracker could not start: ${describeError(err).message}`);
        return;
      }
      void configure(myRun);

      offs = [
        on(kernel, 'camera.ready', (ready) => bind(ready)),
        on(kernel, 'camera.frame', (f) => onFrame(f)),
        on(kernel, 'camera.stopped', () => {
          if (camera) unbind();
        }),
        on(kernel, 'settings.changed', ({ key }) => {
          if (CONFIG_KEYS.includes(key)) void configure(run);
          if (key === 'tracker.debug' && !setting(kernel, 'tracker.debug') && debugBitmap) {
            // Keep the last view alive briefly: a screen may still be drawing it.
            const last = debugBitmap;
            debugBitmap = null;
            setTimeout(() => last.close(), 1000);
          }
        }),
        serve(kernel, 'tracker.autotune', () => autotune()),
        serve(kernel, 'tracker.relearn-mask', () => relearn()),
      ];
      statusTimer = setInterval(() => {
        if (active) publishStatus();
      }, STATUS_EVERY_MS);

      // The camera may already be open (the stage asked for the mirror).
      const status = lastPayload(kernel, 'camera.status');
      const ready = lastPayload(kernel, 'camera.ready');
      if (ready && status?.state === 'on' && status.generation === ready.generation) bind(ready);

      // Ask for the camera without waiting: start() never waits on a permission prompt (contracts/module.ts).
      ask(kernel, 'camera.start', { requester: ID, exposure: 'profile' }).then(
        (r) => {
          if (myRun !== run) {
            // A camera.start that resolves after stop() is released at once (unless we started again).
            if (!active) void ask(kernel, 'camera.stop', { requester: ID }).catch(() => undefined);
            return;
          }
          bind(r);
        },
        (err) => {
          if (myRun !== run) return;
          // Capture keeps this requester registered and publishes camera.ready when it recovers.
          const e = describeError(err);
          log.info('camera not available yet', e.name);
          setState(camera ? state : 'starting', WAITING);
        },
      );
    },

    async stop() {
      if (!active) return;
      active = false;
      // Rule 3: a tracker holding the tip publishes tip.lost when it stops, at the last frame it saw.
      if (holding) loseTip(lastFrameT ?? now());
      run++;
      tune?.cancel();
      tune = null;
      for (const done of [...relearnWaiters.values()]) done();
      for (const off of offs) off();
      offs = [];
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = null;
      // The fast path first: its frames must not reach a worker that is going away.
      stopFeed();
      setIdle();
      worker?.terminate();
      worker = null;
      configured = false;
      camera = null;
      hint = null;
      state = 'stopped';
      message = undefined;
      publishStatus();
      if (debugBitmap) {
        const last = debugBitmap;
        debugBitmap = null;
        setTimeout(() => last.close(), 1000);
      }
      await ask(kernel, 'camera.stop', { requester: ID }).catch(() => undefined);
    },
  };
}

const WAITING = 'Waiting for the camera';

function sanitize(c: TipConfig): TipConfig {
  const num = (v: unknown, fallback: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
  const d = DEFAULT_TIP_CONFIG;
  return {
    k: num(c.k, d.k, 0, 20),
    floor: num(c.floor, d.floor, 0, 255),
    channel: c.channel === 'r' || c.channel === 'g' || c.channel === 'b' ? c.channel : 'luma',
    minArea: num(c.minArea, d.minArea, 0, 1e6),
    maxArea: num(c.maxArea, d.maxArea, 1, 1e7),
    searchRadius: num(c.searchRadius, d.searchRadius, 0.005, 2),
    lostAfter: Math.round(num(c.lostAfter, d.lostAfter, 1, 120)),
    searchWidth: Math.round(num(c.searchWidth, d.searchWidth, 64, 4096)),
    staticMask: c.staticMask !== false,
    flipX: c.flipX !== false,
  };
}

/** Median of each measurement over a few frames, so one noisy frame does not steer the exposure. */
function median3(ms: Measure[]): Measure {
  const mid = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const tips = ms.map((m) => m.tipLevel).filter((v): v is number => v !== null);
  return {
    mean: mid(ms.map((m) => m.mean)),
    std: mid(ms.map((m) => m.std)),
    backgroundMax: mid(ms.map((m) => m.backgroundMax)),
    // The tip counts when it was seen in most of the frames.
    tipLevel: tips.length * 2 > ms.length ? mid(tips) : null,
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
