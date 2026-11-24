// The hand worker (Section 5, "Threads": the hand model, when used, gets its own worker). Started by the
// module as
//   new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'hand' })
// so Vite bundles it, with @mediapipe/tasks-vision, as its own chunk: the app's first download does not
// carry the hand tracker (Section 2 target: 3 MB or less before the optional hand model).
// All logic is in worker-core.ts; this file only connects it to MediaPipe and the worker scope.

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { restrictNetwork } from './guard';
import type { ToWorker } from './protocol';
import { createWorkerCore, frameSize, type LandmarkerLike } from './worker-core';

/** The parts of DedicatedWorkerGlobalScope used here (the project compiles against the DOM library). */
interface WorkerScope {
  location: { href: string; origin: string };
  fetch: typeof fetch;
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ToWorker>) => void): void;
}

const scope = self as unknown as WorkerScope;

// Before any task exists: MediaPipe's usage logger must find the network closed (guard.ts). Importing
// MediaPipe above runs no request; tasks are only created after this line. Each refused origin is noted
// once in the console, so anyone checking the network can see why the request never left.
const noted = new Set<string>();
restrictNetwork(scope as unknown as Parameters<typeof restrictNetwork>[0], (url) => {
  let origin = url;
  try {
    origin = new URL(url, scope.location.href).origin;
  } catch {
    /* keep the raw text */
  }
  if (noted.has(origin)) return;
  noted.add(origin);
  console.info(`[tracker.hand] kept a request to ${origin} from leaving the device (Spellglass sends nothing off the device).`);
});

let previewCanvas: OffscreenCanvas | null = null;
const PREVIEW_WIDTH = 320;

const core = createWorkerCore({
  fetch: (url, init) => scope.fetch(url, init),
  fileset: (base) => FilesetResolver.forVisionTasks(base, true),
  createLandmarker: async ({ wasmLoaderPath, wasmBinaryPath, model, delegate }) =>
    (await HandLandmarker.createFromOptions(
      { wasmLoaderPath, wasmBinaryPath },
      {
        baseOptions: { modelAssetBuffer: model, delegate },
        runningMode: 'VIDEO',
        numHands: 1,
      },
    )) as unknown as LandmarkerLike,
  objectUrl: (bytes, type) => URL.createObjectURL(new Blob([bytes as BlobPart], { type })),
  revokeUrl: (url) => URL.revokeObjectURL(url),
  post: (msg, transfer = []) => scope.postMessage(msg, transfer),
  // The frame is a VideoFrame from the camera track (at the camera's size) or the video's ImageBitmap;
  // drawImage takes either, and frameSize reads a VideoFrame's display size.
  preview: (image, flipX) => {
    if (typeof OffscreenCanvas !== 'function') return null;
    const size = frameSize(image);
    if (!(size.width > 0 && size.height > 0)) return null;
    const w = Math.min(PREVIEW_WIDTH, size.width);
    const h = Math.max(1, Math.round((w * size.height) / size.width));
    if (!previewCanvas || previewCanvas.width !== w || previewCanvas.height !== h) previewCanvas = new OffscreenCanvas(w, h);
    const g = previewCanvas.getContext('2d');
    if (!g) return null;
    g.setTransform(1, 0, 0, 1, 0, 0);
    // Caster orientation (contracts/events.ts TrackerDebugFrame): mirrored like the reflection.
    if (flipX) g.setTransform(-1, 0, 0, 1, w, 0);
    g.drawImage(image, 0, 0, w, h);
    return previewCanvas.transferToImageBitmap();
  },
  // A blank frame for the warm-up detection (worker-core.ts), the size of the bitmaps the 'camera.frame'
  // path feeds (640 x 360). After it, the fast path's first camera-sized VideoFrames took 20 to 60 ms on
  // the GPU delegate in the latency study, against 16 ms once running: no second long compile.
  warmupImage: () => (typeof ImageData === 'function' ? new ImageData(640, 360) : null),
  now: () => performance.now(),
});

scope.addEventListener('message', (event) => {
  void core.handle(event.data);
});
