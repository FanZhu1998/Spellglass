// Hand tracker (tracker.hand): MediaPipe's Hand Landmarker follows a hand or a fingertip, and the wand is
// a prop (Section 4 route B, the no-hardware fallback that always ships; Section 7.3).
//
// Threads (Section 5): the model runs in its own module worker (worker.ts). Verified with
// @mediapipe/tasks-vision 1.2.3 and Vite 8, in the dev server and in a production build, in Chrome:
// FilesetResolver.forVisionTasks(base, true) selects vision_wasm_module_internal.js, which a module worker
// loads with import() (importScripts does not exist there), and MediaPipe draws on its own OffscreenCanvas
// (WebGL 2) in the worker. There is no main-thread fallback: the classic loader variant would be a second
// 14 MB runtime to ship, and every browser that has module workers and OffscreenCanvas runs the worker
// path, so the manifest requires both.
//
// Measured (Chrome, integrated AMD Radeon GPU through ANGLE/D3D11, 1280 x 720 camera fed at 640 x 360):
// detection 17 ms a frame on the GPU delegate and 34 ms on the CPU one; about 1.2 ms of main-thread work
// per camera frame (median, 1.6 ms p95); the first GPU detection compiles shaders for about 4 s, which the
// worker does during loading (worker-core.ts). Lower-end machines will be slower; not measured.
//
// The main thread only moves frames: on each 'camera.frame' it makes an ImageBitmap of the capture
// module's video, scaled to about 640 px wide (the landmarker's own inputs are 192 to 224 px, so a 1080p
// copy would only cost bandwidth), and transfers it. One frame is in flight at a time; frames that arrive
// while the worker is busy are dropped, never queued, so a slow model never delays the trail.
//
// Section 7.9 has a tracker below 20 fps ask capture to step the frame size down. This one does not: it
// scales every frame to 640 px before the model sees it, so a smaller capture would not make detection
// faster. Its rate shows in tracker.status (fps, stepMs) instead.
//
// The model loads only when this tracker starts (Section 7.3: it is several megabytes): tracker.status
// says 'loading' with progress meanwhile. If the files are not installed it says, plainly, "Hand model not
// installed. Run npm run models." and stays stopped (no retries, camera released); a GPU that refuses the
// model gets one retry on the CPU delegate in a fresh worker.
//
// Tip event rules (contracts/events.ts): tracker.status goes out after start() and before any tip event,
// and again when the aspect changes; tip.found precedes the sample of the same frame; tip.lost carries
// lastSeen and is sent on stop, when the camera stops and before a camera generation changes. Sample times
// are the camera's capture times, carried through the worker untouched.

import type { CameraFrame, CameraReady, Kernel, Module, ModuleManifest, TipSample, TrackerStatus } from '../../../contracts';
import { ask, describeError, emit, lastPayload, logger, on, setting } from '../../../kernel';
import type { HandMode } from './geometry';
import type { Delegate, FromWorker, ToWorker } from './protocol';
import { HandTipState, type TrackingSettings } from './tracking';

export const MANIFEST: ModuleManifest = {
  id: 'tracker.hand',
  kind: 'tracker',
  title: 'Hand or finger',
  version: '1.0.0',
  contract: '^1.1',
  provides: ['tip.source'],
  // camera.frames@1 is the capture module's capability: without capture there is nothing to track. The
  // worker path needs module workers with OffscreenCanvas (WebGL for MediaPipe's image input).
  requires: ['platform.camera', 'platform.wasm', 'platform.worker', 'platform.offscreen-canvas', 'camera.frames@1'],
};

const ID = MANIFEST.id;
const log = logger(ID);

/** Width of the bitmaps fed to the model (Section 7.3 notes: "feed it bitmaps about 640 px wide"). */
export const FEED_WIDTH = 640;
const STATUS_EVERY_MS = 500;
/** A frame in flight for longer than this is given up and another is sent. A live worker answers every
 *  frame, so this only covers a hung one; it is long because a first detection that compiles GPU programs
 *  can take seconds, and giving up early would queue stale frames behind it. */
const STALL_MS = 10_000;
/** 'tracker.debug' at about 10 fps (contracts/events.ts TrackerDebugFrame). */
const DEBUG_EVERY_MS = 100;
/** This many detection errors in a row stop the tracker (a lost GPU context, say). */
const MAX_ERRORS = 10;

