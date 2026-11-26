import { describe, expect, it, vi } from 'vitest';
import type { FrameImage, FromWorker, ToWorker } from './protocol';
import type { Rect } from './wand';
import { renderScene } from './wand-scene';
import { createWorkerCore, firstHand, frameSize, wireOf, type LandmarkerLike, type WorkerCoreDeps } from './worker-core';

const BASE = 'https://app.test/models/wasm';
const FILES = { wasmLoaderPath: `${BASE}/vision_wasm_module_internal.js`, wasmBinaryPath: `${BASE}/vision_wasm_module_internal.wasm` };
const MODEL_URL = 'https://app.test/models/hand_landmarker.task';

const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
/** Shaped like hand_landmarker.task: a ZIP entry and the end-of-central-directory record. */
const MODEL = new Uint8Array([0, 0, 0x50, 0x4b, 0x03, 0x04, 20, 0, 0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
const LOADER = new TextEncoder().encode(`async function ModuleFactory(){}\n${'// x\n'.repeat(300)}export default ModuleFactory;`);

function landmarks(tipX = 0.3) {
  return Array.from({ length: 21 }, (_, i) => ({ x: i === 8 ? tipX : 0.5, y: i === 8 ? 0.4 : 0.7, z: -0.01 * i, visibility: 0 }));
}

interface Setup {
  deps: WorkerCoreDeps;
  posted: { msg: FromWorker; transfer?: Transferable[] }[];
  detectTimes: number[];
  /** What the model was given, and whether it was still open then. */
  detected: { image: unknown; open: boolean }[];
  created: Parameters<WorkerCoreDeps['createLandmarker']>[0][];
  revoked: string[];
  scene: { hand: boolean; throwOnDetect: boolean };
  landmarker: LandmarkerLike & { closed: boolean };
}

function setup(opts: { files?: Record<string, Response | 'throw'>; createFails?: string } = {}): Setup {
  const posted: Setup['posted'] = [];
  const detectTimes: number[] = [];
  const detected: Setup['detected'] = [];
  const created: Setup['created'] = [];
  const revoked: string[] = [];
  const scene = { hand: true, throwOnDetect: false };
  const landmarker = {
    closed: false,
    detectForVideo(img: FrameImage | ImageData, ts: number) {
      detectTimes.push(ts);
      const close = (img as { close?: ReturnType<typeof vi.fn> }).close;
      detected.push({ image: img, open: !close || close.mock.calls.length === 0 });
      if (scene.throwOnDetect) throw new Error('WebGL context lost');
      return scene.hand ? { landmarks: [landmarks()], handedness: [[{ score: 0.93, categoryName: 'Left' }]] } : { landmarks: [], handedness: [] };
    },
    close() {
      this.closed = true;
    },
  };
  const responses: Record<string, Response | 'throw'> = {
    [FILES.wasmLoaderPath]: new Response(LOADER, { headers: { 'content-type': 'text/javascript' } }),
    [FILES.wasmBinaryPath]: new Response(WASM, { headers: { 'content-type': 'application/wasm' } }),
    [MODEL_URL]: new Response(MODEL),
    ...opts.files,
  };
  let clock = 0;
  const deps: WorkerCoreDeps = {
    fetch: async (url) => {
      const r = responses[url];
      if (r === 'throw') throw new TypeError('Failed to fetch');
      return r ?? new Response('', { status: 404 });
    },
    fileset: async (base) => ({ wasmLoaderPath: `${base}/vision_wasm_module_internal.js`, wasmBinaryPath: `${base}/vision_wasm_module_internal.wasm` }),
    createLandmarker: async (o) => {
      created.push(o);
      if (opts.createFails) throw new Error(opts.createFails);
      return landmarker;
    },
    objectUrl: () => 'blob:https://app.test/wasm-1',
    revokeUrl: (url) => revoked.push(url),
    post: (msg, transfer) => posted.push({ msg, transfer }),
    preview: (_b, flipX) => ({ width: 320, height: 180, flipX, close: vi.fn() }) as unknown as ImageBitmap,
    now: () => (clock += 4),
  };
  return { deps, posted, detectTimes, detected, created, revoked, scene, landmarker };
}

const load = (delegate: 'GPU' | 'CPU' = 'GPU'): ToWorker => ({ type: 'load', run: 1, wasmBaseUrl: `${BASE}/`, modelUrl: MODEL_URL, delegate });

function bitmap() {
  return { width: 640, height: 360, close: vi.fn() } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

/** A camera track's frame (the fast path): sized by displayWidth and displayHeight, as MediaPipe does. */
function videoFrame() {
  return { displayWidth: 1920, displayHeight: 1080, codedWidth: 1920, codedHeight: 1088, timestamp: 9e9, close: vi.fn() } as unknown as VideoFrame & { close: ReturnType<typeof vi.fn> };
}

function frameMsg(t: number, image: FrameImage = bitmap(), preview = false, seq = 41): ToWorker {
  return { type: 'frame', run: 1, seq, generation: 2, t, frame: 7, width: 1920, height: 1080, image, preview, flipX: true };
}

describe('hand worker core', () => {
  it('downloads the three files with progress, then starts the landmarker from the downloaded bytes', async () => {
    const s = setup();
    const core = createWorkerCore(s.deps);
    await core.handle(load());
    const types = s.posted.map((p) => p.msg.type);
    expect(types.filter((t) => t === 'progress').length).toBeGreaterThan(0);
    expect(types.at(-1)).toBe('ready');
    expect(s.posted.at(-1)!.msg).toMatchObject({ type: 'ready', run: 1, delegate: 'GPU' });
    expect(s.created).toHaveLength(1);
    // The module variant, the WASM from the bytes already downloaded (a blob: URL), the model as bytes.
    expect(s.created[0]).toEqual({ wasmLoaderPath: FILES.wasmLoaderPath, wasmBinaryPath: 'blob:https://app.test/wasm-1', model: MODEL, delegate: 'GPU' });
    expect(s.revoked).toEqual(['blob:https://app.test/wasm-1']);
  });

  it('reports a missing model plainly', async () => {
    const s = setup({ files: { [MODEL_URL]: new Response('<!doctype html><p>app</p>', { headers: { 'content-type': 'text/html' } }) } });
    await createWorkerCore(s.deps).handle(load());
    expect(s.posted.at(-1)!.msg).toMatchObject({ type: 'failed', reason: 'missing', message: 'Hand model not installed. Run npm run models.' });
    expect(s.created).toHaveLength(0);
  });

  it('reports a missing runtime the same way, and an offline download differently', async () => {
    const gone = setup({ files: { [FILES.wasmBinaryPath]: new Response('', { status: 404 }) } });
    await createWorkerCore(gone.deps).handle(load());
    expect(gone.posted.at(-1)!.msg).toMatchObject({ type: 'failed', reason: 'missing' });
    const offline = setup({ files: { [MODEL_URL]: 'throw' } });
    await createWorkerCore(offline.deps).handle(load());
    expect(offline.posted.at(-1)!.msg).toMatchObject({ type: 'failed', reason: 'unreachable' });
  });

  it('warms the model up on a blank image before saying ready, at timestamp 0', async () => {
    const s = setup();
    const blank = { width: 640, height: 360 } as ImageData;
    s.deps.warmupImage = () => blank;
    const core = createWorkerCore(s.deps);
    await core.handle(load());
    expect(s.detectTimes).toEqual([0]);
    expect(s.posted.at(-1)!.msg.type).toBe('ready');
    // Real frames come after it.
    await core.handle(frameMsg(0.2));
    expect(s.detectTimes).toEqual([0, 1]);
  });

  it('fails loading when the warm-up detection fails, so the CPU retry can take over', async () => {
    const s = setup();
    s.scene.throwOnDetect = true;
    s.deps.warmupImage = () => ({ width: 640, height: 360 }) as ImageData;
    await createWorkerCore(s.deps).handle(load());
    expect(s.posted.at(-1)!.msg).toMatchObject({ type: 'failed', reason: 'runtime', detail: 'WebGL context lost' });
    expect(s.landmarker.closed).toBe(true);
  });

  it('reports a delegate that will not start as a runtime failure', async () => {
    const s = setup({ createFails: 'Unable to create a WebGL2 context' });
    await createWorkerCore(s.deps).handle(load());
    expect(s.posted.at(-1)!.msg).toMatchObject({ type: 'failed', reason: 'runtime', detail: 'Unable to create a WebGL2 context' });
    expect(s.revoked).toHaveLength(1);
  });

  it('detects a frame, returns the hand and closes the bitmap', async () => {
    const s = setup();
    const core = createWorkerCore(s.deps);
    await core.handle(load());
    const b = bitmap();
    await core.handle(frameMsg(1000.4, b));
    const out = s.posted.at(-1)!.msg;
    // The frame's own seq comes back with its answer (the tracker matches answers to the frame it waits for).
    expect(out).toMatchObject({ type: 'result', run: 1, seq: 41, generation: 2, t: 1000.4, frame: 7, width: 1920, height: 1080, stepMs: 4 });
    const hand = (out as Extract<FromWorker, { type: 'result' }>).hand!;
    expect(hand.points).toHaveLength(63);
    expect(hand.points.slice(24, 26)).toEqual([0.3, 0.4]);
    expect(hand).toMatchObject({ score: 0.93, label: 'Left' });
    expect(b.close).toHaveBeenCalled();
    s.scene.hand = false;
    await core.handle(frameMsg(1033.7));
    expect((s.posted.at(-1)!.msg as Extract<FromWorker, { type: 'result' }>).hand).toBeNull();
  });

  it('feeds MediaPipe strictly increasing whole-millisecond timestamps', async () => {
    const s = setup();
    const core = createWorkerCore(s.deps);
    await core.handle(load());
    for (const t of [1000.2, 1000.4, 1033.6, 1033.6, 1020, 1066.9]) await core.handle(frameMsg(t));
    expect(s.detectTimes).toEqual([1000, 1001, 1034, 1035, 1036, 1067]);
    // The capture times themselves travel back untouched.
    expect(s.posted.filter((p) => p.msg.type === 'result').map((p) => (p.msg as { t: number }).t)).toEqual([1000.2, 1000.4, 1033.6, 1033.6, 1020, 1066.9]);
  });

  it('transfers a mirrored preview when asked', async () => {
    const s = setup();
    const core = createWorkerCore(s.deps);
    await core.handle(load());
    await core.handle(frameMsg(1000, bitmap(), true));
    const last = s.posted.at(-1)!;
    const preview = (last.msg as Extract<FromWorker, { type: 'result' }>).preview as unknown as { flipX: boolean };
    expect(preview.flipX).toBe(true);
    expect(last.transfer).toEqual([preview]);
  });

  it('reports detection errors and still closes the bitmap', async () => {
    const s = setup();
    const core = createWorkerCore(s.deps);
    await core.handle(load());
    s.scene.throwOnDetect = true;
    const b = bitmap();
    await core.handle(frameMsg(1000, b, false, 42));
    expect(s.posted.at(-1)!.msg).toMatchObject({ type: 'error', run: 1, seq: 42, generation: 2, message: 'WebGL context lost' });
    expect(b.close).toHaveBeenCalled();
  });

  it("detects the camera track's VideoFrame as it is, then closes it", async () => {
    const s = setup();
    const core = createWorkerCore(s.deps);
    await core.handle(load());
    const f = videoFrame();
    await core.handle(frameMsg(1000.4, f, true));
    // The frame itself, still open while the model read it; closed once, after it and the preview.
    expect(s.detected).toHaveLength(1);
    expect(s.detected[0].image === f && s.detected[0].open).toBe(true);
    expect(f.close).toHaveBeenCalledTimes(1);
    const out = s.posted.at(-1)!.msg as Extract<FromWorker, { type: 'result' }>;
    expect(out).toMatchObject({ type: 'result', t: 1000.4, frame: 7, width: 1920, height: 1080 });
    expect(out.hand).not.toBeNull();
    expect(out.preview).toBeTruthy();
  });

  it('closes a VideoFrame when detection fails, and when no model is loaded', async () => {
    const s = setup();
    const core = createWorkerCore(s.deps);
    const early = videoFrame();
    await core.handle(frameMsg(900, early, false, 3));
    expect(early.close).toHaveBeenCalledTimes(1);
    expect(s.posted.at(-1)!.msg).toMatchObject({ type: 'error', seq: 3, message: 'The hand model is not loaded yet.' });
    await core.handle(load());
    s.scene.throwOnDetect = true;
    const f = videoFrame();
    await core.handle(frameMsg(1000, f));
    expect(s.posted.at(-1)!.msg).toMatchObject({ type: 'error', run: 1, generation: 2, message: 'WebGL context lost' });
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the detection when the preview fails, and closes the frame', async () => {
    const s = setup();
    s.deps.preview = () => {
      throw new Error('no 2d context');
    };
    const core = createWorkerCore(s.deps);
    await core.handle(load());
    const f = videoFrame();
    await core.handle(frameMsg(1000, f, true));
    const out = s.posted.at(-1)!.msg as Extract<FromWorker, { type: 'result' }>;
    expect(out.type).toBe('result');
    expect(out.hand).not.toBeNull();
    expect(out.preview).toBeUndefined();
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('closes frames that arrive before the model, and the landmarker on close', async () => {
    const s = setup();
    const core = createWorkerCore(s.deps);
    const early = bitmap();
    await core.handle(frameMsg(900, early));
    expect(early.close).toHaveBeenCalled();
    expect(s.posted.at(-1)!.msg.type).toBe('error');
    await core.handle(load());
    await core.handle({ type: 'close', run: 1 });
    expect(s.landmarker.closed).toBe(true);
  });
});

describe('frameSize', () => {
  it("reads a VideoFrame's display size and an ImageBitmap's own", () => {
    expect(frameSize(videoFrame())).toEqual({ width: 1920, height: 1080 });
    expect(frameSize(bitmap())).toEqual({ width: 640, height: 360 });
  });
});

describe('firstHand', () => {
  it('keeps the fingertip presence when the model reports one', () => {
    const lms = landmarks();
    (lms[8] as { presence?: number }).presence = 0.77;
    expect(firstHand({ landmarks: [lms], handedness: [[{ score: 0.9, categoryName: 'Right' }]] })!.tipPresence).toBe(0.77);
    expect(firstHand({ landmarks: [], handedness: [] })).toBeNull();
    expect(firstHand({ landmarks: [landmarks().slice(0, 5)], handedness: [] })).toBeNull();
  });
});

describe('hand worker core: wand mode', () => {
  /** A fist holding a wand on a 1080p frame (wand-scene.ts), as the model and the pixels see it. */
  const scene = renderScene({
    width: 1920, height: 1080, hand: { x: 960, y: 800, palm: 110, angle: -Math.PI / 2 - 0.2 },
    wand: { angle: -2.0, length: 2.6 }, background: 'room',
  });
  const sceneLandmarks = Array.from({ length: 21 }, (_, i) => ({ x: scene.normalized[i * 3], y: scene.normalized[i * 3 + 1], z: 0 }));
  function plane(rect: Rect) {
    const data = new Uint8Array(rect.width * rect.height);
    for (let y = 0; y < rect.height; y++) data.set(scene.data.subarray((rect.y + y) * 1920 + rect.x, (rect.y + y) * 1920 + rect.x + rect.width), y * rect.width);
    return { data, width: rect.width, height: rect.height, stride: rect.width, x0: rect.x, y0: rect.y };
  }

  async function ready(read: WorkerCoreDeps['readLuma']) {
    const s = setup();
    s.deps.readLuma = read;
    const core = createWorkerCore(s.deps);
    await core.handle(load());
    s.landmarker.detectForVideo = (img: FrameImage | ImageData) => {
      s.detected.push({ image: img, open: true });
      return s.scene.hand ? { landmarks: [sceneLandmarks], handedness: [[{ score: 0.93, categoryName: 'Left' }]] } : { landmarks: [], handedness: [] };
    };
    return { s, core };
  }
  const wandMsg = (image: FrameImage): ToWorker => ({ ...(frameMsg(100, image) as Extract<ToWorker, { type: 'frame' }>), wand: { prior: null } });
  const result = (s: Setup) => s.posted.at(-1)!.msg as Extract<FromWorker, { type: 'result' }>;

  it('reads the pixels around the hand before the frame is closed, and finds the wand', async () => {
    const reads: { rect: Rect; open: boolean }[] = [];
    const image = videoFrame();
    const { s, core } = await ready(async (_img, rect) => {
      reads.push({ rect, open: image.close.mock.calls.length === 0 });
      return plane(rect);
    });
    await core.handle(wandMsg(image));
    expect(reads).toHaveLength(1);
    expect(reads[0].open).toBe(true);
    expect(image.close).toHaveBeenCalledTimes(1);
    const r = result(s);
    expect(r.hand).not.toBeNull();
    expect(r.wand).toBeTruthy();
    // In the landmarks' units: normalized to the frame, unmirrored.
    expect(Math.hypot((r.wand!.tip[0] - scene.tip!.x / 1920) * 1920, (r.wand!.tip[1] - scene.tip!.y / 1080) * 1080)).toBeLessThan(11);
    expect(r.wand!.quality).toBeGreaterThan(0.5);
    expect(typeof r.wandMs).toBe('number');
  });

  it('does nothing of the sort outside wand mode', async () => {
    const read = vi.fn();
    const { s, core } = await ready(read);
    await core.handle(frameMsg(100, videoFrame()));
    expect(read).not.toHaveBeenCalled();
    expect('wand' in result(s)).toBe(false);
  });

  it('loses only the wand when the pixels cannot be read, and reads nothing without a hand', async () => {
    const failing = await ready(async () => {
      throw new Error('copyTo refused');
    });
    await failing.core.handle(wandMsg(videoFrame()));
    expect(result(failing.s).hand).not.toBeNull();
    expect(result(failing.s).wand).toBeNull();

    const read = vi.fn(async (_img: FrameImage, rect: Rect) => plane(rect));
    const empty = await ready(read);
    empty.s.scene.hand = false;
    await empty.core.handle(wandMsg(videoFrame()));
    expect(read).not.toHaveBeenCalled();
    expect(result(empty.s)).toMatchObject({ hand: null, wand: null });
  });

  it('turns a find into the wire', () => {
    expect(wireOf(null, 100, 100)).toBeNull();
    const w = wireOf({ tip: { x: 50, y: 25 }, base: { x: 10, y: 20 }, quality: 0.8, contrast: 40, length: 2, support: 0.9, cut: false, glint: { x: 51, y: 24 }, search: 'prior' }, 100, 50)!;
    expect(w).toEqual({ tip: [0.5, 0.5], base: [0.1, 0.4], quality: 0.8, contrast: 40, length: 2, cut: false, search: 'prior', glint: [0.51, 0.48] });
  });
});
