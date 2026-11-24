// The fast way to get camera frames to the worker in Chromium (Section 7.1: "MediaStreamTrackProcessor
// can hand frames to a worker more directly ... so it is an optional fast path"; Section 5 lists it as
// the capture swap-in).
//
// Why it matters, measured on the reference laptop (Ryzen 5 5500U, Chrome 158, Chrome's fake camera
// playing a 1920x1080 clip): a VideoFrame made from the capture module's <video> is NV12 in GPU memory
// (Chromium uploads camera frames for the compositor), and reading any part of it forces a GPU readback:
// 6.5 ms for a 252x252 window, 11.8 ms for the whole frame (canvas drawImage plus getImageData: 12 and
// 18 ms). Frames from a MediaStreamTrackProcessor on the same track come straight from the capture
// pipeline, I420 in shared memory: 0.2 ms for the window, 1.2 ms for the whole frame. So the bright tip
// reads the camera track itself where it can, and falls back to 'camera.frame' and new VideoFrame(video)
// elsewhere. (A camera whose driver hands Chromium GPU frames would make this path slower too; it is
// never slower than the fallback, which always reads from GPU memory.)
//
// Chrome 158 exposes MediaStreamTrackProcessor on the main thread but not in workers, and a
// MediaStreamTrack cannot be transferred to a worker (both checked), so the processor runs on the main
// thread and frames are transferred to the worker one at a time, as before. Cancelling the processor
// leaves the track live and the capture module's video playing (checked), so no clone is needed; a clone
// would keep the camera on after capture releases it.
//
// Capture time: the processor's VideoFrame.timestamp is the camera's capture time on another clock (in
// Chromium, microseconds of the system's monotonic clock). ClockMap turns it into kernel time with a
// fixed offset, the smallest (read time − timestamp) seen: the capture time plus the processor's smallest
// delivery delay. Measured against rVFC's captureTime for the same frames, the result is about 0.5 ms
// later. Time is still never stamped in the worker.

/** MediaStreamTrackProcessor, which the DOM library does not describe yet. */
export type ProcessorFactory = (track: MediaStreamTrack, maxBufferSize: number) => ReadableStream<VideoFrame> | null;

export function browserProcessor(): ProcessorFactory | null {
  const P = (globalThis as { MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack; maxBufferSize?: number }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor;
  if (typeof P !== 'function') return null;
  return (track, maxBufferSize) => {
    try {
      return new P({ track, maxBufferSize }).readable;
    } catch {
      return null;
    }
  };
}

/** Maps frame timestamps (µs, another clock) to kernel time (ms). */
export class ClockMap {
  private offset: number | null = null;

  /** Note a frame read at kernel time `now`. */
  observe(now: number, timestampUs: number): void {
    const d = now - timestampUs / 1000;
    // The smallest delay is the best estimate; a jump of over a second means the time base changed.
    if (this.offset === null || d < this.offset || d - this.offset > 1000) this.offset = d;
  }

  toKernel(timestampUs: number): number {
    return timestampUs / 1000 + (this.offset ?? 0);
  }
}

export interface FeedFrame {
  frame: VideoFrame;
  /** Capture time on the kernel clock, strictly increasing. */
  t: number;
  /** Camera frames since the feed started, from the timestamps (gaps show dropped frames), strictly
   *  increasing. It stands in for CameraFrame.frame, which counts from the capture module's own start. */
  index: number;
  width: number;
  height: number;
}

export interface Feed {
  cancel(): void;
  /** Resolves when the feed ends (cancelled, the track ended, or the stream failed). */
  readonly done: Promise<void>;
}

/**
 * Read frames from a processor and hand each to `deliver`, but only while the worker is idle: with a
 * one-frame buffer the processor keeps just the newest frame while we wait, so the worker always gets
 * the freshest frame and nothing queues (Section 5). `deliver` owns the frame (transfer or close it).
 */
export function startFeed(o: {
  readable: ReadableStream<VideoFrame>;
  now: () => number;
  fps: number;
  waitIdle: () => Promise<void>;
  deliver: (f: FeedFrame) => void;
}): Feed {
  const reader = o.readable.getReader();
  const clock = new ClockMap();
  const interval = 1e6 / (o.fps > 0 ? o.fps : 30);
  let first: number | null = null;
  let lastT = -Infinity;
  let lastIndex = -1;
  let cancelled = false;
  const done = (async () => {
    try {
      while (!cancelled) {
        await o.waitIdle();
        if (cancelled) break;
        const { value: frame, done: ended } = await reader.read();
        if (ended || !frame) break;
        if (cancelled) {
          frame.close();
          break;
        }
        clock.observe(o.now(), frame.timestamp);
        first ??= frame.timestamp;
        // The offset shrinks as better estimates arrive, so an early frame that was read late could map
        // after its successor; consumers need capture times in order (contracts/events.ts).
        const t = Math.max(clock.toKernel(frame.timestamp), lastT + 0.01);
        const index = Math.max(lastIndex + 1, Math.round((frame.timestamp - first) / interval));
        lastT = t;
        lastIndex = index;
        try {
          o.deliver({ frame, t, index, width: frame.displayWidth, height: frame.displayHeight });
        } catch (err) {
          // Never leave a frame open: it holds a buffer from the camera's small pool (a no-op if it was
          // already transferred or closed).
          frame.close();
          throw err;
        }
      }
    } catch {
      /* the track ended or the stream failed: the caller falls back */
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* still reading */
      }
    }
  })();
  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      reader.cancel().catch(() => undefined);
    },
    done,
  };
}
