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
// per camera frame in the 'camera.frame' handler (median, 1.6 ms p95; the development page, dev/main.ts,
// now times the rest of each path's main-thread work as well, the fast path's included); the first GPU
// detection compiles shaders for about 4 s, which the worker does during loading (worker-core.ts). Without
// a usable GPU, Chrome runs WebGL in software, and there the GPU delegate took 308 ms a frame against 33 ms
// on the CPU one (the hand study): see SLOW_GPU_MS.
//
// The main thread only moves frames, from one of two sources through one send path, as the bright tip's:
//  - The fast path (kernel/frame-feed.ts): where Chromium offers MediaStreamTrackProcessor, frames come
//    straight from the camera track in CameraReady.stream, and each VideoFrame goes to the worker whole,
//    at the camera's size, with no copy on the main thread: MediaPipe takes a VideoFrame and scales it to
//    the model's input itself. Measured in the desktop app with Chrome's fake camera at 1920 x 1080,
//    against the 'camera.frame' path (the latency study): a frame reached the worker 0.3 ms after capture
//    instead of 7.2; capture to result took 16.6 ms instead of 21.9 at 20 fps on the GPU delegate, and
//    17.3 instead of 32.3 with a 60 fps clip, where results went from 30 to 52 a second; on the CPU
//    delegate 37.0 ms instead of 52.4, with every frame processed instead of 79%.
//  - Otherwise, on each 'camera.frame', an ImageBitmap of the capture module's video, scaled to about
//    640 px wide (the landmarker's own inputs are 192 to 224 px, so a 1080p copy would only cost
//    bandwidth). This also takes over when the fast path ends, or goes quiet while the video still gets
//    frames (FEED_STALL_MS).
// One frame is in the worker at a time; frames that arrive while the worker is busy are dropped, never
// queued (on the fast path the track's one-frame buffer keeps only the newest), so a slow model never
// delays the trail. Only the answer to the frame in the worker frees it for the next (protocol.ts seq): a
// frame of a camera generation that has ended stays there until it is answered, and that answer is not
// used; a frame left unanswered for STALL_MS is given up, and a late answer to it changes nothing. Either
// way a result carries the camera frame's own width and height, from which the geometry takes the aspect
// (tracking.ts): the frame's display size on the fast path, as MediaPipe sizes it.
//
// Section 7.9 has a tracker below 20 fps ask capture to step the frame size down. This one does not: the
// model sees 192 to 224 px whatever the capture size, the 'camera.frame' path scales every frame to 640 px
// first, and on the fast path a whole 1080p frame detected faster than a 640 px bitmap made from it (16.1
// against 20.9 ms on the GPU delegate), so a smaller capture would not make detection faster. Its rate
// shows in tracker.status (fps, stepMs) instead.
//
// The model loads only when this tracker starts (Section 7.3: it is several megabytes): tracker.status
// says 'loading' with progress meanwhile. If the files are not installed it says, plainly, "Hand model not
// installed. Run npm run models." and stays stopped (no retries, camera released). A GPU that refuses the
// model gets one retry on the CPU delegate in a fresh worker, and so does a GPU delegate that runs, but
// slowly (SLOW_GPU_MS); after that, this tracker stays on the CPU.
//
// Tip event rules (contracts/events.ts): tracker.status goes out after start() and before any tip event,
// and again when the aspect changes; tip.found precedes the sample of the same frame; tip.lost carries
// lastSeen and is sent on stop, when the camera stops and before a camera generation changes. Sample times
// are the camera's capture times, carried through the worker untouched. The per-frame rules (when the tip
// is lost, the collapsed finger, the hints) are in tracking.ts. Every tracker.status also carries
// `segmentation` (contracts 1.2): the segmenter rules these samples need, measured with the loss rule
// (tracking.ts SEGMENTATION).

