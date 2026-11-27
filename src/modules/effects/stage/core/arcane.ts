// Magic constructs (Section 10.7, original art): the rune circles that light up round a cast, the
// ward of Protego, and the rings a bolt leaves at the wand and where it lands.
//
// The script is invented: each glyph is a stem and a few marks (branches, bowls, bars, loops,
// dots) picked by a seeded generator, so every spell has its own inscription and none of it is a
// real alphabet. The figures are those of old astrolabes and almanac diagrams: concentric rings,
// tick bands, star polygons and node rings. Nothing is taken from any film.
//
// Each layer is painted once into a cached canvas (per design, color and size bucket) and only
// turned and faded per frame, so a construct costs a few drawImage calls: the 60 fps budget on
// integrated graphics (Section 13). A paint is kept cheap (its glow is blurred at a quarter of the
// size), a frame paints at most one, and the costliest are painted ahead in idle time (Arcana).
// Painting needs a document; in Node nothing is painted or drawn.
//
// Motion answers an action (Section 10.6): a construct turns only while its spell's moment lasts.
// Under reduced motion it neither turns nor grows; it fades in and out, since fading is not motion.

import type { Point } from '../../../../contracts';
import { isSaturatedRed, mixRgb, parseColor, rgba, type Rgb } from './color';
import { findCorners } from './ink';
import { createRandom } from './random';
import { makeCanvas } from './sprites';
import type { View } from './view';

const TAU = Math.PI * 2;
const WHITE: Rgb = { r: 255, g: 255, b: 255 };
/** The ink's gold: a construct's color when none is named. */
const DEFAULT_ACCENT = '#FFD27E';
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t: number): number => 1 - (1 - clamp01(t)) ** 3;
const smooth = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};

// ---------------------------------------------------------------- the script

export type GlyphStroke =
  | { k: 'line'; x0: number; y0: number; x1: number; y1: number }
  | { k: 'arc'; x: number; y: number; r: number; a0: number; a1: number }
  | { k: 'dot'; x: number; y: number }
  | { k: 'ring'; x: number; y: number; r: number };

/** FNV-1a: a stable seed from a spell id. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Rows where marks attach to the stem. */
const ROWS = [-0.36, -0.12, 0.12, 0.36];

/**
 * One glyph of the invented script, in a unit box (x and y in -0.5..0.5, y down, its foot at +y).
 * A stem (a staff, a pair of staves, a crescent or a slant) and one to three marks.
 */
export function glyph(seed: number): GlyphStroke[] {
  const rand = createRandom(Math.imul(seed >>> 0, 0x9e3779b1) ^ 0x5bd1e995);
  const out: GlyphStroke[] = [];
  const kind = rand();
  let sx = 0;
  if (kind < 0.5) {
    out.push({ k: 'line', x0: 0, y0: -0.5, x1: 0, y1: 0.5 });
  } else if (kind < 0.66) {
    out.push({ k: 'line', x0: -0.2, y0: -0.5, x1: -0.2, y1: 0.5 }, { k: 'line', x0: 0.2, y0: -0.5, x1: 0.2, y1: 0.5 });
    sx = rand() < 0.5 ? -0.2 : 0.2;
  } else if (kind < 0.82) {
    out.push({ k: 'arc', x: 0.16, y: 0, r: 0.46, a0: Math.PI * 0.62, a1: Math.PI * 1.38 });
    sx = -0.28;
  } else {
    out.push({ k: 'line', x0: -0.26, y0: 0.5, x1: 0.26, y1: -0.5 });
  }
  const marks = 1 + Math.floor(rand() * 3);
  const used = new Set<number>();
  for (let i = 0; i < marks; i++) {
    let row = Math.floor(rand() * ROWS.length);
    if (used.has(row)) row = (row + 2) % ROWS.length;
    used.add(row);
    const y = ROWS[row];
    // Marks on a stem off the middle grow inward, so the glyph stays in its box.
    const pickSide = rand() < 0.5 ? -1 : 1;
    const side = sx > 0.1 ? -1 : sx < -0.1 ? 1 : pickSide;
    const m = rand();
    if (m < 0.28) {
      // A branch, rising or falling away from the stem.
      out.push({ k: 'line', x0: sx, y0: y, x1: sx + side * 0.36, y1: y + (rand() < 0.5 ? -0.2 : 0.2) });
    } else if (m < 0.42) {
      out.push({ k: 'line', x0: -0.3, y0: y, x1: 0.3, y1: y });
    } else if (m < 0.58) {
      // A bowl hung on the stem.
      out.push(side > 0
        ? { k: 'arc', x: sx, y, r: 0.17, a0: -Math.PI / 2, a1: Math.PI / 2 }
        : { k: 'arc', x: sx, y, r: 0.17, a0: Math.PI / 2, a1: Math.PI * 1.5 });
    } else if (m < 0.7) {
      out.push({ k: 'dot', x: sx + side * 0.3, y });
    } else if (m < 0.84) {
      out.push({ k: 'ring', x: sx, y: y < 0 ? -0.38 : 0.38, r: 0.11 });
    } else {
      out.push(
        { k: 'line', x0: sx - 0.28, y0: y - 0.14, x1: sx, y1: y + 0.08 },
        { k: 'line', x0: sx, y0: y + 0.08, x1: sx + 0.28, y1: y - 0.14 },
      );
    }
  }
  // A bare staff crossed by one bar would read as a cross (and, upside down round a ring, as an
  // inverted one): the bar stops at the staff, on one side.
  const bar = out[1];
  if (kind < 0.5 && out.length === 2 && bar.k === 'line' && bar.y0 === bar.y1 && bar.x0 < 0 && bar.x1 > 0) {
    out[1] = { k: 'line', x0: 0, y0: bar.y0, x1: bar.x1, y1: bar.y1 };
  }
  return out;
}

/** What drawing a construct's path needs (a 2D context, or a recorder in tests). */
type PathSink = Pick<CanvasRenderingContext2D, 'moveTo' | 'lineTo' | 'arc'>;

/** Adds a glyph to the current path: centred at (x, y), `size` tall, its top turned to `angle`
 *  (0 is upright; the glyph's top points along (sin a, -cos a)). Dots become tiny rings, which a
 *  stroke fills, so a whole band of glyphs is one stroke. */
