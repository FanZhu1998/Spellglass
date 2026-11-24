// Shared painters for the materials of a candlelit castle study (Section 10.1 and 10.7, and the art
// brief): oak, aged brass, wrought iron, beeswax, bone china, glazed earthenware, leather, canvas and
// straw. All art is original and procedural (Canvas 2D paths, gradients and a seeded noise texture;
// no image files, no logos or film imagery). These run only while a sprite is painted, never per frame.
//
// One light everywhere: a warm key low on the left (the candle on the mantel), a faint cool rim of
// moonlight from the upper right, deep shadow elsewhere. So highlights sit warm and upper left, form
// shadows fall cool on the right, and a thin cool edge comes back at the far right of round things.

import type { CanvasFactory, Surface } from './canvas';

export type Ctx = CanvasRenderingContext2D;
export type Stops = readonly (readonly [number, string])[];

/** Colors. The first eight are the Section 10.2 tokens; the rest are the materials of the study. */
export const PAL = {
  night: '#0F1424',
  slate: '#232A3B',
  vellum: '#E9DFC7',
  ink: '#2B2118',
  candle: '#F2B84B',
  oxblood: '#7B1E2B',
  verdigris: '#5FB3A5',
  ash: '#9A9DB0',

  shadow: '#0B0A10',
  shadowWarm: '#15131C',
  candleDeep: '#D98E2B',
  ember: '#A8521C',

  // Oak, darkened by age and wax polish.
  oakDeep: '#120B06',
  oakDark: '#24170D',
  oak: '#3A2616',
  oakMid: '#5A3B22',
  oakLight: '#8A6240',
  oakGlow: '#B88A58',

  // Brass that has been handled for a century: dark, with bright worn edges.
  brassDeep: '#22170A',
  brassDark: '#4E3815',
  brass: '#8A6A2E',
  brassLight: '#C49A4E',
  brassShine: '#F2DDA6',
  patina: '#3B3F26',

  // Gold leaf and its red bole where it has worn through.
  goldLight: '#E9CF8A',
  gold: '#C9A356',
  goldDark: '#8A6A2C',
  goldRecess: '#3E2C12',
  bole: '#6B2A1E',

  ironDeep: '#0C0C0E',
  ironDark: '#1B1B1F',
  iron: '#2E2E33',
  ironLight: '#4E4D52',
  ironShine: '#8C8A8C',
  rust: '#5E301A',

  chinaDeep: '#7D766E',
  chinaShadow: '#B5AC9F',
  china: '#E6DFD3',
  chinaLight: '#F7F3EB',
  cobalt: '#1F3566',
  cobaltDeep: '#121F3E',
  gilt: '#C9A356',

  glazeDeep: '#0E1A15',
  glazeDark: '#1B3328',
  glaze: '#2C5242',
  glazeLight: '#4D7E66',
  terracottaDark: '#5E2D18',
  terracotta: '#8E4A2A',
  slip: '#D8C29A',

  frondDeep: '#0F1E16',
  frondDark: '#1D3A2B',
  frond: '#2F5A43',
  frondLight: '#58845E',
  frondTip: '#8CAE7C',
  moss: '#4F6B2E',
  bell: '#E4DCCB',
  bellShade: '#A897B8',
  bellThroat: '#3E2A55',

  leatherDeep: '#170D07',
  leatherDark: '#341E10',
  leather: '#573519',
  leatherLight: '#86592F',
  canvasDeep: '#3A3020',
  canvasDark: '#625238',
  canvas: '#8F7C58',
  canvasLight: '#BBA67E',
  straw: '#C9A85A',
  strawDark: '#8E7032',
  stitch: '#1E140C',

  velvetDeep: '#22060C',
  velvet: '#561523',
  velvetLight: '#83303F',

  moon: '#AFC0DC',
  silver: '#DCE5F5',
  frost: '#BFD8FF',
  chalk: '#F2F4F8',
} as const;

