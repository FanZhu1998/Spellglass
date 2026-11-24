// Development page for the hand tracker: the real module and worker with a stand-in camera, drawing the
// mirror view, the landmarks from 'tracker.debug' and the tip trail, with the live status and timings.
//   npx vite --port 5184 --strictPort, then open /src/modules/trackers/hand/dev/index.html
//   ?image=/path/to/hand.jpg   use a still image as the camera
//   ?mode=grip                 grip mode instead of finger mode
//   ?delegate=cpu              skip the GPU delegate (to compare timings with the fallback)
// window.__handHarness exposes the kernel and what was published, for automated checks.

import type { Envelope, TipSample, TrackerDebugFrame, TrackerStatus } from '../../../../contracts';
import { createKernel, memoryPersistence, on } from '../../../../kernel';
import { browserHandDeps, buildHandTracker, type HandDeps } from '../index';
import { createDevCamera } from './camera';

const params = new URLSearchParams(location.search);
const base = import.meta.env.BASE_URL;
const kernel = createKernel({
  // 'tracker.debug' is session-only, so it is switched on after init (saved values never carry it).
  persistence: memoryPersistence({
    'tracker.active': 'tracker.hand',
    'capture.consent': true,
    'hand.mode': params.get('mode') === 'grip' ? 'grip' : 'finger',
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

const deps: HandDeps = browserHandDeps();
if (params.get('delegate') === 'cpu') {
  const make = deps.createWorker;
  deps.createWorker = () => {
    const w = make();
    const post = w.postMessage.bind(w);
    w.postMessage = (m, transfer) => post(m.type === 'load' ? { ...m, delegate: 'CPU' } : m, transfer);
    return w;
  };
}

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
  const sorted = [...handlerMs].sort((a, b) => a - b);
  statusEl.textContent = JSON.stringify({
    status,
    loadMs: readyAt === null ? null : Math.round(readyAt - loadStarted),
    mainThreadFrameMs: sorted.length ? { median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1] } : null,
    samples: events.filter((e) => e.type === 'tip.sample').length,
  }, null, 2);
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

Object.defineProperty(window, '__handHarness', { value: { kernel, events, handlerMs, get status() { return status; }, get debug() { return debug; } } });
void boot();
