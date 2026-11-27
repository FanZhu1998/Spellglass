// Messages between the hand tracker (main thread) and its worker (Section 5, "Threads": the hand model,
// when used, gets its own worker).
//
// Time is never stamped in the worker (contracts/v1.ts TipSample): each frame carries its capture time on
// the kernel clock and a frame counter, from 'camera.frame' or from the camera track's feed
// (kernel/frame-feed.ts), and its result carries them back unchanged. `run` changes on every start() of
// the tracker, so a late message from an earlier run is recognized and dropped. `seq` numbers the frames
// the tracker sends, and the answer to each ('result' or 'error') carries it back, so the tracker can
// tell the answer to the frame it is waiting for from a late answer to one it has given up on.

export type Delegate = 'GPU' | 'CPU';

/** A camera frame as the worker gets it: the camera track's own VideoFrame (the fast path), or an
 *  ImageBitmap copy of the capture module's video. MediaPipe takes either. */
export type FrameImage = VideoFrame | ImageBitmap;

/** Why loading failed. 'missing': a file is not where npm run models puts it (or is not what it should
 *  be); 'unreachable': the download itself failed; 'runtime': the files are fine but the model would not
 *  start (no WebGL in workers, a GPU the delegate refuses, out of memory). */
export type LoadFailure = 'missing' | 'unreachable' | 'runtime';

export type ToWorker =
  | {
      type: 'load';
      run: number;
      /** Absolute URL of the folder holding vision_wasm_module_internal.{js,wasm}. */
      wasmBaseUrl: string;
      /** Absolute URL of hand_landmarker.task. */
      modelUrl: string;
      delegate: Delegate;
    }
  | {
      type: 'frame';
      run: number;
      /** The tracker's number for this frame, different for every frame it sends; the answer carries it
       *  back. */
      seq: number;
      generation: number;
      /** Capture time and frame counter (CameraFrame.t and .frame, or the feed's t and index), carried
       *  through untouched. */
      t: number;
      frame: number;
      /** Size of the camera frame, whose aspect the landmarks need (an ImageBitmap is a scaled copy of the
       *  same aspect; a VideoFrame is the frame itself). */
      width: number;
      height: number;
      /** Transferred; the worker closes it, whatever happens. A VideoFrame comes whole, at the camera's
       *  size; an ImageBitmap about 640 px wide (Section 7.3 notes). */
      image: FrameImage;
      /** Make a small mirrored preview for 'tracker.debug'. */
      preview: boolean;
      /** Mirror the preview into caster orientation (setting 'capture.flipX'). */
      flipX: boolean;
      /** Wand mode (hand.mode 'wand'): after the landmarks, find the wand in the hand (wand.ts), starting
       *  from the tip's place in the hand that the tracker has learned, or anywhere when it has none. */
      wand?: { prior: { a: number; b: number } | null };
    }
  | { type: 'close'; run: number };

/** The wand the worker found in a frame (wand.ts WandFound), in the landmarks' units: normalized to the
 *  frame, unmirrored. */
export interface WandWire {
  tip: [number, number];
  /** Where the visible shaft leaves the hand. */
  base: [number, number];
  /** 0..1 (wand.ts). */
  quality: number;
  /** Mean contrast of the shaft against what is behind it, luma levels. */
  contrast: number;
  /** Visible length ÷ palm length. */
  length: number;
  /** The shaft ran out of the frame: the tip may be further on. */
  cut: boolean;
  /** A lit tip (a light beside the lens): a small bright spot at the end of the shaft. */
  glint?: [number, number];
  /** Found around the prior, or by searching every direction. */
  search: 'prior' | 'wide';
}

/** One hand as the model saw it. */
export interface HandWire {
  /** 21 landmarks as [x, y, z, ...], normalized to the frame, unmirrored. */
  points: number[];
  /** Handedness score of the best category (how sure the model is about this hand). */
  score: number;
  /** MediaPipe's handedness label, as given. It assumes a mirrored (selfie) image, so on an unmirrored
   *  camera frame it names the other hand; the tracker does not use it for anything else. */
  label: string;
  /** Presence of the index fingertip, when the model reports one. */
  tipPresence?: number;
}

export type FromWorker =
  | { type: 'progress'; run: number; loaded: number; total: number }
  | { type: 'ready'; run: number; delegate: Delegate; loadMs: number }
  | { type: 'failed'; run: number; reason: LoadFailure; message: string; detail?: string }
  | {
      type: 'result';
      run: number;
      /** The frame's seq, as it came. */
      seq: number;
      generation: number;
      t: number;
      frame: number;
      width: number;
      height: number;
      hand: HandWire | null;
      /** Worker time for this frame (detectForVideo), ms. Not a timestamp. The tracker also judges a GPU
       *  delegate by it (index.ts, a slow GPU). */
      stepMs: number;
      /** Wand mode: the wand found, or null when there was none to be sure of (absent outside wand mode). */
      wand?: WandWire | null;
      /** Wand mode: worker time spent reading the pixels and finding the wand, ms (not part of stepMs, which
       *  judges the model's delegate). */
      wandMs?: number;
      /** Mirrored preview for 'tracker.debug', transferred. */
      preview?: ImageBitmap;
    }
  | { type: 'error'; run: number; seq: number; generation: number; message: string };
