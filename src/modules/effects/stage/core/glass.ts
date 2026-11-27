// The glass itself (art brief "The stage"): old silvered glass in the study's near-neutral shadow,
// darker toward the frame, desilvered in a few soft patches that creep in from the corners and edges
// where damp has got behind the silver over the years, and one static diagonal sheen. The overlay is
// painted once per mirror size into a canvas (stage.ts renderOverlay) that the shade layer copies every
// frame, over the reflection and under the shelf, so the patches also block the reflection where they
// sit. Nothing here moves: the only ambient motion allowed is the candle's flicker (Section 10.6).
//
// The glass's own tone, where it reflects nothing, is GLASS_BASE: the backdrop behind the video
// (dom.ts) and the plain glass of clips (capture.ts) are both made from it, so they match.

import { makeCanvas } from './sprites';

/** The glass's own tone: deep shadow, a little lighter where the room's light would fall on it. An
 *  ellipse centred at (x, y) with radii (rx, ry), all fractions of the mirror's width and height (as in
 *  a CSS radial-gradient). Near-neutral, never navy: blue glass reads as a television (art brief). */
export const GLASS_BASE = {
  x: 0.5,
  y: 0.38,
  rx: 1.2,
  ry: 0.9,
  stops: [[0, '#26252B'], [0.55, '#17161C'], [1, '#0B0A10']] as readonly (readonly [number, string])[],
} as const;

/** GLASS_BASE as a CSS background (the stage's backdrop). */
export function glassBackdropCss(): string {
  const b = GLASS_BASE;
  const pc = (f: number): string => `${Math.round(f * 1000) / 10}%`;
  const stops = b.stops.map(([o, c]) => `${c} ${pc(o)}`).join(', ');
  return `radial-gradient(${pc(b.rx)} ${pc(b.ry)} at ${pc(b.x)} ${pc(b.y)}, ${stops})`;
}

/** GLASS_BASE as a canvas gradient in the ellipse's unit space; fill with fillGlassBase. Made once. */
export function glassBaseGradient(ctx: CanvasRenderingContext2D): CanvasGradient {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  for (const [o, c] of GLASS_BASE.stops) g.addColorStop(o, c);
  return g;
}

/** Fill a w by h canvas with the glass's own tone. The unit gradient is stretched onto the ellipse by
 *  the transform, so it matches the CSS backdrop. Leaves the transform reset. */
