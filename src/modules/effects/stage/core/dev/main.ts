// Dev harness for the stage (throwaway, not part of the app): a kernel with only the stage, a fake
// "room" camera, a spellbook built from the bundled packs, and scripted events. Time is virtual so
// screenshots are repeatable: window.__dev.freeze() stops the clock and __dev.step(ms) advances it
// frame by frame. Serve with `npx vite --port 5181 --strictPort` and open
// /src/modules/effects/stage/core/dev/index.html.

import '@fontsource/im-fell-english/latin-400.css';
import '@fontsource/im-fell-english/latin-400-italic.css';
import type {
  CameraReady, Point, SceneProps, SpellbookEntry, SpellCast, Stroke, TipSample,
} from '../../../../../contracts';
import { createKernel, emit, geometry, gesturePaceMs, gesturePaths, memoryPersistence } from '../../../../../kernel';
import { emptyShelf, MANIFEST } from '../../index';
import { createShelf } from '../../props';
import type { Shelf } from '../../types';
import { StageCore } from '../stage';
import { buildSpellbook } from './spellbook';

const shelf: Shelf = new URLSearchParams(location.search).get('shelf') === 'off' ? emptyShelf() : createShelf();

const params = new URLSearchParams(location.search);
let now = performance.now();
let live = true;
const kernel = createKernel({
  persistence: memoryPersistence({
    'capture.consent': params.get('camera') !== 'off',
    'capture.mirror': params.get('camera') !== 'off',
    'access.reducedMotion': params.get('reduced') === '1' ? 'on' : 'off',
    'access.highContrastTrail': params.get('contrast') === '1',
    'stage.quality': 'high',
  }),
  clock: () => now,
  features: ['platform.dom'],
});

const mirror = document.getElementById('mirror')!;
const core = new StageCore(MANIFEST, { host: mirror, shelf, seed: 11 });
kernel.register(core.module());

// ------------------------------------------------------------------ a fake camera: a dim study with a figure

function paintRoom(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#2a2119');
  bg.addColorStop(1, '#120e0c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const lamp = ctx.createRadialGradient(w * 0.12, h * 0.18, 0, w * 0.12, h * 0.18, w * 0.4);
  lamp.addColorStop(0, 'rgba(255, 200, 140, 0.55)');
  lamp.addColorStop(1, 'rgba(255, 200, 140, 0)');
  ctx.fillStyle = lamp;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#1b1512';
  for (let i = 0; i < 5; i++) ctx.fillRect(w * (0.66 + i * 0.06), h * 0.12, w * 0.045, h * 0.5);
  ctx.fillStyle = '#4a3a33';
  ctx.beginPath();
  ctx.moveTo(w * 0.3, h);
  ctx.bezierCurveTo(w * 0.3, h * 0.66, w * 0.38, h * 0.6, w * 0.5, h * 0.6);
  ctx.bezierCurveTo(w * 0.62, h * 0.6, w * 0.7, h * 0.66, w * 0.7, h);
  ctx.fill();
  ctx.fillStyle = '#8a6a58';
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.4, h * 0.11, h * 0.14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#2b1f1a';
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.31, h * 0.12, h * 0.08, 0, Math.PI, Math.PI * 2);
  ctx.fill();
}

// ?cam=43 gives the fake camera a 4:3 frame, so the mirror (16:9) letterboxes caster space.
const room = document.createElement('canvas');
room.width = params.get('cam') === '43' ? 960 : 1280;
room.height = 720;
const roomCtx = room.getContext('2d')!;
paintRoom(roomCtx, room.width, room.height);
const roomStream = room.captureStream(10);
setInterval(() => paintRoom(roomCtx, room.width, room.height), 200);
let generation = 0;

kernel.handle('camera.start', async () => {
  const ready: CameraReady = {
    deviceId: 'room', label: 'Fake room', width: room.width, height: room.height, fps: 30, stream: roomStream, exposure: null, infrared: false,
    generation: ++generation,
  };
  emit(kernel, 'capture', 'camera.ready', ready);
  return ready;
});
kernel.handle('camera.stop', async () => {});

// ------------------------------------------------------------------ a fake engine for replays

