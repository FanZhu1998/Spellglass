// Development page for the hand tracker: the real module and worker with a stand-in camera, drawing the
// mirror view, the landmarks from 'tracker.debug' and the tip trail, with the live status and timings.
//   npx vite --port 5184 --strictPort, then open /src/modules/trackers/hand/dev/index.html
//   ?image=/path/to/hand.jpg   use a still image as the camera
//   ?mode=grip                 grip mode instead of finger mode
//   ?mode=wand                 wand mode: the wand in the hand, found in the frame (wand.ts)
//   ?delegate=cpu              skip the GPU delegate (to compare timings with the fallback)
//   ?source=video              read frames from the video ('camera.frame') only, as where Chromium's
//                              MediaStreamTrackProcessor is missing (to compare with the fast path)
// window.__handHarness exposes the kernel and what was published, for automated checks.
//
// mainThreadMs is the tracker's main-thread work per frame, by where its frames come from (status
// source): on the video path the 'camera.frame' handler, which starts the copy, plus handing the copy
// to the worker; on the track path (the fast path) the frame's way from the camera track to the worker,
// timed from when it comes off the track to its postMessage, with the 'camera.frame' handler, there
// only the fast path's watchdog, apart. Both paths add the worker's answer (result). Medians and
// maxima over the last 300 frames; the stand-ins that time them add a few microseconds.

import type { Envelope, TipSample, TrackerDebugFrame, TrackerStatus } from '../../../../contracts';
import { createKernel, memoryPersistence, on } from '../../../../kernel';
import { browserHandDeps, buildHandTracker, type HandDeps, type WorkerLike } from '../index';
import type { FromWorker } from '../protocol';
import { createDevCamera } from './camera';

const params = new URLSearchParams(location.search);
const base = import.meta.env.BASE_URL;
const kernel = createKernel({
  // 'tracker.debug' is session-only, so it is switched on after init (saved values never carry it).
  persistence: memoryPersistence({
    'tracker.active': 'tracker.hand',
    'capture.consent': true,
    'hand.mode': params.get('mode') === 'grip' ? 'grip' : params.get('mode') === 'wand' ? 'wand' : 'finger',
  }),
});

const events: Envelope[] = [];
const keep = new Set(['tip.found', 'tip.sample', 'tip.lost', 'tracker.status']);
kernel.subscribe('*', (e) => {
  if (keep.has(e.type)) events.push(e);
});

// Main-thread cost of the tracker's frame handler: one subscriber before it, one after (the bus calls
// subscribers in the order they subscribed; the tracker subscribes when it starts).
const handlerMs: number[] = [];
let frameStart = 0;
kernel.subscribe('camera.frame', () => (frameStart = performance.now()));

/** The rest of the tracker's main-thread work per frame (see the header): handing a frame to the worker,
 *  from the track (trackMs) or as a copy of the video (copyMs), and the worker's answer (resultMs). */
const trackMs: number[] = [];
const copyMs: number[] = [];
const resultMs: number[] = [];
const note = (list: number[], ms: number) => {
  list.push(Math.round(ms * 1000) / 1000);
  if (list.length > 300) list.shift();
};
/** The frame last read off the camera track, or the last copy of the video made, and when. */
let fromTrack: { frame: VideoFrame; at: number } | null = null;
let fromVideo: { bitmap: ImageBitmap; at: number } | null = null;