/** Mulberry32: small, fast, good enough for texture noise. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function lin(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, stops: Stops): CanvasGradient {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

export function rad(ctx: Ctx, x0: number, y0: number, r0: number, x1: number, y1: number, r1: number, stops: Stops): CanvasGradient {
  const g = ctx.createRadialGradient(x0, y0, Math.max(0, r0), x1, y1, Math.max(0.01, r1));
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

export function ellipsePath(ctx: Ctx, cx: number, cy: number, rx: number, ry: number): void {
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(0.01, rx), Math.max(0.01, ry), 0, 0, Math.PI * 2);
}

export function roundRectPath(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** The band between two stacked ellipses' front halves: the side of a dish, a saucer, a turned base. */
export function bandPath(ctx: Ctx, topY: number, topRx: number, topRy: number, botY: number, botRx: number, botRy: number): void {
  ctx.beginPath();
  ctx.moveTo(-topRx, topY);
  ctx.lineTo(-botRx, botY);
  ctx.ellipse(0, botY, Math.max(0.01, botRx), Math.max(0.01, botRy), 0, Math.PI, 0, true);
  ctx.lineTo(topRx, topY);
  ctx.ellipse(0, topY, Math.max(0.01, topRx), Math.max(0.01, topRy), 0, 0, Math.PI, false);
  ctx.closePath();
}

export interface Material {
  deep: string;
  dark: string;
  mid: string;
  light: string;
  shine: string;
  /** The cool light that comes back at the shadowed edge (moonlight and bounce). */
  rim: string;
}

export const BRASS: Material = { deep: PAL.brassDeep, dark: PAL.brassDark, mid: PAL.brass, light: PAL.brassLight, shine: PAL.brassShine, rim: '#6E6A5E' };
export const GOLD: Material = { deep: PAL.goldRecess, dark: PAL.goldDark, mid: PAL.gold, light: PAL.goldLight, shine: '#FFF3CF', rim: '#8E8A78' };
export const OAK: Material = { deep: PAL.oakDeep, dark: PAL.oakDark, mid: PAL.oak, light: PAL.oakMid, shine: PAL.oakLight, rim: '#4A4440' };
export const IRON: Material = { deep: PAL.ironDeep, dark: PAL.ironDark, mid: PAL.iron, light: PAL.ironLight, shine: PAL.ironShine, rim: '#5A6272' };
export const CHINA: Material = { deep: PAL.chinaDeep, dark: PAL.chinaShadow, mid: PAL.china, light: PAL.chinaLight, shine: '#FFFFFF', rim: '#A9B3C6' };
export const GLAZE: Material = { deep: PAL.glazeDeep, dark: PAL.glazeDark, mid: PAL.glaze, light: PAL.glazeLight, shine: '#BFE0C8', rim: '#5D7C84' };
export const TERRACOTTA: Material = { deep: '#341509', dark: PAL.terracottaDark, mid: PAL.terracotta, light: '#B56A41', shine: '#D99A6E', rim: '#7A6A6A' };
export const LEATHER: Material = { deep: PAL.leatherDeep, dark: PAL.leatherDark, mid: PAL.leather, light: PAL.leatherLight, shine: '#B88A5C', rim: '#5E5A5E' };
export const CANVAS: Material = { deep: PAL.canvasDeep, dark: PAL.canvasDark, mid: PAL.canvas, light: PAL.canvasLight, shine: '#D8C7A0', rim: '#7C808A' };
export const BEECH: Material = { deep: '#2E1B0D', dark: '#563820', mid: '#82603C', light: '#B08A5C', shine: '#E0C190', rim: '#6E6A68' };

/**
 * Shading across a round thing from x0 to x1, lit from the left. Where the surface faces the candle it
 * is brightest (a little in from the left edge), it turns through the halftone to a core shadow past
 * the middle, and a cool reflected edge comes back at the far right. `gloss` adds a narrow specular
 * band (brass, glaze, china) where the light and the eye meet.
 */
export function cylinder(ctx: Ctx, x0: number, x1: number, m: Material, gloss = 0): CanvasGradient {
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  g.addColorStop(0, m.dark);
  g.addColorStop(0.04, m.light);
  if (gloss > 0) {
    g.addColorStop(0.15, m.light);
    g.addColorStop(0.2, m.shine);
    g.addColorStop(0.235, m.shine);
    g.addColorStop(0.3, m.light);
  } else {
    g.addColorStop(0.12, m.light);
  }
  g.addColorStop(0.46, m.mid);
  g.addColorStop(0.68, m.dark);
  g.addColorStop(0.82, m.deep);
  g.addColorStop(0.93, m.rim);
  g.addColorStop(1, m.deep);
  return g;
}

