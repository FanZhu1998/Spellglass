// The tip-finder page (milestone M0, blueprint Appendix A). A standalone page, built by Vite as a second
// input and served at /tools/tip-finder.html. It runs the bright-tip tracker on the camera so the player
// can measure what the camera sees before anything else is built around it.
//
// It uses the app's own pieces directly, without the kernel or the module: the bright-tip worker and its
// frame source (feed.ts: frames straight from the camera track where Chromium allows it, else from the
// video), so the numbers it shows are what the app will get, read path and step time included; and the
// capture module's pure helpers for constraints and exposure.
//
// Settings are shared with the app on purpose (localStorage 'spellglass.settings', through the kernel's
// SettingsStore): Appendix A says the numbers found here "become the starting values in Section 7.2".
// The exposure goes into 'capture.exposureMode' and 'capture.exposureTime', which capture uses as the
// starting exposure of a camera that has no saved profile yet.

import '@fontsource/im-fell-english/latin-400.css';
import '@fontsource/spectral/latin-400.css';
import '@fontsource/spectral/latin-400-italic.css';
import '@fontsource/spectral/latin-600.css';
import '../../src/ui/styles/tokens.css';
import './style.css';

import type { CameraExposureInfo, SettingKey, SettingsMap } from '../../src/contracts';
import { DEFAULT_SETTINGS } from '../../src/contracts';
import { newId } from '../../src/kernel/ids';
import { SettingsStore, localStoragePersistence } from '../../src/kernel/settings';
import {
  FALLBACK_SIZE, exposureConstraintSet, exposureState, frameTimestamp, isInfraredLabel, readExposureInfo, resolveExposure, sizeConstraints,
  videoConstraints, type CameraConstraints, type ExposureTarget, type TrackCapabilities, type TrackSettings,
} from '../../src/modules/capture/camera-utils';
import { INFRARED_DEFAULTS, type Channel, type DebugBlob, type TipConfig } from '../../src/modules/trackers/bright-tip/algorithm';
import { browserProcessor, startFeed, type Feed } from '../../src/modules/trackers/bright-tip/feed';
import type { FromWorker, ToWorker, WireResult } from '../../src/modules/trackers/bright-tip/protocol';
import { SessionRecorder, formatExposure, sliderToTime, timeToSlider, type RecordedTip } from './recorder';

const RECORD_MS = 10_000;
const CHECKLIST_KEY = 'spellglass.tipFinder.checklist';

