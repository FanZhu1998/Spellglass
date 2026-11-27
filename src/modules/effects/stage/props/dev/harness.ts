// Dev harness for the shelf of props: stands in for the stage core (view, layers, particles, tip, glow,
// vignette) so the props can be looked at and poked in Chrome. Not part of the app: nothing imports it,
// and the app's build only takes index.html. window.harness drives it from dev/shoot.ts:
//  - still(name): reset, play a scripted scene, stop the clock (for screenshots);
//  - strip(name): a film strip of one action, frames composited exactly as the page stacks them
//    (room, shade, then light with 'screen'), returned as a PNG data URL;
//  - crops(): where each prop is on the page, for close-ups.
// What is copied from the core (core/sprites.ts glow and core/stage.ts guarded) is copied, and the
// glass is the core's own painter, so the props look here as they will in the app.

import type { EffectStep, ParticlePreset, SpellCast } from '../../../../../contracts';
import type { BurstOptions, FrameInfo, Layers, PropView, StageServices, StageView } from '../../types';
import { paintGlass, REFLECTION_GRADE } from '../../core/glass';
import { createShelf } from '../index';

const params = new URLSearchParams(location.search);
if (params.get('shot')) document.body.classList.add('shot');
const bright = params.get('room') === 'bright';
const casterAspect = (() => {
  const m = /^(\d+):(\d+)$/.exec(params.get('caster') ?? '16:9');
  return m ? Number(m[1]) / Number(m[2]) : 16 / 9;
})();

const mirror = document.getElementById('mirror') as HTMLDivElement;
const roomCanvas = document.getElementById('room') as HTMLCanvasElement;
const shadeCanvas = document.getElementById('shade') as HTMLCanvasElement;
const lightCanvas = document.getElementById('light') as HTMLCanvasElement;
const layers: Layers = {
  shade: shadeCanvas.getContext('2d') as CanvasRenderingContext2D,
  light: lightCanvas.getContext('2d') as CanvasRenderingContext2D,
};
const roomCtx = roomCanvas.getContext('2d') as CanvasRenderingContext2D;
// The room stands in for the camera, so it is shown through the old silver's grade, as the stage's video is.
roomCanvas.style.filter = REFLECTION_GRADE;

// ------------------------------------------------------------------ the view (caster space letterboxed)

let W = 1;
let H = 1;
let dpr = 1;
const caster = { x: 0, y: 0, w: 1, h: 1 };

const view: StageView = {
  get width() { return W; },
  get height() { return H; },
  get dpr() { return dpr; },
  get aspect() { return W / H; },
  toPx: (x, y) => [(caster.x + x * caster.w) * dpr, (caster.y + y * caster.h) * dpr],
  fromPx: (px, py) => [(px / dpr - caster.x) / caster.w, (py / dpr - caster.y) / caster.h],
  size: (f) => f * H * dpr,
};

let overlay: HTMLCanvasElement | null = null;

function layout(): void {
  const r = mirror.getBoundingClientRect();
  W = Math.max(1, r.width);
  H = Math.max(1, r.height);
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.min(W, H * casterAspect);
  const ch = cw / casterAspect;
  caster.x = (W - cw) / 2;
  caster.y = (H - ch) / 2;
  caster.w = cw;
  caster.h = ch;
  for (const c of [roomCanvas, shadeCanvas, lightCanvas]) {
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
  }
  paintRoom();
  overlay = paintOverlay(roomCanvas.width, roomCanvas.height);
}

