// The worker's message handling, kept apart from `self` so tests can run it in Node with a fake reader.
//
// Messages are handled strictly one after another: a 'reset' that arrives while a frame is being read
// waits for that frame, so a frame from an old camera generation never lands in the new state.

import type { FrameResult, TipConfig } from './algorithm';
import { TipTracker, renderThresholdView } from './algorithm';
import type { FromWorker, ToWorker, WireResult } from './protocol';
import type { FrameReader } from './reader';

export interface WorkerDeps {
  reader: FrameReader;
  post: (msg: FromWorker, transfer?: Transferable[]) => void;
  /** Turns a threshold view into an ImageBitmap; null where that is unavailable (tests). */
  makeBitmap?: (rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number) => Promise<ImageBitmap | null>;
  /** A clock for durations only (stepMs). Frames carry their own capture time. */
  now?: () => number;
}

export function createWorkerCore(deps: WorkerDeps): { handle(msg: ToWorker): Promise<void> } {
  const tracker = new TipTracker();
  const now = deps.now ?? (() => performance.now());
  let config: TipConfig = { ...tracker.config };
  let generation = -1;
  let pendingRelearn: { run: number; id: number } | null = null;
  let chain: Promise<void> = Promise.resolve();
  let viewBuf: Uint8ClampedArray | undefined;

  async function onFrame(msg: Extract<ToWorker, { type: 'frame' }>): Promise<void> {
    const started = now();
    if (msg.generation !== generation) {
      // First frame of a stream the main thread did not announce: treat it as a new generation.
      tracker.reset();
      generation = msg.generation;
    }
    const plan = tracker.plan(msg.width, msg.height, msg.t, msg.debug, msg.survey === true);
    let read;
    try {
      read = await deps.reader.read(msg.source, plan.rect, config.channel);
    } catch (err) {
      deps.post({ type: 'skipped', run: msg.run, generation: msg.generation, t: msg.t, frame: msg.frame, reason: err instanceof Error ? err.message : String(err) });
      return;
    } finally {
      // Close at once: an unclosed VideoFrame holds a buffer from the camera's small pool, and the
      // camera freezes when the pool runs dry.
      try {
        msg.source.close();
      } catch {
        /* already closed */
      }
    }
    const readMs = now() - started;
    const result: FrameResult = tracker.process(read.region, plan, msg.t);
    const stepMs = now() - started;

    let debug: { image: ImageBitmap; width: number; height: number } | undefined;
    if (result.view && deps.makeBitmap) {
      const { image } = result.view;
      viewBuf = renderThresholdView(result.view, config.flipX, viewBuf);
      const rgba = new Uint8ClampedArray(viewBuf.subarray(0, image.width * image.height * 4));
      const bitmap = await deps.makeBitmap(rgba, image.width, image.height).catch(() => null);
      if (bitmap) debug = { image: bitmap, width: image.width, height: image.height };
    }
    const { view: _view, ...wire } = result;
    const out: FromWorker = {
      type: 'result',
      run: msg.run,
      generation: msg.generation,
      t: msg.t,
      frame: msg.frame,
      width: msg.width,
      height: msg.height,
      result: wire as WireResult,
      stepMs,
      readMs,
      path: read.path,
      debug,
    };
    deps.post(out, debug ? [debug.image] : []);

    if (pendingRelearn && !tracker.maskWarmingUp(msg.t)) {
      deps.post({ type: 'relearned', ...pendingRelearn });
      pendingRelearn = null;
    }
  }

  async function dispatch(msg: ToWorker): Promise<void> {
    switch (msg.type) {
      case 'config':
        config = { ...msg.config };
        tracker.configure(config);
        return;
      case 'reset':
        tracker.reset();
        generation = msg.generation;
        return;
      case 'relearn':
        tracker.relearnMask();
        pendingRelearn = { run: msg.run, id: msg.id };
        return;
      case 'frame':
        return onFrame(msg);
    }
  }

  return {
    handle(msg) {
      chain = chain.then(() => dispatch(msg)).catch((err) => {
        deps.post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      });
      return chain;
    },
  };
}
