import { describe, expect, it } from 'vitest';
import { ClockMap, startFeed, type FeedFrame } from './frame-feed';

/** Frame timestamps are on another clock (Chromium: µs of the system's monotonic clock). */
const BASE_US = 9_000_000_000;

interface FakeFrame {
  timestamp: number;
  displayWidth: number;
  displayHeight: number;
  closed: boolean;
  close(): void;
}

function frame(captureMs: number): FakeFrame {
  return { timestamp: BASE_US + captureMs * 1000, displayWidth: 640, displayHeight: 360, closed: false, close() { this.closed = true; } };
}

/** A readable that hands out the given frames, each read at kernel time capture + delay. */
function source(frames: { f: FakeFrame; delay: number }[], clock: { t: number }) {
  let i = 0;
  let cancelled = false;
  const readable = new ReadableStream<VideoFrame>(
    {
      pull(c) {
        if (cancelled) return;
        const next = frames[i++];
        if (!next) {
          c.close();
          return;
        }
        clock.t = (next.f.timestamp - BASE_US) / 1000 + next.delay;
        c.enqueue(next.f as unknown as VideoFrame);
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { readable, wasCancelled: () => cancelled };
}

describe('ClockMap', () => {
  it('maps frame timestamps onto the kernel clock with the smallest delay seen', () => {
    const c = new ClockMap();
    const capture = [100, 133.3, 166.7, 200];
    const delay = [20, 3, 1, 5];
    capture.forEach((t, i) => c.observe(t + delay[i], BASE_US + t * 1000));
    // Capture time plus the smallest delivery delay (1 ms).
    expect(c.toKernel(BASE_US + 300_000)).toBeCloseTo(301, 6);
  });

  it('starts again when the time base jumps', () => {
    const c = new ClockMap();
    c.observe(100, BASE_US + 99_000);
    c.observe(5200, BASE_US + 133_000); // the timestamps restarted 5 s behind
    expect(c.toKernel(BASE_US + 133_000)).toBeCloseTo(5200, 6);
  });
});

describe('startFeed', () => {
  it('delivers frames with capture times in order, even when the first one was read late', async () => {
    const clock = { t: 0 };
    const frames = [frame(1000), frame(1033.3), frame(1066.7), frame(1100), frame(1166.7)];
    const { readable } = source([{ f: frames[0], delay: 50 }, { f: frames[1], delay: 1 }, { f: frames[2], delay: 1 }, { f: frames[3], delay: 2 }, { f: frames[4], delay: 1 }], clock);
    const got: FeedFrame[] = [];
    const feed = startFeed({ readable, now: () => clock.t, fps: 30, waitIdle: async () => undefined, deliver: (f) => got.push(f) });
    await feed.done;
    expect(got).toHaveLength(5);
    for (let i = 1; i < got.length; i++) expect(got[i].t).toBeGreaterThan(got[i - 1].t);
    // Once a prompt read has been seen, times are the capture times plus that delay (1 ms).
    expect(got[2].t).toBeCloseTo(1067.7, 6);
    expect(got[4].t).toBeCloseTo(1167.7, 6);
    // Frame numbers from the timestamps: the frame at 1133.3 never arrived.
    expect(got.map((f) => f.index)).toEqual([0, 1, 2, 3, 5]);
    expect(got[0]).toMatchObject({ width: 640, height: 360 });
  });

  it('reads the next frame only when the worker is idle, and stops on cancel', async () => {
    const clock = { t: 0 };
    const frames = Array.from({ length: 6 }, (_, i) => frame(1000 + i * 33));
    const { readable, wasCancelled } = source(frames.map((f) => ({ f, delay: 1 })), clock);
    let release: (() => void) | null = null;
    const delivered: FeedFrame[] = [];
    const feed = startFeed({
      readable,
      now: () => clock.t,
      fps: 30,
      // The worker is busy until the test releases it.
      waitIdle: () => (delivered.length === 0 ? Promise.resolve() : new Promise<void>((r) => (release = r))),
      deliver: (f) => delivered.push(f),
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(delivered).toHaveLength(1);
    (release as (() => void) | null)?.();
    await new Promise((r) => setTimeout(r, 10));
    expect(delivered).toHaveLength(2);
    feed.cancel();
    (release as (() => void) | null)?.();
    await feed.done;
    expect(wasCancelled()).toBe(true);
    expect(delivered).toHaveLength(2);
  });

  it('closes a frame that deliver could not take', async () => {
    const clock = { t: 0 };
    const f = frame(1000);
    const { readable } = source([{ f, delay: 1 }], clock);
    const feed = startFeed({
      readable,
      now: () => clock.t,
      fps: 30,
      waitIdle: async () => undefined,
      deliver: () => {
        throw new Error('no worker');
      },
    });
    await feed.done;
    expect(f.closed).toBe(true);
  });
});