const deps: HandDeps = browserHandDeps();
const cpu = params.get('delegate') === 'cpu';
const make = deps.createWorker;
deps.createWorker = () => {
  const w = make();
  // The tracker talks to this stand-in, which times what it hands over and what comes back.
  const timed: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(m, transfer) {
      // A frame seen coming off the track, or a copy of the video seen made: timed from then to here.
      const from = m.type !== 'frame' ? null
        : m.image === fromTrack?.frame ? { list: trackMs, at: fromTrack.at }
          : m.image === fromVideo?.bitmap ? { list: copyMs, at: fromVideo.at } : null;
      w.postMessage(cpu && m.type === 'load' ? { ...m, delegate: 'CPU' } : m, transfer);
      if (from) note(from.list, performance.now() - from.at);
      fromTrack = fromVideo = null;
    },
    terminate: () => w.terminate(),
  };
  w.onmessage = (e: MessageEvent<FromWorker>) => {
    const began = performance.now();
    timed.onmessage?.(e);
    if (e.data.type === 'result') note(resultMs, performance.now() - began);
  };
  w.onerror = (e) => timed.onerror?.(e);
  return timed;
};
if (params.get('source') === 'video') {
  deps.openProcessor = null;
} else if (deps.openProcessor) {
  // The track's frames pass through a stand-in stream that notes when each one comes off the track. It
  // reads only when the tracker does (highWaterMark 0), so the processor's one-frame buffer stays the
  // only buffer.
  const open = deps.openProcessor;
  deps.openProcessor = (track, maxBufferSize) => {
    const readable = open(track, maxBufferSize);
    if (!readable) return null;
    const reader = readable.getReader();
    return new ReadableStream<VideoFrame>({
      async pull(c) {
        const { value, done } = await reader.read();
        if (done) {
          c.close();
          return;
        }
        fromTrack = { frame: value, at: performance.now() };
        c.enqueue(value);
      },
      cancel: (reason) => reader.cancel(reason),
    }, { highWaterMark: 0 });
  };
}
const grab = deps.grabFrame;
deps.grabFrame = (video, width, height) => {
  const pending = grab(video, width, height);
  return pending && pending.then((bitmap) => {
    fromVideo = { bitmap, at: performance.now() };
    return bitmap;
  });
};

kernel.register(
  createDevCamera({ image: params.get('image') }),
  buildHandTracker({ modelUrl: `${base}models/hand_landmarker.task`, wasmBaseUrl: `${base}models/wasm` }, deps),
);

const canvas = document.getElementById('view') as HTMLCanvasElement;
const g = canvas.getContext('2d')!;
const statusEl = document.getElementById('status')!;
let status: TrackerStatus | null = null;
let debug: TrackerDebugFrame | null = null;
const trail: TipSample[] = [];
const loadStarted = performance.now();
let readyAt: number | null = null;

on(kernel, 'tracker.status', (s) => {
  status = s;
  if (readyAt === null && (s.state === 'searching' || s.state === 'tracking')) readyAt = performance.now();
});
on(kernel, 'tracker.debug', (d) => (debug = d));
on(kernel, 'tip.sample', (s) => {
  trail.push(s);
  if (trail.length > 90) trail.shift();
});

const CONNECTIONS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

function draw(): void {
  requestAnimationFrame(draw);
  const W = canvas.width, H = canvas.height;
  g.fillStyle = '#0f1424';
  g.fillRect(0, 0, W, H);
  if (debug?.image) g.drawImage(debug.image, 0, 0, W, H);
  const lm = debug?.landmarks;
  if (lm) {
    g.strokeStyle = 'rgba(95,179,165,0.9)';
    g.lineWidth = 2;
    for (const [a, b] of CONNECTIONS) {
      g.beginPath();
      g.moveTo(lm[a][0] * W, lm[a][1] * H);
      g.lineTo(lm[b][0] * W, lm[b][1] * H);
      g.stroke();
    }
  }
  g.strokeStyle = '#f2b84b';
  g.lineWidth = 4;
  g.beginPath();
  trail.forEach((s, i) => (i ? g.lineTo(s.x * W, s.y * H) : g.moveTo(s.x * W, s.y * H)));
  g.stroke();
  statusEl.textContent = JSON.stringify({
    status,
    loadMs: readyAt === null ? null : Math.round(readyAt - loadStarted),
    mainThreadMs: mainThread(),
    samples: events.filter((e) => e.type === 'tip.sample').length,
  }, null, 2);
}

function spread(list: readonly number[]): { median: number; max: number } | null {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return { median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1] };
}

/** The tracker's main-thread work per frame, for the source its status names (see the header). */
function mainThread(): Record<string, unknown> | null {
  const source = status?.source;
  if (source === 'track') return { source, fromTrack: spread(trackMs), result: spread(resultMs), watchdog: spread(handlerMs) };
  if (source === 'video') return { source, cameraFrame: spread(handlerMs), sendCopy: spread(copyMs), result: spread(resultMs) };
  return null;
}

async function boot(): Promise<void> {
  await kernel.init();
  kernel.settings.set('tracker.debug', true);
  await kernel.start();
  kernel.subscribe('camera.frame', () => {
    handlerMs.push(Math.round((performance.now() - frameStart) * 1000) / 1000);
    if (handlerMs.length > 300) handlerMs.shift();
  });
  draw();
}

Object.defineProperty(window, '__handHarness', {
  value: { kernel, events, handlerMs, trackMs, copyMs, resultMs, mainThread, get status() { return status; }, get debug() { return debug; } },
});
void boot();