export function addGlyph(p: PathSink, g: readonly GlyphStroke[], x: number, y: number, size: number, angle: number): void {
  const c = Math.cos(angle), s = Math.sin(angle);
  const X = (u: number, v: number) => x + (u * c - v * s) * size;
  const Y = (u: number, v: number) => y + (u * s + v * c) * size;
  for (const st of g) {
    if (st.k === 'line') {
      p.moveTo(X(st.x0, st.y0), Y(st.x0, st.y0));
      p.lineTo(X(st.x1, st.y1), Y(st.x1, st.y1));
    } else if (st.k === 'arc') {
      const u0 = st.x + Math.cos(st.a0) * st.r, v0 = st.y + Math.sin(st.a0) * st.r;
      p.moveTo(X(u0, v0), Y(u0, v0));
      p.arc(X(st.x, st.y), Y(st.x, st.y), st.r * size, st.a0 + angle, st.a1 + angle);
    } else {
      const r = st.k === 'ring' ? st.r : 0.035;
      const cx = X(st.x, st.y), cy = Y(st.x, st.y);
      p.moveTo(cx + r * size, cy);
      p.arc(cx, cy, r * size, 0, TAU);
    }
  }
}

function addCircle(p: PathSink, r: number): void {
  p.moveTo(r, 0);
  p.arc(0, 0, r, 0, TAU);
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** A star polygon {n/k} on radius r (k = 1 is the plain polygon); compounds are drawn whole. */
export function addStar(p: PathSink, n: number, k: number, r: number, rot: number): void {
  const parts = gcd(n, k);
  const per = n / parts;
  for (let s = 0; s < parts; s++) {
    for (let j = 0; j <= per; j++) {
      const i = (s + j * k) % n;
      const a = rot + (i / n) * TAU;
      const x = Math.cos(a) * r, y = Math.sin(a) * r;
      if (j === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
    }
  }
}

function addDiamond(p: PathSink, x: number, y: number, r: number, angle: number): void {
  const c = Math.cos(angle) * r, s = Math.sin(angle) * r;
  // Long along the ring, short across it.
  p.moveTo(x - s * 1.6, y + c * 1.6);
  p.lineTo(x + c * 0.7, y + s * 0.7);
  p.lineTo(x + s * 1.6, y - c * 1.6);
  p.lineTo(x - c * 0.7, y - s * 0.7);
  p.lineTo(x - s * 1.6, y + c * 1.6);
}

// ---------------------------------------------------------------- painting

/**
 * The glow is painted at this fraction of a layer's size and laid under it. A blur is most of what a
 * paint costs (a sixteenth of the pixels costs a sixteenth as much) and a glow has no fine detail to
 * lose: the lines themselves are painted at full size on top.
 */
const GLOW_SCALE = 0.25;
/** A shape drawn this far to the left is off its glow canvas, so only its shadow lands on it. */
const SHADOW_ONLY = 1 << 14;

/** A layer being painted: its canvas and a small one for its glow, both with the origin at the
 *  layer's centre, in the same units (the layer's pixels). */
interface Brush {
  ctx: CanvasRenderingContext2D;
  glow: CanvasRenderingContext2D | null;
  /** Something is in the glow canvas, waiting to be laid under the lines. */
  glowed: boolean;
  /** Lays the glow painted so far under the lines (before a mask that must apply to both). */
  flush(): void;
}

/** Draws only the blurred shadow of what `draw` paints into the glow canvas. */
function shadowOnly(g: CanvasRenderingContext2D, blur: number, color: string, draw: (g: CanvasRenderingContext2D) => void): void {
  g.save();
  // Shadow offsets and blur are in canvas pixels, which the transform does not scale.
  const k = g.getTransform().a || 1;
  g.translate(-SHADOW_ONLY / k, 0);
  g.shadowOffsetX = SHADOW_ONLY;
  g.shadowOffsetY = 0;
  g.shadowBlur = blur * k;
  g.shadowColor = color;
  draw(g);
  g.restore();
}

/**
 * Strokes a path as light: a soft glow of the accent, a tinted body, then a fine core that is
 * nearly white. The glow is a shadow, which only an offscreen paint can afford.
 */
function lightStroke(b: Brush, p: Path2D, accent: Rgb, width: number, glow: number, strength = 1): void {
  const body = rgba(mixRgb(accent, WHITE, 0.25), 0.78 * strength);
  if (b.glow) {
    shadowOnly(b.glow, glow, rgba(accent, 0.9 * strength), (g) => {
      g.strokeStyle = body;
      g.lineWidth = width * 2;
      g.stroke(p);
    });
    b.glowed = true;
  }
  const ctx = b.ctx;
  ctx.strokeStyle = body;
  ctx.lineWidth = width * 2;
  ctx.stroke(p);
  ctx.strokeStyle = rgba(mixRgb(accent, WHITE, 0.82), 0.95 * strength);
  ctx.lineWidth = Math.max(0.75, width * 0.7);
  ctx.stroke(p);
}

/** Fills a path as light, with a glow of `shadow` round it. */
function lightFill(b: Brush, p: Path2D, fill: string, shadow: string, glow: number): void {
  if (b.glow) {
    shadowOnly(b.glow, glow, shadow, (g) => {
      g.fillStyle = fill;
      g.fill(p);
    });
    b.glowed = true;
  }
  b.ctx.fillStyle = fill;
  b.ctx.fill(p);
}

/** A ring of runes. Radii are fractions of the half-size of the canvas it is painted in. */
export interface RingDesign {
  seed: number;
  runes: number;
  ticks: number;
  /** The band the runes sit in: inner and outer radius. */
  band: readonly [number, number];
  /** Draw the inner bold ring and its hairline (a cast's circle; a ward's rim has none). */
  inner: boolean;
  /** As big as the mirror (a ward's rim, Revelio's lens): painted up to BIG_BUCKET, so it stays
   *  sharp on a large or high-density screen. There is one of each at a time. */
  big?: boolean;
}

/** The outer bold ring of every RingDesign sits at this radius (a fraction of the half-size). */
export const RING_OUTER = 0.94;

function paintRing(b: Brush, S: number, accent: Rgb, d: RingDesign): void {
  const m = S / 2;
  const w = Math.max(0.8, S * 0.0021);
  const [b0, b1] = d.band;
  // The bold rings.
  const bold = new Path2D();
  addCircle(bold, RING_OUTER * m);
  if (d.inner) addCircle(bold, (b0 - 0.035) * m);
  lightStroke(b, bold, accent, w * 1.5, S * 0.011);
  // Hairlines: the band's edges, the tick band, the runes and the beads between them.
  const fine = new Path2D();
  const tick0 = RING_OUTER - 0.04;
  addCircle(fine, tick0 * m);
  addCircle(fine, b1 * m);
  addCircle(fine, b0 * m);
  if (d.inner) addCircle(fine, (b0 - 0.075) * m);
  for (let i = 0; i < d.ticks; i++) {
    const a = (i / d.ticks) * TAU;
    const r1 = (i % 6 === 0 ? RING_OUTER : RING_OUTER - 0.018) * m;
    fine.moveTo(Math.cos(a) * tick0 * m, Math.sin(a) * tick0 * m);
    fine.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
  }
  const mid = ((b0 + b1) / 2) * m;
  const tall = (b1 - b0) * m * 0.72;
  for (let i = 0; i < d.runes; i++) {
    const a = (i / d.runes) * TAU;
    addGlyph(fine, glyph(d.seed * 131 + i * 17 + 3), Math.cos(a) * mid, Math.sin(a) * mid, tall, a + Math.PI / 2);
    const c = a + Math.PI / d.runes;
    addDiamond(fine, Math.cos(c) * mid, Math.sin(c) * mid, tall * 0.1, c);
  }
  lightStroke(b, fine, accent, w, S * 0.007, 0.92);
  if (d.inner) {
    // Beads on the innermost hairline, every few runes.
    const beads = new Path2D();
    const rb = (b0 - 0.075) * m;
    const count = Math.max(6, Math.round(d.runes / 2));
    for (let i = 0; i < count; i++) {
      const a = ((i + 0.5) / count) * TAU;
      const x = Math.cos(a) * rb, y = Math.sin(a) * rb;
      beads.moveTo(x + w * 2.2, y);
      beads.arc(x, y, w * 2.2, 0, TAU);
    }
    lightFill(b, beads, rgba(mixRgb(accent, WHITE, 0.7), 0.95), rgba(accent, 0.9), S * 0.008);
  }
}

/**
 * The step of a sigil's star {n/k}: always one unbroken line (k prime to n), never a compound of
 * polygons. Overlapping triangles inside a ring, with a stroke through them, could read as another
 * work's well-known emblem; six points make a religious symbol, and five inside a ring a pentacle.
 * sidesFor asks for 7 to 11 points only.
 */
const STAR_STEP: Readonly<Record<number, number>> = { 7: 3, 8: 3, 9: 4, 10: 3, 11: 4 };

/** The step k of the star {n/k} a sigil of `sides` points draws (1, the plain polygon, if none fits). */
export function starStep(sides: number): number {
  const k = STAR_STEP[sides] ?? 2;
  return gcd(sides, k) === 1 ? k : 1;
}

/** The figure inside a cast's circle: a star polygon in a ring, nodes at its points, runes in its
 *  notches, a ticked inner circle and a seal at the centre. Fills its canvas (radius 1). */
function paintSigil(b: Brush, S: number, accent: Rgb, seed: number, sides: number): void {
  const m = S / 2;
  const w = Math.max(0.8, S * 0.0032);
  const R = 0.9 * m;
  const rot = -Math.PI / 2;
  const star = new Path2D();
  addCircle(star, R);
  addStar(star, sides, starStep(sides), R, rot);
  lightStroke(b, star, accent, w * 1.25, S * 0.014);

  const fine = new Path2D();
  addCircle(fine, R * 1.045);
  addStar(fine, sides, 1, R, rot + Math.PI / sides);
  addCircle(fine, R * 0.5);
  addCircle(fine, R * 0.455);
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * TAU;
    const r0 = R * (i % 4 === 0 ? 0.4 : 0.43);
    fine.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
    fine.lineTo(Math.cos(a) * R * 0.455, Math.sin(a) * R * 0.455);
  }
  // Node rings at the star's points.
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * TAU;
    const x = Math.cos(a) * R, y = Math.sin(a) * R;
    fine.moveTo(x + R * 0.06, y);
    fine.arc(x, y, R * 0.06, 0, TAU);
  }
  // Runes in the notches between the points, and a seal at the centre.
  for (let i = 0; i < sides; i++) {
    const a = rot + ((i + 0.5) / sides) * TAU;
    addGlyph(fine, glyph(seed * 977 + i * 29 + 11), Math.cos(a) * R * 0.74, Math.sin(a) * R * 0.74, R * 0.15, a + Math.PI / 2);
  }
  addCircle(fine, R * 0.17);
  addCircle(fine, R * 0.12);
  // The seal: a rosette of six overlapping circles, not a glyph. A stroke through the middle could,
  // round a triangle (Incendio's shape), read as another work's well-known emblem.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    const x = Math.cos(a) * R * 0.055, y = Math.sin(a) * R * 0.055;
    fine.moveTo(x + R * 0.055, y);
    fine.arc(x, y, R * 0.055, 0, TAU);
  }
  lightStroke(b, fine, accent, w * 0.75, S * 0.009, 0.92);

  // Bright points at the star's tips.
  const tips = new Path2D();
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * TAU;
    const x = Math.cos(a) * R, y = Math.sin(a) * R;
    tips.moveTo(x + R * 0.022, y);
    tips.arc(x, y, R * 0.022, 0, TAU);
  }
  lightFill(b, tips, rgba(mixRgb(accent, WHITE, 0.85), 1), rgba(accent, 1), S * 0.02);
}