/** A rounded thing lit from the upper left: a knob, a head, a bead. */
export function sphere(ctx: Ctx, cx: number, cy: number, r: number, m: Material): CanvasGradient {
  return rad(ctx, cx - r * 0.42, cy - r * 0.38, r * 0.06, cx - r * 0.1, cy - r * 0.08, r * 1.12, [
    [0, m.shine], [0.16, m.light], [0.45, m.mid], [0.72, m.dark], [0.88, m.deep], [0.96, m.rim], [1, m.deep],
  ]);
}

// ------------------------------------------------------------------ grain

const NOISE = 128;
const noiseCache = new WeakMap<CanvasFactory, Surface | null>();

/** A tile of fine grain, made once per canvas factory, or null where the canvas cannot make one (the
 *  tests' recording context). Each texel is a speck of white or of black with its own opacity, so the
 *  grain lightens and darkens what is under it with plain source-over drawing, the cheapest kind.
 *  Grain is texture only: nothing depends on it being there. */
export function noiseTile(factory: CanvasFactory): Surface | null {
  if (noiseCache.has(factory)) return noiseCache.get(factory) ?? null;
  let tile: Surface | null = null;
  const s = factory(NOISE, NOISE);
  if (s) {
    try {
      const img = s.ctx.createImageData(NOISE, NOISE) as ImageData | undefined;
      if (img && img.data) {
        const r = rng(9001);
        const d = img.data;
        for (let i = 0; i < d.length; i += 4) {
          // Two octaves: single-pixel speckle over a softer mottle, so it reads as material, not static.
          const v = (r() - 0.5) * 1.6 + (r() - 0.5) * 0.6;
          const light = v > 0;
          d[i] = d[i + 1] = d[i + 2] = light ? 255 : 0;
          d[i + 3] = Math.min(255, Math.abs(v) * (light ? 150 : 190));
        }
        s.ctx.putImageData(img, 0, 0);
        tile = s;
      }
    } catch {
      tile = null;
    }
  }
  noiseCache.set(factory, tile);
  return tile;
}

/**
 * Grain over what is clipped inside `area` (mH: x0, y0, x1, y1), one texel per canvas pixel whatever
 * the art's scale (sprites are drawn at the size they were painted). `stretch` draws the noise long
 * along x and `angle` turns it, which gives wood its fibre, a turned brass stem its lathe marks and
 * dipped wax its streaks. Only the area's own pixels are filled: painting stays cheap.
 */
export function grain(c: Ctx, tile: Surface | null, alpha: number, stretch: number, angle: number,
  x0: number, y0: number, x1: number, y1: number): void {
  if (!tile || !(alpha > 0)) return;
  const m = typeof c.getTransform === 'function' ? c.getTransform() : null;
  if (!m) return;
  const pattern = c.createPattern(tile.canvas, 'repeat');
  if (!pattern) return;
  // The area's corners in canvas pixels.
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const) {
    const px = m.a * x + m.c * y + m.e;
    const py = m.b * x + m.d * y + m.f;
    bx0 = Math.min(bx0, px);
    by0 = Math.min(by0, py);
    bx1 = Math.max(bx1, px);
    by1 = Math.max(by1, py);
  }
  const w = bx1 - bx0;
  const h = by1 - by0;
  if (!(w > 0 && h > 0)) return;
  c.save();
  c.setTransform(1, 0, 0, 1, (bx0 + bx1) / 2, (by0 + by1) / 2);
  c.globalAlpha = alpha;
  c.fillStyle = pattern;
  const k = Math.max(1, stretch);
  if (angle !== 0) c.rotate(angle);
  c.scale(k, 1);
  // Large enough to cover the area however the pattern is turned.
  const d = angle !== 0 ? Math.hypot(w, h) : 0;
  const fw = angle !== 0 ? d : w;
  const fh = angle !== 0 ? d : h;
  c.fillRect(-fw / (2 * k), -fh / 2, fw / k, fh);
  c.restore();
}