export function fillGlassBase(ctx: CanvasRenderingContext2D, gradient: CanvasGradient, w: number, h: number): void {
  const b = GLASS_BASE;
  const sx = b.rx * w;
  const sy = b.ry * h;
  if (!(sx > 0 && sy > 0)) return;
  ctx.setTransform(sx, 0, 0, sy, b.x * w, b.y * h);
  ctx.fillStyle = gradient;
  ctx.fillRect(-b.x / b.rx, -b.y / b.ry, 1 / b.rx, 1 / b.ry);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * What the old silver does to the reflection: a touch less colour, a little warmer and darker than the
 * camera sees, so a webcam image reads as an antique mirror and not as live video. A CSS filter on the
 * stage's own video, for display only: the trackers read frames from the capture module, never from
 * this element, and clips copy the camera without it. Off in high contrast, where the reflection should
 * be as clear as it can be.
 */
export const REFLECTION_GRADE = 'saturate(0.8) sepia(0.14) contrast(0.95) brightness(0.9)';

/** The filter for the stage's video: the exposure lift (dom.ts exposureFilter) first, then the glass's
 *  grade unless high contrast is on. */
export function reflectionFilter(exposure: string, highContrast: boolean): string {
  const grade = highContrast ? '' : REFLECTION_GRADE;
  return exposure && grade ? `${exposure} ${grade}` : exposure || grade;
}

/** Mulberry32, so the patches fall in the same places at every size and on every visit. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A canvas to build the glass in, or null (Node, or a browser without 2D canvas). */
export type GlassCanvas = (w: number, h: number) => { canvas: CanvasImageSource; ctx: CanvasRenderingContext2D } | null;

const documentCanvas: GlassCanvas = (w, h) => {
  const canvas = makeCanvas(w, h);
  const ctx = canvas?.getContext('2d');
  return canvas && ctx ? { canvas, ctx } : null;
};

/**
 * Paint the glass over a cleared canvas `w` by `h` device pixels. It is built as one small picture on
 * the desilvering's grid (desilverField: about GRID cells across the smaller side): the patches, then
 * the darkening toward the frame, the room's light and the sheen, all smooth enough to lose nothing
 * there. Drawn smoothed up once, it stays cheap even where canvases are drawn in software, where filling
 * those gradients over the whole glass cost several times as much.
 */
export function paintGlass(ctx: CanvasRenderingContext2D, w: number, h: number, make: GlassCanvas = documentCanvas): void {
  if (!(w > 0 && h > 0)) return;
  const m = Math.min(w, h);
  const field = desilverField(w, h);
  const s = make(field.gw, field.gh);
  if (!s) return;
  const c = s.ctx;
  // The tests' recording context has no pixels: the patches are left out there, the rest is drawn.
  const img = c.createImageData(field.gw, field.gh) as ImageData | undefined;
  if (img && img.data && img.data.length === field.rgba.length) {
    img.data.set(field.rgba);
    c.putImageData(img, 0, 0);
  }
  c.save();
  c.scale(1 / field.cell, 1 / field.cell);
  vignette(c, w, h, m);
  roomLight(c, w, h);
  sheen(c, w, h);
  c.restore();
  ctx.save();
  // Plain bilinear smoothing: everything in it is soft already, and the finer filters cost several
  // times as much where the canvas is drawn in software.
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'low';
  ctx.drawImage(s.canvas, 0, 0, field.gw * field.cell, field.gh * field.cell);
  ctx.restore();
}

/** The study's light on the glass: a breath of warmth low on the left, where the mantel's candles are,
 *  and of cool moonlight at the upper right (art brief, "Light"). Each is filled only over its own
 *  reach, so they stay cheap. */
function roomLight(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const glow = (x: number, y: number, r: number, rgb: string, a: number): void => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb}, ${a})`);
    g.addColorStop(0.5, `rgba(${rgb}, ${(a * 0.4).toFixed(4)})`);
    g.addColorStop(1, `rgba(${rgb}, 0)`);
    ctx.fillStyle = g;
    const x0 = Math.max(0, x - r);
    const y0 = Math.max(0, y - r);
    ctx.fillRect(x0, y0, Math.min(w, x + r) - x0, Math.min(h, y + r) - y0);
  };
  glow(w * 0.12, h * 0.98, h * 0.62, '255, 178, 98', 0.05);
  glow(w * 0.97, h * 0.02, h * 0.72, '170, 188, 222', 0.032);
}

/** The silver has darkened most where the frame has kept the air off it least: toward every edge. */
function vignette(ctx: CanvasRenderingContext2D, w: number, h: number, m: number): void {
  // An elliptical falloff across the whole glass...
  ctx.save();
  ctx.translate(w / 2, h * 0.46);
  ctx.scale(w / h, 1);
  const r = h * 0.78;
  const g = ctx.createRadialGradient(0, 0, r * 0.34, 0, 0, r);
  g.addColorStop(0, 'rgba(6, 5, 9, 0)');
  g.addColorStop(0.55, 'rgba(6, 5, 9, 0.12)');
  g.addColorStop(0.85, 'rgba(6, 5, 9, 0.34)');
  g.addColorStop(1, 'rgba(5, 4, 7, 0.52)');
  ctx.fillStyle = g;
  ctx.fillRect(-r * 1.2, -r * 1.2, r * 2.4, r * 2.4);
  ctx.restore();
  // ...and a narrow band hard against the frame, where old silver goes nearly black.
  const band = m * 0.07;
  const edges: [number, number, number, number, number, number, number, number][] = [
    [0, 0, 0, band, 0, 0, w, band],
    [0, h, 0, h - band, 0, h - band, w, band],
    [0, 0, band, 0, 0, 0, band, h],
    [w, 0, w - band, 0, w - band, 0, band, h],
  ];
  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of edges) {
    const e = ctx.createLinearGradient(x0, y0, x1, y1);
    e.addColorStop(0, 'rgba(4, 3, 6, 0.42)');
    e.addColorStop(0.35, 'rgba(4, 3, 6, 0.16)');
    e.addColorStop(1, 'rgba(4, 3, 6, 0)');
    ctx.fillStyle = e;
    ctx.fillRect(rx, ry, rw, rh);
  }
}

// ------------------------------------------------------------------ desilvering

/** Value noise on a 256-cell lattice, seeded once: smooth, cheap, and the same on every visit. */
const LATTICE = (() => {
  const r = rng(7341);
  const perm = new Uint8Array(512);
  const val = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    perm[i] = i;
    val[i] = r();
  }
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const t = perm[i];
    perm[i] = perm[j];
    perm[j] = t;
  }
  for (let i = 0; i < 256; i++) perm[i + 256] = perm[i];
  return { perm, val };
})();

function noise(x: number, y: number): number {
  const { perm, val } = LATTICE;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const X = xi & 255;
  const Y = yi & 255;
  const a = val[perm[perm[X] + Y]];
  const b = val[perm[perm[X + 1] + Y]];
  const c = val[perm[perm[X] + Y + 1]];
  const d = val[perm[perm[X + 1] + Y + 1]];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Fractal noise in 0..1. Each octave is turned and shifted, so the lattice never shows as a grid. */
function fbm(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let px = x;
  let py = y;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(px, py);
    norm += amp;
    const nx = px * 1.6 - py * 1.2 + 11.3;
    py = px * 1.2 + py * 1.6 + 5.7;
    px = nx;
    amp *= 0.5;
  }
  return sum / norm;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Where the damp got in: the side each patch creeps in from (0 top, 1 right, 2 bottom, 3 left), where
 *  along it (a fraction of its length), how big (a fraction of the glass's smaller side) and how strong.
 *  Hand-placed: heaviest in the corners, light along the top where the guide's words sit, none behind
 *  the middle. The bottom corners are mostly behind the mantel but show beside it when a 4:3 camera
 *  letterboxes the reflection. */
const PATCHES: readonly { edge: 0 | 1 | 2 | 3; at: number; r: number; a: number }[] = [
  { edge: 0, at: 0, r: 0.19, a: 1 },
  { edge: 0, at: 0.3, r: 0.06, a: 0.6 },
  { edge: 1, at: 0, r: 0.23, a: 1.05 },
  { edge: 1, at: 0.5, r: 0.075, a: 0.66 },
  { edge: 1, at: 0.74, r: 0.13, a: 0.86 },
  { edge: 2, at: 1, r: 0.17, a: 0.85 },
  { edge: 2, at: 0, r: 0.18, a: 0.9 },
  { edge: 3, at: 0.64, r: 0.12, a: 0.84 },
  { edge: 3, at: 0.36, r: 0.075, a: 0.68 },
];

/** Cells across the smaller side of the glass: fine enough for the pitting to read as texture, coarse
 *  enough to build in a few milliseconds. */
const GRID = 280;

export interface DesilverField {
  /** Grid size in cells. */
  gw: number;
  gh: number;
  /** Device pixels per cell. */
  cell: number;
  /** Straight (not premultiplied) RGBA per cell, ready for ImageData. */
  rgba: Uint8ClampedArray;
}

/**
 * The desilvering of a w by h glass, on a grid of about GRID cells across the smaller side, drawn
 * smoothed up to full size. Each patch is a soft potential around a point just outside the glass, so it
 * creeps in from the edge. A broad noise bends its outline and a fine one frays the leading edge into
 * the ragged, islanded front of failing silver. Inside, a grey-brown haze where the silver has thinned
 * (paler and greyer at the front, browner deeper in), and over it the dark of the backing showing
 * through: blotches deep in, and fine pitting thickening toward the frame. Each layer is a mid tone, so
 * the patches show on the dark glass and still block a bright reflection.
 */
export function desilverField(w: number, h: number): DesilverField {
  const m = Math.min(w, h);
  const cell = Math.max(1, m / GRID);
  const gw = Math.max(1, Math.ceil(w / cell));
  const gh = Math.max(1, Math.ceil(h / cell));
  const rgba = new Uint8ClampedArray(gw * gh * 4);
  if (!(m > 0 && Number.isFinite(w + h))) return { gw, gh, cell, rgba };
  // Each patch adds a smooth bump, (1 − d²/R²)³ out to R = 2.2 r, over its own cells only.
  const pot = new Float32Array(gw * gh);
  const r = rng(52817);
  const out = 0.02 * m;
  for (const p of PATCHES) {
    const along = Math.min(1, Math.max(0, p.at + (p.at > 0 && p.at < 1 ? (r() - 0.5) * 0.04 : 0)));
    const R = 2.2 * p.r * (0.9 + r() * 0.2) * m;
    // Just outside the edge it sits on (corners: outside both).
    let sx = 0;
    let sy = 0;
    if (p.edge === 0) { sx = along * w; sy = -out; }
    else if (p.edge === 1) { sx = w + out; sy = along * h; }
    else if (p.edge === 2) { sx = along * w; sy = h + out; }
    else { sx = -out; sy = along * h; }
    if (along === 0 || along === 1) {
      if (p.edge === 0 || p.edge === 2) sx += along === 0 ? -out : out;
      else sy += along === 0 ? -out : out;
    }
    const inv = 1 / (R * R);
    const i0 = Math.max(0, Math.floor((sx - R) / cell));
    const i1 = Math.min(gw - 1, Math.ceil((sx + R) / cell));
    const j0 = Math.max(0, Math.floor((sy - R) / cell));
    const j1 = Math.min(gh - 1, Math.ceil((sy + R) / cell));
    for (let j = j0; j <= j1; j++) {
      const ey = (j + 0.5) * cell - sy;
      for (let i = i0; i <= i1; i++) {
        const ex = (i + 0.5) * cell - sx;
        const q = (ex * ex + ey * ey) * inv;
        if (q < 1) {
          const k = 1 - q;
          pot[j * gw + i] += p.a * k * k * k;
        }
      }
    }
  }
  const rimWidth = 0.012 * m;
  for (let j = 0; j < gh; j++) {
    const y = (j + 0.5) * cell;
    const dy = Math.min(y, h - y);
    for (let i = 0; i < gw; i++) {
      const idx = j * gw + i;
      const x = (i + 0.5) * cell;
      const d = Math.min(x, w - x, dy);
      // A thin, broken rim hard against the frame everywhere.
      const rim = d < rimWidth * 4 ? 0.45 * Math.exp(-d / rimWidth) : 0;
      const p = pot[idx];
      // Even at the noise's peaks this cell would stay clear.
      if (p * 1.65 + rim * 1.6 < 0.24) continue;
      const u = x / m;
      const v = y / m;
      const broad = fbm(u * 6, v * 6, 3);
      const fray = fbm(u * 34 + 17.3, v * 34 + 5.1, 2);
      const t = p * (0.35 + 1.3 * broad) + rim * (0.4 + 1.2 * broad) + 0.34 * (fray - 0.5);
      const cov = smooth(0.4, 0.56, t);
      if (cov <= 0.004) continue;
      const deep = smooth(0.5, 1.2, t);
      // The haze: thin, pale and grey at the front, browner and denser deeper in, never even.
      const cloud = fbm(u * 11 + 23.9, v * 11 + 61.4, 2);
      const hz = cov * (0.18 + 0.27 * deep) * (0.6 + 0.8 * cloud);
      const hr = 90 - 26 * deep;
      const hg = 81 - 28 * deep;
      const hb = 70 - 28 * deep;
      // The backing showing through, in soft spots of every size (none smaller than a few cells, so
      // nothing reads as a pixel): blotches deep in, smaller spots thickening toward the frame.
      const blotch = smooth(0.5, 0.74, fbm(u * 24 + 41.7, v * 24 + 9.2, 2) + 0.3 * deep - 0.16);
      const spot = smooth(0.58, 0.8, fbm(u * 62 + 3.1, v * 62 + 7.7, 2) + 0.2 * deep - 0.08) * (0.3 + 0.7 * cov);
      const dk = cov * Math.min(0.86, 0.92 * Math.max(blotch * deep, spot * 0.85));
      const a = dk + hz * (1 - dk);
      const k = idx * 4;
      if (a <= 0) continue;
      const wh = (hz * (1 - dk)) / a;
      const wd = dk / a;
      rgba[k] = hr * wh + 17 * wd;
      rgba[k + 1] = hg * wh + 13 * wd;
      rgba[k + 2] = hb * wh + 11 * wd;
      rgba[k + 3] = 255 * a;
    }
  }
  return { gw, gh, cell, rgba };
}

// ------------------------------------------------------------------ sheen

/** One soft band of reflected light across the upper left of the glass, running from lower left to
 *  upper right: brightest a little toward its upper edge and fading slowly below it, as a broad light
 *  reflects in old glass. Warm, like the room's light. */
function sheen(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const g = ctx.createLinearGradient(0, 0, w, h * 0.95);
  g.addColorStop(0.13, 'rgba(255, 244, 224, 0)');
  g.addColorStop(0.185, 'rgba(255, 244, 224, 0.022)');
  g.addColorStop(0.218, 'rgba(255, 244, 224, 0.06)');
  g.addColorStop(0.24, 'rgba(255, 244, 224, 0.078)');
  g.addColorStop(0.265, 'rgba(255, 244, 224, 0.07)');
  g.addColorStop(0.3, 'rgba(255, 244, 224, 0.04)');
  g.addColorStop(0.36, 'rgba(255, 244, 224, 0.016)');
  g.addColorStop(0.45, 'rgba(255, 244, 224, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}
