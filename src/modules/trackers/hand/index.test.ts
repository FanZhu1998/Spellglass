import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraReady, Envelope, TipSample, TrackerDebugFrame, TrackerStatus } from '../../../contracts';
import { createKernel, memoryPersistence, type KernelHost } from '../../../kernel';
import { buildHandTracker, FEED_STALL_FRAMES, FEED_STALL_MS, MANIFEST, SLOW_GPU_FRAMES, type WorkerLike } from './index';
import type { FromWorker, ToWorker } from './protocol';
import { LOST_AFTER_MS } from './tracking';
import { createWorkerCore, type WorkerCoreDeps } from './worker-core';

const W = 1280, H = 720;
const MODEL_URL = '/models/hand_landmarker.task';
const WASM_BASE = '/models/wasm';
const ORIGIN = 'https://app.test';

const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
/** Shaped like hand_landmarker.task: a ZIP entry and the end-of-central-directory record. */
const MODEL = new Uint8Array([0, 0, 0x50, 0x4b, 0x03, 0x04, 20, 0, 0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
const LOADER = new TextEncoder().encode(`async function ModuleFactory(){}\n${'// x\n'.repeat(300)}export default ModuleFactory;`);

interface Scene {
  /** Index fingertip (frame-normalized, unmirrored), or null for no hand. */
  tip: [number, number] | null;
  /** Wrist to middle knuckle ÷ frame width (TipSample.size); 0.1125 when not given. */
  size?: number;
  modelMissing: boolean;
  gpuFails: boolean;
  cpuFails?: boolean;
  /** The worker dies (an uncaught error) while loading on the GPU. */
  gpuCrashes?: boolean;
  /** Detection time on each delegate (stepMs), ms, or by the detection's number on that delegate; 0
   *  when not given. */
  stepMs?: Partial<Record<'GPU' | 'CPU', number | ((i: number) => number)>>;
  /** postMessage refuses frames (a DataCloneError, say). */
  postFails?: boolean;
  /** The worker warms the model up before 'ready' (worker-core.ts), with a detection of its own. */
  warmup?: boolean;
  /** The model's files arrive only once this resolves (the model is still loading until then). */
  loadGate?: Promise<void>;
  /** The model takes its time: answers to frames wait in `held` until the test lets them go. */
  hold?: boolean;
}

/** Frames in the worker at once (posted, answer not yet back), and the most ever seen. */
const flight = { now: 0, max: 0 };
/** Answers held back while Scene.hold is set, each one a delivery. */
const held: (() => void)[] = [];

function landmarks(tip: [number, number], size = 0.2 / (W / H)) {
  return Array.from({ length: 21 }, (_, i) => ({ x: i === 8 ? tip[0] : i === 9 ? 0.5 : 0.5, y: i === 8 ? tip[1] : i === 9 ? 0.8 - size * (W / H) : 0.8, z: 0 }));
}

function fakeWorker(scene: Scene, log: ToWorker[], delegates: string[]): WorkerLike {
  let terminated = false;
  /** The worker's own clock (performance.now() there), which detections advance by their stepMs. */
  let clockMs = 0;
  const w: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(msg) {
      if (msg.type === 'frame' && scene.postFails) throw new DOMException('could not clone the frame', 'DataCloneError');
      log.push(msg);
      if (msg.type === 'load' && msg.delegate === 'GPU' && scene.gpuCrashes) {
        void Promise.resolve().then(() => w.onerror?.({ message: 'Uncaught RuntimeError: unreachable' } as ErrorEvent));
        return;
      }
      if (msg.type === 'frame') flight.max = Math.max(flight.max, ++flight.now);
      void core.handle(msg);
    },
    terminate() {
      terminated = true;
    },
  };
  const deps: WorkerCoreDeps = {
    fetch: async (url) => {
      if (scene.loadGate) await scene.loadGate;
      if (url.endsWith('.task')) return scene.modelMissing ? new Response('', { status: 404 }) : new Response(MODEL);
      if (url.endsWith('.wasm')) return new Response(WASM);
      return new Response(LOADER);
    },
    fileset: async (base) => ({ wasmLoaderPath: `${base}/vision_wasm_module_internal.js`, wasmBinaryPath: `${base}/vision_wasm_module_internal.wasm` }),
    createLandmarker: async (o) => {
      delegates.push(o.delegate);
      if (o.delegate === 'GPU' && scene.gpuFails) throw new Error('GPU delegate refused');
      if (o.delegate === 'CPU' && scene.cpuFails) throw new Error('out of memory');
      let detections = 0;
      return {
        detectForVideo: () => {
          const step = scene.stepMs?.[o.delegate];
          clockMs += typeof step === 'function' ? step(detections) : (step ?? 0);
          detections++;
          return scene.tip ? { landmarks: [landmarks(scene.tip, scene.size)], handedness: [[{ score: 0.96, categoryName: 'Left' }]] } : { landmarks: [], handedness: [] };
        },
        close() {},
      };
    },
    objectUrl: () => 'blob:https://app.test/wasm',
    revokeUrl: () => {},
    // Delivered asynchronously, like postMessage.
    post: (msg) => {
      const deliver = () => {
        // The answer to a frame is back on the main thread (or gone with the worker): it is out of flight.
        if (msg.type === 'result' || msg.type === 'error') flight.now--;
        if (!terminated) w.onmessage?.({ data: msg } as MessageEvent<FromWorker>);
      };
      if (scene.hold && (msg.type === 'result' || msg.type === 'error')) held.push(deliver);
      else void Promise.resolve().then(deliver);
    },
    preview: () => ({ width: 320, height: 180, close: vi.fn() }) as unknown as ImageBitmap,
    now: () => clockMs,
  };
  if (scene.warmup) deps.warmupImage = () => ({ width: 640, height: 360 }) as ImageData;
  const core = createWorkerCore(deps);
  return w;
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** Lets queued work run until `check` holds (a model loading, say), giving up after `rounds` settles. */
async function until(check: () => boolean, rounds = 50): Promise<void> {
  for (let i = 0; i < rounds && !check(); i++) await settle();
}

/** A VideoFrame from the camera track, with what the feed and the tracker read of it. */
interface FakeVideoFrame {
  /** Capture time in µs on the processor's own clock. */
  timestamp: number;
  displayWidth: number;
  displayHeight: number;
  closed: boolean;
  close(): void;
}

/** The processor's clock is another clock (Chromium: µs of the system's monotonic clock). */
const PROCESSOR_BASE_US = 7_000_000_000;

/**
 * A MediaStreamTrackProcessor stand-in with Chromium's maxBufferSize 1 behaviour: it keeps only the
 * newest frame until the feed reads it, closing the one it replaces.
 */
class FakeProcessor {
  opened = 0;
  cancelled = 0;
  read: FakeVideoFrame[] = [];
  pushed: FakeVideoFrame[] = [];
  private slot: FakeVideoFrame | null = null;
  private waiting: (() => void) | null = null;
  private controller: ReadableStreamDefaultController<VideoFrame> | null = null;

  open(): ReadableStream<VideoFrame> {
    this.opened++;
    this.slot?.close();
    this.slot = null;
    this.waiting = null;
    return new ReadableStream<VideoFrame>(
      {
        start: (c) => {
          this.controller = c;
        },
        pull: (c) => {
          const take = () => {
            const f = this.slot!;
            this.slot = null;
            this.read.push(f);
            c.enqueue(f as unknown as VideoFrame);
          };
          if (this.slot) return take();
          return new Promise<void>((resolve) => {
            this.waiting = () => {
              take();
              resolve();
            };
          });
        },
        cancel: () => {
          this.cancelled++;
          this.slot?.close();
          this.slot = null;
          this.waiting = null;
        },
      },
      { highWaterMark: 0 },
    );
  }

  /** A camera frame arrives, captured `delayMs` before `nowMs` on the kernel clock. */
  push(nowMs: number, size: [number, number] = [W, H], delayMs = 2): FakeVideoFrame {
    const f: FakeVideoFrame = {
      timestamp: PROCESSOR_BASE_US + (nowMs - delayMs) * 1000, displayWidth: size[0], displayHeight: size[1],
      closed: false, close() { this.closed = true; },
    };
    this.pushed.push(f);
    this.slot?.close();
    this.slot = f;
    const w = this.waiting;
    this.waiting = null;
    w?.();
    return f;
  }

  /** The track ends: the stream closes, and a read waiting on it ends. */
  end(): void {
    this.slot?.close();
    this.slot = null;
    this.waiting = null;
    try {
      this.controller?.close();
    } catch {
      /* cancelled already */
    }
  }
}

interface Harness {
  kernel: KernelHost;
  clock: { t: number };
  scene: Scene;
  events: Envelope[];
  toWorker: ToWorker[];
  delegates: string[];
  workers: number;
  /** Copies made of the video (the 'camera.frame' path). */
  bitmaps: { width: number; height: number; close: ReturnType<typeof vi.fn> }[];
  stops: string[];
  starts: { requester: string; exposure?: string }[];
  generation: number;
  proc: FakeProcessor;
  ready: (generation?: number) => CameraReady;
  frame: (advanceMs?: number) => Promise<void>;
  /** With a processor: a camera frame through the fast path, and the matching 'camera.frame', as
   *  capture publishes it for everyone else. */
  feedFrame: (advanceMs?: number, size?: [number, number]) => Promise<FakeVideoFrame>;
  /** The frame messages the worker got. */
  frames: () => Extract<ToWorker, { type: 'frame' }>[];
  /** Lets the answers held back by Scene.hold go, in order. */
  release: () => void;
  of: <T>(type: string) => T[];
  statuses: () => TrackerStatus[];
}

async function harness(scene: Partial<Scene> = {}, settings: Record<string, unknown> = {}, opts: { processor?: boolean } = {}): Promise<Harness> {
  const clock = { t: 1000 };
  flight.now = 0;
  flight.max = 0;
  held.length = 0;
  const kernel = createKernel({
    persistence: memoryPersistence({ 'tracker.active': 'tracker.hand', ...settings }),
    clock: () => clock.t,
    features: ['platform.camera', 'platform.wasm', 'platform.worker', 'platform.offscreen-canvas'],
  });
  const events: Envelope[] = [];
  kernel.subscribe('*', (e) => events.push(e));
  let frameNo = 0;
  const proc = new FakeProcessor();
  // With a processor, CameraReady.stream has a live video track for it to read.
  const track = { kind: 'video', readyState: 'live' } as unknown as MediaStreamTrack;
  const stream = (opts.processor ? { getVideoTracks: () => [track] } : {}) as MediaStream;
  const emitFrame = () =>
    kernel.emit('camera.frame', { t: clock.t, timeSource: 'capture', frame: frameNo++, generation: h.generation, width: W, height: H, video: { readyState: 4 } as HTMLVideoElement }, 'capture.camera');
  const h: Harness = {
    kernel, clock, events, proc,
    scene: { tip: null, modelMissing: false, gpuFails: false, ...scene },
    toWorker: [], delegates: [], workers: 0, bitmaps: [], stops: [], starts: [], generation: 1,
    ready: (generation = h.generation) => ({ deviceId: 'cam', label: 'Test camera', width: W, height: H, fps: 30, stream, exposure: null, infrared: false, generation }),
    async frame(advanceMs = 1000 / 30) {
      clock.t += advanceMs;
      emitFrame();
      await settle();
    },
    async feedFrame(advanceMs = 1000 / 30, size) {
      clock.t += advanceMs;
      const f = proc.push(clock.t, size);
      emitFrame();
      await settle(40);
      return f;
    },
    frames: () => h.toWorker.filter((m): m is Extract<ToWorker, { type: 'frame' }> => m.type === 'frame'),
    release: () => {
      for (const deliver of held.splice(0)) deliver();
    },
    of: <T>(type: string) => events.filter((e) => e.type === type).map((e) => e.payload as T),
    statuses: () => events.filter((e) => e.type === 'tracker.status').map((e) => e.payload as TrackerStatus),
  };
  const ready = () => h.ready();
  // A fake capture module: just the requests the tracker uses.
  kernel.register({
    manifest: { id: 'capture.camera', kind: 'capture', version: '1.0.0', contract: '^1.1', provides: ['camera.frames@1'] },
    async init(k) {
      k.handle('camera.start', (p: { requester: string; exposure?: string }) => {
        h.starts.push(p);
        const r = ready();
        k.publish({ type: 'camera.ready', v: 1, t: k.now(), source: 'capture.camera', payload: r });
        k.publish({ type: 'camera.status', v: 1, t: k.now(), source: 'capture.camera', payload: { state: 'on', generation: r.generation, permission: 'granted' } });
        return r;
      });
      k.handle('camera.stop', (p: { requester: string }) => {
        h.stops.push(p.requester);
      });
    },
    async start() {},
    async stop() {},
  });
  kernel.register(
    buildHandTracker({ modelUrl: MODEL_URL, wasmBaseUrl: WASM_BASE }, {
      createWorker: () => {
        h.workers++;
        return fakeWorker(h.scene, h.toWorker, h.delegates);
      },
      grabFrame: (_video, width, height) => {
        const bitmap = { width, height, close: vi.fn() };
        h.bitmaps.push(bitmap);
        return Promise.resolve(bitmap as unknown as ImageBitmap);
      },
      openProcessor: opts.processor ? () => proc.open() : null,
      resolveUrl: (path) => new URL(path, `${ORIGIN}/`).href,
    }),
  );
  await kernel.init();
  await kernel.start();
  await settle();
  return h;
}

describe('hand tracker', () => {
  let h: Harness;

  afterEach(async () => {
    await h?.kernel.stop();
    vi.useRealTimers();
  });

  describe('loading', () => {
    beforeEach(async () => {
      h = await harness();
    });

    it('says it is loading before anything else, with progress, then waits for frames', () => {
      const statuses = h.statuses();
      expect(statuses[0]).toMatchObject({ tracker: 'tracker.hand', state: 'loading', progress: 0, message: 'Hand model loading', pen: false });
      // Every status says what the samples need from the segmenter (contracts 1.2).
      for (const s of statuses) expect(s.segmentation).toEqual({ lostMs: 500, minSamples: 5, pauseMs: 300 });
      expect(MANIFEST.contract).toBe('^1.3');
      // Downloads fill 90% of the bar; then the model is set up.
      expect(statuses.some((s) => s.state === 'loading' && s.progress === 0.9 && s.message === 'Hand model starting')).toBe(true);
      const loading = statuses.filter((s) => s.state === 'loading').map((s) => s.progress ?? 0);
      for (let i = 1; i < loading.length; i++) expect(loading[i]).toBeGreaterThanOrEqual(loading[i - 1]);
      expect(statuses.at(-1)).toMatchObject({ state: 'searching', aspect: W / H });
      expect(statuses.at(-1)!.message).toBeUndefined();
      // The model and runtime come from absolute URLs on the app's origin, GPU first.
      expect(h.toWorker[0]).toEqual({ type: 'load', run: 1, delegate: 'GPU', wasmBaseUrl: `${ORIGIN}/models/wasm`, modelUrl: `${ORIGIN}/models/hand_landmarker.task` });
      // Continuous exposure: the landmarker wants a normal picture.
      expect(h.starts).toEqual([{ requester: 'tracker.hand', exposure: 'auto' }]);
    });
  });

  it('tells the player plainly when the model is not installed, and stays stopped', async () => {
    h = await harness({ modelMissing: true });
    const last = h.statuses().at(-1)!;
    expect(last).toMatchObject({ state: 'error', message: 'Hand model not installed. Run npm run models.', hint: null });
    expect(h.stops).toContain('tracker.hand');
    // No CPU retry for a missing file, and frames are not processed.
    expect(h.workers).toBe(1);
    const before = h.toWorker.length;
    h.scene.tip = [0.3, 0.4];
    await h.frame();
    expect(h.toWorker.length).toBe(before);
    expect(h.of('tip.found')).toHaveLength(0);
  });

  it('gives the hand-not-found hint after 3 s of frames without a hand, and clears it when found', async () => {
    // Fake timers drive the twice-a-second status refresh; the kernel clock is the harness's own.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    h = await harness();
    for (let i = 0; i < 25; i++) await h.frame(100);
    vi.advanceTimersByTime(500);
    expect(h.statuses().at(-1)!.hint ?? null).toBeNull();
    for (let i = 0; i < 10; i++) await h.frame(100);
    vi.advanceTimersByTime(500);
    // 3.5 s of frames without a hand.
    expect(h.statuses().at(-1)).toMatchObject({ state: 'searching', hint: 'hand-not-found' });
    h.scene.tip = [0.3, 0.4];
    await h.frame(100);
    expect(h.statuses().at(-1)).toMatchObject({ state: 'tracking', hint: null });
  });

  it('says the hand looks small while a small hand is held, until it comes near enough', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    h = await harness({ tip: [0.3, 0.4], size: 0.04 });
    for (let i = 0; i < 15; i++) await h.frame();
    vi.advanceTimersByTime(500);
    expect(h.statuses().at(-1)).toMatchObject({ state: 'tracking', hint: 'hand-too-small' });
    // Stepping closer: a second later the hand is large enough.
    h.scene.size = 0.08;
    for (let i = 0; i < 30; i++) await h.frame();
    vi.advanceTimersByTime(500);
    expect(h.statuses().at(-1)).toMatchObject({ state: 'tracking', hint: null });
  });

  it('in wand mode asks the worker for the wand, guesses past the knuckles until it is seen, and says so', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    h = await harness({}, { 'hand.mode': 'wand' });
    await h.kernel.settings.set('tracker.debug', true);
    h.scene.tip = [0.3, 0.4];
    await h.frame();
    // Every frame asks for the wand, with no place in the hand learned yet.
    expect(h.frames().at(-1)!.wand).toEqual({ prior: null });
    // This worker reads no pixels: no wand, so the tip is the grip projection.
    const [s] = h.of<TipSample>('tip.sample');
    expect(s.x).toBeCloseTo(0.5, 5);
    expect(s.y).toBeLessThan(0.6);
    expect(h.of<TrackerDebugFrame>('tracker.debug')[0].wand).toMatchObject({ source: 'grip', quality: 0 });
    for (let i = 0; i < 35; i++) await h.frame(100);
    vi.advanceTimersByTime(500);
    expect(h.statuses().at(-1)).toMatchObject({ state: 'tracking', hint: 'wand-not-seen', wand: { seen: 0, learned: false } });
    // Not in finger mode, at once: the hand has gone before the switch, so no frame with a hand comes to
    // tell the tracking state the mode changed.
    h.scene.tip = null;
    for (let i = 0; i < 3; i++) await h.frame();
    await h.kernel.settings.set('hand.mode', 'finger');
    vi.advanceTimersByTime(500);
    expect(h.statuses().at(-1)!.wand).toBeUndefined();
    await h.frame();
    expect(h.frames().at(-1)!.wand).toBeUndefined();
  });

  it('retries once on the CPU when the GPU delegate fails', async () => {
    h = await harness({ gpuFails: true });
    expect(h.delegates).toEqual(['GPU', 'CPU']);
    expect(h.workers).toBe(2);
    expect(h.statuses().at(-1)!.state).toBe('searching');
    // The retry starts its own progress from zero.
    const loads = h.toWorker.filter((m) => m.type === 'load').map((m) => (m as { delegate: string }).delegate);
    expect(loads).toEqual(['GPU', 'CPU']);
  });

  it('retries on the CPU when the worker dies while loading on the GPU', async () => {
    h = await harness({ gpuCrashes: true });
    expect(h.workers).toBe(2);
    expect(h.delegates).toEqual(['CPU']);
    expect(h.statuses().at(-1)!.state).toBe('searching');
  });

  it('gives up plainly when the CPU cannot run the model either', async () => {
    h = await harness({ gpuFails: true, cpuFails: true });
    expect(h.delegates).toEqual(['GPU', 'CPU']);
    expect(h.workers).toBe(2);
    expect(h.statuses().at(-1)).toMatchObject({ state: 'error', message: 'Hand tracking could not start in this browser.' });
    expect(h.stops).toContain('tracker.hand');
  });

  describe('tracking', () => {
    beforeEach(async () => {
      h = await harness();
    });

    it('publishes tip.found, then samples in caster space with capture times, then tip.lost', async () => {
      h.events.length = 0;
      h.scene.tip = [0.3, 0.4];
      await h.frame();
      const t1 = h.clock.t;
      h.scene.tip = [0.32, 0.41];
      await h.frame();
      const t2 = h.clock.t;
      h.scene.tip = null;
      await h.frame();
      await h.frame();
      await h.frame();
      // Frames without a hand are forgiven until LOST_AFTER_MS of capture time has passed.
      expect(h.of('tip.lost')).toHaveLength(0);
      await h.frame(LOST_AFTER_MS);
      const t5 = h.clock.t;
      const types = h.events.map((e) => e.type).filter((t) => t.startsWith('tip.') || t === 'tracker.status');
      expect(types.filter((t) => t.startsWith('tip.'))).toEqual(['tip.found', 'tip.sample', 'tip.sample', 'tip.lost']);
      // Rule 2: found right before the sample of the same frame, same t; status says tracking first.
      expect(types.slice(0, 3)).toEqual(['tracker.status', 'tip.found', 'tip.sample']);
      const [found] = h.of<TipSample>('tip.found');
      const samples = h.of<TipSample>('tip.sample');
      expect(found).toEqual(samples[0]);
      expect(samples[0]).toMatchObject({ t: t1, x: 0.7, y: 0.4, conf: 0.96, src: 'tracker.hand', frame: 0 });
      expect(samples[0].size).toBeCloseTo(0.2 / (W / H), 4);
      expect(samples[1]).toMatchObject({ t: t2, x: 0.68, y: 0.41 });
      expect(h.of<{ t: number; lastSeen: number }>('tip.lost')[0]).toEqual({ t: t5, src: 'tracker.hand', lastSeen: t2 });
      expect(h.events.find((e) => e.type === 'tip.sample')!.t).toBe(t1);
      expect(h.statuses().at(-1)!.state).toBe('searching');
    });

    it('follows the grip projection and the flip setting', async () => {
      await h.kernel.settings.set('hand.mode', 'grip');
      await h.kernel.settings.set('capture.flipX', false);
      h.scene.tip = [0.3, 0.4];
      await h.frame();
      const [s] = h.of<TipSample>('tip.sample');
      // The fake hand is upright and centred: the projection sits above the knuckles at x 0.5, unflipped.
      expect(s.x).toBeCloseTo(0.5, 5);
      expect(s.y).toBeLessThan(0.6);
    });

    it('drops frames while one is in flight instead of queueing them', async () => {
      const framesBefore = h.toWorker.filter((m) => m.type === 'frame').length;
      h.clock.t += 33;
      for (let i = 0; i < 3; i++) h.kernel.emit('camera.frame', { t: h.clock.t + i, timeSource: 'capture', frame: 100 + i, generation: 1, width: W, height: H, video: {} as HTMLVideoElement }, 'capture.camera');
      await settle();
      expect(h.toWorker.filter((m) => m.type === 'frame').length - framesBefore).toBe(1);
    });

    it('scales frames to about 640 px wide for the model, and says it reads the video', async () => {
      await h.frame();
      const msg = h.frames()[0];
      const image = msg.image as ImageBitmap;
      expect(image.width).toBe(640);
      expect(image.height).toBe(360);
      expect(msg).toMatchObject({ width: W, height: H, generation: 1, flipX: true });
      // Without a track processor there is no fast path.
      expect(h.statuses().at(-1)!.source).toBe('video');
    });

    it('closes a copy of the video made just as the camera changes, instead of sending it', async () => {
      h.clock.t += 33;
      h.kernel.emit('camera.frame', { t: h.clock.t, timeSource: 'capture', frame: 50, generation: 1, width: W, height: H, video: { readyState: 4 } as HTMLVideoElement }, 'capture.camera');
      // The copy is still being made when the camera moves to a new generation.
      h.generation = 2;
      h.kernel.emit('camera.ready', h.ready(2), 'capture.camera');
      await settle();
      expect(h.bitmaps.at(-1)!.close).toHaveBeenCalled();
      expect(h.frames().some((m) => m.frame === 50)).toBe(false);
      // The new camera's frames go through.
      await h.frame();
      expect(h.frames().at(-1)!.generation).toBe(2);
    });

    it('keeps a frame of an old camera generation in the worker until it is answered: never two at once', async () => {
      h.scene.tip = [0.3, 0.4];
      await h.frame();
      h.scene.hold = true;
      // A (generation 1) is in the worker when the camera moves to a new generation.
      await h.frame();
      h.generation = 2;
      h.kernel.emit('camera.ready', h.ready(2), 'capture.camera');
      await settle();
      const samples = h.of('tip.sample').length;
      // The new camera's first frame is dropped while A is still in the worker.
      await h.frame();
      expect(h.frames()).toHaveLength(2);
      expect(flight.now).toBe(1);
      // A's answer frees the worker without being used; then frames go one at a time.
      h.release();
      await settle();
      expect(h.of('tip.sample')).toHaveLength(samples);
      for (let i = 0; i < 6; i++) {
        await h.frame();
        expect(h.frames().at(-1)!.generation).toBe(2);
        h.release();
        await settle();
      }
      expect(h.frames()).toHaveLength(8);
      expect(h.of('tip.sample')).toHaveLength(samples + 6);
      expect(flight.max).toBe(1);
    });

    it('gives up a frame the worker has not answered in ten seconds, and a late answer to it changes nothing', async () => {
      h.scene.tip = [0.3, 0.4];
      await h.frame();
      h.scene.hold = true;
      await h.frame(); // A, never answered in time
      await h.frame(10_000); // B goes in its place
      expect(h.frames()).toHaveLength(3);
      const samples = h.of('tip.sample').length;
      // A's answer, late: not used, and B still has the worker.
      held.shift()!();
      await settle();
      expect(h.of('tip.sample')).toHaveLength(samples);
      await h.frame();
      expect(h.frames()).toHaveLength(3);
      // B's answer is used, and frees the worker.
      held.shift()!();
      await settle();
      expect(h.of<TipSample>('tip.sample').at(-1)!.t).toBe(h.frames()[2].t);
      await h.frame();
      expect(h.frames()).toHaveLength(4);
    });

    it('closes a copy the worker could not take, and sends the next one', async () => {
      h.scene.postFails = true;
      await h.frame();
      expect(h.bitmaps).toHaveLength(1);
      expect(h.bitmaps[0].close).toHaveBeenCalled();
      expect(h.frames()).toHaveLength(0);
      h.scene.postFails = false;
      await h.frame();
      expect(h.frames()).toHaveLength(1);
    });

    it('publishes tracker.debug with landmarks while the debug view is on', async () => {
      await h.kernel.settings.set('tracker.debug', true);
      h.scene.tip = [0.3, 0.4];
      await h.frame();
      await h.frame(50);
      await h.frame(60);
      const debug = h.of<TrackerDebugFrame>('tracker.debug');
      // About 10 a second: the second frame is too soon, the third is due.
      expect(debug).toHaveLength(2);
      expect(debug[0]).toMatchObject({ tracker: 'tracker.hand', width: 320, height: 180, blobs: [] });
      expect(debug[0].landmarks![8]).toEqual([0.7, 0.4]);
      expect(debug[0].image).not.toBeNull();
    });

    it('loses the tip before a new camera generation, and when the camera stops', async () => {
      h.scene.tip = [0.3, 0.4];
      await h.frame();
      h.generation = 2;
      h.kernel.emit('camera.ready', { deviceId: 'cam', label: 'Test camera', width: 1920, height: 1080, fps: 30, stream: {} as MediaStream, exposure: null, infrared: false, generation: 2 }, 'capture.camera');
      expect(h.of('tip.lost')).toHaveLength(1);
      await h.frame();
      expect(h.of('tip.found')).toHaveLength(2);
      h.kernel.emit('camera.stopped', { reason: 'released', generation: 2 }, 'capture.camera');
      expect(h.of('tip.lost')).toHaveLength(2);
      expect(h.statuses().at(-1)).toMatchObject({ state: 'starting', message: 'Waiting for the camera' });
    });

    it('ends a held stroke when the tip definition changes', async () => {
      h.scene.tip = [0.3, 0.4];
      await h.frame();
      await h.kernel.settings.set('hand.mode', 'grip');
      expect(h.of('tip.lost')).toHaveLength(1);
    });

    it('lets go of the tip on stop, then says stopped and releases the camera', async () => {
      h.scene.tip = [0.3, 0.4];
      await h.frame();
      const seen = h.clock.t;
      h.clock.t += 500;
      await h.kernel.stop();
      const types = h.events.map((e) => e.type).filter((t) => t.startsWith('tip.') || t === 'tracker.status');
      expect(types.slice(-2)).toEqual(['tip.lost', 'tracker.status']);
      expect(h.of<{ t: number; lastSeen: number }>('tip.lost')[0]).toMatchObject({ t: seen, lastSeen: seen });
      expect(h.statuses().at(-1)).toMatchObject({ state: 'stopped', hint: null });
      expect(h.stops).toEqual(['tracker.hand']);
      expect(h.toWorker.at(-1)).toMatchObject({ type: 'close' });
    });
  });
});