// ------------------------------------------------------------------------------------ elements

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from tip-finder.html`);
  return el as T;
};
const el = {
  video: $<HTMLVideoElement>('preview'),
  overlay: $<HTMLCanvasElement>('overlay'),
  placeholder: $('placeholder'),
  threshold: $<HTMLCanvasElement>('threshold'),
  cameraSelect: $<HTMLSelectElement>('camera-select'),
  start: $<HTMLButtonElement>('start'),
  stop: $<HTMLButtonElement>('stop'),
  cameraStatus: $('camera-status'),
  rTip: $('r-tip'),
  rBg: $('r-bg'),
  rContrast: $('r-contrast'),
  rVerdict: $('r-verdict'),
  rFound: $('r-found'),
  rSize: $('r-size'),
  rStreak: $('r-streak'),
  rFps: $('r-fps'),
  rStep: $('r-step'),
  rCapture: $('r-capture'),
  exposureNone: $('exposure-none'),
  exposureAuto: $<HTMLInputElement>('exposure-auto'),
  exposure: $<HTMLInputElement>('exposure'),
  exposureValue: $<HTMLOutputElement>('exposure-value'),
  k: $<HTMLInputElement>('k'),
  kValue: $<HTMLOutputElement>('k-value'),
  floor: $<HTMLInputElement>('floor'),
  floorValue: $<HTMLOutputElement>('floor-value'),
  channel: $<HTMLSelectElement>('channel'),
  mask: $<HTMLInputElement>('mask'),
  flip: $<HTMLInputElement>('flip'),
  relearn: $<HTMLButtonElement>('relearn'),
  resetValues: $<HTMLButtonElement>('reset-values'),
  title: $<HTMLInputElement>('title'),
  intended: $<HTMLSelectElement>('intended'),
  record: $<HTMLButtonElement>('record'),
  recordStatus: $('record-status'),
  band: $('screen-band'),
  bandToggle: $<HTMLInputElement>('band-toggle'),
  checklist: $('checklist'),
};

// ------------------------------------------------------------------------------------ settings

const settings = new SettingsStore(localStoragePersistence());
const get = <K extends SettingKey>(key: K): SettingsMap[K] => settings.get(key, DEFAULT_SETTINGS[key]);
function put<K extends SettingKey>(key: K, value: SettingsMap[K]): void {
  // Like capture, skip writes that change nothing, so a default never becomes a "changed" setting
  // (exports and recordings carry only the values the player changed).
  if (JSON.stringify(get(key)) === JSON.stringify(value)) return;
  try {
    settings.set(key, value);
  } catch (err) {
    console.warn(`[tip-finder] could not save ${key}`, err);
  }
}

/** What the tracker uses: the settings, with route C's defaults for an infrared camera (as the module does). */
function effectiveConfig(): TipConfig {
  const cfg: TipConfig = {
    k: get('brightTip.k'),
    floor: get('brightTip.floor'),
    channel: get('brightTip.channel'),
    minArea: get('brightTip.minArea'),
    maxArea: get('brightTip.maxArea'),
    searchRadius: get('brightTip.searchRadius'),
    lostAfter: get('brightTip.lostAfter'),
    searchWidth: get('brightTip.searchWidth'),
    staticMask: get('brightTip.staticMask'),
    flipX: get('capture.flipX'),
  };
  if (get('brightTip.profile') === 'infrared') {
    const user = settings.changed();
    for (const [key, value] of Object.entries(INFRARED_DEFAULTS) as [keyof TipConfig, never][]) {
      if (!(`brightTip.${key}` in user)) cfg[key] = value;
    }
  }
  return cfg;
}

// ------------------------------------------------------------------------------------ state

let stream: MediaStream | null = null;
let track: MediaStreamTrack | null = null;
let worker: Worker | null = null;
let generation = 0;
let busy = false;
let busySince = 0;
/** The fast path (as in the app): frames straight from the camera track while it runs, when it last
 *  delivered one, and how many video frames arrived since while the worker was idle. */
let feed: Feed | null = null;
let feedSeenAt = 0;
let framesSinceFeed = 0;
let idleWaiters: (() => void)[] = [];
let holding = false;
let exposureInfo: CameraExposureInfo | null = null;
let applying: Promise<void> | null = null;
let pendingExposure: ExposureTarget | null = null;
let relearnId = 0;
let recorder: SessionRecorder | null = null;
let recordTimer: ReturnType<typeof setInterval> | null = null;
let lastReadout = 0;
let contrastEma: number | null = null;

const cameraFrames: { t: number; n: number }[] = [];
const processed: { t: number; found: boolean; stepMs: number }[] = [];
const trail: { x: number; y: number; t: number }[] = [];
let lastResult: (WireResult & { path: string; width: number; height: number }) | null = null;

// ------------------------------------------------------------------------------------ camera

function setStatus(node: HTMLElement, text: string, error = false): void {
  node.textContent = text;
  node.classList.toggle('error', error);
}

function errorText(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera is blocked. Allow camera access in the address bar, then choose Start camera.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found. Plug one in, then choose Start camera.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The camera is in use by another app. Close that app, then choose Start camera.';
  return `The camera could not start: ${(err as { message?: string })?.message ?? String(err)}`;
}

async function listCameras(): Promise<void> {
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const chosen = get('capture.deviceId') ?? '';
    el.cameraSelect.replaceChildren(new Option('Default camera', ''));
    devices.forEach((d, i) => {
      const name = d.label || `Camera ${i + 1}`;
      const opt = new Option(isInfraredLabel(d.label) ? `${name} (infrared)` : name, d.deviceId);
      el.cameraSelect.append(opt);
    });
    el.cameraSelect.value = devices.some((d) => d.deviceId === chosen) ? chosen : '';
  } catch {
    /* the list stays as it is */
  }
}

async function startCamera(): Promise<void> {
  stopCamera();
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    setStatus(el.cameraStatus, 'The camera needs a secure page: open this page over HTTPS or from localhost.', true);
    return;
  }
  const deviceId = el.cameraSelect.value || null;
  setStatus(el.cameraStatus, 'Opening the camera…');
  el.start.disabled = true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: videoConstraints({ deviceId, width: get('capture.width'), height: get('capture.height'), fps: get('capture.fps') }),
    });
  } catch (err) {
    el.start.disabled = false;
    setStatus(el.cameraStatus, errorText(err), true);
    return;
  }
  track = stream.getVideoTracks()[0] ?? null;
  if (!track) {
    stopCamera();
    setStatus(el.cameraStatus, 'The camera gave no picture.', true);
    return;
  }
  track.addEventListener('ended', () => {
    stopCamera();
    setStatus(el.cameraStatus, 'The camera stopped. Plug it back in, then choose Start camera.', true);
  });
  await reachMinFps(track);
  // The app opens the same camera, and treats an infrared one as route C (capture does this on open).
  put('capture.deviceId', deviceId);
  put('brightTip.profile', isInfraredLabel(track.label) ? 'infrared' : 'visible');

  el.video.srcObject = stream;
  try {
    await el.video.play();
  } catch (err) {
    console.warn('[tip-finder] preview would not play', err);
  }
  el.placeholder.hidden = true;
  el.stop.disabled = false;
  el.start.disabled = false;
  el.start.textContent = 'Restart camera';
  el.record.disabled = false;
  el.relearn.disabled = false;

  const caps = typeof track.getCapabilities === 'function' ? (track.getCapabilities() as TrackCapabilities) : undefined;
  exposureInfo = readExposureInfo(caps, track.getSettings() as TrackSettings);
  setupExposureControls();
  // Start where the app would: the exposure saved by this page last time.
  if (exposureInfo && get('capture.exposureMode') === 'manual' && typeof get('capture.exposureTime') === 'number') {
    void applyExposure({ mode: 'manual', time: get('capture.exposureTime')! });
  }

  startWorker();
  startTrackFeed();
  await listCameras();
  describeCamera();
  startFrameLoop();
}

/** Section 7.1: if the preferred size cannot reach capture.minFps, try 1280x720 (as capture does). */
async function reachMinFps(t: MediaStreamTrack): Promise<void> {
  const s = t.getSettings();
  const minFps = get('capture.minFps');
  if ((s.frameRate ?? minFps) >= minFps || (s.height ?? 0) <= FALLBACK_SIZE.height) return;
  try {
    await t.applyConstraints(sizeConstraints(FALLBACK_SIZE.width, FALLBACK_SIZE.height, get('capture.fps')) as MediaTrackConstraints);
    if ((t.getSettings().frameRate ?? 0) <= (s.frameRate ?? 0) && s.width && s.height) {
      await t.applyConstraints(sizeConstraints(s.width, s.height, get('capture.fps')) as MediaTrackConstraints);
    }
  } catch {
    /* keep what we have */
  }
}

function stopCamera(): void {
  finishRecording(false);
  stopTrackFeed();
  for (const t of stream?.getTracks() ?? []) t.stop();
  stream = null;
  track = null;
  worker?.terminate();
  worker = null;
  busy = false;
  holding = false;
  generation++;
  el.video.srcObject = null;
  el.placeholder.hidden = false;
  el.stop.disabled = true;
  el.start.textContent = 'Start camera';
  el.record.disabled = true;
  el.relearn.disabled = true;
  trail.length = 0;
  processed.length = 0;
  cameraFrames.length = 0;
  lastResult = null;
  contrastEma = null;
  clearCanvas(el.overlay);
  clearCanvas(el.threshold);
  setStatus(el.cameraStatus, 'Camera off.');
}

function describeCamera(): void {
  if (!track) return;
  const s = track.getSettings();
  const ir = isInfraredLabel(track.label) ? ' It looks like an infrared camera, so the tracker uses its infrared defaults.' : '';
  setStatus(el.cameraStatus, `${track.label || 'Camera'}: ${s.width} × ${s.height} at ${Math.round(s.frameRate ?? 0)} fps.${ir}`);
}

// ------------------------------------------------------------------------------------ exposure

function setupExposureControls(): void {
  const info = exposureInfo;
  const hasTime = !!info && info.modes.includes('manual') && info.min !== undefined && info.max !== undefined;
  const hasComp = !!info?.compensation;
  el.exposureAuto.disabled = !hasTime && !hasComp;
  el.exposure.disabled = !hasTime && !hasComp;
  if (!hasTime && !hasComp) {
    el.exposureNone.textContent = 'This camera does not let the browser set its exposure. Dim the room instead.';
    el.exposureValue.textContent = '–';
    return;
  }
  el.exposureNone.textContent = hasTime
    ? 'Turn automatic exposure off and lower the time until the room is nearly black.'
    : 'This camera offers exposure compensation only: lower it until the room is nearly black.';
  const live = exposureState(track?.getSettings() as TrackSettings);
  if (hasTime) {
    const time = get('capture.exposureMode') === 'manual' ? (get('capture.exposureTime') ?? live.time ?? 333) : (live.time ?? 333);
    el.exposure.value = String(timeToSlider(time, info!.min!, info!.max!));
    el.exposureAuto.checked = get('capture.exposureMode') !== 'manual';
    el.exposureValue.textContent = formatExposure(time);
  } else {
    const c = info!.compensation!;
    el.exposure.value = String(Math.round((((live.compensation ?? 0) - c.min) / (c.max - c.min || 1)) * 1000));
    el.exposureAuto.checked = true;
    el.exposureValue.textContent = `${(live.compensation ?? 0).toFixed(1)} stops`;
  }
}

function exposureFromSlider(): ExposureTarget | null {
  const info = exposureInfo;
  if (!info) return null;
  const v = Number(el.exposure.value);
  if (info.modes.includes('manual') && info.min !== undefined && info.max !== undefined) {
    return { mode: 'manual', time: sliderToTime(v, info.min, info.max) };
  }
  if (info.compensation) {
    const c = info.compensation;
    return { mode: 'continuous', compensation: c.min + (v / 1000) * (c.max - c.min) };
  }
  return null;
}

/** Apply an exposure to the track, one change at a time (the latest wins), keeping the size. */
async function applyExposure(want: ExposureTarget): Promise<void> {
  pendingExposure = want;
  if (applying) return;
  applying = (async () => {
    while (pendingExposure && track) {
      const target = resolveExposure(exposureInfo, pendingExposure);
      pendingExposure = null;
      const set = target && exposureConstraintSet(exposureInfo, target);
      if (!target || !set) continue;
      const before = track.getSettings();
      try {
        await track.applyConstraints({ advanced: [set] } as CameraConstraints as MediaTrackConstraints);
        const after = track.getSettings();
        if (before.width && before.height && (after.width !== before.width || after.height !== before.height)) {
          await track.applyConstraints(sizeConstraints(before.width, before.height, before.frameRate ?? get('capture.fps')) as MediaTrackConstraints);
        }
      } catch (err) {
        console.warn('[tip-finder] the camera refused the exposure', err);
        continue;
      }
      // The app's starting exposure for this camera (see the header comment).
      put('capture.exposureMode', target.mode);
      put('capture.exposureTime', target.mode === 'manual' ? (target.time ?? null) : null);
      el.exposureValue.textContent = target.mode === 'manual' && target.time !== undefined ? formatExposure(target.time) : target.compensation !== undefined ? `${target.compensation.toFixed(1)} stops` : 'automatic';
    }
  })();
  try {
    await applying;
  } finally {
    applying = null;
  }
}

el.exposure.addEventListener('input', () => {
  const want = exposureFromSlider();
  if (!want) return;
  if (want.mode === 'manual') el.exposureAuto.checked = false;
  el.exposureValue.textContent = want.time !== undefined ? formatExposure(want.time) : `${(want.compensation ?? 0).toFixed(1)} stops`;
  void applyExposure(want);
});

el.exposureAuto.addEventListener('change', () => {
  if (el.exposureAuto.checked) void applyExposure({ mode: 'continuous', compensation: exposureInfo?.compensation ? 0 : undefined });
  else {
    const want = exposureFromSlider();
    if (want) void applyExposure(want);
  }
});

// ------------------------------------------------------------------------------------ tracker

function startWorker(): void {
  worker = new Worker(new URL('../../src/modules/trackers/bright-tip/worker.ts', import.meta.url), { type: 'module', name: 'tip-finder' });
  worker.onmessage = (e: MessageEvent<FromWorker>) => onWorker(e.data);
  worker.onerror = (e) => setStatus(el.cameraStatus, `The tracker stopped: ${e.message || 'unknown error'}`, true);
  generation++;
  post({ type: 'config', config: effectiveConfig() });
  post({ type: 'reset', run: 1, generation });
}

function post(msg: ToWorker, transfer: Transferable[] = []): void {
  worker?.postMessage(msg, transfer);
}

/** The worker is free: the fast path may read its next frame. */
function setIdle(): void {
  busy = false;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const w of waiters) w();
}

/** As in the module: resolves when the worker is free, or once a lost frame has been given up after 1 s. */
async function waitIdle(): Promise<void> {
  while (busy) {
    const timedOut = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), 1000);
      idleWaiters.push(() => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (timedOut && busy && performance.now() - busySince >= 1000) setIdle();
  }
}

/** Frames straight from the camera track where Chromium offers MediaStreamTrackProcessor (feed.ts). */
function startTrackFeed(): void {
  stopTrackFeed();
  const open = browserProcessor();
  const readable = open && track ? open(track, 1) : null;
  if (!readable) return;
  const gen = generation;
  feedSeenAt = performance.now();
  framesSinceFeed = 0;
  const f = startFeed({
    readable,
    now: () => performance.now(),
    fps: track?.getSettings().frameRate ?? 30,
    waitIdle,
    deliver: ({ frame, t, index, width, height }) => {
      feedSeenAt = performance.now();
      framesSinceFeed = 0;
      if (feed !== f || !worker || generation !== gen) {
        frame.close();
        return;
      }
      busy = true;
      busySince = performance.now();
      post({ type: 'frame', run: 1, generation: gen, t, frame: index, width, height, source: frame, debug: true }, [frame]);
    },
  });
  feed = f;
  // If the feed ends on its own, the video takes over (startFrameLoop keeps running either way).
  void f.done.then(() => {
    if (feed === f) feed = null;
  });
}

function stopTrackFeed(): void {
  const f = feed;
  feed = null;
  f?.cancel();
  setIdle();
}

function startFrameLoop(): void {
  const video = el.video;
  if (typeof video.requestVideoFrameCallback === 'function') {
    const tick: VideoFrameRequestCallback = (_now, meta) => {
      if (!stream) return;
      video.requestVideoFrameCallback(tick);
      onFrame(meta);
    };
    video.requestVideoFrameCallback(tick);
    return;
  }
  let last = -1;
  const poll = () => {
    if (!stream) return;
    requestAnimationFrame(poll);
    const q = video.getVideoPlaybackQuality?.();
    const n = q ? q.totalVideoFrames : Math.round(video.currentTime * 1000);
    if (n !== last && video.readyState >= 2) {
      last = n;
      onFrame(null);
    }
  };
  requestAnimationFrame(poll);
}

let frameCounter = 0;
/** Each frame the video shows: counted for the camera's frame rate, and sent on when the fast path is off. */
function onFrame(meta: VideoFrameCallbackMetadata | null): void {
  const now = performance.now();
  const n = meta?.presentedFrames ?? frameCounter;
  frameCounter++;
  cameraFrames.push({ t: now, n });
  while (cameraFrames.length > 2 && now - cameraFrames[0].t > 1500) cameraFrames.shift();
  if (feed) {
    // The video still gets frames: if the fast path has gone quiet while the worker waits (30 video
    // frames and 1.5 s, as in the module: time alone proves nothing after a long task), drop it.
    if (busy) return;
    framesSinceFeed++;
    if (framesSinceFeed < 30 || now - feedSeenAt < 1500) return;
    console.warn('[tip-finder] the camera track stopped handing frames to the fast path; reading the video instead');
    stopTrackFeed();
  }
  if (!worker || (busy && now - busySince < 1000)) return; // one frame in flight; drop the rest
  const video = el.video;
  const width = meta?.width || video.videoWidth, height = meta?.height || video.videoHeight;
  if (!width || !height) return;
  const { t } = frameTimestamp(meta, now, now);
  const send = (source: VideoFrame | ImageBitmap) => {
    if (!worker) {
      source.close();
      return;
    }
    post({ type: 'frame', run: 1, generation, t, frame: n, width, height, source, debug: true }, [source]);
  };
  busy = true;
  busySince = now;
  try {
    send(new VideoFrame(video, { timestamp: Math.round(t * 1000) }));
  } catch {
    createImageBitmap(video).then(send, () => setIdle());
  }
}

function onWorker(msg: FromWorker): void {
  if (msg.type === 'relearned') {
    if (msg.id === relearnId) setStatus(el.cameraStatus, 'The room is learned again.');
    return;
  }
  if (msg.type === 'error') {
    console.warn('[tip-finder] worker:', msg.message);
    return;
  }
  // The next frame is read when this handler has finished (the waiters resume afterwards).
  setIdle();
  if (msg.type === 'skipped') return;
  if (msg.generation !== generation) {
    msg.debug?.image.close();
    return;
  }
  const r = msg.result;
  const now = performance.now();
  processed.push({ t: now, found: !!r.sample, stepMs: msg.stepMs });
  while (processed.length > 60) processed.shift();
  lastResult = { ...r, path: msg.path, width: msg.width, height: msg.height };

  // Tip events, as the module sends them, for the recording.
  if (r.sample) {
    const tip: RecordedTip = { t: msg.t, x: r.sample.x, y: r.sample.y, conf: r.sample.conf, size: r.sample.size, frame: msg.frame };
    if (!holding) {
      holding = true;
      recorder?.found(tip);
    }
    recorder?.sample(tip);
    trail.push({ x: r.sample.x, y: r.sample.y, t: now });
  } else if (holding && (r.lost || r.state === 'searching')) {
    holding = false;
    recorder?.lost(msg.t);
  }
  while (trail.length && now - trail[0].t > 1500) trail.shift();
  if (r.contrast !== null) contrastEma = contrastEma === null ? r.contrast : 0.85 * contrastEma + 0.15 * r.contrast;

  drawOverlay(r);
  if (msg.debug) drawThreshold(msg.debug.image, r.blobs);
  if (now - lastReadout > 200) {
    lastReadout = now;
    updateReadout();
  }
}

// ------------------------------------------------------------------------------------ drawing

function clearCanvas(c: HTMLCanvasElement): void {
  c.getContext('2d')?.clearRect(0, 0, c.width, c.height);
}

/** The rectangle the video occupies inside its box (object-fit: contain). */
function contentRect(boxW: number, boxH: number, vw: number, vh: number): { x: number; y: number; w: number; h: number } {
  if (!vw || !vh) return { x: 0, y: 0, w: boxW, h: boxH };
  const s = Math.min(boxW / vw, boxH / vh);
  const w = vw * s, h = vh * s;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

function drawOverlay(r: WireResult): void {
  const c = el.overlay;
  const dpr = window.devicePixelRatio || 1;
  const bw = c.clientWidth, bh = c.clientHeight;
  if (c.width !== Math.round(bw * dpr) || c.height !== Math.round(bh * dpr)) {
    c.width = Math.round(bw * dpr);
    c.height = Math.round(bh * dpr);
  }
  const ctx = c.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, bw, bh);
  const box = contentRect(bw, bh, el.video.videoWidth, el.video.videoHeight);
  // Caster space maps straight onto the picture: the preview is mirrored exactly when x is flipped.
  const px = (x: number) => box.x + x * box.w, py = (y: number) => box.y + y * box.h;
  if (trail.length > 1) {
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < trail.length; i++) {
      ctx.strokeStyle = `rgba(242, 184, 75, ${(i / trail.length) * 0.8})`;
      ctx.beginPath();
      ctx.moveTo(px(trail[i - 1].x), py(trail[i - 1].y));
      ctx.lineTo(px(trail[i].x), py(trail[i].y));
      ctx.stroke();
    }
  }
  for (const b of r.blobs) drawBlob(ctx, b, px, py, box.w);
}

function drawBlob(ctx: CanvasRenderingContext2D, b: DebugBlob, px: (x: number) => number, py: (y: number) => number, scale: number): void {
  const radius = Math.max(6, b.r * scale * 2.5);
  ctx.lineWidth = b.chosen ? 2.5 : 1.5;
  ctx.strokeStyle = b.chosen ? '#F2B84B' : 'rgba(154, 157, 176, 0.9)';
  ctx.beginPath();
  ctx.arc(px(b.x), py(b.y), radius, 0, Math.PI * 2);
  ctx.stroke();
}

function drawThreshold(image: ImageBitmap, blobs: DebugBlob[]): void {
  const c = el.threshold;
  if (c.width !== image.width || c.height !== image.height) {
    c.width = image.width;
    c.height = image.height;
  }
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.drawImage(image, 0, 0);
    for (const b of blobs) drawBlob(ctx, b, (x) => x * c.width, (y) => y * c.height, c.width);
  }
  image.close();
}

function updateReadout(): void {
  const r = lastResult;
  const now = performance.now();
  const recent = processed.slice(-10);
  const found = recent.filter((p) => p.found).length;
  el.rFound.textContent = recent.length ? `${found} of the last ${recent.length} frames` : '–';
  if (!r) return;
  el.rTip.textContent = r.tipLevel !== null ? `${r.tipLevel} of 255` : 'no tip';
  el.rBg.textContent = `${r.backgroundMax} of 255`;
  const c = r.sample ? contrastEma : null;
  el.rContrast.textContent = c === null ? '–' : `${c.toFixed(1)}×`;
  const verdict = el.rVerdict;
  if (c === null) {
    verdict.className = 'wide verdict';
    verdict.textContent = 'Waiting for the tip.';
  } else if (c >= 3) {
    verdict.className = 'wide verdict pass';
    verdict.textContent = 'Passes: the tip is at least 3 times brighter than anything else.';
  } else {
    verdict.className = 'wide verdict fail';
    verdict.textContent = 'Not yet: dim the room or lower the exposure.';
  }
  const chosen = r.blobs.find((b) => b.chosen);
  if (r.sample) {
    el.rSize.textContent = `${(r.sample.radiusPx * 2).toFixed(1)} px across, ${r.sample.areaPx} px²`;
  } else el.rSize.textContent = '–';
  el.rStreak.textContent = chosen && chosen.minor > 0 ? `${(chosen.major / chosen.minor).toFixed(1)}× as long as wide (aim for under 2)` : '–';
  const camFps = cameraFrames.length > 1 ? ((cameraFrames.at(-1)!.n - cameraFrames[0].n) / (cameraFrames.at(-1)!.t - cameraFrames[0].t)) * 1000 : 0;
  const lastSecond = processed.filter((p) => now - p.t <= 1000);
  el.rFps.textContent = `camera ${Math.round(camFps)}, tracked ${lastSecond.length}`;
  const steps = processed.slice(-30).map((p) => p.stepMs).sort((a, b) => a - b);
  el.rStep.textContent = steps.length ? `${steps[steps.length >> 1].toFixed(1)} ms a frame (budget 4 ms)` : '–';
  const path = r.path === 'y-plane' ? 'luma plane' : r.path === 'rgba-copy' ? 'RGBA copy' : 'canvas';
  const from = feed ? 'straight from the camera' : 'from the video';
  el.rCapture.textContent = `${r.width} × ${r.height}, ${path}, read ${from}`;
}

// ------------------------------------------------------------------------------------ controls

function syncControls(): void {
  const cfg = effectiveConfig();
  el.k.value = String(cfg.k);
  el.kValue.textContent = String(cfg.k);
  el.floor.value = String(cfg.floor);
  el.floorValue.textContent = String(cfg.floor);
  el.channel.value = cfg.channel;
  el.mask.checked = cfg.staticMask;
  el.flip.checked = cfg.flipX;
  el.video.classList.toggle('mirrored', cfg.flipX);
}

function configChanged(): void {
  syncControls();
  post({ type: 'config', config: effectiveConfig() });
  trail.length = 0;
}

el.k.addEventListener('input', () => {
  put('brightTip.k', Number(el.k.value));
  configChanged();
});
el.floor.addEventListener('input', () => {
  put('brightTip.floor', Number(el.floor.value));
  configChanged();
});
el.channel.addEventListener('change', () => {
  put('brightTip.channel', el.channel.value as Channel);
  configChanged();
});
el.mask.addEventListener('change', () => {
  put('brightTip.staticMask', el.mask.checked);
  configChanged();
});
el.flip.addEventListener('change', () => {
  put('capture.flipX', el.flip.checked);
  configChanged();
});
el.resetValues.addEventListener('click', () => {
  for (const key of ['brightTip.k', 'brightTip.floor', 'brightTip.channel', 'brightTip.staticMask', 'capture.flipX'] as const) settings.reset(key);
  configChanged();
});
el.relearn.addEventListener('click', () => {
  relearnId++;
  post({ type: 'relearn', run: 1, id: relearnId });
  setStatus(el.cameraStatus, 'Learning the room: keep the tip out of view for a second.');
});
el.start.addEventListener('click', () => void startCamera());
el.stop.addEventListener('click', () => stopCamera());
el.cameraSelect.addEventListener('change', () => {
  if (stream) void startCamera();
});
el.bandToggle.addEventListener('change', () => {
  el.band.hidden = !el.bandToggle.checked;
});
navigator.mediaDevices?.addEventListener?.('devicechange', () => void listCameras());
window.addEventListener('pagehide', () => stopCamera());

// ------------------------------------------------------------------------------------ recording

el.record.addEventListener('click', () => {
  if (recorder) finishRecording(true);
  else startRecording();
});

function startRecording(): void {
  if (!stream) return;
  const start = performance.now();
  recorder = new SessionRecorder(start);
  el.record.classList.add('recording');
  const tick = () => {
    const left = Math.max(0, RECORD_MS - (performance.now() - start));
    el.record.textContent = `Recording, ${Math.ceil(left / 1000)} s (choose to stop)`;
    if (left <= 0) finishRecording(true);
  };
  tick();
  recordTimer = setInterval(tick, 250);
}

/** Settings that shape the pipeline and differ from the defaults (RecordedSession.settings). */
function pipelineSettings(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings.changed())) {
    if (/^(brightTip|capture\.flipX|filter|segmenter|recognizer|engine|playArea)/.test(key)) out[key] = value;
  }
  return out;
}

function finishRecording(save: boolean): void {
  if (recordTimer) clearInterval(recordTimer);
  recordTimer = null;
  const rec = recorder;
  recorder = null;
  el.record.classList.remove('recording');
  el.record.textContent = 'Record 10 s';
  if (!rec || !save || !track) return;
  const s = track.getSettings() as TrackSettings;
  const live = exposureState(s);
  const session = rec.finish(performance.now(), {
    id: newId('session'),
    title: el.title.value.trim() || undefined,
    intended: el.intended.value || undefined,
    aspect: (s.width ?? 16) / (s.height ?? 9),
    settings: pipelineSettings(),
    camera: { label: track.label, width: s.width ?? 0, height: s.height ?? 0, fps: Math.round(s.frameRate ?? 0), exposure: { mode: live.mode, time: live.time } },
  });
  const samples = session.events.filter((e) => e.type === 'tip.sample').length;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `tip-session-${stamp}.json`;
  const url = URL.createObjectURL(new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  setStatus(el.recordStatus, `Saved ${filename} with ${samples} tip samples.`);
}

// ------------------------------------------------------------------------------------ checklist and spells

function loadChecklist(): void {
  let done: number[] = [];
  try {
    done = JSON.parse(localStorage.getItem(CHECKLIST_KEY) ?? '[]');
  } catch {
    done = [];
  }
  for (const li of el.checklist.querySelectorAll<HTMLLIElement>('li[data-step]')) {
    const step = Number(li.dataset.step);
    const box = li.querySelector<HTMLInputElement>('label:first-child input[type=checkbox]');
    if (!box) continue;
    box.checked = done.includes(step);
    li.classList.toggle('done', box.checked);
    box.addEventListener('change', () => {
      li.classList.toggle('done', box.checked);
      const now = [...el.checklist.querySelectorAll<HTMLLIElement>('li[data-step]')]
        .filter((x) => x.querySelector<HTMLInputElement>('label:first-child input')?.checked)
        .map((x) => Number(x.dataset.step));
      try {
        localStorage.setItem(CHECKLIST_KEY, JSON.stringify(now));
      } catch {
        /* a private window: the ticks last for this visit */
      }
    });
  }
}

/** The spells, for labelling a recording with what was cast (same origin; quietly skipped if absent). */
async function loadSpells(): Promise<void> {
  try {
    const base = import.meta.env.BASE_URL;
    const index = (await (await fetch(`${base}packs/index.json`)).json()) as { packs: { kind: string; path: string }[] };
    for (const p of index.packs.filter((x) => x.kind === 'spellpack')) {
      const pack = (await (await fetch(`${base}packs/${p.path}`)).json()) as { title: string; spells: { id: string; incantation: string }[] };
      const group = document.createElement('optgroup');
      group.label = pack.title;
      for (const s of pack.spells) group.append(new Option(s.incantation, s.id));
      el.intended.append(group);
    }
  } catch {
    /* no packs: the field keeps "None" */
  }
}

syncControls();
loadChecklist();
void loadSpells();
void listCameras();
