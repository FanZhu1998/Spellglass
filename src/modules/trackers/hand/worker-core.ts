// The hand worker's logic, with MediaPipe and the browser injected so it runs in tests without either.
// worker.ts wires the real @mediapipe/tasks-vision HandLandmarker in.
//
// Loading (one 'load' per worker; a CPU retry gets a fresh worker, because MediaPipe's loader hands its
// module factory over once and a second task in the same worker would find none):
//   1. the fileset for the module variant (FilesetResolver.forVisionTasks(base, true)), which a module
//      worker loads with import(): the classic variant needs importScripts, which module workers lack;
//   2. the loader script, the WASM binary and the model, downloaded together with progress (assets.ts);
//   3. HandLandmarker in VIDEO mode, one hand, on the requested delegate. The WASM binary is handed over
//      as a blob: URL of the bytes already downloaded, so it is not fetched twice, and the model as bytes;
//   4. one warm-up detection on a blank image before saying 'ready'. The first detection compiles the GPU
//      programs and took 4.9 s in Chrome on an integrated AMD GPU; done here, that wait shows as loading,
//      not as a frozen trail, and a delegate that fails on its first frame fails while loading, where the
//      CPU retry can still take over.
// Frames: detectForVideo needs strictly increasing timestamps, so each frame's capture time is rounded to
// whole milliseconds and nudged past the previous one when two frames share a millisecond. A frame is a
// VideoFrame from the camera track or an ImageBitmap of the video (protocol.ts FrameImage); MediaPipe
// 1.2.3 takes both (a VideoFrame sized by its displayWidth, measured in the latency study), and whole
// 1080p VideoFrames ran on both delegates. Each one is closed as soon as the model is done with it (in
// wand mode, once the pixels around the hand have been read for the wand finder, wand.ts), on every path:
// an open VideoFrame holds one of the camera's few buffers, and the camera stalls when they run out.

import { AssetError, downloadAll, type AssetRequest } from './assets';
import type { Delegate, FrameImage, FromWorker, HandWire, ToWorker, WandWire } from './protocol';
import { gripFrame, WandFinder, wandRegion, type LumaPlane, type Rect, type WandFound } from './wand';

/** What the core needs from a HandLandmarker (a subset of @mediapipe/tasks-vision's). */
export interface LandmarkerLike {
  detectForVideo(image: FrameImage | ImageData, timestamp: number): {
    landmarks: { x: number; y: number; z: number; presence?: number }[][];
    handedness: { score: number; categoryName: string }[][];
  };
  close(): void;
}

export interface WorkerCoreDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** FilesetResolver.forVisionTasks(base, true). */
  fileset(base: string): Promise<{ wasmLoaderPath: string; wasmBinaryPath: string }>;
  /** HandLandmarker.createFromOptions with the given files and delegate. */
  createLandmarker(opts: { wasmLoaderPath: string; wasmBinaryPath: string; model: Uint8Array; delegate: Delegate }): Promise<LandmarkerLike>;
  /** URL.createObjectURL / revokeObjectURL. */
  objectUrl(bytes: Uint8Array, type: string): string;
  revokeUrl(url: string): void;
  post(msg: FromWorker, transfer?: Transferable[]): void;
  /** A small copy of the frame in caster orientation for 'tracker.debug', or null. */
  preview?(image: FrameImage, flipX: boolean): ImageBitmap | null;
  /** A blank image for the warm-up detection, or null to skip it. */
  warmupImage?(): ImageBitmap | ImageData | null;
  /** Wand mode: the brightness of a rectangle of the frame (luma.ts), or null when it cannot be read.
   *  Absent: wand mode finds no wand (the tracker then guesses past the knuckles). */
  readLuma?(image: FrameImage, rect: Rect): Promise<LumaPlane | null>;
  /** performance.now(), for stepMs only. */
  now(): number;
}

export interface WorkerCore {
  handle(msg: ToWorker): Promise<void>;
}