let castN = 0;
kernel.handle('engine.cast', (p: { spellId: string; aim?: { x: number; y: number }; targetId?: string; variant?: boolean; holdMs?: number; detail?: SpellCast['detail'] }) => {
  const e = entry(p.spellId);
  const cast: SpellCast = {
    id: `replay-${++castN}`, spellId: p.spellId, t: now, via: 'gesture', quality: 0.9, power: 0.5, aim: p.aim ?? { x: 0.5, y: 0.5 }, replay: true,
    incantation: e?.spell.incantation, ...(p.targetId ? { targetId: p.targetId } : {}), ...(p.detail ? { detail: p.detail } : {}),
  };
  emit(kernel, 'engine', 'spell.cast', cast);
  if (e?.lasts !== null && e?.lasts !== undefined) {
    const hold = p.holdMs ?? (typeof e.lasts === 'number' ? Math.min(e.lasts, 8000) : 4000);
    setTimeout(() => emit(kernel, 'engine', 'spell.ended', { spellId: p.spellId, castId: cast.id, t: now, by: 'replay' }), hold);
  }
  return cast;
});

// ------------------------------------------------------------------ scripted input

let book: Awaited<ReturnType<typeof buildSpellbook>> | null = null;
const entry = (id: string): SpellbookEntry | undefined => book?.spells.find((s) => s.spell.id === id);
let lastStroke: { id: string; points: Point[] } | null = null;
let holdTip: { x: number; y: number } | null = null;
let strokeN = 0;

function step(ms: number): void {
  const end = now + ms;
  while (now < end) {
    now = Math.min(end, now + 16);
    if (holdTip) emit(kernel, 'stroke', 'tip.filtered', { t: now, x: holdTip.x, y: holdTip.y, conf: 1, src: 'tracker.pointer' });
    core.tick(now, true);
  }
}

function aspect(): number {
  return core.view.casterAspect;
}

/** The spell's shape in caster space, in a box round (cx, cy), with a little hand wobble. */
function scripted(spellId: string, cx = 0.5, cy = 0.45, size = 0.42): Point[] {
  const e = entry(spellId);
  if (!e) return [];
  const g = e.spell.gesture;
  const unit = 'flick' in g ? geometry.flickPath(g.flick, 32) : geometry.resample(gesturePaths(g)[0], 72);
  const a = aspect();
  const box = { minX: cx * a - size / 2, maxX: cx * a + size / 2, minY: cy - size / 2, maxY: cy + size / 2, w: size, h: size };
  return geometry.fromIsotropic(geometry.fitInto(unit, box), a).map(([x, y], i) => [x + 0.004 * Math.sin(i * 0.45), y + 0.004 * Math.cos(i * 0.31)] as Point);
}

function trace(spellId: string, fraction = 1, at?: { cx?: number; cy?: number; size?: number }): string {
  const e = entry(spellId);
  const path = scripted(spellId, at?.cx, at?.cy, at?.size);
  const id = `stroke-${++strokeN}`;
  const pace = (e ? gesturePaceMs(e.spell.gesture) : 1000) * 1.25;
  const samples: TipSample[] = [];
  holdTip = null;
  emit(kernel, 'stroke', 'segmenter.state', { state: 'tracing', t: now, mode: 'hold-still', strokeId: id });
  emit(kernel, 'stroke', 'stroke.begin', { id, points: [], t0: now, t1: now, quality: 1 } as Stroke);
  const steps = Math.max(2, Math.round(pace / 16));
  const last = Math.round(steps * fraction);
  for (let k = 0; k <= last; k++) {
    const u = 0.5 - 0.5 * Math.cos((Math.PI * k) / steps);
    const p = geometry.pointAt(path, u);
    const s: TipSample = { t: now, x: p[0], y: p[1], conf: 1, src: 'tracker.pointer' };
    samples.push(s);
    emit(kernel, 'stroke', 'tip.filtered', s);
    step(16);
  }
  const tail = samples[samples.length - 1];
  holdTip = { x: tail.x, y: tail.y };
  if (fraction >= 1) {
    emit(kernel, 'stroke', 'segmenter.state', { state: 'evaluating', t: now, mode: 'hold-still', strokeId: id });
    emit(kernel, 'stroke', 'stroke.end', { id, points: samples, t0: samples[0].t, t1: tail.t, quality: 0.9, aspect: aspect(), src: 'tracker.pointer', endReason: 'pause' });
  }
  lastStroke = { id, points: samples.map((s) => [s.x, s.y] as Point) };
  return id;
}

