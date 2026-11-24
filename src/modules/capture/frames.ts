// Frames from the camera (Section 7.1): a hidden <video> driven by requestVideoFrameCallback, which
// every major browser has had since late 2024, with requestAnimationFrame polling where it is missing.
// Each new frame becomes one 'camera.frame' event.
//
// Capture time (Section 6: "t is the timestamp of the camera frame, not the time the code ran"):
//  - 'capture': rVFC metadata.captureTime, the time the camera captured the frame. Chromium reports it
//    for camera streams. It is on the performance.now() clock.
//  - 'presented': metadata.expectedDisplayTime, when captureTime is missing (Firefox). It is regular
//    (vsync-aligned) but up to one display frame later than the callback, and hides camera latency.
//  - 'callback': the time the callback ran, with the rAF fallback. Main-thread jank shows up in it.
// The kernel clock is performance.now() in the browser; times are converted through it anyway, so a
// kernel with another clock still gets consistent capture times.

import type { CameraFrame } from '../../contracts';
import { logger } from '../../kernel';
import { frameTimestamp } from './camera-utils';

export { frameTimestamp };

const log = logger('capture.camera');

/** What the controller needs from a frame source (the browser pump, or a fake in tests). */
export interface FramePumpLike {
  bind(stream: MediaStream, generation: number): void;
  /** The same stream at a new generation (a size change on the same track). */
  setGeneration(generation: number): void;
  unbind(): void;
  destroy(): void;
  /** Frames the camera delivered per second, measured (0 when none lately). */
  readonly fps: number;
}

export class FramePump implements FramePumpLike {
  private video: HTMLVideoElement | null = null;
  private bound = false;
  private generation = 0;
  private counter = 0;
  private firstPresented: number | null = null;
  private rvfc: number | null = null;
  private raf: number | null = null;
  private lastPolled = -1;
  /** (kernel time, frame number) of recent frames, for the delivered rate. */
  private recent: { t: number; n: number }[] = [];

  constructor(
    private readonly onFrame: (frame: CameraFrame) => void,
    private readonly kernelNow: () => number,
  ) {}

  get fps(): number {
    const r = this.recent;
    if (r.length < 2) return 0;
    const a = r[0], b = r[r.length - 1];
    if (this.kernelNow() - b.t > 1000 || b.t <= a.t) return 0;
    return ((b.n - a.n) / (b.t - a.t)) * 1000;
  }

  bind(stream: MediaStream, generation: number): void {
    this.stopLoop();
    const video = this.ensureVideo();
    this.generation = generation;
    this.resetCounters();
    if (video.srcObject !== stream) video.srcObject = stream;
    this.bound = true;
    // Muted, inline playback needs no user gesture. No autoplay attribute: Chrome pauses muted
    // autoplaying videos it considers out of view, and this one must keep playing.
    video.play().catch((err) => log.warn('the hidden camera video would not play', err));
    this.startLoop(video);
  }

  setGeneration(generation: number): void {
    this.generation = generation;
    this.resetCounters();
  }

  unbind(): void {
    this.bound = false;
    this.stopLoop();
    const v = this.video;
    if (v) {
      try {
        v.pause();
      } catch {
        /* ignore */
      }
      v.srcObject = null;
    }
    this.recent = [];
  }

  destroy(): void {
    this.unbind();
    this.video?.remove();
    this.video = null;
  }

  private resetCounters(): void {
    this.counter = 0;
    this.firstPresented = null;
    this.recent = [];
  }

  private ensureVideo(): HTMLVideoElement {
    if (this.video) return this.video;
    const v = document.createElement('video');
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('aria-hidden', 'true');
    v.tabIndex = -1;
    v.disablePictureInPicture = true;
    v.dataset.spellglass = 'capture';
    // In the document and in view, at 1 px and fully transparent: a detached or display:none video
    // may not fire requestVideoFrameCallback reliably.
    v.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;z-index:-1;';
    // Keep it playing if something pauses it (a media key, the system).
    v.addEventListener('pause', () => {
      if (this.bound && v.srcObject) v.play().catch(() => undefined);
    });
    (document.body ?? document.documentElement).appendChild(v);
    this.video = v;
    return v;
  }

  private startLoop(video: HTMLVideoElement): void {
    if (typeof video.requestVideoFrameCallback === 'function') {
      const tick: VideoFrameRequestCallback = (_now, meta) => {
        if (!this.bound || this.video !== video) return;
        this.rvfc = video.requestVideoFrameCallback(tick);
        this.deliver(video, meta);
      };
      this.rvfc = video.requestVideoFrameCallback(tick);
      return;
    }
    const poll = () => {
      if (!this.bound || this.video !== video) return;
      this.raf = requestAnimationFrame(poll);
      if (video.readyState < 2) return;
      const quality = typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
      const n = quality ? quality.totalVideoFrames : Math.round(video.currentTime * 1000);
      if (n === this.lastPolled) return;
      this.lastPolled = n;
      this.deliver(video, null);
    };
    this.raf = requestAnimationFrame(poll);
  }

  private stopLoop(): void {
    const v = this.video;
    if (v && this.rvfc !== null && typeof v.cancelVideoFrameCallback === 'function') v.cancelVideoFrameCallback(this.rvfc);
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.rvfc = null;
    this.raf = null;
  }

  private deliver(video: HTMLVideoElement, meta: VideoFrameCallbackMetadata | null): void {
    const k = this.kernelNow();
    const { t, timeSource } = frameTimestamp(meta, performance.now(), k);
    // presentedFrames counts every frame, also those whose callback was skipped while the main thread
    // was busy, so frame numbers show gaps and the measured rate is the camera's, not the callbacks'.
    let frame: number;
    if (meta && typeof meta.presentedFrames === 'number') {
      this.firstPresented ??= meta.presentedFrames;
      frame = meta.presentedFrames - this.firstPresented;
    } else {
      frame = this.counter;
    }
    this.counter++;
    this.recent.push({ t: k, n: frame });
    while (this.recent.length > 2 && k - this.recent[0].t > 1500) this.recent.shift();
    const width = meta?.width || video.videoWidth;
    const height = meta?.height || video.videoHeight;
    if (!width || !height) return;
    this.onFrame({ t, timeSource, frame, generation: this.generation, width, height, video });
  }
}