const LOADING = 'Hand model loading';
const STARTING = 'Hand model starting';
const WAITING = 'Waiting for the camera';
/** Share of TrackerStatus.progress given to the downloads (about 23 MB). The rest is setting up: compiling
 *  the runtime and the first detection, which compiles the GPU programs (about 4 s on an integrated GPU),
 *  so the bar does not sit at 99% while nothing seems to happen. */
const DOWNLOAD_SHARE = 0.9;

/** The worker as the module uses it (a real Worker in the browser, a fake in tests). */
export interface WorkerLike {
  postMessage(message: ToWorker, transfer: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<FromWorker>) => void) | null;
  onerror: ((event: ErrorEvent | Event) => void) | null;
}

export interface HandDeps {
  createWorker(): WorkerLike;
  /** A scaled copy of the video's current frame, or null when there is none yet. */
  grabFrame(video: HTMLVideoElement, width: number, height: number): Promise<ImageBitmap> | null;
  /** Absolute URL for a path (the worker resolves URLs against its own script, not the page). */
  resolveUrl(path: string): string;
}

export function createHandTracker(opts: { modelUrl: string; wasmBaseUrl: string }): Module {
  return buildHandTracker(opts, browserHandDeps());
}

/** The browser side: a module worker, ImageBitmap copies of the video, absolute URLs. Exported for the
 *  development page (dev/main.ts), which wraps it to compare delegates. */
export function browserHandDeps(): HandDeps {
  return {
    createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'hand' }) as unknown as WorkerLike,
    grabFrame(video, width, height) {
      if (typeof createImageBitmap !== 'function' || video.readyState < 2) return null;
      return createImageBitmap(video, { resizeWidth: width, resizeHeight: height, resizeQuality: 'low' });
    },
    // Absolute URLs: in development Vite would rewrite a root-relative dynamic import of the loader
    // (adding ?import, which it refuses for files in public/), and a worker resolves relative URLs against
    // its own script rather than the page.
    resolveUrl: (path) => new URL(path, globalThis.location?.href ?? 'http://localhost/').href,
  };
}

type Phase = 'loading' | 'ready' | 'failed';