import type { CameraFrame, CameraReady, Kernel, Module, ModuleManifest, TipSample, TrackerStatus } from '../../../contracts';
import {
  ask, browserProcessor, describeError, emit, lastPayload, logger, on, setting, startFeed, type Feed, type ProcessorFactory,
} from '../../../kernel';
import type { HandMode } from './geometry';
import type { Delegate, FrameImage, FromWorker, ToWorker } from './protocol';
import { HandTipState, SEGMENTATION, type TrackingSettings } from './tracking';

export const MANIFEST: ModuleManifest = {
  id: 'tracker.hand',
  kind: 'tracker',
  title: 'Hand or finger',
  version: '1.0.0',
  // 1.2: tracker.status carries `segmentation` and may say 'hand-too-small'.
  contract: '^1.2',
  provides: ['tip.source'],
  // camera.frames@1 is the capture module's capability: without capture there is nothing to track. The
  // worker path needs module workers with OffscreenCanvas (WebGL for MediaPipe's image input).
  requires: ['platform.camera', 'platform.wasm', 'platform.worker', 'platform.offscreen-canvas', 'camera.frames@1'],
};

const ID = MANIFEST.id;
const log = logger(ID);

/** Width of the bitmaps the 'camera.frame' path feeds the model (Section 7.3 notes: "feed it bitmaps
 *  about 640 px wide"). The fast path sends the camera's VideoFrame as it is. */
export const FEED_WIDTH = 640;
const STATUS_EVERY_MS = 500;
/** A frame in flight for longer than this is given up and another is sent; a late answer to it is then
 *  ignored. A live worker answers every frame, so this only covers a hung one; it is long because a first
 *  detection that compiles GPU programs can take seconds, and giving up early would queue stale frames
 *  behind it. */
const STALL_MS = 10_000;
/** The fast path is given up for the rest of a camera generation when, with the model ready and idle, it
 *  has delivered nothing for FEED_STALL_MS while FEED_STALL_FRAMES 'camera.frame' events arrived: the
 *  camera is fine (the capture module's video still gets frames), but its track has stopped feeding the
 *  processor. About a second. Counting frames as well as time keeps a long main-thread task (the app
 *  starting up, say) from counting: after one, the video's queued callback can run before the processor's
 *  queued frame, which proves nothing. */
export const FEED_STALL_MS = 1000;
export const FEED_STALL_FRAMES = 20;
/** The GPU delegate is on trial for its first SLOW_GPU_FRAMES detections after 'ready' (the warm-up that
 *  compiles its programs comes before 'ready', worker-core.ts). When their median stepMs is over
 *  SLOW_GPU_MS, WebGL is running in software (no usable GPU, or a blocked driver), where the hand study
 *  measured 308 ms a detection against 33 ms on the CPU delegate: the model is loaded again on the CPU, in
 *  a fresh worker, once, and this tracker does not try the GPU again. A real GPU is far under the line:
 *  17 ms a frame on an integrated one, and its first detections after the warm-up took 20 to 60 ms (the
 *  latency study), which the median lets pass. */
export const SLOW_GPU_FRAMES = 10;
export const SLOW_GPU_MS = 100;
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
  /** The 'camera.frame' path: a scaled copy of the video's current frame, or null when there is none yet. */
  grabFrame(video: HTMLVideoElement, width: number, height: number): Promise<ImageBitmap> | null;
  /** MediaStreamTrackProcessor on the camera track, where the browser has it (the fast path,
   *  kernel/frame-feed.ts). Absent or null: frames come from 'camera.frame' only. */
  openProcessor?: ProcessorFactory | null;
  /** Absolute URL for a path (the worker resolves URLs against its own script, not the page). */
  resolveUrl(path: string): string;
}

/** Where a frame came from, and what travels with it to the worker and back. */
interface FrameMeta {
  t: number;
  frame: number;
  width: number;
  height: number;
  generation: number;
}

/** What holds the worker's one place: a frame sent to it, or a copy of the video that the 'camera.frame'
 *  path is still making to send (so that the video is not copied twice). */
