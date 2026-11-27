import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraExposureInfo, CameraReady, Envelope, TrackerStatus } from '../../../contracts';
import { createKernel, memoryPersistence, type KernelHost } from '../../../kernel';
import type { PixelRegion } from './algorithm';
import { buildBrightTipTracker, type WorkerLike } from './index';
import type { FromWorker, ToWorker } from './protocol';
import { crop, renderFrame, type SyntheticFrame } from './synthetic';
import { createWorkerCore } from './worker-core';

const W = 320, H = 180;

/** A stand-in VideoFrame: the worker core only needs close(); the fake reader reads `region`. */
interface FakeSource {
  region: PixelRegion;
  closed: boolean;
  close(): void;
  /** Processor frames only: capture time in µs on the processor's own clock. */
  timestamp?: number;
  displayWidth?: number;
  displayHeight?: number;
}

/** Frames in the worker at once (posted, result not yet back), and the most ever seen. */
const flight = { now: 0, max: 0 };

function fakeWorker(configs: ToWorker[]): WorkerLike {
  const w: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(msg) {
      if (msg.type === 'config' || msg.type === 'reset') configs.push(msg);
      if (msg.type === 'frame') flight.max = Math.max(flight.max, ++flight.now);
      void core.handle(msg);
    },
    terminate() {
      terminated = true;
    },
  };
  let terminated = false;
  const core = createWorkerCore({
    reader: {
      async read(source, rect) {
        const s = source as unknown as FakeSource;
        return { region: crop(s.region, rect), path: 'canvas' };
      },
    },
    // Delivered asynchronously, like postMessage.
    post: (msg) => {
      if (msg.type === 'result' || msg.type === 'skipped') flight.now--;
      void Promise.resolve().then(() => {
        if (!terminated) w.onmessage?.({ data: msg } as MessageEvent<FromWorker>);
      });
    },
    makeBitmap: async () => ({ close: vi.fn(), width: 1, height: 1 }) as unknown as ImageBitmap,
  });
  return w;
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
  read: FakeSource[] = [];
  private slot: FakeSource | null = null;
  private waiting: (() => void) | null = null;

  open(): ReadableStream<VideoFrame> {
    this.opened++;
    this.slot?.close();
    this.slot = null;
    this.waiting = null;
    return new ReadableStream<VideoFrame>(
      {
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
  push(region: PixelRegion, nowMs: number, delayMs = 2): FakeSource {
    const f: FakeSource = {
      region, closed: false, close() { this.closed = true; },
      timestamp: PROCESSOR_BASE_US + (nowMs - delayMs) * 1000, displayWidth: region.width, displayHeight: region.height,
    };
    this.slot?.close();
    this.slot = f;
    const w = this.waiting;
    this.waiting = null;
    w?.();
    return f;
  }
}

async function settle(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

interface Harness {
  kernel: KernelHost;
  events: Envelope[];
  clock: { t: number };
  scene: { spec: SyntheticFrame };
  configs: ToWorker[];
  sources: FakeSource[];
  exposureCalls: unknown[];
  stepDowns: unknown[];
  stops: string[];
  generation: number;
  ready: (generation?: number) => CameraReady;
  frame: (advanceMs?: number) => Promise<void>;
  /** With a processor: a camera frame through the fast path (and the matching 'camera.frame', as
   *  capture publishes it for everyone else). */
  feedFrame: (advanceMs?: number) => Promise<void>;
  proc: FakeProcessor;
  types: () => string[];
}

const EXPOSURE: CameraExposureInfo = { modes: ['continuous', 'manual'], min: 1, max: 2000, step: 1, mode: 'continuous', time: 320 };

async function harness(opts: { camera?: boolean; processor?: boolean } = {}): Promise<Harness> {
  const clock = { t: 1000 };
  flight.now = 0;
  flight.max = 0;
  const kernel = createKernel({ persistence: memoryPersistence(), clock: () => clock.t, features: ['platform.camera', 'platform.worker', 'platform.offscreen-canvas'] });
  const events: Envelope[] = [];
  kernel.subscribe('*', (e) => events.push(e));
  const configs: ToWorker[] = [];
  const sources: FakeSource[] = [];
  const scene = { spec: { width: W, height: H, noise: 3 } as SyntheticFrame };
  const exposureCalls: unknown[] = [];
  const stepDowns: unknown[] = [];
  const stops: string[] = [];
  const proc = new FakeProcessor();
  // With a processor, CameraReady.stream has a live video track for it to read.
  const track = { kind: 'video', readyState: 'live' } as unknown as MediaStreamTrack;
  const stream = (opts.processor ? { getVideoTracks: () => [track] } : {}) as MediaStream;
  let frameNo = 0;
  const h: Harness = {
    kernel, events, clock, scene, configs, sources, exposureCalls, stepDowns, stops, proc,
    generation: 1,
    ready: (generation = h.generation) => ({
      deviceId: 'cam', label: 'Test camera', width: W, height: H, fps: 30, stream, exposure: EXPOSURE, infrared: false, generation,
    }),
    async frame(advanceMs = 1000 / 30) {
      clock.t += advanceMs;
      kernel.emit('camera.frame', { t: clock.t, timeSource: 'capture', frame: frameNo++, generation: h.generation, width: W, height: H, video: {} as HTMLVideoElement }, 'capture.camera');
      await settle();
    },
    async feedFrame(advanceMs = 1000 / 30) {
      clock.t += advanceMs;
      proc.push(renderFrame({ seed: frameNo + 1, ...scene.spec }), clock.t);
      kernel.emit('camera.frame', { t: clock.t, timeSource: 'capture', frame: frameNo++, generation: h.generation, width: W, height: H, video: {} as HTMLVideoElement }, 'capture.camera');
      await settle();
    },
    types: () => events.map((e) => e.type),
  };
  // A fake capture module: just the requests the tracker uses.
  kernel.register({
    manifest: { id: 'capture.camera', kind: 'capture', version: '1.0.0', contract: '^1.1', provides: ['camera.frames@1'] },
    async init(k) {
      k.handle('camera.start', () => {
        if (opts.camera === false) return Promise.reject({ name: 'ConsentRequired', message: 'no consent' });
        const r = h.ready();
        k.publish({ type: 'camera.ready', v: 1, t: k.now(), source: 'capture.camera', payload: r });
        k.publish({ type: 'camera.status', v: 1, t: k.now(), source: 'capture.camera', payload: { state: 'on', generation: r.generation, permission: 'granted', exposure: { mode: 'continuous', time: 320 } } });
        return r;
      });
      k.handle('camera.stop', (p: { requester: string }) => {
        stops.push(p.requester);
      });
      k.handle('camera.exposure', (p: { mode: string; time?: number }) => {
        exposureCalls.push(p);
        // The scene follows the exposure: a brighter room with a longer exposure.
        if (p.mode === 'manual' && p.time !== undefined) scene.spec = { ...scene.spec, background: Math.min(200, p.time / 4) };
        return { mode: p.mode, time: p.time };
      });
      k.handle('camera.step-down', (p: unknown) => {
        stepDowns.push(p);
        return null;
      });
      k.handle('camera.profile.save', () => ({}));
    },
    async start() {},
    async stop() {},
  });
  kernel.register(
    buildBrightTipTracker({
      createWorker: () => fakeWorker(configs),
      grabFrame: () => {
        const src: FakeSource = { region: renderFrame({ seed: frameNo + 1, ...scene.spec }), closed: false, close() { this.closed = true; } };
        sources.push(src);
        return src as unknown as VideoFrame;
      },
      openProcessor: opts.processor ? () => proc.open() : null,
    }),
  );
  await kernel.init();
  await kernel.settings.set('tracker.active', 'tracker.bright-tip');
  await kernel.start();
  await settle();
  return h;
}

/** Frames with an empty room until the static mask has warmed up (the tracker never locks before). */
async function warm(h: Harness, frames = 36): Promise<void> {
  for (let i = 0; i < frames; i++) await h.frame();
}

const dot = (x: number, y: number) => ({ width: W, height: H, noise: 3, dots: [{ x, y, radius: 3 }] });

describe('bright-tip module', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    await h.kernel.stop();
  });

  it('publishes its status, with aspect and pen, before any tip event', async () => {
    await warm(h);
    h.scene.spec = dot(80, 45);
    await h.frame();
    const types = h.types();
    const firstTip = types.findIndex((t) => t.startsWith('tip.'));
    const firstStatus = types.indexOf('tracker.status');
    expect(firstStatus).toBeGreaterThanOrEqual(0);
    expect(firstStatus).toBeLessThan(firstTip);
    const status = h.events[firstStatus].payload as TrackerStatus;
    expect(status.aspect).toBeCloseTo(16 / 9, 5);
    expect(status.pen).toBe(false);
  });

  it('sends tip.found just before the sample of the same frame, in caster space', async () => {
    await warm(h);
    h.scene.spec = dot(80, 45);
    await h.frame();
    const tips = h.events.filter((e) => e.type.startsWith('tip.'));
    expect(tips.map((e) => e.type)).toEqual(['tip.found', 'tip.sample']);
    const [found, sample] = tips.map((e) => e.payload as { t: number; x: number; y: number; src: string; frame: number });
    expect(found.t).toBe(sample.t);
    expect(sample.t).toBe(h.clock.t); // the frame's capture time, not the time the worker ran
    expect(sample.src).toBe('tracker.bright-tip');
    expect(sample.x).toBeCloseTo(0.75, 2); // camera x 0.25, mirrored
    expect(sample.y).toBeCloseTo(0.25, 2);
    expect(typeof sample.frame).toBe('number');
  });

  it('closes every frame it hands to the worker and keeps one in flight', async () => {
    await warm(h, 5);
    // Two frames in the same task: the second arrives while the first is in flight and is dropped.
    h.kernel.emit('camera.frame', { t: h.clock.t + 1, timeSource: 'capture', frame: 900, generation: 1, width: W, height: H, video: {} as HTMLVideoElement }, 'capture.camera');
    h.kernel.emit('camera.frame', { t: h.clock.t + 2, timeSource: 'capture', frame: 901, generation: 1, width: W, height: H, video: {} as HTMLVideoElement }, 'capture.camera');
    await settle();
    expect(h.sources).toHaveLength(6);
    expect(h.sources.every((s) => s.closed)).toBe(true);
  });

  it('declares the tip lost with lastSeen, and again on stop', async () => {
    await warm(h);
    h.scene.spec = dot(160, 90);
    await h.frame();
    await h.frame();
    const lastSeen = h.clock.t;
    h.scene.spec = { width: W, height: H, noise: 3 };
    for (let i = 0; i < 6; i++) await h.frame();
    const lost = h.events.filter((e) => e.type === 'tip.lost');
    expect(lost).toHaveLength(1);
    expect(lost[0].payload).toMatchObject({ src: 'tracker.bright-tip', lastSeen, t: h.clock.t });

    h.scene.spec = dot(160, 90);
    await h.frame();
    const before = h.events.length;
    await h.kernel.stop();
    const after = h.events.slice(before).map((e) => e.type);
    expect(after).toContain('tip.lost');
    expect(h.stops).toContain('tracker.bright-tip');
    const status = h.events.filter((e) => e.type === 'tracker.status').at(-1)!.payload as TrackerStatus;
    expect(status.state).toBe('stopped');
    expect(status.hint).toBeNull();
  });

  it('loses the tip before a new camera generation and resets the worker', async () => {
    await warm(h);
    h.scene.spec = dot(160, 90);
    await h.frame();
    const before = h.events.length;
    h.generation = 2;
    h.kernel.emit('camera.ready', h.ready(2), 'capture.camera');
    await settle();
    const after = h.events.slice(before).map((e) => e.type);
    expect(after[0]).toBe('camera.ready');
    expect(after).toContain('tip.lost');
    expect(h.configs.some((c) => c.type === 'reset' && c.generation === 2)).toBe(true);
    // Frames of the old generation are ignored.
    h.generation = 1;
    const n = h.sources.length;
    await h.frame();
    expect(h.sources.length).toBe(n);
  });

  it('shows the tip-not-found hint after 3 s without a tip, and clears it when found', async () => {
    for (let i = 0; i < 100; i++) await h.frame(); // 3.3 s of an empty room
    h.kernel.emit('settings.changed', { key: 'noop', value: null });
    await h.frame();
    // The status timer runs every 500 ms; a state change also publishes. Force one through a found tip later.
    await new Promise((r) => setTimeout(r, 520));
    const statuses = h.events.filter((e) => e.type === 'tracker.status').map((e) => e.payload as TrackerStatus);
    expect(statuses.at(-1)!.hint).toBe('tip-not-found');
    h.scene.spec = dot(100, 100);
    await h.frame();
    const last = h.events.filter((e) => e.type === 'tracker.status').at(-1)!.payload as TrackerStatus;
    expect(last.state).toBe('tracking');
    expect(last.hint).toBeNull();
  });

  it('asks capture to step down after 2 s below 20 fps', async () => {
    // 10 fps for 6 s.
    for (let i = 0; i < 60; i++) await h.frame(100);
    expect(h.stepDowns).toHaveLength(1);
    expect(h.stepDowns[0]).toMatchObject({ requester: 'tracker.bright-tip' });
  });

  it('publishes debug frames while tracker.debug is on', async () => {
    await h.kernel.settings.set('tracker.debug', true);
    await warm(h, 10);
    const debug = h.events.filter((e) => e.type === 'tracker.debug');
    expect(debug.length).toBeGreaterThanOrEqual(2);
    const d = debug[0].payload as { tracker: string; image: ImageBitmap; threshold: number; blobs: unknown[] };
    expect(d.tracker).toBe('tracker.bright-tip');
    expect(d.image).toBeTruthy();
    expect(typeof d.threshold).toBe('number');
    // About 10 fps: 10 frames at 30 fps give 3 or 4 views.
    expect(debug.length).toBeLessThanOrEqual(5);
  });

  it('adapts its defaults for an infrared camera, but keeps values the player set', async () => {
    await h.kernel.settings.set('brightTip.profile', 'infrared');
    await settle();
    let cfg = h.configs.filter((c) => c.type === 'config').at(-1) as Extract<ToWorker, { type: 'config' }>;
    expect(cfg.config.floor).toBe(230);
    expect(cfg.config.k).toBe(5);
    await h.kernel.settings.set('brightTip.floor', 180);
    await settle();
    cfg = h.configs.filter((c) => c.type === 'config').at(-1) as Extract<ToWorker, { type: 'config' }>;
    expect(cfg.config.floor).toBe(180);
    expect(cfg.config.k).toBe(5);
  });

  it('relearns the static mask on request', async () => {
    await warm(h, 3);
    const done = h.kernel.request('tracker.relearn-mask');
    for (let i = 0; i < 40; i++) await h.frame();
    await expect(done).resolves.toBeUndefined();
  });

  it('autotunes: lowers the exposure until the room is dark, then sets k and the floor', async () => {
    // A bright room (background follows exposure time: 320 → 80). The tip comes into view after the
    // mask has warmed up and moves a little, as a held wand does (a perfectly still one is a lamp).
    h.scene.spec = { width: W, height: H, noise: 3, background: 80 };
    await warm(h, 36);
    const tipAt = (i: number) => [{ x: 100 + 10 * Math.cos(i / 4), y: 60 + 10 * Math.sin(i / 4), radius: 3, color: [255, 255, 255] as [number, number, number] }];
    h.scene.spec = { ...h.scene.spec, dots: tipAt(0) };
    await h.frame();
    const result = h.kernel.request<{ ok: boolean; message: string; k?: number; exposureTime?: number | null; contrast?: number }>('tracker.autotune');
    for (let i = 1; i < 200; i++) {
      h.scene.spec = { ...h.scene.spec, dots: tipAt(i) };
      await h.frame();
    }
    const r = await result;
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^Tuned/);
    expect(h.exposureCalls.length).toBeGreaterThan(2);
    // 320 → 160 → 80 → 40: background 10, nearly black.
    expect(r.exposureTime).toBeLessThanOrEqual(48);
    expect(h.kernel.settings.get('brightTip.k', 0)).toBe(r.k);
    expect(r.contrast).toBeGreaterThan(3);
  });
});

