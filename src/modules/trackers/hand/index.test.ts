import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraReady, Envelope, TipSample, TrackerDebugFrame, TrackerStatus } from '../../../contracts';
import { createKernel, memoryPersistence, type KernelHost } from '../../../kernel';
import { buildHandTracker, type WorkerLike } from './index';
import type { FromWorker, ToWorker } from './protocol';
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
  modelMissing: boolean;
  gpuFails: boolean;
  cpuFails?: boolean;
  /** The worker dies (an uncaught error) while loading on the GPU. */
  gpuCrashes?: boolean;
}

function landmarks(tip: [number, number]) {
  return Array.from({ length: 21 }, (_, i) => ({ x: i === 8 ? tip[0] : i === 9 ? 0.5 : 0.5, y: i === 8 ? tip[1] : i === 9 ? 0.6 : 0.8, z: 0 }));
}

function fakeWorker(scene: Scene, log: ToWorker[], delegates: string[]): WorkerLike {
  let terminated = false;
  const w: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(msg) {
      log.push(msg);
      if (msg.type === 'load' && msg.delegate === 'GPU' && scene.gpuCrashes) {
        void Promise.resolve().then(() => w.onerror?.({ message: 'Uncaught RuntimeError: unreachable' } as ErrorEvent));
        return;
      }
      void core.handle(msg);
    },
    terminate() {
      terminated = true;
    },
  };
  const deps: WorkerCoreDeps = {
    fetch: async (url) => {
      if (url.endsWith('.task')) return scene.modelMissing ? new Response('', { status: 404 }) : new Response(MODEL);
      if (url.endsWith('.wasm')) return new Response(WASM);
      return new Response(LOADER);
    },
    fileset: async (base) => ({ wasmLoaderPath: `${base}/vision_wasm_module_internal.js`, wasmBinaryPath: `${base}/vision_wasm_module_internal.wasm` }),
    createLandmarker: async (o) => {
      delegates.push(o.delegate);
      if (o.delegate === 'GPU' && scene.gpuFails) throw new Error('GPU delegate refused');
      if (o.delegate === 'CPU' && scene.cpuFails) throw new Error('out of memory');
      return {
        detectForVideo: () => (scene.tip ? { landmarks: [landmarks(scene.tip)], handedness: [[{ score: 0.96, categoryName: 'Left' }]] } : { landmarks: [], handedness: [] }),
        close() {},
      };
    },
    objectUrl: () => 'blob:https://app.test/wasm',
    revokeUrl: () => {},
    // Delivered asynchronously, like postMessage.
    post: (msg) => {
      void Promise.resolve().then(() => {
        if (!terminated) w.onmessage?.({ data: msg } as MessageEvent<FromWorker>);
      });
    },
    preview: () => ({ width: 320, height: 180, close: vi.fn() }) as unknown as ImageBitmap,
    now: () => 0,
  };
  const core = createWorkerCore(deps);
  return w;
}

async function settle(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

interface Harness {
  kernel: KernelHost;
  clock: { t: number };
  scene: Scene;
  events: Envelope[];
  toWorker: ToWorker[];
  delegates: string[];
  workers: number;
  stops: string[];
  starts: { requester: string; exposure?: string }[];
  generation: number;
  frame: (advanceMs?: number) => Promise<void>;
  of: <T>(type: string) => T[];
  statuses: () => TrackerStatus[];
}

async function harness(scene: Partial<Scene> = {}, settings: Record<string, unknown> = {}): Promise<Harness> {
  const clock = { t: 1000 };
  const kernel = createKernel({
    persistence: memoryPersistence({ 'tracker.active': 'tracker.hand', ...settings }),
    clock: () => clock.t,
    features: ['platform.camera', 'platform.wasm', 'platform.worker', 'platform.offscreen-canvas'],
  });
  const events: Envelope[] = [];
  kernel.subscribe('*', (e) => events.push(e));
  let frameNo = 0;
  const h: Harness = {
    kernel, clock, events,
    scene: { tip: null, modelMissing: false, gpuFails: false, ...scene },
    toWorker: [], delegates: [], workers: 0, stops: [], starts: [], generation: 1,
    async frame(advanceMs = 1000 / 30) {
      clock.t += advanceMs;
      kernel.emit('camera.frame', { t: clock.t, timeSource: 'capture', frame: frameNo++, generation: h.generation, width: W, height: H, video: { readyState: 4 } as HTMLVideoElement }, 'capture.camera');
      await settle();
    },
    of: <T>(type: string) => events.filter((e) => e.type === type).map((e) => e.payload as T),
    statuses: () => events.filter((e) => e.type === 'tracker.status').map((e) => e.payload as TrackerStatus),
  };
  const ready = (): CameraReady => ({ deviceId: 'cam', label: 'Test camera', width: W, height: H, fps: 30, stream: {} as MediaStream, exposure: null, infrared: false, generation: h.generation });
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
      grabFrame: (_video, width, height) => Promise.resolve({ width, height, close: vi.fn() } as unknown as ImageBitmap),
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
      expect(h.of('tip.lost')).toHaveLength(0);
      await h.frame();
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

    it('scales frames to about 640 px wide for the model', async () => {
      await h.frame();
      const msg = h.toWorker.find((m) => m.type === 'frame') as Extract<ToWorker, { type: 'frame' }>;
      expect(msg.bitmap.width).toBe(640);
      expect(msg.bitmap.height).toBe(360);
      expect(msg).toMatchObject({ width: W, height: H, generation: 1, flipX: true });
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