function targetFor(spellId: string, aim: { x: number; y: number }): string | undefined {
  const e = entry(spellId);
  const sp = kernel.last<SceneProps>('scene.props')?.payload;
  if (!e?.spell.targets?.length || !sp?.props.length) return undefined;
  for (const tag of e.spell.targets) {
    const ok = sp.props.filter((p) => tag === 'prop.any' || p.tags.includes(tag));
    if (!ok.length) continue;
    ok.sort((a, b) => Math.hypot((a.x - aim.x) * sp.aspect, a.y - aim.y) - Math.hypot((b.x - aim.x) * sp.aspect, b.y - aim.y));
    return ok[0].id;
  }
  return undefined;
}

function cast(spellId: string, opts: { variant?: string; scale?: number; voice?: boolean; target?: string; aim?: { x: number; y: number } } = {}): SpellCast {
  const e = entry(spellId);
  const stroke = opts.voice ? null : lastStroke;
  const aim = opts.aim ?? (stroke ? { x: stroke.points[stroke.points.length - 1][0], y: stroke.points[stroke.points.length - 1][1] } : { x: 0.5, y: 0.5 });
  let aligned: Point[] | undefined;
  if (stroke && e) {
    const g = e.spell.gesture;
    if ('flick' in g) aligned = [stroke.points[0], stroke.points[stroke.points.length - 1]];
    else {
      const a = aspect();
      aligned = geometry.fromIsotropic(geometry.fitInto(geometry.resample(gesturePaths(g)[0], 64), geometry.bbox(geometry.toIsotropic(stroke.points, a))), a);
    }
  }
  const c: SpellCast = {
    id: `cast-${++castN}`, spellId, t: now, via: opts.voice ? 'voice' : 'gesture', quality: 0.9, power: 0.6, aim,
    incantation: e?.spell.incantation,
    ...(stroke ? { strokeId: stroke.id } : {}),
    ...(opts.variant ? { variant: opts.variant } : {}),
    ...(opts.scale ? { effectScale: opts.scale } : {}),
    ...((opts.target ?? targetFor(spellId, aim)) ? { targetId: opts.target ?? targetFor(spellId, aim) } : {}),
    ...(aligned ? { detail: { spellId, score: 0.9, template: 'seed:0', pathIndex: 0, deviation: [], aligned, rotation: 0, reached: 1 } } : {}),
  };
  emit(kernel, 'engine', 'spell.cast', c);
  emit(kernel, 'stroke', 'segmenter.state', { state: 'cooldown', t: now, mode: 'hold-still' });
  return c;
}