describe('hand tracker with a track processor (the fast path)', () => {
  let h: Harness;

  afterEach(async () => {
    await h?.kernel.stop();
    vi.useRealTimers();
  });

  it("hands the worker the camera track's own frames, whole, with capture times on the kernel clock", async () => {
    h = await harness({ tip: [0.3, 0.4] }, {}, { processor: true });
    expect(h.proc.opened).toBe(1);
    const a = await h.feedFrame();
    const tA = h.clock.t;
    const b = await h.feedFrame();
    // The video is never copied: the worker gets each VideoFrame itself, at the camera's size.
    expect(h.bitmaps).toHaveLength(0);
    const frames = h.frames();
    expect(frames).toHaveLength(2);
    expect(frames[0].image === (a as unknown as VideoFrame) && frames[1].image === (b as unknown as VideoFrame)).toBe(true);
    expect(frames[0]).toMatchObject({ width: W, height: H, generation: 1, frame: 0, flipX: true });
    expect(frames[1].frame).toBe(1);
    // The processor's timestamps are on another clock; mapped back they give the capture time (plus the
    // smallest delivery delay, the same 2 ms for every frame here, so exactly the push time).
    const samples = h.of<TipSample>('tip.sample');
    expect(samples).toHaveLength(2);
    expect(samples[0].t).toBeCloseTo(tA, 6);
    expect(samples[0]).toMatchObject({ x: 0.7, y: 0.4, frame: 0 });
    // The worker closed both once the model had read them.
    expect([a.closed, b.closed]).toEqual([true, true]);
    expect(h.statuses().at(-1)).toMatchObject({ state: 'tracking', source: 'track' });
  });

  it('sends the size of the frame itself, which the geometry takes the aspect from', async () => {
    h = await harness({ tip: [0.3, 0.4] }, {}, { processor: true });
    // A 4:3 frame from a camera announced at 16:9.
    await h.feedFrame(undefined, [640, 480]);
    expect(h.frames()[0]).toMatchObject({ width: 640, height: 480 });
    // Wrist to middle knuckle spans 0.2 of the frame's height in the fake hand: 0.15 of a 4:3 frame's width.
    expect(h.of<TipSample>('tip.sample')[0].size).toBeCloseTo(0.15, 4);
  });

  it('keeps one frame in flight and takes the newest frame when the worker frees up', async () => {
    h = await harness({ tip: [0.3, 0.4] }, {}, { processor: true });
    await h.feedFrame();
    const before = h.proc.read.length;
    // The feed is waiting, so a goes to the worker at once. The model takes its time over it: b and c
    // arrive meanwhile, with capture's 'camera.frame' for each, and the processor keeps only the newest
    // of them, unread, until the worker is free. (Compared by identity.)
    h.scene.hold = true;
    const a = await h.feedFrame();
    const b = await h.feedFrame();
    const c = await h.feedFrame();
    expect(h.proc.read.length === before + 1 && h.proc.read.at(-1) === a).toBe(true);
    expect(flight.now).toBe(1);
    expect([b.closed, c.closed]).toEqual([true, false]);
    expect(h.bitmaps).toHaveLength(0);
    // The answer for a comes back: c goes next.
    h.scene.hold = false;
    h.release();
    await settle(40);
    const taken = h.proc.read.slice(before);
    expect(taken.length === 2 && taken[0] === a && taken[1] === c).toBe(true);
    expect(h.proc.read.includes(b)).toBe(false);
    const sent = h.frames().slice(-2).map((m) => m.image);
    expect(sent[0] === (a as unknown as VideoFrame) && sent[1] === (c as unknown as VideoFrame)).toBe(true);
    expect([a.closed, b.closed, c.closed]).toEqual([true, true, true]);
    expect(flight.max).toBe(1);
  });

  it('gives up a frame the worker never answers, after ten seconds, and sends the newest', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    h = await harness({ tip: [0.3, 0.4] }, {}, { processor: true });
    await h.feedFrame();
    h.scene.hold = true;
    await h.feedFrame(); // never answered
    const sent = h.frames().length;
    const next = await h.feedFrame();
    expect(h.frames()).toHaveLength(sent);
    h.clock.t += 9_000;
    vi.advanceTimersByTime(9_000);
    await settle(40);
    expect(h.frames()).toHaveLength(sent);
    h.clock.t += 1_000;
    vi.advanceTimersByTime(1_000);
    await settle(40);
    expect(h.frames()).toHaveLength(sent + 1);
    expect(h.frames().at(-1)!.image === (next as unknown as VideoFrame)).toBe(true);
  });

  it('keeps a frame of an old camera generation in the worker until it is answered, then sends one at a time', async () => {
    h = await harness({ tip: [0.3, 0.4] }, {}, { processor: true });
    await h.feedFrame();
    h.scene.hold = true;
    // A (generation 1) is in the worker, its answer slow, when the camera moves to a new generation.
    const a = await h.feedFrame();
    h.generation = 2;
    h.kernel.emit('camera.ready', h.ready(2), 'capture.camera');
    await settle(40);
    expect(h.proc.opened).toBe(2);
    const samples = h.of('tip.sample').length;
    // B, the new stream's first frame, waits in the processor's buffer while A is in the worker.
    const b = await h.feedFrame();
    expect(h.frames().at(-1)!.image === (a as unknown as VideoFrame)).toBe(true);
    expect(b.closed).toBe(false);
    expect(flight.now).toBe(1);
    // A's answer frees the worker without being used (its generation has ended), and B goes.
    h.release();
    await settle(40);
    expect(h.of('tip.sample')).toHaveLength(samples);
    expect(h.frames().at(-1)!.image === (b as unknown as VideoFrame)).toBe(true);
    expect(h.frames().at(-1)!.generation).toBe(2);
    expect(flight.now).toBe(1);
    // A slow model from here on: the camera always has a newer frame waiting when an answer comes back.
    for (let i = 0; i < 6; i++) {
      const next = await h.feedFrame();
      expect(flight.now).toBe(1);
      h.release();
      await settle(40);
      expect(h.frames().at(-1)!.image === (next as unknown as VideoFrame)).toBe(true);
    }
    // B and the frames after it were used, each once, and never two were in the worker.
    expect(h.of('tip.sample')).toHaveLength(samples + 6);
    expect(flight.max).toBe(1);
  });

  it('ignores a late answer to a frame it gave up on: the frame sent in its place keeps the worker', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    h = await harness({ tip: [0.3, 0.4] }, {}, { processor: true });
    await h.feedFrame();
    h.scene.hold = true;
    await h.feedFrame(); // A, never answered in time
    const b = await h.feedFrame();
    h.clock.t += 10_000;
    vi.advanceTimersByTime(10_000);
    await settle(40);
    expect(h.frames().at(-1)!.image === (b as unknown as VideoFrame)).toBe(true);
    const samples = h.of('tip.sample').length;
    // A's answer comes back late: it is not used, and frees nothing, so C waits.
    held.shift()!();
    await settle(40);
    expect(h.of('tip.sample')).toHaveLength(samples);
    const c = await h.feedFrame();
    expect(h.frames().at(-1)!.image === (b as unknown as VideoFrame)).toBe(true);
    expect(c.closed).toBe(false);
    // B's answer is used, and C goes.
    held.shift()!();
    await settle(40);
    expect(h.of('tip.sample')).toHaveLength(samples + 1);
    expect(h.frames().at(-1)!.image === (c as unknown as VideoFrame)).toBe(true);
  });

  it('reads no frame from the track until the model is ready, then the newest', async () => {
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    h = await harness({ tip: [0.3, 0.4], loadGate: gate }, {}, { processor: true });
    expect(h.statuses().at(-1)!.state).toBe('loading');
    const early = [await h.feedFrame(), await h.feedFrame(), await h.feedFrame()];
    expect(h.proc.read).toHaveLength(0);
    expect(h.bitmaps).toHaveLength(0);
    open();
    await until(() => h.statuses().at(-1)!.state !== 'loading');
    await settle(40);
    // The processor kept only the newest frame (closing the others); it is the first the model sees.
    expect(h.proc.read.length === 1 && h.proc.read[0] === early[2]).toBe(true);
    expect([early[0].closed, early[1].closed, early[2].closed]).toEqual([true, true, true]);
    expect(h.frames()).toHaveLength(1);
    expect(h.of('tip.found')).toHaveLength(1);
  });

  it('closes a frame the worker could not take, and goes on with the next', async () => {
    h = await harness({ tip: [0.3, 0.4] }, {}, { processor: true });
    h.scene.postFails = true;
    const a = await h.feedFrame();
    expect(a.closed).toBe(true);
    expect(h.frames()).toHaveLength(0);
    h.scene.postFails = false;
    const b = await h.feedFrame();
    expect(h.frames()).toHaveLength(1);
    expect(h.frames()[0].image === (b as unknown as VideoFrame)).toBe(true);
  });

  it('closes a frame read just as the camera changes, instead of sending it', async () => {
    h = await harness({ tip: [0.3, 0.4] }, {}, { processor: true });
    await h.feedFrame();
    const sent = h.frames().length;
    // The feed takes this frame, and before it is handed on, the camera moves to a new generation.
    const stale = h.proc.push(h.clock.t + 33);
    h.generation = 2;
    h.kernel.emit('camera.ready', h.ready(2), 'capture.camera');
    await settle(40);
    expect(stale.closed).toBe(true);
    expect(h.frames().slice(sent).some((m) => m.generation === 1)).toBe(false);
  });

  it('reads the video instead when the track stops handing frames over while the video still gets them', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    h = await harness({ tip: [0.3, 0.4] }, {}, { processor: true });
    for (let i = 0; i < 3; i++) await h.feedFrame();
    expect(h.bitmaps).toHaveLength(0);
    // Capture keeps publishing camera.frame, but the processor delivers nothing for over a second.
    const quiet = Math.max(FEED_STALL_FRAMES, Math.ceil(FEED_STALL_MS / (1000 / 30))) + 5;
    for (let i = 0; i < quiet; i++) await h.frame();
    expect(h.proc.cancelled).toBe(1);
    expect(h.bitmaps.length).toBeGreaterThan(3);
    vi.advanceTimersByTime(500);
    expect(h.statuses().at(-1)).toMatchObject({ state: 'tracking', source: 'video' });
    // From now on frames come from the video only, for this camera generation.
    const read = h.proc.read.length;
    await h.feedFrame();
    expect(h.proc.read.length).toBe(read);
    expect(h.proc.opened).toBe(1);
  });

  it('keeps the fast path through a long main-thread task', async () => {
    h = await harness({}, {}, { processor: true });
    for (let i = 0; i < 3; i++) await h.feedFrame();
    // Nothing ran for 2 s (the app starting up); then the video's callback runs before the processor's frame.
    await h.frame(2000);
    await h.feedFrame();
    await h.feedFrame();
    expect(h.proc.cancelled).toBe(0);
    expect(h.bitmaps).toHaveLength(0);
  });

  it('reads the video when the track ends', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    h = await harness({ tip: [0.3, 0.4] }, {}, { processor: true });
    await h.feedFrame();
    h.proc.end();
    await settle(40);
    await h.frame();
    expect(h.bitmaps).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(h.statuses().at(-1)!.source).toBe('video');
  });

  it('opens a new processor for a new camera generation, and cancels it when the camera stops and on stop', async () => {
    h = await harness({ tip: [0.3, 0.4] }, {}, { processor: true });
    await h.feedFrame();
    expect(h.proc.opened).toBe(1);
    h.generation = 2;
    h.kernel.emit('camera.ready', h.ready(2), 'capture.camera');
    await settle();
    expect(h.proc.cancelled).toBe(1);
    expect(h.proc.opened).toBe(2);
    await h.feedFrame();
    expect(h.frames().at(-1)!.generation).toBe(2);
    h.kernel.emit('camera.stopped', { reason: 'released', generation: 2 }, 'capture.camera');
    expect(h.proc.cancelled).toBe(2);
    expect(h.statuses().at(-1)!.source).toBeUndefined();
    // The camera comes back with a new processor, which stop cancels.
    h.generation = 3;
    h.kernel.emit('camera.ready', h.ready(3), 'capture.camera');
    expect(h.proc.opened).toBe(3);
    await h.feedFrame();
    expect(h.frames().at(-1)!.generation).toBe(3);
    await h.kernel.stop();
    expect(h.proc.cancelled).toBe(3);
    // A frame that arrives after stop is never read, and every frame read was closed.
    const late = h.proc.push(h.clock.t + 33);
    await settle(40);
    expect(h.proc.read.includes(late)).toBe(false);
    expect(h.proc.read.every((f) => f.closed)).toBe(true);
  });
});