/** A stand-in for the camera image: a room with a figure in it, inside the caster rectangle. */
function paintRoom(): void {
  const c = roomCtx;
  const k = dpr;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.fillStyle = '#05070c';
  c.fillRect(0, 0, roomCanvas.width, roomCanvas.height);
  const x0 = caster.x * k;
  const y0 = caster.y * k;
  const w = caster.w * k;
  const h = caster.h * k;
  const g = c.createLinearGradient(0, y0, 0, y0 + h);
  g.addColorStop(0, bright ? '#8a847c' : '#1b1f2b');
  g.addColorStop(0.6, bright ? '#77706a' : '#141821');
  g.addColorStop(1, bright ? '#5b544d' : '#0c0f16');
  c.fillStyle = g;
  c.fillRect(x0, y0, w, h);
  // A window's glow, a bookcase, and the player lit by the screen.
  const win = c.createRadialGradient(x0 + w * 0.18, y0 + h * 0.2, 0, x0 + w * 0.18, y0 + h * 0.2, w * 0.25);
  win.addColorStop(0, bright ? 'rgba(255,248,230,0.7)' : 'rgba(120,140,190,0.18)');
  win.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = win;
  c.fillRect(x0, y0, w, h);
  c.fillStyle = bright ? 'rgba(60,40,28,0.55)' : 'rgba(20,14,10,0.6)';
  c.fillRect(x0 + w * 0.74, y0 + h * 0.08, w * 0.2, h * 0.7);
  for (let i = 1; i < 5; i++) {
    c.fillStyle = bright ? 'rgba(30,20,12,0.6)' : 'rgba(8,6,4,0.7)';
    c.fillRect(x0 + w * 0.74, y0 + h * (0.08 + i * 0.14), w * 0.2, h * 0.012);
  }
  const face = c.createRadialGradient(x0 + w * 0.5, y0 + h * 0.4, 0, x0 + w * 0.5, y0 + h * 0.5, h * 0.55);
  face.addColorStop(0, bright ? 'rgba(230,200,170,0.75)' : 'rgba(150,135,125,0.4)');
  face.addColorStop(0.5, bright ? 'rgba(170,140,120,0.45)' : 'rgba(70,64,64,0.25)');
  face.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = face;
  c.beginPath();
  c.ellipse(x0 + w * 0.5, y0 + h * 0.36, h * 0.13, h * 0.17, 0, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.ellipse(x0 + w * 0.5, y0 + h * 0.86, h * 0.42, h * 0.33, 0, Math.PI, 0);
  c.fill();
  const vig = c.createRadialGradient(x0 + w / 2, y0 + h / 2, h * 0.3, x0 + w / 2, y0 + h / 2, w * 0.7);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.55)');
  c.fillStyle = vig;
  c.fillRect(x0, y0, w, h);
}

/** The core's glass (core/glass.ts, as core/stage.ts renderOverlay paints it), drawn on the shade
 *  layer before the shelf, as in the app. */
function paintOverlay(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  paintGlass(c.getContext('2d') as CanvasRenderingContext2D, w, h);
  return c;
}

// ------------------------------------------------------------------ particles (a minimal stand-in)

interface Particle { x: number; y: number; vx: number; vy: number; age: number; life: number; size: number; color: string; shade: boolean; rise: number; grow: number }
const particles: Particle[] = [];
const PRESETS: Record<ParticlePreset, { color: string; speed: number; life: number; size: number; shade: boolean; rise: number; grow: number }> = {
  sparks: { color: '#FFD27A', speed: 0.5, life: 700, size: 2.2, shade: false, rise: 0.5, grow: 0 },
  embers: { color: '#FF8A2A', speed: 0.3, life: 1100, size: 2.2, shade: false, rise: -0.25, grow: 0 },
  water: { color: '#9FD3FF', speed: 0.5, life: 800, size: 2.4, shade: false, rise: 0.8, grow: 0 },
  mist: { color: '#C9D8F0', speed: 0.12, life: 1300, size: 7, shade: false, rise: -0.05, grow: 1.5 },
  stars: { color: '#FFF4D6', speed: 0.35, life: 900, size: 2.4, shade: false, rise: 0, grow: 0 },
  dust: { color: '#9A8A70', speed: 0.3, life: 1100, size: 2.2, shade: true, rise: 0.45, grow: 0 },
  smoke: { color: '#8A8C96', speed: 0.08, life: 1700, size: 5, shade: true, rise: -0.12, grow: 2.2 },
};

let seed = 7;
const random = (): number => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

function burst(o: BurstOptions): void {
  const p = PRESETS[o.preset];
  const n = Math.min(200, o.count ?? 20);
  const dir = ((o.directionDeg ?? -90) * Math.PI) / 180;
  const spread = ((o.spreadDeg ?? 360) * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const a = dir + (random() - 0.5) * spread;
    const s = p.speed * (o.speed ?? 1) * (0.35 + random() * 0.8);
    particles.push({
      x: o.x, y: o.y, vx: (Math.cos(a) * s) / casterAspect, vy: Math.sin(a) * s, age: 0,
      life: (o.lifeMs ?? p.life) * (0.6 + random() * 0.6), size: p.size * (o.size ?? 1) * (0.6 + random() * 0.8),
      color: o.color ?? p.color, shade: p.shade, rise: p.rise, grow: p.grow,
    });
  }
}

