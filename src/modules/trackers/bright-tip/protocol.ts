// Messages between the bright-tip module (main thread) and its worker (Section 5, "Threads": the
// tracker runs in a worker so a slow frame never stalls the trail). The tip-finder page speaks the same
// protocol to the same worker, so it measures exactly what the app will do.
//
// Time is never stamped in the worker (contracts/v1.ts TipSample): each frame carries the capture time
// and counter from 'camera.frame', and results carry them back unchanged.

import type { FrameResult, TipConfig } from './algorithm';

/** How the worker got the pixels, fastest first. */
export type ReadPath = 'y-plane' | 'rgba-copy' | 'canvas';

export type ToWorker =
  | { type: 'config'; config: TipConfig }
  | {
      type: 'frame';
      /** Changes on every start(); results from an earlier run are dropped. */
      run: number;
      generation: number;
      /** CameraFrame.t and CameraFrame.frame, carried through untouched. */
      t: number;
      frame: number;
      width: number;
      height: number;
      /** Transferred. The worker closes it as soon as the pixels are read. */
      source: VideoFrame | ImageBitmap;
      /** Make a threshold view for 'tracker.debug' when one is due. */
      debug: boolean;
      /** Read the whole frame (fresh statistics for autotune), whatever the tracker's plan. */
      survey?: boolean;
    }
  /** A new camera generation: forget the static mask and the prediction. */
  | { type: 'reset'; run: number; generation: number }
  | { type: 'relearn'; run: number; id: number };

/** FrameResult without the tracker's internal buffers. */
export type WireResult = Omit<FrameResult, 'view'>;

export type FromWorker =
  | {
      type: 'result';
      run: number;
      generation: number;
      t: number;
      frame: number;
      width: number;
      height: number;
      result: WireResult;
      /** Worker time for this frame (reading pixels plus Section 7.2), ms. Not a timestamp. */
      stepMs: number;
      readMs: number;
      path: ReadPath;
      /** Threshold view in caster orientation, transferred. */
      debug?: { image: ImageBitmap; width: number; height: number };
    }
  /** The frame could not be read (closed, detached, or a format nothing here can read). */
  | { type: 'skipped'; run: number; generation: number; t: number; frame: number; reason: string }
  /** The static mask finished learning after a 'relearn'. */
  | { type: 'relearned'; run: number; id: number }
  | { type: 'error'; message: string };