interface Slot {
  /** The frame's number (protocol.ts seq), which its answer carries back; null while the copy is made. */
  seq: number | null;
  /** Kernel time the slot was taken, for STALL_MS. */
  since: number;
  /** The frame's camera generation ended while it was in the worker: its answer frees the slot and is
   *  otherwise not used. */
  stale: boolean;
  /** The frame asked the worker for a 'tracker.debug' preview. */
  preview: boolean;
}

export function createHandTracker(opts: { modelUrl: string; wasmBaseUrl: string }): Module {
  return buildHandTracker(opts, browserHandDeps());
}

/** The browser side: a module worker, the camera track's processor where Chromium has one, ImageBitmap
 *  copies of the video otherwise, absolute URLs. Exported for the development page (dev/main.ts), which
 *  wraps it to compare delegates. */
export function browserHandDeps(): HandDeps {
  return {
    createWorker: () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'hand' }) as unknown as WorkerLike,
    openProcessor: browserProcessor(),
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
  /** The worker's one place (Slot); null while the worker can take a frame. */
  let slot: Slot | null = null;
  /** Frames sent to the worker, which numbers them (Slot.seq). */
  let sent = 0;
  let errors = 0;
  /** The fast path while it runs; a number that changes whenever a feed starts or stops (a feed that is
   *  not the current one stops waiting for the worker, and its frames are closed); when the feed last
   *  delivered a frame, and the 'camera.frame' events seen since; the generation it failed on. */
  let feed: Feed | null = null;
  let feedId = 0;
  let feedSeenAt = 0;
  let framesSinceFeed = 0;
  let feedFailedFor: number | null = null;
  let idleWaiters: (() => void)[] = [];
  /** stepMs of the GPU delegate's detections while it is on trial (SLOW_GPU_FRAMES), null otherwise. */
  let gpuTrial: number[] | null = null;
  /** The GPU delegate was found too slow: every later start goes straight to the CPU. */
  let gpuTooSlow = false;

  let state: TrackerStatus['state'] = 'stopped';
  let message: string | undefined;
  const tip = new HandTipState(ID);

  let debugBitmap: ImageBitmap | null = null;
  let lastDebugAt = -Infinity;

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
    gpuTrial = null;
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
    gpuTrial = null;
    // A frame in flight there is gone with it; the fast path waits for the next worker to be ready.
    setIdle();
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
    loadOnCpu();
  }

  /** The GPU delegate runs, but in software (SLOW_GPU_MS): load the model again on the CPU, for good. */
  function leaveSlowGpu(medianMs: number): void {
    if (!active || delegate !== 'GPU') return;
    gpuTooSlow = true;
    log.warn(`the GPU delegate takes ${Math.round(medianMs)} ms a frame (WebGL without a usable GPU, most likely); loading the model on the CPU`);
    // No frames are processed while the model loads again: let go of the tip first, with no 'searching'
    // in between, and start the hint clock and the measurements afresh for the new model.
    phase = 'loading';
    if (tip.holding) loseTip(tip.lastFrameT ?? now());
    tip.rebase();
    loadOnCpu();
  }

  /** A fresh worker on the CPU delegate (MediaPipe's loader serves one task per worker). The camera stays
   *  bound, and the fast path waits for the new model. */
  function loadOnCpu(): void {
    killWorker();
    progress = 0;
    // The status first: spawn() may fail at once, and its 'error' must be the last word.
    setState('loading', LOADING);
    spawn('CPU');
  }

  /** Loading failed for good, or detection broke: report it plainly and stay stopped. */
  function fail(text: string): void {
    if (!active) return;
    stopFeed();
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
        // The GPU delegate is on trial for its first detections (SLOW_GPU_MS).
        gpuTrial = msg.delegate === 'GPU' ? [] : null;
        // The fast path sat waiting while the model loaded: that was not the track going quiet.
        feedSeenAt = now();
        framesSinceFeed = 0;
        if (camera) setState('searching', '');
        else setState('starting', WAITING);
        // The fast path may read its first frame now (no frame is in a worker that was loading).
        wakeWaiters();
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
        // The answer to a frame given up on (STALL_MS) changes nothing: the slot has moved on.
        if (!answers(msg.seq)) return;
        setIdle();
        // A frame of an old camera generation failing still says the model is failing.
        if (++errors >= MAX_ERRORS) {
          log.error('hand detection keeps failing', msg.message);
          fail(`Hand tracking stopped: ${msg.message}`);
        }
        return;
      case 'result': {
        const f = answers(msg.seq);
        if (!f) {
          // Given up on (STALL_MS): too late to use, and the slot has moved on.
          msg.preview?.close();
          return;
        }
        errors = 0;
        // A frame of an old camera generation still says how fast the delegate is.
        const slowMs = judgeGpu(msg.stepMs);
        // Record the result first, then free the slot: the fast path's next frame is read only after.
        try {
          if (f.stale || !camera || msg.generation !== camera.generation) msg.preview?.close();
          else onResult(msg, f.preview);
        } finally {
          setIdle();
        }
        if (slowMs !== null) leaveSlowGpu(slowMs);
        return;
      }
    }
  }

  /** One detection of the GPU delegate while it is on trial. Returns the median detection time when the
   *  trial is over and the delegate is too slow, otherwise null. */
  function judgeGpu(stepMs: number): number | null {
    if (!gpuTrial || !Number.isFinite(stepMs)) return null;
    gpuTrial.push(stepMs);
    if (gpuTrial.length < SLOW_GPU_FRAMES) return null;
    const m = median(gpuTrial);
    gpuTrial = null;
    if (m <= SLOW_GPU_MS) {
      log.info(`the GPU delegate takes ${Math.round(m)} ms a frame`);
      return null;
    }
    return m;
  }

  // ------------------------------------------------------------------------------------ camera

  function bind(ready: CameraReady): void {
    if (camera && camera.generation === ready.generation && camera.deviceId === ready.deviceId) return;
    // Rule 3: the tip is lost before the generation changes.
    if (tip.holding) loseTip(tip.lastFrameT ?? now());
    camera = ready;
    // A frame of the old generation still in the worker keeps its place until it is answered (the new
    // stream's first frame waits for that), and the answer is not used.
    retire();
    tip.rebase();
    // The new stream's fast path (the old one is cancelled) before any status, so the status names the
    // source frames will come from. It waits for the model if the model is still loading.
    startTrackFeed(ready);
    if (phase === 'ready') setState('searching', '');
    // The aspect may have changed: say so before any tip event from this stream.
    publishStatus();
  }

  function unbind(): void {
    if (tip.holding) loseTip(tip.lastFrameT ?? now());
    stopFeed();
    camera = null;
    retire();
    if (phase === 'ready') setState('starting', WAITING);
  }

  /** The fast path: frames straight from the camera track, the newest one whenever the model is free. */
  function startTrackFeed(ready: CameraReady): void {
    stopFeed();
    if (!deps.openProcessor || feedFailedFor === ready.generation) return;
    const track = typeof ready.stream?.getVideoTracks === 'function' ? ready.stream.getVideoTracks()[0] : undefined;
    if (!track || track.readyState === 'ended') return;
    let readable: ReadableStream<VideoFrame> | null;
    try {
      // A one-frame buffer: while the worker is busy, or the model loads, the processor keeps only the
      // newest frame.
      readable = deps.openProcessor(track, 1);
    } catch (err) {
      log.info('the camera track cannot be read directly; reading the video instead', describeError(err).message);
      readable = null;
    }
    if (!readable) return;
    const id = ++feedId, myRun = run, gen = ready.generation;
    feedSeenAt = now();
    framesSinceFeed = 0;
    const f = startFeed({
      readable,
      now,
      fps: ready.fps,
      waitIdle: () => waitForWorker(id),
      deliver: ({ frame, t, index, width, height }) => {
        if (id !== feedId || myRun !== run) {
          frame.close();
          return;
        }
        feedSeenAt = now();
        framesSinceFeed = 0;
        // The feed waited for a free worker, so this never happens; if it did, a second frame in flight
        // would be worse than a dropped one.
        if (slot) {
          frame.close();
          return;
        }
        send(frame, { t, frame: index, width, height, generation: gen });
      },
    });
    feed = f;
    // When the feed ends on its own (the track ended, the stream failed), 'camera.frame' takes over.
    void f.done.then(() => {
      if (feed !== f) return;
      feed = null;
      feedId++;
      log.info('the camera track ended or could not be read; reading the video instead');
    });
  }

  function stopFeed(): void {
    const f = feed;
    feed = null;
    // A feed waiting for the worker stops waiting, sees it was cancelled, and ends.
    feedId++;
    f?.cancel();
    wakeWaiters();
  }

  /** 'camera.frame': the fallback source, and the fast path's watchdog. */
  function onFrame(f: CameraFrame): void {
    if (!active || phase !== 'ready' || !worker || !camera || f.generation !== camera.generation) return;
    if (feed) {
      // The capture module's video still gets frames, so the camera is fine: if the processor has gone
      // quiet while the worker waits, give it up for this generation and read the video instead.
      if (slot) return;
      framesSinceFeed++;
      if (framesSinceFeed < FEED_STALL_FRAMES || now() - feedSeenAt < FEED_STALL_MS) return;
      log.warn('the camera track stopped handing frames to the fast path; reading the video instead');
      feedFailedFor = camera.generation;
      stopFeed();
    }
    if (slot) {
      if (now() - slot.since < STALL_MS) return; // drop, never queue
      // Given up on: a late answer to it changes nothing.
      setIdle();
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
    // Hold the slot while the copy is made, so the video is not copied twice. Whatever frees the slot
    // meanwhile (the camera generation changing, the model going, a stop) means the copy is not sent.
    const copy: Slot = { seq: null, since: now(), stale: false, preview: false };
    slot = copy;
    const myRun = run;
    const meta: FrameMeta = { t: f.t, frame: f.frame, width: f.width, height: f.height, generation: f.generation };
    pending.then(
      (bitmap) => {
        if (myRun === run && slot === copy) send(bitmap, meta, copy);
        else bitmap.close();
      },
      () => {
        // The video had no frame to copy (it was switching); the next frame tries again.
        if (slot === copy) setIdle();
      },
    );
  }

  /** Hand one frame to the worker, transferred; the worker closes it, and the frame holds the slot until
   *  its answer. A frame that cannot go (the camera, the model or the run changed) is closed here at once:
   *  an open VideoFrame holds one of the camera's few buffers. `copy` is the slot a copy of the video held
   *  while it was made: the frame takes it over, or lets it go when it cannot be sent. */
  function send(image: FrameImage, m: FrameMeta, copy: Slot | null = null): void {
    if (!active || phase !== 'ready' || !worker || !camera || camera.generation !== m.generation) {
      closeImage(image);
      if (copy && slot === copy) setIdle();
      return;
    }
    const wantPreview = setting(kernel, 'tracker.debug') === true && now() - lastDebugAt >= DEBUG_EVERY_MS;
    if (wantPreview) lastDebugAt = now();
    const seq = ++sent;
    const mine: Slot = { seq, since: now(), stale: false, preview: wantPreview };
    slot = mine;
    const msg: ToWorker = {
      type: 'frame', run, seq, generation: m.generation, t: m.t, frame: m.frame, width: m.width, height: m.height,
      image, preview: wantPreview, flipX: setting(kernel, 'capture.flipX') !== false,
    };
    try {
      worker.postMessage(msg, [image]);
    } catch (err) {
      closeImage(image);
      if (slot === mine) setIdle();
      log.warn('could not hand a frame to the worker', err);
    }
  }

  /** The slot, when `seq` is the number of the frame in it: an answer to that frame. Null for a late
   *  answer to a frame given up on (STALL_MS), which must change nothing. */
  function answers(seq: number): Slot | null {
    return slot !== null && slot.seq === seq ? slot : null;
  }

  /** The camera generation has ended (a new one, or none). A frame of it in the worker keeps the slot
   *  until it is answered, so that there is never more than one frame in the worker, and the answer is
   *  not used. A copy of the video still being made lets go of the slot at once: nothing of it is in the
   *  worker, and it is closed when it is done. */
  function retire(): void {
    if (!slot) return;
    if (slot.seq === null) setIdle();
    else slot.stale = true;
  }

  /** The worker is free: let the fast path read its next frame. Freeing the slot is also how a frame is
   *  given up on: answers are matched to the frame in the slot (answers()), so a late one finds none. */
  function setIdle(): void {
    slot = null;
    wakeWaiters();
  }

  function wakeWaiters(): void {
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const w of waiters) w();
  }

  /** The fast path's wait: resolves when the worker can take a frame (the model is ready and none is in
   *  flight), giving up a frame in flight after STALL_MS (the worker hung or lost it; a late answer to it
   *  then changes nothing). Also resolves once the feed asking is no longer the current one, so that it
   *  sees it was cancelled and ends. */
  async function waitForWorker(id: number): Promise<void> {
    while (id === feedId && (slot !== null || !takingFrames())) {
      const timedOut = await new Promise<boolean>((resolve) => {
        // Only a frame in flight can time out; a model that is loading is waited for.
        const timer = slot !== null ? setTimeout(() => resolve(true), STALL_MS) : null;
        idleWaiters.push(() => {
          if (timer !== null) clearTimeout(timer);
          resolve(false);
        });
      });
      if (timedOut && slot !== null && now() - slot.since >= STALL_MS) setIdle();
    }
  }

  function takingFrames(): boolean {
    return active && phase === 'ready' && worker !== null && camera !== null;
  }

  // ------------------------------------------------------------------------------------ results

  /** A result to use. `preview`: its frame asked for a 'tracker.debug' view. */
  function onResult(msg: Extract<FromWorker, { type: 'result' }>, preview: boolean): void {
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
    if (preview) publishDebug(msg, out.landmarks);
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
      // Where frames come from while a camera is bound: the camera track (the fast path) or the video.
      source: state === 'stopped' || state === 'error' || !camera ? undefined : feed ? 'track' : 'video',
      exposure: exposure ? { mode: exposure.mode, time: exposure.time } : undefined,
      progress: state === 'loading' ? Math.round(progress * 100) / 100 : undefined,
      message,
      // Section 7.9, contracts/events.ts: 'hand-not-found' 3 s after the last confident sample, cleared
      // when found; 'hand-too-small' while the hands of the last second are small; both cleared on stop.
      hint: state === 'stopped' || state === 'error' || phase !== 'ready' || !camera ? null : tip.hint(k),
      // What these samples need from the segmenter (tracking.ts), a plain copy of the frozen constant.
      segmentation: { ...SEGMENTATION },
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
      slot = null;
      errors = 0;
      feed = null;
      feedFailedFor = null;
      idleWaiters = [];
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

      // The model loads in the background (start() never waits on a download, contracts/module.ts). A GPU
      // delegate found too slow before is not tried again.
      spawn(gpuTooSlow ? 'CPU' : 'GPU');

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
      // The fast path first: its frames must not reach a worker that is going away.
      stopFeed();
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

/** Closing twice, or a frame already transferred, is not an error. */
function closeImage(image: FrameImage): void {
  try {
    image.close();
  } catch {
    /* already closed */
  }
}

/** The middle value (the mean of the two middle ones for an even count). */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