/** The hand tracker with its browser dependencies injected (tests pass fakes). */
export function buildHandTracker(opts: { modelUrl: string; wasmBaseUrl: string }, deps: HandDeps): Module {
  let kernel: Kernel;
  let run = 0;
  let active = false;
  let worker: WorkerLike | null = null;
  let delegate: Delegate = 'GPU';
  let phase: Phase = 'loading';
  let progress = 0;
  let offs: (() => void)[] = [];
  let statusTimer: ReturnType<typeof setInterval> | null = null;

  let camera: CameraReady | null = null;
  let busy = false;
  let busySince = 0;
  let errors = 0;

  let state: TrackerStatus['state'] = 'stopped';
  let message: string | undefined;
  const tip = new HandTipState(ID);

  let debugBitmap: ImageBitmap | null = null;
  let lastDebugAt = -Infinity;
  /** The frame in flight was asked for a 'tracker.debug' view (one frame is in flight at a time). */
  let inFlightDebug = false;

  const now = () => kernel.now();

  // ------------------------------------------------------------------------------------ settings

  function trackingSettings(): TrackingSettings {
    const mode = setting(kernel, 'hand.mode');
    const reach = setting(kernel, 'hand.gripReach');
    return {
      mode: (mode === 'grip' ? 'grip' : 'finger') as HandMode,
      reach: typeof reach === 'number' && Number.isFinite(reach) ? reach : 0.9,
      flipX: setting(kernel, 'capture.flipX') !== false,
    };
  }

  // ------------------------------------------------------------------------------------ worker

  function spawn(d: Delegate): void {
    delegate = d;
    phase = 'loading';
    progress = 0;
    try {
      const w = deps.createWorker();
      worker = w;
      const myRun = run;
      w.onmessage = (e) => onWorker(e.data, myRun);
      w.onerror = (e) => {
        const text = (e as ErrorEvent)?.message || 'the worker stopped';
        log.error('hand worker failed', e);
        if (phase === 'loading') retryOnCpuOrFail('Hand tracking could not start in this browser.', text);
        else fail(`Hand tracking stopped: ${text}`);
      };
      w.postMessage({
        type: 'load', run, delegate: d,
        wasmBaseUrl: deps.resolveUrl(opts.wasmBaseUrl),
        modelUrl: deps.resolveUrl(opts.modelUrl),
      }, []);
    } catch (err) {
      worker = null;
      fail(`Hand tracking could not start in this browser: ${describeError(err).message}`);
    }
  }

  function killWorker(): void {
    const w = worker;
    worker = null;
    busy = false;
    if (!w) return;
    w.onmessage = null;
    w.onerror = null;
    try {
      w.postMessage({ type: 'close', run }, []);
    } catch {
      /* already gone */
    }
    w.terminate();
  }

  /** A GPU (or driver) the delegate refuses, or a worker that died while loading on it: try once more on
   *  the CPU, in a fresh worker (MediaPipe's loader serves one task per worker). Otherwise give up. */
  function retryOnCpuOrFail(text: string, detail?: string): void {
    if (!active) return;
    if (delegate !== 'GPU') {
      fail(text);
      return;
    }
    log.warn('the GPU delegate failed; trying the CPU', detail);
    killWorker();
    progress = 0;
    // The status first: spawn() may fail at once, and its 'error' must be the last word.
    setState('loading', LOADING);
    spawn('CPU');
  }

  /** Loading failed for good, or detection broke: report it plainly and stay stopped. */
  function fail(text: string): void {
    if (!active) return;
    killWorker();
    phase = 'failed';
    if (tip.holding) loseTip(tip.lastFrameT ?? now());
    for (const off of offs) off();
    offs = [];
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
    camera = null;
    setState('error', text);
    // "Stay stopped": the camera is not needed any more (others may still use it; capture counts requesters).
    void ask(kernel, 'camera.stop', { requester: ID }).catch(() => undefined);
  }

  function onWorker(msg: FromWorker, myRun: number): void {
    if (!active || myRun !== run || msg.run !== run) {
      if (msg.type === 'result') msg.preview?.close();
      return;
    }
    switch (msg.type) {
      case 'progress': {
        const downloaded = msg.total > 0 && msg.loaded >= msg.total;
        if (downloaded) {
          // Everything is here; the worker is compiling and warming up the model.
          progress = DOWNLOAD_SHARE;
          message = STARTING;
          publishStatus();
          return;
        }
        const p = msg.total > 0 ? DOWNLOAD_SHARE * Math.min(1, msg.loaded / msg.total) : 0;
        if (p - progress >= 0.01) {
          progress = p;
          publishStatus();
        }
        return;
      }
      case 'ready':
        phase = 'ready';
        progress = 1;
        log.info(`hand model ready on the ${msg.delegate} delegate in ${msg.loadMs} ms`);
        if (camera) setState('searching', '');
        else setState('starting', WAITING);
        return;
      case 'failed':
        // Missing or undownloadable files fail the same way on any delegate: no retry for those.
        if (msg.reason === 'runtime') {
          retryOnCpuOrFail(msg.message, msg.detail);
          return;
        }
        log.warn('hand model failed to load', msg.reason, msg.detail);
        fail(msg.message);
        return;
      case 'error':
        busy = false;
        inFlightDebug = false;
        if (++errors >= MAX_ERRORS) {
          log.error('hand detection keeps failing', msg.message);
          fail(`Hand tracking stopped: ${msg.message}`);
        }
        return;
      case 'result':
        busy = false;
        errors = 0;
        if (!camera || msg.generation !== camera.generation) {
          inFlightDebug = false;
          msg.preview?.close();
          return;
        }
        onResult(msg);
        return;
    }
  }

  // ------------------------------------------------------------------------------------ camera

  function bind(ready: CameraReady): void {
    if (camera && camera.generation === ready.generation && camera.deviceId === ready.deviceId) return;
    // Rule 3: the tip is lost before the generation changes.
    if (tip.holding) loseTip(tip.lastFrameT ?? now());
    camera = ready;
    busy = false;
    tip.rebase();
    if (phase === 'ready') setState('searching', '');
    // The aspect may have changed: say so before any tip event from this stream.
    publishStatus();
  }

  function unbind(): void {
    if (tip.holding) loseTip(tip.lastFrameT ?? now());
    camera = null;
    busy = false;
    if (phase === 'ready') setState('starting', WAITING);
  }

  function onFrame(f: CameraFrame): void {
    if (!active || phase !== 'ready' || !worker || !camera || f.generation !== camera.generation) return;
    if (busy) {
      if (now() - busySince < STALL_MS) return; // drop, never queue
      busy = false;
    }
    const width = Math.min(FEED_WIDTH, f.width);
    const height = Math.max(1, Math.round((width * f.height) / Math.max(1, f.width)));
    let pending: Promise<ImageBitmap> | null;
    try {
      pending = deps.grabFrame(f.video, width, height);
    } catch (err) {
      log.debug('could not grab a frame', err);
      return;
    }
    if (!pending) return;
    busy = true;
    busySince = now();
    const myRun = run;
    const wantPreview = setting(kernel, 'tracker.debug') === true && now() - lastDebugAt >= DEBUG_EVERY_MS;
    if (wantPreview) lastDebugAt = now();
    inFlightDebug = wantPreview;
    const flipX = setting(kernel, 'capture.flipX') !== false;
    pending.then(
      (bitmap) => {
        if (myRun !== run || !worker || !active || phase !== 'ready') {
          bitmap.close();
          return;
        }
        const msg: ToWorker = {
          type: 'frame', run, generation: f.generation, t: f.t, frame: f.frame, width: f.width, height: f.height,
          bitmap, preview: wantPreview, flipX,
        };
        try {
          worker.postMessage(msg, [bitmap]);
        } catch (err) {
          bitmap.close();
          busy = false;
          log.warn('could not hand a frame to the worker', err);
        }
      },
      () => {
        // The video had no frame to copy (it was switching); the next frame tries again.
        if (myRun === run) busy = false;
      },
    );
  }

  // ------------------------------------------------------------------------------------ results

  function onResult(msg: Extract<FromWorker, { type: 'result' }>): void {
    const k = now();
    const out = tip.frame(msg, trackingSettings(), k);
    if (out.lost) {
      emit(kernel, ID, 'tip.lost', { t: out.lost.t, src: ID, lastSeen: out.lost.lastSeen }, out.lost.t);
      setState('searching', '');
    }
    if (out.found) {
      setState('tracking', '');
      // Rule 2: tip.found just before the sample of the same frame, with the same t.
      emit(kernel, ID, 'tip.found', out.found, out.found.t);
    }
    if (out.sample) emit(kernel, ID, 'tip.sample', out.sample as TipSample, out.sample.t);
    const wanted = inFlightDebug;
    inFlightDebug = false;
    if (wanted) publishDebug(msg, out.landmarks);
    else msg.preview?.close();
  }

  /** One 'tracker.debug' per frame that asked for it (about 10 a second), with the worker's mirrored
   *  preview when it could make one (image null otherwise) and the landmarks in caster space. */
  function publishDebug(msg: Extract<FromWorker, { type: 'result' }>, landmarks: [number, number][] | undefined): void {
    const image = msg.preview ?? null;
    if (setting(kernel, 'tracker.debug') !== true) {
      image?.close();
      return;
    }
    const previous = debugBitmap;
    if (image) debugBitmap = image;
    emit(kernel, ID, 'tracker.debug', {
      tracker: ID,
      t: msg.t,
      image,
      width: image?.width ?? msg.width,
      height: image?.height ?? msg.height,
      blobs: [],
      ...(landmarks ? { landmarks } : {}),
    }, msg.t);
    // The previous view stays valid until this one is out (contracts/events.ts TrackerDebugFrame).
    if (image) previous?.close();
  }

  function loseTip(t: number): void {
    const lost = tip.loseNow(t);
    if (!lost) return;
    emit(kernel, ID, 'tip.lost', { t: lost.t, src: ID, lastSeen: lost.lastSeen }, lost.t);
    if (active && phase === 'ready' && camera) setState('searching', '');
  }

  // ------------------------------------------------------------------------------------ status

  /** msg '' clears the message; undefined keeps it. */
  function setState(next: TrackerStatus['state'], msg?: string): void {
    const nextMessage = msg === undefined ? message : msg || undefined;
    const changed = next !== state || nextMessage !== message;
    state = next;
    message = nextMessage;
    if (changed) publishStatus();
  }

  function aspectOf(c: CameraReady | null): number {
    const ready = c ?? lastPayload(kernel, 'camera.ready');
    return ready && ready.width > 0 && ready.height > 0 ? ready.width / ready.height : 16 / 9;
  }

  function publishStatus(): void {
    const k = now();
    const exposure = lastPayload(kernel, 'camera.status')?.exposure;
    const status: TrackerStatus = {
      tracker: ID,
      state,
      lock: tip.lock(k),
      fps: tip.fps(k),
      aspect: aspectOf(camera),
      width: camera?.width,
      height: camera?.height,
      pen: false,
      stepMs: tip.stepMs(k),
      exposure: exposure ? { mode: exposure.mode, time: exposure.time } : undefined,
      progress: state === 'loading' ? Math.round(progress * 100) / 100 : undefined,
      message,
      // Section 7.9, contracts/events.ts: set 3 s after the last confident sample, cleared when found and on stop.
      hint: state === 'stopped' || state === 'error' || phase !== 'ready' || !camera ? null : tip.hint(k),
    };
    emit(kernel, ID, 'tracker.status', status);
  }

  function closeDebugLater(): void {
    if (!debugBitmap) return;
    // Keep the last view alive briefly: a screen may still be drawing it.
    const last = debugBitmap;
    debugBitmap = null;
    setTimeout(() => last.close(), 1000);
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
      tip.reset();
      camera = null;
      busy = false;
      errors = 0;
      lastDebugAt = -Infinity;
      state = 'loading';
      message = LOADING;
      phase = 'loading';
      progress = 0;
      // Rule 1: status (aspect and pen) before any tip event.
      publishStatus();

      offs = [
        on(kernel, 'camera.ready', (ready) => bind(ready)),
        on(kernel, 'camera.frame', (f) => onFrame(f)),
        on(kernel, 'camera.stopped', () => {
          if (camera) unbind();
        }),
        on(kernel, 'settings.changed', ({ key }) => {
          // A new tip definition or flip mid-stroke would make the stroke jump: end it first.
          if ((key === 'hand.mode' || key === 'capture.flipX') && tip.holding) loseTip(tip.lastFrameT ?? now());
          if (key === 'tracker.debug' && setting(kernel, 'tracker.debug') !== true) closeDebugLater();
        }),
      ];
      statusTimer = setInterval(() => {
        if (active && phase !== 'failed') publishStatus();
      }, STATUS_EVERY_MS);

      // The model loads in the background (start() never waits on a download, contracts/module.ts).
      spawn('GPU');

      // The camera may already be open (the stage asked for the mirror).
      const status = lastPayload(kernel, 'camera.status');
      const ready = lastPayload(kernel, 'camera.ready');
      if (ready && status?.state === 'on' && status.generation === ready.generation) bind(ready);

      // Ask for the camera without waiting: start() never waits on a permission prompt. Continuous exposure:
      // the landmarker wants a normally exposed image, not the bright tip's dark one.
      ask(kernel, 'camera.start', { requester: ID, exposure: 'auto' }).then(
        (r) => {
          if (myRun !== run || phase === 'failed') {
            // A camera.start that resolves after stop() (or after giving up) is released at once.
            if (!active || phase === 'failed') void ask(kernel, 'camera.stop', { requester: ID }).catch(() => undefined);
            return;
          }
          bind(r);
        },
        (err) => {
          if (myRun !== run) return;
          // Capture keeps this requester registered and publishes camera.ready when it recovers.
          log.info('camera not available yet', describeError(err).name);
        },
      );
    },

    async stop() {
      if (!active) return;
      active = false;
      // Rule 3: a tracker holding the tip publishes tip.lost when it stops, at the last frame it saw
      // (then 'stopped', below, with no 'searching' in between).
      if (tip.holding) loseTip(tip.lastFrameT ?? now());
      const wasFailed = phase === 'failed';
      run++;
      killWorker();
      for (const off of offs) off();
      offs = [];
      if (statusTimer) clearInterval(statusTimer);
      statusTimer = null;
      camera = null;
      state = 'stopped';
      message = undefined;
      publishStatus();
      closeDebugLater();
      if (!wasFailed) await ask(kernel, 'camera.stop', { requester: ID }).catch(() => undefined);
    },
  };
}