export function createWorkerCore(deps: WorkerCoreDeps): WorkerCore {
  let landmarker: LandmarkerLike | null = null;
  let loading = false;
  let lastTs = -Infinity;
  const finder = new WandFinder();

  async function load(msg: Extract<ToWorker, { type: 'load' }>): Promise<void> {
    if (loading || landmarker) return;
    loading = true;
    const started = deps.now();
    const { run } = msg;
    let files: { wasmLoaderPath: string; wasmBinaryPath: string };
    try {
      files = await deps.fileset(msg.wasmBaseUrl.replace(/\/+$/, ''));
    } catch (err) {
      deps.post({ type: 'failed', run, reason: 'runtime', message: 'Hand tracking could not start in this browser.', detail: text(err) });
      return;
    }
    const reqs: AssetRequest[] = [
      { kind: 'loader', url: files.wasmLoaderPath },
      { kind: 'wasm', url: files.wasmBinaryPath },
      { kind: 'model', url: msg.modelUrl },
    ];
    let bytes: Uint8Array[];
    try {
      bytes = await downloadAll(deps.fetch, reqs, (p) => deps.post({ type: 'progress', run, loaded: p.loaded, total: p.total }));
    } catch (err) {
      if (err instanceof AssetError) deps.post({ type: 'failed', run, reason: err.reason, message: err.message, detail: err.detail });
      else deps.post({ type: 'failed', run, reason: 'unreachable', message: 'The hand model could not be downloaded. Check the connection, then try again.', detail: text(err) });
      return;
    }
    const [, wasm, model] = bytes;
    const wasmUrl = deps.objectUrl(wasm, 'application/wasm');
    let created: LandmarkerLike | null = null;
    try {
      created = await deps.createLandmarker({ wasmLoaderPath: files.wasmLoaderPath, wasmBinaryPath: wasmUrl, model, delegate: msg.delegate });
      warmUp(created);
      landmarker = created;
      deps.post({ type: 'ready', run, delegate: msg.delegate, loadMs: Math.round(deps.now() - started) });
    } catch (err) {
      try {
        created?.close();
      } catch {
        /* a broken graph */
      }
      deps.post({ type: 'failed', run, reason: 'runtime', message: 'Hand tracking could not start in this browser.', detail: text(err) });
    } finally {
      deps.revokeUrl(wasmUrl);
    }
  }

  /** Step 4: one detection on a blank image at timestamp 0, before any camera frame (whose capture times
   *  are later on the kernel clock, so the timestamps stay increasing). Throws when the delegate fails. */
  function warmUp(l: LandmarkerLike): void {
    const image = deps.warmupImage?.();
    if (!image) return;
    try {
      l.detectForVideo(image, 0);
      lastTs = 0;
    } finally {
      if ('close' in image && typeof image.close === 'function') image.close();
    }
  }

  async function frame(msg: Extract<ToWorker, { type: 'frame' }>): Promise<void> {
    // seq goes back with the answer, whichever it is: the tracker frees its one slot only for the frame
    // it is waiting for (protocol.ts).
    const { run, seq, generation, t, frame: n, width, height, image } = msg;
    let hand: HandWire | null = null;
    let stepMs = 0;
    let preview: ImageBitmap | null = null;
    let wand: WandWire | null | undefined;
    let wandMs: number | undefined;
    try {
      if (!landmarker) {
        deps.post({ type: 'error', run, seq, generation, message: 'The hand model is not loaded yet.' });
        return;
      }
      // Strictly increasing whole-millisecond timestamps (MediaPipe's graph rejects repeats).
      const ts = Math.max(Math.round(t), Number.isFinite(lastTs) ? lastTs + 1 : -Infinity);
      lastTs = ts;
      try {
        const began = deps.now();
        const result = landmarker.detectForVideo(image, ts);
        stepMs = deps.now() - began;
        hand = firstHand(result);
      } catch (err) {
        deps.post({ type: 'error', run, seq, generation, message: text(err) });
        return;
      }
      // Wand mode: the pixels around the hand, read before the frame is closed. A failure here costs the
      // wand for this frame, never the hand.
      if (msg.wand) {
        wand = null;
        if (hand && deps.readLuma) {
          const began = deps.now();
          try {
            wand = await findWand(image, hand, msg.wand.prior);
          } catch {
            wand = null;
          }
          wandMs = Math.round((deps.now() - began) * 100) / 100;
        }
      }
      // The preview is only a view for the tuning screen: when it fails, the detection still counts.
      if (msg.preview && deps.preview) {
        try {
          preview = deps.preview(image, msg.flipX);
        } catch {
          preview = null;
        }
      }
    } finally {
      // Every path closes the frame: by now detectForVideo (synchronous), the wand's read and the preview
      // have read it, or it never reached them.
      closeImage(image);
    }
    const out: FromWorker = { type: 'result', run, seq, generation, t, frame: n, width, height, hand, stepMs: Math.round(stepMs * 100) / 100 };
    if (wand !== undefined) {
      out.wand = wand;
      if (wandMs !== undefined) out.wandMs = wandMs;
    }
    if (preview) {
      out.preview = preview;
      deps.post(out, [preview]);
    } else {
      deps.post(out);
    }
  }

  /** Wand mode, one frame: the region around the hand (wand.ts wandRegion) at the frame's own size, its
   *  brightness, the finder; the find in the landmarks' units (normalized, unmirrored). */
  async function findWand(image: FrameImage, hand: HandWire, prior: { a: number; b: number } | null): Promise<WandWire | null> {
    const size = frameSize(image);
    if (!(size.width > 0 && size.height > 0)) return null;
    const px: number[] = [];
    for (let i = 0; i < 21; i++) px.push(hand.points[i * 3] * size.width, hand.points[i * 3 + 1] * size.height);
    const rect = wandRegion(gripFrame(px, 2, 1, 1), size.width, size.height);
    const plane = await deps.readLuma!(image, rect);
    if (!plane) return null;
    return wireOf(finder.find(plane, px, prior), size.width, size.height);
  }

  return {
    async handle(msg) {
      switch (msg.type) {
        case 'load':
          await load(msg);
          return;
        case 'frame':
          await frame(msg);
          return;
        case 'close':
          try {
            landmarker?.close();
          } catch {
            /* closing a broken graph */
          }
          landmarker = null;
          return;
      }
    },
  };
}