/**
 * Protego's tracery: a rose window of light laid on a dome seen face on. Rings of foils, a chain of
 * interlaced circles, spokes and a ring of pointed arches, drawn on a flat window and then wrapped
 * onto the sphere (each figure shrinks toward the rim as the surface turns away). It is lit mostly
 * near the rim, as a lit bubble is, and stays nearly clear in the middle so the face shows through.
 * Fills its canvas (radius 1 is the dome's rim).
 */
function paintTracery(b: Brush, S: number, accent: Rgb): void {
  const m = S / 2;
  const R = 0.985 * m;
  // The window (radius 1) is wrapped onto the sphere: window radius rho lands at R sin(rho pi / 2).
  const at = (rho: number, a: number): [number, number] => {
    const r = R * Math.sin((Math.min(1, Math.max(0, rho)) * Math.PI) / 2);
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  // A polyline on the window, given as (rho, angle) samples.
  const line = (p: Path2D, pts: [number, number][]): void => {
    for (let i = 0; i < pts.length; i++) {
      const [x, y] = at(pts[i][0], pts[i][1]);
      if (i === 0) p.moveTo(x, y);
      else p.lineTo(x, y);
    }
  };
  // A circle on the window, centred at (rho, angle) with window radius r.
  const circle = (p: Path2D, rho: number, a: number, r: number): void => {
    const cx = Math.cos(a) * rho, cy = Math.sin(a) * rho;
    const pts: [number, number][] = [];
    for (let i = 0; i <= 40; i++) {
      const u = (i / 40) * TAU;
      const x = cx + Math.cos(u) * r, y = cy + Math.sin(u) * r;
      pts.push([Math.hypot(x, y), Math.atan2(y, x)]);
    }
    line(p, pts);
  };
  const ring = (p: Path2D, rho: number): void => {
    const pts: [number, number][] = [];
    for (let i = 0; i <= 120; i++) pts.push([rho, (i / 120) * TAU]);
    line(p, pts);
  };
  const spokes = 12;

  // The frame: rings and spokes, a little bolder.
  const frame = new Path2D();
  for (const rho of [0.2, 0.43, 0.7, 0.93]) ring(frame, rho);
  for (let i = 0; i < spokes; i++) {
    const a = (i / spokes) * TAU;
    line(frame, [[0.2, a], [0.43, a]]);
    line(frame, [[0.7, a], [1, a]]);
  }
  lightStroke(b, frame, accent, Math.max(0.8, S * 0.0024), S * 0.008, 0.9);

  // The fill: foils, the chain, the arches.
  const fill = new Path2D();
  for (let i = 0; i < spokes; i++) circle(fill, 0.315, ((i + 0.5) / spokes) * TAU, 0.075);
  for (let i = 0; i < spokes * 2; i++) circle(fill, 0.565, (i / (spokes * 2)) * TAU, 0.09);
  for (let i = 0; i < spokes * 2; i++) {
    // A pointed arch between each pair of half-spokes, springing from the 0.7 ring.
    const a0 = (i / (spokes * 2)) * TAU, a1 = ((i + 1) / (spokes * 2)) * TAU, mid = (a0 + a1) / 2;
    const pts: [number, number][] = [];
    for (let k = 0; k <= 12; k++) {
      const u = k / 12;
      // Rises from the springing points to an apex near the outer ring, pointed at the top.
      const lift = Math.sin(u * Math.PI) ** 0.6;
      pts.push([0.7 + 0.2 * lift, a0 + (a1 - a0) * u]);
    }
    line(fill, pts);
    if (i % 2 === 0) line(fill, [[0.7, mid], [0.8, mid]]);
  }
  lightStroke(b, fill, accent, Math.max(0.7, S * 0.0016), S * 0.006, 0.8);

  // Lit toward the rim: fade the middle out (a bubble is clear where you look straight through it),
  // glow and lines alike.
  b.flush();
  const ctx = b.ctx;
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, m);
  g.addColorStop(0, 'rgba(0,0,0,0.03)');
  g.addColorStop(0.35, 'rgba(0,0,0,0.06)');
  g.addColorStop(0.6, 'rgba(0,0,0,0.22)');
  g.addColorStop(0.82, 'rgba(0,0,0,0.65)');
  g.addColorStop(0.95, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.globalCompositeOperation = 'destination-in';
  ctx.fillStyle = g;
  ctx.fillRect(-m, -m, S, S);
  ctx.globalCompositeOperation = 'source-over';
}

// ---------------------------------------------------------------- the cache

const BUCKETS = [128, 192, 256, 384, 512, 768, 1024, 1536] as const;
/** The largest canvas most layers are painted at (about 4 MB); larger ones are drawn enlarged. */
const BUCKET_MAX = 1024;
/** The largest for a mirror-sized layer (RingDesign.big, Protego's tracery): about 9 MB. */
export const BIG_BUCKET = 1536;
/**
 * Construct canvases kept (each up to 1024 px square, about 4 MB, or 1536 for the few mirror-sized
 * ones): enough for the layers of a few spells cast in turn (a circle is two, Protego's ward two,
 * Revelio's lens two, a bolt two), so a varied session paints each once. A frame may need more than
 * this, and never loses a layer it is using (FrameCache).
 */
export const CACHE_SIZE = 16;

/** The canvas side to paint a layer at, to be drawn `px` wide: the bucket at or above it, at most `max`. */
export function bucketFor(px: number, max: number = BUCKET_MAX): number {
  let last: number = BUCKETS[0];
  for (const b of BUCKETS) {
    if (b > max) break;
    last = b;
    if (b >= px) return b;
  }
  return last;
}

type Painter = (b: Brush, size: number) => void;

/**
 * Least recently used first, except that nothing the current or the previous frame used is dropped:
 * frames draw the same layers in the same order, so a layer the last frame drew is one this frame
 * is about to draw. A frame that needs more than `cap` items keeps them all, rather than each new
 * paint dropping the next layer to be drawn (one layer missing a frame, a different one each time).
 * Pure; tested.
 */
export class FrameCache<T> {
  private readonly items = new Map<string, { value: T; frame: number }>();
  /** The current frame (FrameCache.beginFrame). */
  frame = 0;

  constructor(private readonly cap: number) {}

  beginFrame(): void {
    this.frame++;
  }

  get(key: string): T | undefined {
    const hit = this.items.get(key);
    if (!hit) return undefined;
    this.items.delete(key);
    hit.frame = this.frame;
    this.items.set(key, hit);
    return hit.value;
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  /**
   * An item kept under the same key but another size (keys end in `:<size>`), marked as used: the
   * same layer at the size it was painted before, to draw scaled while the new size waits its turn
   * (after a resize), rather than nothing.
   */
  sibling(key: string): T | undefined {
    const cut = key.lastIndexOf(':');
    if (cut < 0) return undefined;
    const prefix = key.slice(0, cut + 1);
    for (const k of this.items.keys()) if (k !== key && k.startsWith(prefix)) return this.get(k);
    return undefined;
  }

  set(key: string, value: T): void {
    this.items.delete(key);
    this.items.set(key, { value, frame: this.frame });
    if (this.items.size <= this.cap) return;
    for (const [k, item] of this.items) {
      if (this.items.size <= this.cap) break;
      if (item.frame < this.frame - 1) this.items.delete(k);
    }
  }

  get size(): number {
    return this.items.size;
  }

  clear(): void {
    this.items.clear();
  }
}

/**
 * Painted layers. A layer is painted the first time a frame asks for it, at most one per frame (the
 * others wait a frame or so; the first moments of a construct are nearly transparent anyway), and the
 * layers a spell is sure to want can be painted ahead, in idle time (ring/sigil/tracery with
 * `ahead`, warm, prewarm).
 */
export class Arcana {
  private readonly cache = new FrameCache<CanvasImageSource>(CACHE_SIZE);
  /** Wanted ahead of use: painted one at a time when the browser is idle. A layer not to keep is
   *  painted only to have the browser do its first paint of that kind and size then (warm). */
  private readonly wanted = new Map<string, { size: number; paint: Painter; keep: boolean }>();
  /** Kinds and sizes already painted once to warm them. */
  private readonly warmed = new Set<string>();
  private paintedIn = -1;
  private idle = false;
  /** The glow's canvas, kept between paints. */
  private glowCanvas: HTMLCanvasElement | null = null;
  /** A pixel to draw a layer painted in idle time into, so its painting is done then (a browser
   *  may otherwise leave the work until the layer is first drawn). */
  private sink: CanvasRenderingContext2D | null = null;
  /** Paints done (for tests and the harness). */
  paints = 0;

  /** Starts a frame: the layers it uses are kept, and it may paint one. */
  beginFrame(): void {
    this.cache.beginFrame();
  }

  ring(d: RingDesign, color: string, px: number, ahead = false): CanvasImageSource | null {
    const size = bucketFor(px, d.big ? BIG_BUCKET : BUCKET_MAX);
    const c = canonical(color);
    const key = `ring:${d.seed}:${d.runes}:${d.ticks}:${d.band[0]}:${d.band[1]}:${d.inner ? 1 : 0}:${c}:${size}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const accent = parseColor(c, DEFAULT_ACCENT);
    return this.miss(key, size, (b, s) => paintRing(b, s, accent, d), ahead);
  }

  sigil(seed: number, sides: number, color: string, px: number, ahead = false): CanvasImageSource | null {
    const size = bucketFor(px);
    const c = canonical(color);
    const key = `sigil:${seed}:${sides}:${c}:${size}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const accent = parseColor(c, DEFAULT_ACCENT);
    return this.miss(key, size, (b, s) => paintSigil(b, s, accent, seed, sides), ahead);
  }

  /** Protego's tracery (paintTracery): as big as the mirror. */
  tracery(color: string, px: number, ahead = false): CanvasImageSource | null {
    const size = bucketFor(px, BIG_BUCKET);
    const c = canonical(color);
    const key = `tracery:${c}:${size}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const accent = parseColor(c, '#BFE3FF');
    return this.miss(key, size, (b, s) => paintTracery(b, s, accent), ahead);
  }

  /**
   * A browser's first paint of a kind of layer at a size is many times slower than the rest (tens to
   * a couple of hundred milliseconds: it sets up the work on the graphics processor). This paints one
   * of `kind` at `size` in idle time and throws it away, so the first cast after launch does not pay.
   */
  warm(kind: 'ring' | 'sigil', size: number): void {
    const key = `warm:${kind}:${size}`;
    if (this.warmed.has(key) || this.wanted.has(key)) return;
    const accent = parseColor(DEFAULT_ACCENT, DEFAULT_ACCENT);
    const paint: Painter = kind === 'ring' ? (b, s) => paintRing(b, s, accent, CAST_RING(0)) : (b, s) => paintSigil(b, s, accent, 0, 7);
    this.wanted.set(key, { size, paint, keep: false });
  }

  /** Layers wanted ahead and not yet painted. */
  get waiting(): number {
    return this.wanted.size;
  }

  /** Forgets what was wanted ahead (for a view size that has gone: a window being dragged). */
  unwant(): void {
    this.wanted.clear();
  }

  /** Paints what is wanted ahead in idle time, one layer per idle moment (where the browser has
   *  idle callbacks; elsewhere each is painted when first drawn). */
  prewarm(): void {
    if (this.idle || !this.wanted.size) return;
    const ric = (globalThis as { requestIdleCallback?: (cb: (d: { timeRemaining(): number }) => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (typeof ric !== 'function') return;
    this.idle = true;
    ric((deadline) => {
      this.idle = false;
      if (deadline.timeRemaining() >= 8) this.paintWanted();
      this.prewarm();
    }, { timeout: 3000 });
  }

  clear(): void {
    this.cache.clear();
    this.wanted.clear();
  }

  /** A layer not painted yet: wanted ahead, painted now, or (a paint already done this frame) left
   *  for a later frame. */
  private miss(key: string, size: number, paint: Painter, ahead: boolean): CanvasImageSource | null {
    if (ahead) {
      this.wanted.set(key, { size, paint, keep: true });
      return null;
    }
    // One paint a frame; the rest wait their turn, drawn meanwhile from the same layer at another
    // size if one is kept (a resize changed the size it is wanted at).
    if (this.paintedIn === this.cache.frame) return this.cache.sibling(key) ?? null;
    return this.paint(key, size, paint);
  }

  private paintWanted(): void {
    const next = this.wanted.entries().next();
    if (next.done) return;
    const [key, job] = next.value;
    this.wanted.delete(key);
    if (this.cache.has(key)) return;
    const img = this.paint(key, job.size, job.paint, job.keep);
    if (!img) return;
    if (!job.keep) this.warmed.add(key);
    if (!this.sink) this.sink = makeCanvas(1, 1)?.getContext('2d') ?? null;
    this.sink?.drawImage(img, 0, 0, 1, 1);
  }

  private paint(key: string, size: number, paint: Painter, keep = true): CanvasImageSource | null {
    const canvas = makeCanvas(size, size);
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return null;
    this.paintedIn = this.cache.frame;
    this.wanted.delete(key);
    const gs = Math.max(8, Math.round(size * GLOW_SCALE));
    if (!this.glowCanvas || this.glowCanvas.width < gs) this.glowCanvas = makeCanvas(gs, gs);
    const gc = this.glowCanvas;
    const g = gc?.getContext('2d') ?? null;
    if (g && gc) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, gc.width, gc.height);
      const k = gs / size;
      g.setTransform(k, 0, 0, k, gs / 2, gs / 2);
      g.lineCap = 'round';
      g.lineJoin = 'round';
    }
    ctx.setTransform(1, 0, 0, 1, size / 2, size / 2);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const brush: Brush = {
      ctx,
      glow: g,
      glowed: false,
      flush: () => {
        if (!brush.glowed || !g || !gc) return;
        brush.glowed = false;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = 'destination-over';
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(gc, 0, 0, gs, gs, 0, 0, size, size);
        ctx.restore();
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, gc.width, gc.height);
        g.restore();
      },
    };
    paint(brush, size);
    brush.flush();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.paints++;
    if (keep) this.cache.set(key, canvas);
    return canvas;
  }
}

/** One spelling of each color for the cache's keys, remembered (colors come from the packs). */
const CANONICAL = new Map<string, string>();
function canonical(color: string): string {
  let c = CANONICAL.get(color);
  if (c === undefined) {
    c = color.trim().toLowerCase();
    if (CANONICAL.size > 256) CANONICAL.clear();
    CANONICAL.set(color, c);
  }
  return c;
}

/** Draws a square layer centred at (x, y), `half` px from centre to edge, turned by `angle`;
 *  `squash` flattens it across `tilt` (a ring seen at a slant). */
export function drawLayer(
  ctx: CanvasRenderingContext2D, img: CanvasImageSource, x: number, y: number, half: number, angle: number, alpha: number,
  squash = 1, tilt = 0,
): void {
  if (alpha <= 0.004 || half < 1) return;
  ctx.save();
  ctx.translate(x, y);
  if (squash !== 1) {
    ctx.rotate(tilt);
    ctx.scale(squash, 1);
    ctx.rotate(-tilt);
  }
  ctx.rotate(angle);
  ctx.globalAlpha = Math.min(1, alpha);
  ctx.drawImage(img, -half, -half, half * 2, half * 2);
  ctx.restore();
}

// ---------------------------------------------------------------- the cast's circle

/** The circle round a cast: drawn in by a turning wedge while the ink settles, held while the
 *  incantation writes itself, then it widens a little and fades as the effect takes over. */
export const CAST_CIRCLE = {
  /** The wedge sweeps round in this long. */
  drawMs: 460,
  /** Fully lit from the start until here. */
  holdMs: 1050,
  outMs: 1000,
  /** Outer ring and inner figure, at most this bright. */
  ringAlpha: 0.78,
  sigilAlpha: 0.62,
  /** Turns (radians per second): the ring one way, the figure the other. */
  spin: 0.28,
  /** Size against the gesture's own reach. */
  reach: 1.2,
  minRadius: 0.13,
  maxRadius: 0.36,
} as const;

/** How bright a construct of this color may be: saturated reds are kept dimmer, as red bolts are
 *  (WCAG's red-flash rule, limits.ts). */
export function constructBrightness(color: string): number {
  return isSaturatedRed(parseColor(color, DEFAULT_ACCENT)) ? 0.72 : 1;
}

/** The ring of a cast's circle: its spell's own runes. */
const CAST_RING = (seed: number): RingDesign => ({ seed, runes: 26, ticks: 120, band: [0.76, 0.885], inner: true });

export class CastCircle {
  readonly total = CAST_CIRCLE.holdMs + CAST_CIRCLE.outMs;
  readonly brightness: number;
  /** Its ring: the spell's own runes. */
  readonly ring: RingDesign;
  /** Shed its motes (once, as it starts to fade). */
  shed = false;
  constructor(
    readonly castId: string,
    /** Centre, caster space. */
    readonly x: number,
    readonly y: number,
    /** Radius in caster heights. */
    readonly radius: number,
    readonly color: string,
    readonly seed: number,
    readonly sides: number,
    readonly born: number,
    readonly still: boolean,
  ) {
    this.brightness = constructBrightness(color);
    this.ring = CAST_RING(seed);
  }

  done(now: number): boolean {
    return now - this.born >= this.total;
  }
}

/** The centre and reach of a shape (caster space; reach in caster heights), from its points. */
export function circleFor(points: readonly Point[], aspect: number): { x: number; y: number; radius: number } | null {
  if (!points.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [px, py] of points) {
    const ix = px * aspect;
    if (ix < x0) x0 = ix;
    if (ix > x1) x1 = ix;
    if (py < y0) y0 = py;
    if (py > y1) y1 = py;
  }
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) return null;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let reach = 0;
  for (const [px, py] of points) reach = Math.max(reach, Math.hypot(px * aspect - cx, py - cy));
  const radius = Math.min(CAST_CIRCLE.maxRadius, Math.max(CAST_CIRCLE.minRadius, reach * CAST_CIRCLE.reach + 0.02));
  return { x: cx / aspect, y: cy, radius };
}

/**
 * Whether a shape set inside a ring would make an emblem (Section 10.7): a star drawn in one stroke
 * that closes on itself (a five-point star in a circle is a pentacle), or a zig-zag with two sharp
 * turns (a lightning bolt in a circle is a known political emblem, and a scar's mark). Such a shape
 * lights no circle and has no stencil; its spell's own effect still plays. Caster space; aspect is
 * width ÷ height. Pure; tested.
 */
export function emblemLike(points: readonly Point[], aspect: number): boolean {
  const n = 96;
  if (points.length < 3) return false;
  // Evenly along its length, in units of the caster's height.
  const len: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    len.push(len[i - 1] + Math.hypot((points[i][0] - points[i - 1][0]) * aspect, points[i][1] - points[i - 1][1]));
  }
  const total = len[len.length - 1];
  if (!(total > 1e-6)) return false;
  const x: number[] = [], y: number[] = [];
  for (let k = 0, j = 0; k < n; k++) {
    const at = (k / (n - 1)) * total;
    while (j < len.length - 2 && len[j + 1] < at) j++;
    const t = len[j + 1] > len[j] ? (at - len[j]) / (len[j + 1] - len[j]) : 0;
    x.push((points[j][0] + (points[j + 1][0] - points[j][0]) * t) * aspect);
    y.push(points[j][1] + (points[j + 1][1] - points[j][1]) * t);
  }
  const size = Math.max(Math.max(...x) - Math.min(...x), Math.max(...y) - Math.min(...y));
  const closed = Math.hypot(x[n - 1] - x[0], y[n - 1] - y[0]) < 0.15 * size;
  // Where it crosses itself (segments that are not neighbours, nor the two that meet to close it).
  let crossings = 0;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 2; j < n - 1; j++) {
      if (i === 0 && j === n - 2) continue;
      const d1 = (x[i + 1] - x[i]) * (y[j] - y[i]) - (y[i + 1] - y[i]) * (x[j] - x[i]);
      const d2 = (x[i + 1] - x[i]) * (y[j + 1] - y[i]) - (y[i + 1] - y[i]) * (x[j + 1] - x[i]);
      const d3 = (x[j + 1] - x[j]) * (y[i] - y[j]) - (y[j + 1] - y[j]) * (x[i] - x[j]);
      const d4 = (x[j + 1] - x[j]) * (y[i + 1] - y[j]) - (y[j + 1] - y[j]) * (x[i + 1] - x[j]);
      if (d1 * d2 < 0 && d3 * d4 < 0) crossings++;
    }
  }
  // Already in caster-height units: findCorners' aspect is 1 here.
  const corners = findCorners(x, y, n, 1);
  if (closed) return crossings >= 3 && corners.length >= 4;
  if (corners.length !== 2 || crossings > 0) return false;
  // A zig-zag: the two turns go opposite ways.
  const turn = (i: number): number => {
    const a = Math.max(0, i - 3), b = Math.min(n - 1, i + 3);
    return Math.sign((x[i] - x[a]) * (y[b] - y[i]) - (y[i] - y[a]) * (x[b] - x[i]));
  };
  return turn(corners[0]) * turn(corners[1]) < 0;
}

/** A spell's seed for its circle: the same in its cast and in its practice stencil. */
export function spellSeed(spellId: string): number {
  return hashString(spellId) % 100000;
}

/** The points a spell's star may have (never 5 or 6: see STAR_STEP). */
const STAR_POINTS = [11, 10, 7, 8, 9] as const;

/** How many points a spell's figure has (7, 8, 9, 10 or 11), from its seed. */
export function sidesFor(seed: number): number {
  return STAR_POINTS[seed % STAR_POINTS.length];
}

/** What the circles need from the stage when they shed their motes. */
export interface MoteSink {
  spawn(spec: { preset: 'stars'; x: number; y: number; count: number; color?: string; speed?: number; size?: number; lifeMs?: number; spreadDeg?: number; directionDeg?: number }): void;
}

/**
 * How often a circle may light (Section 10.6). A circle coming up is a quick change of light over a
 * wide area, so they light no closer together than this: however fast the casts come (a pen flicked
 * up and down three times a second, Protego cast again and again), the circles' area never flashes
 * more than two or three times a second. A cast that comes sooner lights none; those already lit
 * stay and fade as they would, so none ever vanishes at once.
 */
export const CIRCLE_GAP_MS = 400;
/** At most this many at once (each is two layers to draw); a cast beyond it lights none. */
export const MAX_CIRCLES = 4;
/** How long a circle that holds still keeps the next one at its place still too (see cast). */
export const STILL_HOLD_MS = 800;

export class ConstructLayer {
  readonly arcana = new Arcana();
  circles: CastCircle[] = [];

  /**
   * A cast's circle round its settled shape, unless one lit too recently (CIRCLE_GAP_MS) or too many
   * are lit (MAX_CIRCLES). One lit over another holds still, as under reduced motion (it only fades
   * in and out), while that one is turning and fully lit (its first holdMs) or is itself holding
   * still and was lit less than STILL_HOLD_MS ago. So when casts come fast only one circle at a time
   * turns at a place, and the runes of several never sweep over the same place at once (a pattern
   * turning past a point flickers there, and several together would flicker more than three times a
   * second). At a steady pace of about one a second every other one turns; further apart (Lumos,
   * then Nox a second or two later), every one does.
   */
  cast(castId: string, shape: readonly Point[] | null, color: string, spellId: string, now: number, aspect: number, reducedMotion: boolean): CastCircle | null {
    const at = shape && !emblemLike(shape, aspect) ? circleFor(shape, aspect) : null;
    if (!at) return null;
    let live = 0, last = -Infinity, crowded = false;
    for (const c of this.circles) {
      if (c.done(now)) continue;
      live++;
      if (c.born <= now && c.born > last) last = c.born;
      const claims = c.still ? STILL_HOLD_MS : CAST_CIRCLE.holdMs;
      if (now - c.born < claims && Math.hypot((c.x - at.x) * aspect, c.y - at.y) < c.radius + at.radius) crowded = true;
    }
    if (live >= MAX_CIRCLES || now - last < CIRCLE_GAP_MS) return null;
    const seed = spellSeed(spellId);
    const c = new CastCircle(castId, at.x, at.y, at.radius, color, seed, sidesFor(seed), now, reducedMotion || crowded);
    this.circles.push(c);
    return c;
  }

  animating(): boolean {
    return this.circles.length > 0;
  }

  update(now: number, aspect: number, motes: MoteSink | null, moteCount: (n: number) => number): void {
    for (const c of this.circles) {
      if (!c.shed && now - c.born >= CAST_CIRCLE.holdMs) {
        c.shed = true;
        if (!motes) continue;
        // As it fades the circle lets go of a few motes round its rim.
        const n = moteCount(14);
        for (let i = 0; i < n; i++) {
          const a = (i / Math.max(1, n)) * TAU + c.seed;
          motes.spawn({
            preset: 'stars', x: c.x + (Math.cos(a) * c.radius * 0.94) / aspect, y: c.y + Math.sin(a) * c.radius * 0.94,
            count: 1, color: c.color, speed: 0.35, size: 0.6, lifeMs: 900, spreadDeg: 50, directionDeg: -90,
          });
        }
      }
    }
    if (this.circles.some((c) => c.done(now))) this.circles = this.circles.filter((c) => !c.done(now));
  }

  clear(): void {
    this.circles = [];
  }

  /** Light layer ('lighter'). */
  draw(ctx: CanvasRenderingContext2D, view: View, now: number): void {
    if (!this.circles.length) return;
    const unit = view.caster.height * view.dpr;
    const cap = view.height * view.dpr * 0.45;
    ctx.globalCompositeOperation = 'lighter';
    for (const c of this.circles) {
      const t = now - c.born;
      if (t < 0 || t >= c.total) continue;
      const R = Math.min(cap, c.radius * unit);
      if (R < 4) continue;
      const out = t > CAST_CIRCLE.holdMs ? clamp01((t - CAST_CIRCLE.holdMs) / CAST_CIRCLE.outMs) : 0;
      const fadeOut = (1 - out) ** 1.6;
      const lit = c.still ? smooth(t / 260) : smooth(t / 320);
      const drawn = c.still ? 1 : easeOut(t / CAST_CIRCLE.drawMs);
      const spin = c.still ? 0 : CAST_CIRCLE.spin * (t / 1000) + 0.7 * (1 - Math.exp(-t / 240));
      const grow = c.still ? 1 : 0.9 + 0.1 * drawn + 0.07 * easeOut(out);
      const x = view.px(c.x), y = view.py(c.y);
      const half = (R * grow) / RING_OUTER;
      // Each layer is asked for only once it shows: the first frames are nearly transparent, and a
      // paint there would buy nothing (Arcana paints at most one layer a frame).
      const ringAlpha = CAST_CIRCLE.ringAlpha * c.brightness * lit * fadeOut;
      // Painted at the largest size it is drawn, so growing never paints it again.
      const ring = ringAlpha > 0.004 ? this.arcana.ring(c.ring, c.color, ((R * 1.07) / RING_OUTER) * 2) : null;
      if (ring) {
        ctx.save();
        if (drawn < 0.999) {
          // Drawn in clockwise from the top by a turning wedge.
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.arc(x, y, half * 1.05, -Math.PI / 2, -Math.PI / 2 + TAU * drawn);
          ctx.closePath();
          ctx.clip();
        }
        drawLayer(ctx, ring, x, y, half, spin, ringAlpha);
        ctx.restore();
      }
      // The figure inside comes a beat later and turns against the ring.
      const sLit = c.still ? lit : smooth((t - 140) / 380);
      const sigilAlpha = CAST_CIRCLE.sigilAlpha * c.brightness * sLit * fadeOut;
      if (sigilAlpha > 0.004) {
        const sHalf = R * grow * (c.still ? 0.6 : 0.6 * (0.86 + 0.14 * easeOut((t - 140) / 420)) * (1 - 0.06 * out));
        const sigil = this.arcana.sigil(c.seed, c.sides, c.color, R * 1.2);
        if (sigil) drawLayer(ctx, sigil, x, y, sHalf, -spin * 1.7 + (c.seed % 628) / 100, sigilAlpha);
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }
}

/**
 * A turn that comes to rest: `rate` radians per second at first, slowing so that it stops by about
 * `settleMs`. A construct that is held (a held ward, a held reveal) turns into place and then holds
 * still: motion answers an action, and the only ambient motion is the candle's flicker (Section 10.6).
 */
export function restingTurn(ageMs: number, rate: number, settleMs = 4000): number {
  const T = settleMs / 3;
  return (rate * T * (1 - Math.exp(-Math.max(0, ageMs) / T))) / 1000;
}

/** Revelio's lens: two rings of runes round the middle of the glass while it shows what is hidden. */
const REVEAL_OUTER: RingDesign = { seed: 5150, runes: 40, ticks: 160, band: [0.8, 0.875], inner: true, big: true };
const REVEAL_INNER: RingDesign = { seed: 6260, runes: 28, ticks: 112, band: [0.79, 0.87], inner: false, big: true };
export const REVEAL_COLOR = '#D8E4FF';

/** The lens's outer radius in device px. */
function revealRadius(view: View): number {
  return Math.min(view.height * view.dpr * 0.47, view.caster.height * view.dpr * 0.47);
}

export function drawRevealRings(ctx: CanvasRenderingContext2D, arcana: Arcana, view: View, ageMs: number, alpha: number, reducedMotion: boolean): void {
  if (alpha <= 0.01) return;
  const R = revealRadius(view);
  const x = view.px(0.5), y = view.py(0.5);
  const turn = reducedMotion ? 0 : restingTurn(ageMs, 0.16, 6000);
  const grow = reducedMotion ? 1 : 0.94 + 0.06 * easeOut(ageMs / 900);
  ctx.globalCompositeOperation = 'lighter';
  const outer = arcana.ring(REVEAL_OUTER, REVEAL_COLOR, (R / RING_OUTER) * 2);
  if (outer) drawLayer(ctx, outer, x, y, (R * grow) / RING_OUTER, turn, 0.34 * alpha);
  const r2 = R * 0.8 * grow;
  const inner = arcana.ring(REVEAL_INNER, REVEAL_COLOR, ((R * 0.8) / RING_OUTER) * 2);
  if (inner) drawLayer(ctx, inner, x, y, r2 / RING_OUTER, -turn * 1.4, 0.24 * alpha);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

/**
 * Cast circles warmed at every size this view may draw them (Arcana.warm): the buckets a ring and a
 * figure fall in, from the smallest circle to the largest.
 */
export function prewarmCircles(arcana: Arcana, view: View): void {
  const unit = view.caster.height * view.dpr;
  const cap = view.height * view.dpr * 0.45;
  const R0 = Math.min(cap, CAST_CIRCLE.minRadius * unit), R1 = Math.min(cap, CAST_CIRCLE.maxRadius * unit);
  if (R1 < 4) return;
  const rings = new Set<number>(), figures = new Set<number>();
  for (let k = 0; k <= 8; k++) {
    const R = R0 + ((R1 - R0) * k) / 8;
    rings.add(bucketFor(((R * 1.07) / RING_OUTER) * 2));
    figures.add(bucketFor(R * 1.2));
  }
  for (const s of rings) arcana.warm('ring', s);
  for (const s of figures) arcana.warm('sigil', s);
}

/** Revelio's lens, wanted ahead (Arcana.prewarm): the same layers drawRevealRings asks for. */
export function prewarmReveal(arcana: Arcana, view: View): void {
  const R = revealRadius(view);
  if (R < 4) return;
  arcana.ring(REVEAL_OUTER, REVEAL_COLOR, (R / RING_OUTER) * 2, true);
  arcana.ring(REVEAL_INNER, REVEAL_COLOR, ((R * 0.8) / RING_OUTER) * 2, true);
}

/** The stencil's ring design, kept while the same spell is practised. */
let stencilRing: RingDesign | null = null;

/**
 * The practice guide's stencil: the spell's own circle, the one its cast lights, drawn faint and
 * still behind the guide, so the shape is traced inside the figure it will light.
 */
export function drawStencil(
  ctx: CanvasRenderingContext2D, arcana: Arcana, view: View, at: { x: number; y: number; radius: number }, spellId: string, color: string, alpha: number,
): void {
  if (alpha <= 0.004) return;
  const seed = spellSeed(spellId);
  const R = Math.min(view.height * view.dpr * 0.45, at.radius * view.caster.height * view.dpr);
  if (R < 4) return;
  const x = view.px(at.x), y = view.py(at.y);
  ctx.globalCompositeOperation = 'lighter';
  if (stencilRing?.seed !== seed) stencilRing = CAST_RING(seed);
  const ring = arcana.ring(stencilRing, color, ((R * 1.07) / RING_OUTER) * 2);
  if (ring) drawLayer(ctx, ring, x, y, R / RING_OUTER, 0, alpha);
  const sigil = arcana.sigil(seed, sidesFor(seed), color, R * 1.2);
  if (sigil) drawLayer(ctx, sigil, x, y, R * 0.6, (seed % 628) / 100, alpha * 0.6);
}

/** The color of a cast's circle: the first color its effect steps name, else the color of its
 *  main primitive, else the ink's gold. */
export function castColor(steps: readonly { use?: unknown; color?: unknown }[] | undefined, isColor: (c: unknown) => c is string): string {
  for (const s of steps ?? []) if (isColor(s.color)) return s.color.trim();
  for (const s of steps ?? []) {
    const fallback = typeof s.use === 'string' ? PRIMITIVE_COLORS[s.use] : undefined;
    if (fallback) return fallback;
  }
  return DEFAULT_ACCENT;
}

/** Colors for primitives that name none (the stage's own defaults, limits.ts, and a few more). */
const PRIMITIVE_COLORS: Record<string, string> = {
  'shield.dome': '#BFE3FF',
  'creature.summon': '#DDE8FF',
  'light.orb': '#FFE7B3',
  'bolt.cast': '#FFE9A8',
  'scene.reveal': '#D8E4FF',
  'time.slow': '#BFD8FF',
  'prop.freeze': '#BFD8FF',
  'prop.ignite': '#FF9A3C',
  'prop.douse': '#9FD3FF',
  'effects.end': '#E9DFC7',
};