const dev = {
  ready: false,
  core,
  kernel,
  freeze() {
    live = false;
  },
  live() {
    live = true;
  },
  step,
  holdTipAt(x: number, y: number) {
    holdTip = { x, y };
    emit(kernel, 'stroke', 'tip.filtered', { t: now, x, y, conf: 1, src: 'tracker.pointer' });
  },
  /** Move the held tip to (x, y) over `ms`, frame by frame (steering: Leviosa, Locomotor, Imperio). */
  glide(x: number, y: number, ms: number) {
    const from = holdTip ?? { x, y };
    const frames = Math.max(1, Math.round(ms / 16));
    for (let k = 1; k <= frames; k++) {
      const u = 0.5 - 0.5 * Math.cos((Math.PI * k) / frames);
      holdTip = { x: from.x + (x - from.x) * u, y: from.y + (y - from.y) * u };
      step(16);
    }
  },
  releaseTip() {
    holdTip = null;
    emit(kernel, 'tracker', 'tip.lost', { t: now, src: 'tracker.pointer' });
  },
  hover(progress: number, x = 0.5, y = 0.66) {
    dev.holdTipAt(x, y);
    emit(kernel, 'stroke', 'segmenter.state', { state: progress >= 1 ? 'armed' : 'hovering', t: now, mode: 'hold-still', armProgress: Math.min(1, progress) });
  },
  trace,
  cast,
  fizzle(reason: 'low-score' | 'steering' | 'ignored' = 'low-score') {
    emit(kernel, 'engine', 'spell.fizzle', { id: `fizzle-${++castN}`, t: now, strokeId: lastStroke?.id, reason, quality: 0.4, stray: { from: 0.5, to: 0.8 } });
  },
  pending() {
    if (lastStroke) emit(kernel, 'engine', 'spell.pending', { strokeId: lastStroke.id, until: now + 2500, waitingFor: 'voice' });
  },
  end(c: SpellCast, by: string, byCastId?: string) {
    emit(kernel, 'engine', 'spell.ended', { spellId: c.spellId, castId: c.id, t: now, by, ...(byCastId ? { byCastId } : {}) });
  },
  practice(spellId: string | null) {
    emit(kernel, 'shell', 'practice.focus', { spellId });
  },
  slowly(spellId: string) {
    emit(kernel, 'shell', 'practice.guide', { spellId, slow: true });
  },
  attempt(spellId: string) {
    if (lastStroke) emit(kernel, 'engine', 'practice.attempt', { spellId, attempt: 1, success: false, score: 0.6, quality: 0.5, strokeId: lastStroke.id, stray: { from: 0.55, to: 0.85 } });
  },
  replay(spellId: string, backdrop: 'plain' | 'camera' = 'plain') {
    const points = scripted(spellId).filter((_, i, a) => i % Math.ceil(a.length / 64) === 0);
    return kernel.request('stage.replay', { spellId, points, aspect: aspect(), durationMs: 1200, via: 'gesture', quality: 0.9, power: 0.5, variant: false, backdrop });
  },
  async set(key: string, value: unknown) {
    await kernel.request('settings.set', { key, value });
  },
  reset() {
    return kernel.request('stage.reset');
  },
  /** The bright-tip tracker's short manual exposure: the stage lifts the reflection. */
  exposure(mode: 'manual' | 'continuous', time = 20) {
    emit(kernel, 'capture', 'camera.status', { state: 'on', generation, permission: 'granted', exposure: { mode, time } });
  },
  /** Start a clip ('stage.capture.start') and show its stream in #clip, under the frame. */
  async clip(includeCamera: boolean) {
    const { stream } = await kernel.request<{ stream: MediaStream }>('stage.capture.start', { requester: 'dev', includeCamera, fps: 30 });
    const v = document.getElementById('clip') as HTMLVideoElement;
    v.srcObject = stream;
    await v.play().catch(() => {});
    return { tracks: stream.getVideoTracks().length };
  },
  async clipStop() {
    await kernel.request('stage.capture.stop', { requester: 'dev' });
  },
  /** The sticky stage.surface, summarized. */
  surface() {
    const s = kernel.last<{ caster: unknown; aspect: number; width: number; height: number; dpr: number; videoMirrored: boolean; video: unknown; layers: { blend: string }[] }>('stage.surface')?.payload;
    return s ? { caster: s.caster, aspect: s.aspect, width: s.width, height: s.height, dpr: s.dpr, mirrored: s.videoMirrored, video: !!s.video, layers: s.layers.map((l) => l.blend) } : null;
  },
};
(window as unknown as { __dev: typeof dev }).__dev = dev;

let lastReal = performance.now();
const drive = (ts: number) => {
  if (live) now += Math.min(50, Math.max(0, ts - lastReal));
  lastReal = ts;
  requestAnimationFrame(drive);
};
requestAnimationFrame(drive);

(async () => {
  await kernel.init();
  await kernel.start();
  book = await buildSpellbook(import.meta.env.BASE_URL);
  emit(kernel, 'kernel.packs', 'spellbook.changed', book);
  await document.fonts.load('italic 400 48px "IM Fell English"');
  await new Promise((r) => setTimeout(r, 300));
  dev.ready = true;
  document.body.dataset.ready = '1';
})();
