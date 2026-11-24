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
// whole milliseconds and nudged past the previous one when two frames share a millisecond.

import { AssetError, downloadAll, type AssetRequest } from './assets';
import type { Delegate, FromWorker, HandWire, ToWorker } from './protocol';

/** What the core needs from a HandLandmarker (a subset of @mediapipe/tasks-vision's). */
export interface LandmarkerLike {
  detectForVideo(image: ImageBitmap | ImageData, timestamp: number): {
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
  preview?(bitmap: ImageBitmap, flipX: boolean): ImageBitmap | null;
  /** A blank image for the warm-up detection, or null to skip it. */
  warmupImage?(): ImageBitmap | ImageData | null;
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

  function frame(msg: Extract<ToWorker, { type: 'frame' }>): void {
    const { run, generation, t, frame: n, width, height, bitmap } = msg;
    if (!landmarker) {
      bitmap.close();
      deps.post({ type: 'error', run, generation, message: 'The hand model is not loaded yet.' });
      return;
    }
    // Strictly increasing whole-millisecond timestamps (MediaPipe's graph rejects repeats).
    const ts = Math.max(Math.round(t), Number.isFinite(lastTs) ? lastTs + 1 : -Infinity);
    lastTs = ts;
    let hand: HandWire | null = null;
    let stepMs = 0;
    let preview: ImageBitmap | null = null;
    try {
      const began = deps.now();
      const result = landmarker.detectForVideo(bitmap, ts);
      stepMs = deps.now() - began;
      hand = firstHand(result);
      if (msg.preview && deps.preview) preview = deps.preview(bitmap, msg.flipX);
    } catch (err) {
      bitmap.close();
      deps.post({ type: 'error', run, generation, message: text(err) });
      return;
    }
    bitmap.close();
    const out: FromWorker = { type: 'result', run, generation, t, frame: n, width, height, hand, stepMs: Math.round(stepMs * 100) / 100 };
    if (preview) {
      out.preview = preview;
      deps.post(out, [preview]);
    } else {
      deps.post(out);
    }
  }

  return {
    async handle(msg) {
      switch (msg.type) {
        case 'load':
          await load(msg);
          return;
        case 'frame':
          frame(msg);
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

function r5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

function text(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}