describe('hand tracker on a slow GPU delegate', () => {
  let h: Harness;

  afterEach(async () => {
    await h?.kernel.stop();
  });

  it(`loads the model again on the CPU when the GPU's first ${SLOW_GPU_FRAMES} detections are slow, for good`, async () => {
    // WebGL in software: about 300 ms a detection on the GPU delegate (the hand study: 308), 33 on the CPU.
    h = await harness({ tip: [0.3, 0.4], stepMs: { GPU: 300, CPU: 33 } });
    for (let i = 0; i < SLOW_GPU_FRAMES - 1; i++) await h.frame();
    expect(h.workers).toBe(1);
    expect(h.statuses().at(-1)!.state).toBe('tracking');
    h.events.length = 0;
    await h.frame();
    await until(() => h.statuses().at(-1)!.state !== 'loading');
    expect(h.delegates).toEqual(['GPU', 'CPU']);
    expect(h.workers).toBe(2);
    expect(h.toWorker.filter((m) => m.type === 'load').map((m) => (m as { delegate: string }).delegate)).toEqual(['GPU', 'CPU']);
    // The tip is let go of before the model goes away; the tracker says it is loading, then searches.
    const seq = h.events.flatMap((e) => (e.type === 'tip.lost' ? ['lost'] : e.type === 'tracker.status' ? [(e.payload as TrackerStatus).state] : []));
    expect(seq.indexOf('lost')).toBeGreaterThanOrEqual(0);
    expect(seq.indexOf('lost')).toBeLessThan(seq.indexOf('loading'));
    expect(seq.slice(0, seq.indexOf('loading'))).not.toContain('searching');
    expect(seq.at(-1)).toBe('searching');
    // Frames go on, on the CPU. A CPU that turns out slow too is kept: there is no going back to the GPU.
    h.scene.stepMs = { CPU: 400 };
    for (let i = 0; i < 2 * SLOW_GPU_FRAMES; i++) await h.frame();
    expect(h.workers).toBe(2);
    expect(h.statuses().at(-1)!.state).toBe('tracking');
    // Started again, the tracker goes straight to the CPU.
    await h.kernel.stop();
    await h.kernel.start();
    await until(() => h.statuses().at(-1)!.state !== 'loading');
    expect(h.toWorker.filter((m) => m.type === 'load').map((m) => (m as { delegate: string }).delegate)).toEqual(['GPU', 'CPU', 'CPU']);
    expect(h.delegates).toEqual(['GPU', 'CPU', 'CPU']);
  });

  it('keeps a GPU delegate that is fast enough, whatever its warm-up and first few detections took', async () => {
    // A real GPU: the warm-up compiles its programs for seconds (before 'ready', so it does not count),
    // and the first detections after it are slower than the rest; here four of them far slower.
    h = await harness({ tip: [0.3, 0.4], warmup: true, stepMs: { GPU: (i) => (i === 0 ? 5000 : i < 5 ? 400 : 17) } });
    for (let i = 0; i < 3 * SLOW_GPU_FRAMES; i++) await h.frame();
    expect(h.workers).toBe(1);
    expect(h.delegates).toEqual(['GPU']);
    expect(h.statuses().at(-1)!.state).toBe('tracking');
  });

  it('keeps reading the camera track while the model loads again on the CPU', async () => {
    h = await harness({ tip: [0.3, 0.4], stepMs: { GPU: 300, CPU: 33 } }, {}, { processor: true });
    for (let i = 0; i < SLOW_GPU_FRAMES; i++) await h.feedFrame();
    await until(() => h.statuses().at(-1)!.state !== 'loading');
    expect(h.workers).toBe(2);
    const sent = h.frames().length;
    await h.feedFrame();
    await h.feedFrame();
    expect(h.frames().length).toBe(sent + 2);
    expect(h.proc.opened).toBe(1);
    expect(h.proc.cancelled).toBe(0);
    expect(h.bitmaps).toHaveLength(0);
    expect(h.statuses().at(-1)).toMatchObject({ state: 'tracking', source: 'track' });
  });
});
