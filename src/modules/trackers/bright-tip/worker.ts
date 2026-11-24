// The bright-tip worker (Section 5, "Threads"). Started by the module as
//   new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
// and by the tip-finder page the same way. All logic is in worker-core.ts and algorithm.ts.

import type { ToWorker } from './protocol';
import { createFrameReader } from './reader';
import { createWorkerCore } from './worker-core';

/** The parts of DedicatedWorkerGlobalScope used here (the project compiles against the DOM library). */
interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ToWorker>) => void): void;
}

const scope = self as unknown as WorkerScope;

const core = createWorkerCore({
  reader: createFrameReader(),
  post: (msg, transfer = []) => scope.postMessage(msg, transfer),
  makeBitmap: async (rgba, width, height) => {
    if (typeof createImageBitmap !== 'function' || typeof ImageData !== 'function') return null;
    return createImageBitmap(new ImageData(rgba, width, height));
  },
});

scope.addEventListener('message', (event) => {
  void core.handle(event.data);
});