function stepParticles(dt: number): void {
  const s = dt / 1000;
  for (let i = particles.length - 1; i >= 0; i--) {
    const q = particles[i];
    q.age += dt;
    if (q.age >= q.life) {
      particles.splice(i, 1);
      continue;
    }
    q.vy += q.rise * s;
    q.vx *= 1 - 1.5 * s;
    q.vy *= 1 - 1.2 * s;
    q.x += q.vx * s;
    q.y += q.vy * s;
  }
}

function drawParticles(): void {
  for (const q of particles) {
    const ctx = q.shade ? layers.shade : layers.light;
    const [px, py] = view.toPx(q.x, q.y);
    const k = 1 - q.age / q.life;
    ctx.globalAlpha = q.shade ? 0.55 * k : k;
    ctx.fillStyle = q.color;
    ctx.beginPath();
    ctx.arc(px, py, q.size * dpr * (1 + q.grow * (1 - k)), 0, Math.PI * 2);
    ctx.fill();
  }
  layers.shade.globalAlpha = 1;
  layers.light.globalAlpha = 1;
}

// ------------------------------------------------------------------ services

/** The core's glow sprite (core/sprites.ts Sprites.glow), same stops. */
const glows = new Map<string, HTMLCanvasElement>();
function glow(color: string): CanvasImageSource {
  let g = glows.get(color);
  if (!g) {
    g = document.createElement('canvas');
    g.width = g.height = 128;
    const c = g.getContext('2d') as CanvasRenderingContext2D;
    const n = parseInt(color.slice(1, 7), 16);
    const rgb = `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
    const r = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    for (const [o, a] of [[0, 1], [0.12, 0.85], [0.3, 0.42], [0.55, 0.14], [0.8, 0.035], [1, 0]] as const) {
      r.addColorStop(o, `rgba(${rgb},${a})`);
    }
    c.fillStyle = r;
    c.fillRect(0, 0, 128, 128);
    glows.set(color, g);
  }
  return g;
}

let now = 0;
let tip: { x: number; y: number } | null = null;
let reveal = 0;
let revealUntil = 0;
let reduced = params.get('reduced') === '1';
let changes = 0;

const services: StageServices = {
  view,
  particles: { burst, get count() { return particles.length; } },
  tip: () => (tip ? { x: tip.x, y: tip.y } : null),
  glow,
  now: () => now,
  random,
  propsChanged: () => {
    changes++;
  },
  revealAlpha: () => reveal,
};

const shelf = createShelf();
const byId = (id: string): PropView => {
  const p = shelf.props.find((q) => q.id === id);
  if (!p) throw new Error(`no prop ${id}`);
  return p;
};

let castSeq = 0;
const doneLog: string[] = [];
function apply(id: string, use: string, step: Record<string, unknown> = {}, aim?: { x: number; y: number }): { ok: boolean; castId: string } {
  const castId = `cast-${++castSeq}`;
  const cast: SpellCast = { id: castId, spellId: use, t: now, via: 'gesture', quality: 1, power: 0.5, aim: aim ?? tip ?? { x: 0.5, y: 0.5 } };
  const s: EffectStep = { use, ...step };
  const ok = byId(id).apply(use, { cast, step: s, scale: 1, done: () => doneLog.push(`${castId} ${use}`) }, services);
  if (!ok) burst({ preset: 'stars', x: byId(id).x, y: byId(id).y, count: 16 });
  return { ok, castId };
}

// ------------------------------------------------------------------ the loop

let paused = false;
let last = performance.now();
const slowed = new Map<string, number>();
/** A path the tip follows during a scripted strip: [ms, x, y] keys, linearly interpolated. */
let tipPath: readonly (readonly [number, number, number])[] | null = null;
let pathStart = 0;

function followPath(): void {
  if (!tipPath || tipPath.length === 0) return;
  const t = now - pathStart;
  let k = 0;
  while (k < tipPath.length - 1 && tipPath[k + 1][0] <= t) k++;
  const a = tipPath[k];
  const b = tipPath[Math.min(k + 1, tipPath.length - 1)];
  const u = b[0] === a[0] ? 1 : Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
  tip = { x: a[1] + (b[1] - a[1]) * u, y: a[2] + (b[2] - a[2]) * u };
}

function frame(dt: number): void {
  now += dt;
  followPath();
  for (const [id, until] of slowed) {
    if (now >= until) {
      byId(id).timeScale = 1;
      slowed.delete(id);
    }
  }
  if (revealUntil && now > revealUntil) revealUntil = 0;
  reveal = revealUntil ? Math.min(1, reveal + dt / 700) : Math.max(0, reveal - dt / 900);
  const f: FrameInfo = { now, dt, rawDt: dt, timeScale: 1, reducedMotion: reduced, quality: 'high' };
  for (const c of [layers.shade, layers.light]) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
  }
  for (const p of shelf.props) p.update(f, services);
  if (overlay) layers.shade.drawImage(overlay, 0, 0);
  guarded(() => shelf.drawShelf(layers, f, services));
  for (const p of shelf.props) {
    guarded(() => {
      p.draw(layers, f, services);
      if (reveal > 0.01) p.drawHidden?.(layers, f, services, reveal);
    });
  }
  stepParticles(dt);
  drawParticles();
  if (tip) {
    const [px, py] = view.toPx(tip.x, tip.y);
    const s = 40 * dpr;
    layers.light.drawImage(glow('#F2B84B'), px - s / 2, py - s / 2, s, s);
  }
  const readout = document.getElementById('readout');
  if (readout) readout.textContent = `${shelf.props.map((p) => p.label()).join(' · ')}   (changes ${changes})`;
}

/** As the core does (core/stage.ts guarded): each prop draws inside its own save/restore. */
function guarded(fn: () => void): void {
  layers.shade.save();
  layers.light.save();
  try {
    fn();
  } finally {
    layers.shade.restore();
    layers.light.restore();
  }
}

function loop(t: number): void {
  const dt = Math.min(100, t - last);
  last = t;
  if (!paused) frame(dt);
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------ controls

mirror.addEventListener('pointermove', (e) => {
  const r = mirror.getBoundingClientRect();
  const [x, y] = view.fromPx((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
  tip = { x, y };
});
mirror.addEventListener('pointerleave', () => {
  tip = null;
});

const controls = document.getElementById('controls') as HTMLDivElement;
function button(label: string, fn: () => void, alt = false): void {
  const b = document.createElement('button');
  b.textContent = label;
  if (alt) b.className = 'alt';
  b.addEventListener('click', fn);
  controls.append(b);
}
const row = () => controls.append(document.createElement('b'));

const lastCast = new Map<string, string>();
const small = ['candle', 'feather', 'box', 'teacup', 'plant'];
button('Incendio', () => lastCast.set('ignite', apply('candle', 'prop.ignite', { hold: true }).castId));
button('Aguamenti', () => { for (const p of shelf.props) apply(p.id, 'prop.douse', { all: true }); });
button('End Incendio', () => { const id = lastCast.get('ignite'); if (id) byId('candle').end(id); });
button('Alohomora', () => apply('box', 'prop.unlock'));
button('Reparo cup', () => apply('teacup', 'prop.mend'));
button('Revelio', () => { revealUntil = now + 6000; }, true);
button('Finite', () => { for (const p of shelf.props) p.end('*'); }, true);
button('Reset', () => { for (const p of shelf.props) p.reset(); }, true);
button('Reduced motion', () => { reduced = !reduced; }, true);
button('Pause', () => { paused = !paused; }, true);
row();
for (const id of small) {
  button(`Leviosa ${id}`, () => apply(id, 'prop.levitate', { follow_tip: true, duration_ms: 8000 }));
}
for (const id of small) button(`Accio ${id}`, () => apply(id, 'prop.pull', { hold_ms: 3000 }));
for (const id of small) button(`Locomotor ${id}`, () => apply(id, 'prop.push', { mode: 'follow', duration_ms: 5000 }));
row();
for (const id of [...small, 'dummy']) button(`Engorgio ${id}`, () => apply(id, 'prop.scale', { factor: 1.6, mode: 'grow', duration_ms: 8000 }));
for (const id of [...small, 'dummy']) button(`Reducio ${id}`, () => apply(id, 'prop.scale', { factor: 0.55, mode: 'shrink', duration_ms: 8000 }));
for (const id of small) button(`Reducto ${id}`, () => apply(id, 'prop.scale', { factor: 0, mode: 'shatter' }));
for (const id of small) button(`Reparo ${id}`, () => apply(id, 'prop.mend'));
for (const id of small) button(`Push ${id}`, () => apply(id, 'prop.push', { mode: 'away', distance: 0.2 }, { x: 0.5, y: 0.8 }));
row();
button('Stupefy', () => apply('dummy', 'prop.reel', { intensity: 0.8 }));
button('Expelliarmus', () => apply('dummy', 'prop.disarm'));
button('Petrificus', () => apply('dummy', 'prop.freeze', { topple: true, duration_ms: 6000 }));
button('Impedimenta', () => { apply('dummy', 'prop.reel', { intensity: 0.6 }); byId('dummy').timeScale = 0.2; slowed.set('dummy', now + 5000); });
button('Riddikulus', () => apply('dummy', 'prop.costume', { costume: 'random' }));
button('Imperio', () => apply('dummy', 'prop.mimic', { duration_ms: 5000 }));
button('Crucio', () => apply('dummy', 'prop.reel', { intensity: 1 }));
button('Avada Kedavra', () => apply('dummy', 'prop.topple', { duration_ms: 6000 }));

// ------------------------------------------------------------------ scripted scenes for screenshots

function advance(ms: number, step = 16): void {
  for (let t = 0; t < ms; t += step) frame(step);
}

/** Back to the start: every prop at home, no particles, no tip, the clock running from 0. */
function fresh(): void {
  paused = true;
  for (const p of shelf.props) p.reset();
  slowed.clear();
  particles.length = 0;
  tip = null;
  tipPath = null;
  reveal = 0;
  revealUntil = 0;
  doneLog.length = 0;
  advance(50);
}

function setPath(path: readonly (readonly [number, number, number])[]): void {
  tipPath = path;
  pathStart = now;
  followPath();
}

/** Stills: set up at t = 0, then run `ms`. */
const STILLS: Record<string, { setup: () => void; ms: number }> = {
  rest: { setup: () => {}, ms: 300 },
  lit: {
    setup: () => {
      apply('candle', 'prop.ignite', { hold: true });
      apply('box', 'prop.unlock');
      apply('dummy', 'prop.costume', { costume: 'hat' });
    },
    ms: 1600,
  },
  action: {
    setup: () => {
      tip = { x: 0.33, y: 0.42 };
      apply('candle', 'prop.ignite', { hold: true });
      apply('feather', 'prop.levitate', { follow_tip: true, duration_ms: 8000 });
      apply('plant', 'prop.scale', { factor: 1.6, mode: 'grow', duration_ms: 8000 });
      apply('box', 'prop.unlock');
      apply('dummy', 'prop.disarm');
    },
    ms: 2000,
  },
  frozen: {
    setup: () => {
      apply('dummy', 'prop.freeze', { topple: true, duration_ms: 6000 });
      apply('plant', 'prop.scale', { factor: 0.55, mode: 'shrink', duration_ms: 8000 });
    },
    ms: 1400,
  },
  stiff: { setup: () => { apply('dummy', 'prop.freeze', { duration_ms: 6000 }); }, ms: 900 },
  shattered: {
    setup: () => {
      apply('box', 'prop.scale', { factor: 0, mode: 'shatter' });
      apply('teacup', 'prop.scale', { factor: 0, mode: 'shatter' });
      apply('candle', 'prop.scale', { factor: 0, mode: 'shatter' });
      apply('dummy', 'prop.topple', { duration_ms: 6000 });
    },
    ms: 2200,
  },
  // Every small prop's wreck at once (Reducto).
  wrecks: {
    setup: () => {
      for (const id of ['candle', 'feather', 'box', 'teacup', 'plant'] as const) apply(id, 'prop.scale', { factor: 0, mode: 'shatter' });
    },
    ms: 2200,
  },
  mending: { setup: () => { apply('teacup', 'prop.mend'); }, ms: 560 },
  mended: { setup: () => { apply('teacup', 'prop.mend'); }, ms: 1500 },
  reveal: { setup: () => { revealUntil = now + 6000; }, ms: 1400 },
  'reveal-open': { setup: () => { apply('box', 'prop.unlock'); revealUntil = now + 6000; }, ms: 1400 },
  hat: { setup: () => { apply('dummy', 'prop.costume', { costume: 'hat' }); }, ms: 600 },
  ruff: { setup: () => { apply('dummy', 'prop.costume', { costume: 'ruff' }); }, ms: 600 },
  bow: { setup: () => { apply('dummy', 'prop.costume', { costume: 'bow' }); }, ms: 600 },
  mimic: {
    setup: () => {
      tip = { x: 0.97, y: 0.25 };
      apply('dummy', 'prop.mimic', { duration_ms: 5000 });
    },
    ms: 900,
  },
  dropped: { setup: () => { apply('dummy', 'prop.disarm'); }, ms: 1200 },
  accio: {
    setup: () => {
      tip = { x: 0.55, y: 0.35 };
      apply('teacup', 'prop.pull', { hold_ms: 3000 });
      apply('candle', 'prop.ignite', { hold: true });
      apply('candle', 'prop.pull', { hold_ms: 3000 });
    },
    ms: 1000,
  },
  big: {
    setup: () => {
      for (const id of ['candle', 'box', 'teacup', 'plant', 'dummy']) apply(id, 'prop.scale', { factor: 1.6, mode: 'grow', duration_ms: 8000 });
    },
    ms: 1200,
  },
  'small-all': {
    setup: () => {
      for (const id of ['candle', 'feather', 'box', 'teacup', 'plant', 'dummy']) apply(id, 'prop.scale', { factor: 0.55, mode: 'shrink', duration_ms: 8000 });
    },
    ms: 1200,
  },
};

interface StripSpec {
  setup: () => void;
  /** Ms after setup at which to take each frame. */
  times: number[];
  /** Caster-space region to crop: x0, y0, x1, y1. */
  region: [number, number, number, number];
  reduced?: boolean;
}

const LIFT_PATH = [[0, 0.3, 0.55], [1200, 0.33, 0.45], [2400, 0.45, 0.4], [3600, 0.55, 0.5], [6000, 0.5, 0.45]] as const;

const STRIPS: Record<string, StripSpec> = {
  leviosa: {
    setup: () => {
      setPath(LIFT_PATH);
      apply('feather', 'prop.levitate', { follow_tip: true, duration_ms: 3000 });
    },
    times: [120, 300, 700, 1400, 2200, 3000, 3400, 4000],
    region: [0.12, 0.3, 0.66, 1],
  },
  'leviosa-reduced': {
    setup: () => {
      setPath(LIFT_PATH);
      apply('feather', 'prop.levitate', { follow_tip: true, duration_ms: 3000 });
    },
    times: [120, 300, 700, 1400, 2200, 3000, 3400, 4000],
    region: [0.12, 0.3, 0.66, 1],
    reduced: true,
  },
  accio: {
    setup: () => {
      setPath([[0, 0.5, 0.4], [1500, 0.5, 0.4], [2500, 0.62, 0.35]]);
      apply('box', 'prop.pull', { hold_ms: 2000 });
    },
    times: [100, 250, 450, 700, 1500, 2600, 3000, 3600],
    region: [0.3, 0.25, 0.75, 1],
  },
  locomotor: {
    setup: () => {
      setPath([[0, 0.5, 0.6], [1500, 0.3, 0.6], [3000, 0.75, 0.6]]);
      apply('teacup', 'prop.push', { mode: 'follow', duration_ms: 3000 });
    },
    times: [200, 800, 1500, 2200, 3000, 3600, 4200, 5200],
    region: [0.2, 0.72, 0.85, 1],
  },
  push: {
    setup: () => { apply('box', 'prop.push', { mode: 'away', distance: 0.2, duration_ms: 1500 }, { x: 0.3, y: 0.85 }); },
    times: [60, 150, 300, 500, 1800, 2200, 2600],
    region: [0.3, 0.72, 0.65, 1],
  },
  incendio: {
    setup: () => { apply('candle', 'prop.ignite', { hold: true }); },
    times: [40, 120, 240, 400, 700, 1200, 2000, 3000],
    region: [0.04, 0.55, 0.2, 1],
  },
  douse: {
    setup: () => {
      apply('candle', 'prop.ignite', { hold: true });
      advance(1500);
      apply('candle', 'prop.douse', { all: true });
    },
    times: [16, 120, 300, 600, 1000, 1600],
    region: [0.04, 0.55, 0.2, 1],
  },
  alohomora: {
    setup: () => { apply('box', 'prop.unlock'); },
    times: [40, 100, 180, 300, 450, 700, 1000, 1600],
    region: [0.34, 0.66, 0.5, 1],
  },
  relock: {
    // RELOCK_MS counts from the moment the lid has finished opening (about 750 ms after the cast).
    setup: () => {
      apply('box', 'prop.unlock');
      advance(25600, 50);
    },
    times: [100, 250, 350, 450, 520, 600, 700, 900],
    region: [0.34, 0.66, 0.5, 1],
  },
  reparo: {
    setup: () => { apply('teacup', 'prop.mend'); },
    times: [60, 200, 350, 500, 650, 800, 900, 1100],
    region: [0.5, 0.74, 0.64, 1],
  },
  reducto: {
    setup: () => { apply('teacup', 'prop.scale', { factor: 0, mode: 'shatter' }); },
    times: [16, 100, 250, 500, 900, 1500],
    region: [0.48, 0.66, 0.66, 1],
  },
  restore: {
    setup: () => {
      apply('box', 'prop.scale', { factor: 0, mode: 'shatter' });
      advance(1500);
      apply('box', 'prop.mend');
    },
    times: [16, 120, 250, 400, 550, 700],
    region: [0.34, 0.66, 0.5, 1],
  },
  engorgio: {
    setup: () => { apply('plant', 'prop.scale', { factor: 1.6, mode: 'grow', duration_ms: 2000 }); },
    times: [100, 250, 450, 700, 1500, 2300, 2700, 3200],
    region: [0.62, 0.55, 0.82, 1],
  },
  reducio: {
    setup: () => { apply('plant', 'prop.scale', { factor: 0.55, mode: 'shrink', duration_ms: 2000 }); },
    times: [100, 250, 450, 700, 1500, 2300, 2700, 3200],
    region: [0.62, 0.55, 0.82, 1],
  },
  stupefy: {
    setup: () => { apply('dummy', 'prop.reel', { intensity: 0.8 }); },
    times: [60, 150, 250, 400, 600, 900, 1300, 2000],
    region: [0.76, 0.5, 1, 1],
  },
  crucio: {
    setup: () => { apply('dummy', 'prop.reel', { intensity: 1 }); },
    times: [60, 150, 250, 400, 600, 900, 1300, 2000],
    region: [0.76, 0.5, 1, 1],
  },
  impedimenta: {
    setup: () => {
      apply('dummy', 'prop.reel', { intensity: 0.6 });
      byId('dummy').timeScale = 0.2;
      slowed.set('dummy', now + 5000);
    },
    times: [100, 400, 800, 1200, 1800, 2600, 3600, 4800],
    region: [0.76, 0.5, 1, 1],
  },
  expelliarmus: {
    setup: () => { apply('dummy', 'prop.disarm'); },
    times: [60, 180, 320, 480, 640, 800, 1400, 4500, 4700, 5000],
    region: [0.7, 0.5, 1, 1],
  },
  petrificus: {
    setup: () => { apply('dummy', 'prop.freeze', { topple: true, duration_ms: 2500 }); },
    times: [60, 200, 350, 500, 650, 900, 2600, 3000, 3400, 3800],
    region: [0.72, 0.5, 1, 1],
  },
  avada: {
    setup: () => { apply('dummy', 'prop.topple', { duration_ms: 2500 }); },
    times: [60, 200, 350, 500, 650, 900, 2600, 3000, 3400, 3800],
    region: [0.72, 0.5, 1, 1],
  },
  riddikulus: {
    setup: () => { apply('dummy', 'prop.costume', { costume: 'random' }); },
    times: [40, 120, 200, 320, 600],
    region: [0.76, 0.5, 1, 1],
  },
  imperio: {
    setup: () => {
      setPath([[0, 0.7, 0.5], [800, 0.95, 0.3], [1600, 0.75, 0.65], [2400, 0.95, 0.55], [3200, 0.8, 0.3]]);
      apply('dummy', 'prop.mimic', { duration_ms: 3000 });
    },
    times: [200, 600, 1000, 1400, 1800, 2200, 2600, 3000, 3600],
    region: [0.7, 0.2, 1, 1],
  },
  'candle-flicker': {
    setup: () => {
      apply('candle', 'prop.ignite', { hold: true });
      advance(1000);
    },
    times: [0, 60, 120, 180, 240, 300, 360, 420],
    region: [0.07, 0.6, 0.17, 0.95],
  },
  'candle-flicker-reduced': {
    setup: () => {
      apply('candle', 'prop.ignite', { hold: true });
      advance(1000);
    },
    times: [0, 60, 120, 180, 240, 300, 360, 420],
    region: [0.07, 0.6, 0.17, 0.95],
    reduced: true,
  },
  revelio: {
    setup: () => { revealUntil = now + 2500; },
    times: [100, 350, 700, 1200, 2500, 3000, 3400],
    region: [0, 0.6, 1, 1],
  },
};

/** Composite the three page layers as the browser does: room, shade, then light with 'screen'. */
function composite(out: CanvasRenderingContext2D, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number): void {
  out.save();
  out.globalCompositeOperation = 'source-over';
  out.filter = REFLECTION_GRADE;
  out.drawImage(roomCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
  out.filter = 'none';
  out.drawImage(shadeCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
  out.globalCompositeOperation = 'screen';
  out.drawImage(lightCanvas, sx, sy, sw, sh, dx, dy, dw, dh);
  out.restore();
}

function strip(name: string, scale = 1, cols = 4): string {
  const spec = STRIPS[name];
  if (!spec) throw new Error(`no strip ${name}`);
  const wasReduced = reduced;
  reduced = !!spec.reduced;
  fresh();
  spec.setup();
  // Frame times count from the end of the setup, which may run a pre-roll of its own.
  const t0 = now;
  const [x0, y0, x1, y1] = spec.region;
  const [px0, py0] = view.toPx(x0, y0);
  const [px1, py1] = view.toPx(x1, y1);
  const sw = Math.round(px1 - px0);
  const sh = Math.round(py1 - py0);
  const cw = Math.round(sw * scale);
  const ch = Math.round(sh * scale);
  const n = spec.times.length;
  const c = Math.min(cols, n);
  const rows = Math.ceil(n / c);
  const gap = 4;
  const sheet = document.createElement('canvas');
  sheet.width = c * cw + (c - 1) * gap;
  sheet.height = rows * ch + (rows - 1) * gap;
  const out = sheet.getContext('2d') as CanvasRenderingContext2D;
  out.fillStyle = '#ff00ff';
  out.fillRect(0, 0, sheet.width, sheet.height);
  spec.times.forEach((t, i) => {
    const target = t0 + t;
    while (now < target - 0.5) frame(Math.min(16, target - now));
    const dx = (i % c) * (cw + gap);
    const dy = Math.floor(i / c) * (ch + gap);
    composite(out, px0, py0, sw, sh, dx, dy, cw, ch);
    out.fillStyle = 'rgba(0,0,0,0.6)';
    out.fillRect(dx, dy, 64, 18);
    out.fillStyle = '#E9DFC7';
    out.font = '12px Georgia, serif';
    out.fillText(`${t} ms`, dx + 5, dy + 13);
  });
  reduced = wasReduced;
  return sheet.toDataURL('image/png');
}

interface Crop { id: string; x: number; y: number; w: number; h: number }

/** How much of the mirror's height each close-up takes, half of it: room for the candle's flame and
 *  the dummy's hat. */
const CROP_HALF: Record<string, number> = { candle: 0.16, feather: 0.13, box: 0.13, teacup: 0.11, plant: 0.15, dummy: 0.24 };

/** Where each prop is on the page (CSS px), for close-ups. */
function crops(): Crop[] {
  const r = mirror.getBoundingClientRect();
  return shelf.props.map((p) => {
    const half = H * (CROP_HALF[p.id] ?? 0.12);
    const cx = r.left + caster.x + p.x * caster.w;
    const cy = r.top + caster.y + p.y * caster.h;
    const x = Math.max(0, cx - half * 1.15);
    const y = Math.max(0, cy - half * 1.25);
    return { id: p.id, x: Math.round(x), y: Math.round(y), w: Math.round(half * 2.3), h: Math.round(half * 2.1) };
  });
}

interface Harness {
  ready: boolean;
  still(name: string): void;
  strip(name: string, scale?: number, cols?: number): string;
  stills(): string[];
  strips(): string[];
  crops(): Crop[];
  pause(): void;
  advance(ms: number): void;
  reset(): void;
  apply(id: string, use: string, step?: Record<string, unknown>): boolean;
  setTip(x: number | null, y?: number): void;
  setReduced(on: boolean): void;
  labels(): string[];
  done(): string[];
}

const harness: Harness = {
  ready: false,
  still(name) {
    const s = STILLS[name];
    if (!s) throw new Error(`no still ${name}`);
    fresh();
    s.setup();
    advance(s.ms);
  },
  strip,
  stills: () => Object.keys(STILLS),
  strips: () => Object.keys(STRIPS),
  crops,
  pause() {
    paused = true;
  },
  advance,
  reset() {
    for (const p of shelf.props) p.reset();
  },
  apply: (id, use, step) => apply(id, use, step).ok,
  setTip(x, y) {
    tip = x === null ? null : { x, y: y ?? 0.5 };
  },
  setReduced(on) {
    reduced = on;
  },
  labels: () => shelf.props.map((p) => p.label()),
  done: () => [...doneLog],
};
(window as unknown as { harness: Harness }).harness = harness;

window.addEventListener('resize', layout);
layout();
requestAnimationFrame((t) => {
  last = t;
  harness.ready = true;
  loop(t);
});