// ------------------------------------------------------------------ light

/** The candle's warm light along the left of the current path, and the moon's cool edge on its right.
 *  Build the path first; it is clipped to, so only the inner half of each stroke shows. */
export function edgeLight(c: Ctx, x0: number, x1: number, width: number, warm = 0.4, cool = 0.3): void {
  c.save();
  c.clip();
  c.lineWidth = width * 2;
  c.lineJoin = 'round';
  c.strokeStyle = lin(c, x0, 0, x1, 0, [
    [0, `rgba(255,206,140,${warm})`], [0.3, 'rgba(255,206,140,0)'], [0.66, 'rgba(175,192,220,0)'], [1, `rgba(175,192,220,${cool})`],
  ]);
  c.stroke();
  c.restore();
}

// ------------------------------------------------------------------ texture

export interface GrainOptions {
  color: string;
  alpha: number;
  /** Average distance between grain lines. */
  gap: number;
  /** How far a line wanders. */
  wave: number;
  width: number;
  /** Distance between the points of each line (longer is cheaper). */
  stepX?: number;
}

/** How many tones the textures below are drawn in. Every mark of one tone goes into one path and is
 *  drawn with one call, so a texture of hundreds of marks costs a handful of calls to paint. */
const TONES = [0.45, 0.72, 1] as const;