describe('bright-tip module with a track processor (the fast path)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness({ processor: true });
  });
  afterEach(async () => {
    await h.kernel.stop();
  });

  async function warmFeed(frames = 36): Promise<void> {
    for (let i = 0; i < frames; i++) await h.feedFrame();
  }

  it('reads frames from the camera track instead of the video, with capture times on the kernel clock', async () => {
    await warmFeed();
    h.scene.spec = dot(80, 45);
    await h.feedFrame();
    expect(h.sources).toHaveLength(0); // the video was never read
    const tips = h.events.filter((e) => e.type.startsWith('tip.'));
    expect(tips.map((e) => e.type)).toEqual(['tip.found', 'tip.sample']);
    const sample = tips[1].payload as { t: number; x: number; frame: number };
    // The processor's timestamps are on another clock; mapped back they give the capture time (plus
    // the smallest delivery delay, the same 2 ms for every frame here, so exactly the push time).
    expect(sample.t).toBeCloseTo(h.clock.t, 6);
    expect(sample.x).toBeCloseTo(0.75, 2);
    expect(sample.frame).toBe(36);
    expect(h.proc.read.every((f) => f.closed)).toBe(true);
  });

  it('keeps one frame in flight and takes the newest frame when the worker frees up', async () => {
    await warmFeed(3);
    const before = h.proc.read.length;
    // The feed is waiting, so a goes to the worker at once; b and c arrive while a is in flight, and
    // the processor keeps only the newest of them. (Compared by identity: a failed deep comparison of
    // frames holding pixel buffers takes minutes to print.)
    h.clock.t += 33;
    const a = h.proc.push(renderFrame({ ...h.scene.spec, seed: 91 }), h.clock.t);
    const b = h.proc.push(renderFrame({ ...h.scene.spec, seed: 92 }), h.clock.t + 1);
    const c = h.proc.push(renderFrame({ ...h.scene.spec, seed: 93 }), h.clock.t + 2);
    await settle(24);
    const taken = h.proc.read.slice(before);
    expect(taken.length).toBe(2);
    expect(taken[0] === a && taken[1] === c).toBe(true);
    expect(h.proc.read.includes(b)).toBe(false);
    expect([a.closed, b.closed, c.closed]).toEqual([true, true, true]);
    expect(flight.max).toBe(1);
  });

  it('falls back to the video when the track stops handing frames to the processor', async () => {
    await warmFeed(3);
    expect(h.sources).toHaveLength(0);
    // Capture keeps publishing camera.frame, but the processor delivers nothing for 2 s.
    for (let i = 0; i < 60; i++) await h.frame();
    expect(h.proc.cancelled).toBe(1);
    expect(h.sources.length).toBeGreaterThan(3);
    // From now on frames come from the video only, for this camera generation.
    const read = h.proc.read.length;
    await h.feedFrame();
    expect(h.proc.read.length).toBe(read);
  });

  it('keeps the fast path through a long main-thread task', async () => {
    await warmFeed(3);
    // Nothing ran for 2 s (the app starting up); then the video's callback runs before the processor's frame.
    await h.frame(2000);
    await h.feedFrame();
    await h.feedFrame();
    expect(h.proc.cancelled).toBe(0);
    expect(h.sources).toHaveLength(0);
  });

  it('opens a new processor for a new camera generation and cancels it on stop', async () => {
    await warmFeed(2);
    expect(h.proc.opened).toBe(1);
    h.generation = 2;
    h.kernel.emit('camera.ready', h.ready(2), 'capture.camera');
    await settle();
    expect(h.proc.cancelled).toBe(1);
    expect(h.proc.opened).toBe(2);
    await warmFeed(2);
    await h.kernel.stop();
    expect(h.proc.cancelled).toBe(2);
    // A frame that arrives after stop is never read.
    const late = h.proc.push(renderFrame(h.scene.spec), h.clock.t + 33);
    await settle();
    expect(h.proc.read.includes(late)).toBe(false);
  });
});

describe('bright-tip module without a camera', () => {
  it('starts promptly, waits for the camera and reports it in status', async () => {
    const h = await harness({ camera: false });
    const status = h.events.filter((e) => e.type === 'tracker.status').at(-1)!.payload as TrackerStatus;
    expect(status.state).toBe('starting');
    expect(status.message).toBe('Waiting for the camera');
    expect(h.kernel.modules().find((m) => m.manifest.id === 'tracker.bright-tip')?.state).toBe('running');
    // Capture recovers later and publishes camera.ready: the tracker binds to it.
    h.kernel.emit('camera.ready', h.ready(1), 'capture.camera');
    h.kernel.emit('camera.status', { state: 'on', generation: 1, permission: 'granted' }, 'capture.camera');
    await warm(h);
    h.scene.spec = dot(80, 45);
    await h.frame();
    expect(h.types()).toContain('tip.found');
    await h.kernel.stop();
  });
});