/** The first detected hand, flattened for the wire. */
export function firstHand(result: ReturnType<LandmarkerLike['detectForVideo']>): HandWire | null {
  const lms = result.landmarks?.[0];
  if (!lms || lms.length < 21) return null;
  const points: number[] = [];
  for (let i = 0; i < 21; i++) {
    const p = lms[i];
    points.push(r5(p.x), r5(p.y), r5(p.z));
  }
  const cat = result.handedness?.[0]?.[0];
  const hand: HandWire = { points, score: typeof cat?.score === 'number' ? cat.score : 0, label: cat?.categoryName ?? '' };
  const presence = lms[8]?.presence;
  if (typeof presence === 'number' && presence > 0) hand.tipPresence = presence;
  return hand;
}

/** A find in frame pixels to the wire's units (normalized to the frame, like the landmarks). */
export function wireOf(f: WandFound | null, width: number, height: number): WandWire | null {
  if (!f) return null;
  const nx = (x: number) => r5(x / width), ny = (y: number) => r5(y / height);
  const wire: WandWire = {
    tip: [nx(f.tip.x), ny(f.tip.y)],
    base: [nx(f.base.x), ny(f.base.y)],
    quality: f.quality,
    contrast: f.contrast,
    length: f.length,
    cut: f.cut,
    search: f.search,
  };
  if (f.glint) wire.glint = [nx(f.glint.x), ny(f.glint.y)];
  return wire;
}

/** The size a frame shows at: a VideoFrame's display size (what MediaPipe sizes it by), an ImageBitmap's
 *  own. */
export function frameSize(image: FrameImage): { width: number; height: number } {
  if ('displayWidth' in image) return { width: image.displayWidth, height: image.displayHeight };
  return { width: image.width, height: image.height };
}

/** Closing twice, or a frame already given away, is not an error. */
function closeImage(image: FrameImage): void {
  try {
    image.close();
  } catch {
    /* already closed */
  }
}

function r5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

function text(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}