/** Long wavy grain lines along x, inside whatever clip is set. */
export function woodGrain(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, seed: number, o: GrainOptions): void {
  const step = o.stepX ?? 4;
  ctx.save();
  ctx.strokeStyle = o.color;
  for (let t = 0; t < TONES.length; t++) {
    const r = rng(seed + t * 7919);
    ctx.globalAlpha = o.alpha * TONES[t];
    ctx.lineWidth = o.width * (0.7 + 0.35 * t);
    ctx.beginPath();
    for (let y = y0 + r() * o.gap * TONES.length; y < y1; y += o.gap * TONES.length * (0.55 + r() * 0.9)) {
      const amp = o.wave * (0.3 + r());
      const f1 = (0.4 + r()) * 0.045;
      const f2 = (0.2 + r()) * 0.011;
      const p1 = r() * 6.283;
      const p2 = r() * 6.283;
      for (let x = x0; x <= x1 + step; x += step) {
        const yy = y + Math.sin(p1 + x * f1) * amp * 0.35 + Math.sin(p2 + x * f2) * amp;
        if (x === x0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Oak's ray fleck: short pale flashes across the grain on a quarter-sawn face. */
export function rayFleck(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, seed: number, count: number, color: string, alpha: number, len = 6): void {
  ctx.save();
  ctx.fillStyle = color;
  for (let t = 0; t < TONES.length; t++) {
    const r = rng(seed + t * 104729);
    ctx.globalAlpha = alpha * TONES[t];
    ctx.beginPath();
    for (let i = t; i < count; i += TONES.length) {
      const x = x0 + r() * (x1 - x0);
      const y = y0 + r() * (y1 - y0);
      const l = len * (0.4 + r());
      const ry = 0.28 + r() * 0.45;
      const a = (r() - 0.5) * 0.12;
      ctx.moveTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      ctx.ellipse(x, y, l, ry, a, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.restore();
}

/** A knot in the wood: a dark eye with rings around it. */
export function knot(ctx: Ctx, cx: number, cy: number, rx: number, ry: number, alpha: number): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = rad(ctx, cx, cy, 0, cx, cy, rx, [[0, PAL.oakDeep], [0.5, PAL.oakDark], [1, 'rgba(18,11,6,0)']]);
  ellipsePath(ctx, cx, cy, rx, ry);
  ctx.fill();
  ctx.strokeStyle = PAL.oakDeep;
  ctx.lineWidth = 0.6;
  for (let i = 1; i <= 3; i++) {
    ctx.globalAlpha = alpha * (0.5 - i * 0.12);
    ellipsePath(ctx, cx, cy, rx * (1 + i * 0.55), ry * (1 + i * 0.35));
    ctx.stroke();
  }
  ctx.restore();
}

/** Fine dots: grit, velvet nap, soil, the pits of old brass. One path per color and tone. */
export function speckle(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, seed: number, count: number,
  colors: readonly string[], rMin: number, rMax: number, alpha: number): void {
  ctx.save();
  const groups = colors.length * TONES.length;
  for (let g = 0; g < groups; g++) {
    const r = rng(seed + g * 15485863);
    ctx.fillStyle = colors[g % colors.length];
    ctx.globalAlpha = alpha * TONES[Math.floor(g / colors.length)];
    ctx.beginPath();
    for (let i = g; i < count; i += groups) {
      const x = x0 + r() * (x1 - x0);
      const y = y0 + r() * (y1 - y0);
      const rr = rMin + r() * (rMax - rMin);
      ctx.moveTo(x + rr, y);
      ctx.arc(x, y, rr, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.restore();
}

/** A close weave of crossing threads (canvas), inside whatever clip is set: alternate threads in two
 *  tones, each tone one path. */
export function weave(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, step: number, color: string, alpha: number, seed: number): void {
  const r = rng(seed);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = step * 0.32;
  for (const tone of [0.55, 1]) {
    const first = tone < 1 ? 0 : step;
    ctx.globalAlpha = alpha * tone;
    ctx.beginPath();
    for (let x = x0 + first; x <= x1; x += step * 2) {
      ctx.moveTo(x + (r() - 0.5) * step * 0.3, y0);
      ctx.lineTo(x + (r() - 0.5) * step * 0.3, y1);
    }
    for (let y = y0 + step - first; y <= y1; y += step * 2) {
      ctx.moveTo(x0, y + (r() - 0.5) * step * 0.3);
      ctx.lineTo(x1, y + (r() - 0.5) * step * 0.3);
    }
    ctx.stroke();
  }
  ctx.restore();
}

/** Stroke a polyline given as flat [x0, y0, x1, y1, ...]. */
export function polyline(ctx: Ctx, pts: readonly number[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.stroke();
}

/** A domed rivet or nail head with its little shadow, in `m` (brass by default). */
export function rivet(ctx: Ctx, x: number, y: number, r: number, m: Material = BRASS): void {
  ctx.fillStyle = 'rgba(6,4,2,0.55)';
  ctx.beginPath();
  ctx.arc(x + r * 0.35, y + r * 0.4, r * 1.05, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = sphere(ctx, x, y, r, m);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** A run of stitches along a polyline: short dark dashes with a pale thread catching the light. All
 *  the dashes are one path and all the threads another. */
export function stitches(ctx: Ctx, pts: readonly number[], gap: number, len: number, width: number, thread = 'rgba(214,196,160,0.55)'): void {
  ctx.save();
  ctx.lineCap = 'round';
  for (const pass of [0, 1]) {
    ctx.strokeStyle = pass === 0 ? PAL.stitch : thread;
    ctx.lineWidth = pass === 0 ? width * 1.6 : width;
    ctx.beginPath();
    let carry = 0;
    for (let i = 2; i < pts.length; i += 2) {
      const ax = pts[i - 2], ay = pts[i - 1], bx = pts[i], by = pts[i + 1];
      const seg = Math.hypot(bx - ax, by - ay);
      if (!(seg > 0)) continue;
      const ux = (bx - ax) / seg, uy = (by - ay) / seg;
      for (let d = carry; d < seg; d += gap) {
        const x = ax + ux * d, y = ay + uy * d;
        // Across the seam a little, as hand stitches lie.
        const nx = -uy * len * 0.35, ny = ux * len * 0.35;
        if (pass === 0) {
          ctx.moveTo(x - ux * len * 0.5 - nx, y - uy * len * 0.5 - ny);
          ctx.lineTo(x + ux * len * 0.5 + nx, y + uy * len * 0.5 + ny);
        } else {
          ctx.moveTo(x - ux * len * 0.45 - nx - 0.2, y - uy * len * 0.45 - ny - 0.25);
          ctx.lineTo(x + ux * len * 0.4 + nx - 0.2, y + uy * len * 0.4 + ny - 0.25);
        }
      }
      carry = (carry + Math.ceil((seg - carry) / gap) * gap) - seg;
    }
    ctx.stroke();
  }
  ctx.restore();
}
