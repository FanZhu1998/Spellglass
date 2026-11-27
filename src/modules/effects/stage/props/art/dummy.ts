// The training dummy: a duelling dummy made like good furniture. A squared oak post, its arrises
// chamfered, stands in a cross foot of two beams with braces, bound in brass and bolted with iron. On it
// a torso of button-tufted quilted canvas under a tooled leather breastplate nailed on in brass, belted
// at the waist over a skirt of padded tabs, straw showing where seams have split and scorches where
// spells have hit. Worked into the breastplate is the target, an enchanted practice roundel: a riveted,
// engraved brass bezel; a ring of marks in an invented script inlaid in a soot-black band; aged cream
// with fine ticks, oxblood, soot; and at its heart a brass boss inlaid with a faintly glowing sigil,
// the paint tooled, worn, nicked and scorched. Turned beech arms are pinned through a shoulder block,
// with brass ferrules and carved fists, a wooden wand gripped in the left; the head is a padded sack
// sewn from gores under a leather cap. Parts are separate sprites so the dummy can rock, topple, swing
// its arms and lose its wand. Costumes (Riddikulus, all original): a paper party hat, a ruff collar, a
// polka-dot bow. Hidden detail (Revelio): someone's chalked tally of hits, and a little star, on the
// torso. Coordinates in mH; each part has its own origin (below). The script, the sigil and every mark
// are made up here, from a few strokes and a seeded random number generator.
//
// The head has no face on purpose. The dummy is a thing to practise on, never a character: the
// restricted section's curses are "drawn as abstract light and sound on the wooden dummy" (Section 8),
// and a face that recoils or drops would undo that. A plain padded head also makes it the "wooden
// training dummy" of Section 7.8. So nothing on the front of the head is a feature: its seams run
// crown to neck, off centre and unlike each other.

import { makeOutline, makeTinted, paintSprite, type CanvasFactory, type Sprite } from './canvas';
import {
  BEECH, BRASS, CANVAS, IRON, LEATHER, PAL, cylinder, edgeLight, ellipsePath, grain, knot, lin, noiseTile, rad, rayFleck, rivet,
  rng, roundRectPath, speckle, sphere, stitches, weave, woodGrain, type Ctx, type Stops,
} from './paint';

/** Where each part's origin sits in the dummy's frame (base centre at 0, 0; y up is negative). */
export const DUMMY_JOINTS = {
  /** The arms' pivot on the post, about which they swing. */
  shoulder: { x: 0, y: -206 },
  /** The head's centre. */
  head: { x: 0, y: -296 },
  headRadius: 38,
  /** The top of the head, where the hat sits. */
  crown: { x: 0, y: -334 },
  /** The neck, where the ruff and the bow sit. */
  neck: { x: 0, y: -254 },
  /** Middle of the torso, for the chalk. */
  chest: { x: 0, y: -172 },
  /** The left hand (as seen in the mirror), relative to the shoulder; it holds the wand. */
  hand: { x: -102, y: 2 },
  /** The wand's resting angle in the hand, radians (pointing up and out). */
  wandAngle: -0.62,
  /** The wand from its grip (the sprite's origin) to its tip, and its half-thickness at the grip. */
  wandLength: 80,
  wandHalf: 3.8,
  /** The stand's half-width: the dummy rocks on its edges. */
  standHalf: 62,
} as const;

/** How big the costumes are drawn, against the sizes they were designed at. */
const COSTUME_SCALE = 1.25;

export type Costume = 'hat' | 'ruff' | 'bow';
export const COSTUMES: readonly Costume[] = ['hat', 'ruff', 'bow'];

export interface DummyParts {
  stand: Sprite;
  torso: Sprite;
  arms: Sprite;
  head: Sprite;
}

export interface DummyArt extends DummyParts {
  wand: Sprite;
}

/** What the dummy wears, or hides, only some of the time: painted the first time it is wanted. */
export interface DummyExtras {
  hat: Sprite;
  ruff: Sprite;
  bow: Sprite;
  /** Revelio's chalk on the torso, centred on DUMMY_JOINTS.chest. */
  chalk: Sprite;
}

export function buildDummyArt(factory: CanvasFactory, res: number): DummyArt | null {
  const J = DUMMY_JOINTS;
  const tile = noiseTile(factory);
  // Each box holds all that its part paints: the near feet's sawn ends and ferrules reach y 17.3,
  // the torso's quilting x 55.2.
  const stand = paintSprite(factory, res, { x0: -70, y0: -66, x1: 70, y1: 20 }, (c) => paintStand(c, tile));
  const torso = paintSprite(factory, res, { x0: -58, y0: -262, x1: 58, y1: -24 }, (c) => paintTorso(c, tile));
  const arms = paintSprite(factory, res, { x0: -124, y0: -26, x1: 124, y1: 26 }, (c) => paintArms(c, tile));
  const head = paintSprite(factory, res, { x0: -44, y0: -44, x1: 44, y1: 44 }, (c) => paintHead(c, tile));
  const wand = paintSprite(factory, res, { x0: -6, y0: -J.wandLength - 4, x1: 6, y1: 16 }, (c) => paintWand(c, tile));
  if (!stand || !torso || !arms || !head || !wand) return null;
  return { stand, torso, arms, head, wand };
}

export function buildDummyExtras(factory: CanvasFactory, res: number): DummyExtras | null {
  const s = COSTUME_SCALE;
  const tile = noiseTile(factory);
  const hat = paintSprite(factory, res, { x0: -24 * s, y0: -66 * s, x1: 28 * s, y1: 66 * s }, (c) => scaled(c, tile, paintHat));
  const ruff = paintSprite(factory, res, { x0: -48 * s, y0: -16 * s, x1: 48 * s, y1: 16 * s }, (c) => scaled(c, tile, paintRuff));
  const bow = paintSprite(factory, res, { x0: -35 * s, y0: -16 * s, x1: 35 * s, y1: 16 * s }, (c) => scaled(c, tile, paintBow));
  // The tally's last mark reaches x 49.3.
  const chalk = paintSprite(factory, res, { x0: -48, y0: -44, x1: 52, y1: 44 }, paintChalk);
  if (!hat || !ruff || !bow || !chalk) return null;
  return { hat, ruff, bow, chalk };
}

function scaled(c: Ctx, tile: Tile, paint: (c: Ctx, tile: Tile) => void): void {
  c.save();
  c.scale(COSTUME_SCALE, COSTUME_SCALE);
  paint(c, tile);
  c.restore();
}

/** Paints, in a part's own mH coordinates, where that part's rim must not show. */
export type RimMask = (c: Ctx) => void;

/** The torso's rim stops where other parts cover it in every pose: the top of the post runs up into
 *  the head and its foot sits in the stand's socket. Rims are drawn on the light layer, which adds and
 *  never hides, so without this those buried edges glow through as little boxes. */
export const TORSO_RIM_MASK: RimMask = (c) => {
  const J = DUMMY_JOINTS;
  c.beginPath();
  c.arc(J.head.x, J.head.y, J.headRadius + 0.5, 0, Math.PI * 2);
  c.fill();
  c.fillRect(-16, -40, 32, 20);
};

/** Lazily made variants of a part: the frozen tint (Petrificus Totalus) and a glowing rim (the frost
 *  of a frozen dummy, the violet aura of Imperio). Made once per part sprite and kept. */
export class DummyVariants {
  private tints = new WeakMap<Sprite, Sprite>();
  private tintColor = '';
  private readonly rims = new Map<string, WeakMap<Sprite, Sprite>>();

  constructor(private readonly factory: CanvasFactory) {}

  /** The part washed with `color`; falls back to the plain part if no canvas can be made. */
  tinted(s: Sprite, color: string): Sprite {
    if (color !== this.tintColor) {
      // A pack asked for a different tint: start over (rare). WeakMap has no clear().
      this.tintColor = color;
      this.tints = new WeakMap();
    }
    let t = this.tints.get(s);
    if (!t) {
      t = makeTinted(this.factory, s, color, 0.5) ?? s;
      this.tints.set(s, t);
    }
    return t;
  }

  /** A glowing rim around the part in `color`, for the light layer, minus what `mask` covers. */
  rim(s: Sprite, color: string, mask?: RimMask): Sprite | null {
    let byColor = this.rims.get(color);
    if (!byColor) {
      byColor = new WeakMap();
      this.rims.set(color, byColor);
    }
    const known = byColor.get(s);
    if (known) return known;
    const made = makeOutline(this.factory, s, color, Math.max(1.2, s.res * 1.6));
    if (made && mask) {
      // The same mH-to-pixel mapping paintSprite used for this sprite.
      const c = made.surface.ctx;
      c.save();
      c.setTransform(s.res, 0, 0, s.res, -s.x * s.res, -s.y * s.res);
      c.globalCompositeOperation = 'destination-out';
      c.fillStyle = '#000';
      mask(c);
      c.restore();
    }
    if (made) byColor.set(s, made);
    return made;
  }
}

type Tile = ReturnType<typeof noiseTile>;

// ------------------------------------------------------------------ small helpers of the dummy's own

const TAU = Math.PI * 2;

type Rgb = readonly [number, number, number];

function rgbOf(hex: string): Rgb {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A color part way along a ramp of hex colors (t in 0..1), as numbers. */
function rampRgb(cols: readonly string[], t: number): Rgb {
  const u = Math.min(1, Math.max(0, t)) * (cols.length - 1);
  const i = Math.min(cols.length - 2, Math.floor(u));
  const f = u - i;
  const a = rgbOf(cols[i]);
  const b = rgbOf(cols[i + 1]);
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function css(c: Rgb): string {
  return `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
}

/** A color part way along a ramp of hex colors (t in 0..1). */
function ramp(cols: readonly string[], t: number): string {
  return css(rampRgb(cols, t));
}

const BRASS_RAMP = [PAL.brassDeep, PAL.brassDark, PAL.brass, PAL.brassLight, PAL.brassShine] as const;
const BEECH_RAMP = [BEECH.deep, BEECH.dark, BEECH.mid, BEECH.light, BEECH.shine] as const;

/** Values at increasing keys, [key, value] pairs, read smoothly between them (Catmull-Rom). */
function smoothAt(t: readonly number[], y: number): number {
  const n = t.length / 2;
  if (y <= t[0]) return t[1];
  if (y >= t[(n - 1) * 2]) return t[(n - 1) * 2 + 1];
  let i = 0;
  while (i < n - 2 && y > t[(i + 1) * 2]) i++;
  const u = (y - t[i * 2]) / Math.max(1e-6, t[(i + 1) * 2] - t[i * 2]);
  const v0 = t[Math.max(0, i - 1) * 2 + 1];
  const v1 = t[i * 2 + 1];
  const v2 = t[(i + 1) * 2 + 1];
  const v3 = t[Math.min(n - 1, i + 2) * 2 + 1];
  return 0.5 * (2 * v1 + (v2 - v0) * u + (2 * v0 - 5 * v1 + 4 * v2 - v3) * u * u + (3 * v1 - v0 - 3 * v2 + v3) * u * u * u);
}

/** The torso outline's half-width down its sides, sampled from torsoPath's two side curves: [y, half]
 *  pairs, shoulder to hem. Detail that wraps round the body (quilting, the belt, the skirt) uses it. */
const TORSO_SIDE: readonly number[] = (() => {
  const out: number[] = [];
  const curves = [[-53, -220, -57, -196, -56, -168, -48, -146], [-48, -146, -45, -134, -46, -122, -51, -106]] as const;
  for (const [x0, y0, x1, y1, x2, y2, x3, y3] of curves) {
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const u = 1 - t;
      const a = u * u * u;
      const b = 3 * u * u * t;
      const d = 3 * u * t * t;
      const e = t * t * t;
      const y = a * y0 + b * y1 + d * y2 + e * y3;
      if (out.length && y <= out[out.length - 2]) continue;
      out.push(y, -(a * x0 + b * x1 + d * x2 + e * x3));
    }
  }
  return out;
})();

function torsoHalf(y: number): number {
  const p = TORSO_SIDE;
  if (y <= p[0]) return p[1];
  for (let i = 2; i < p.length; i += 2) {
    if (y <= p[i]) return p[i - 1] + ((p[i + 1] - p[i - 1]) * (y - p[i - 2])) / (p[i] - p[i - 2]);
  }
  return p[p.length - 1];
}

/** How far a level ring round the torso dips at the front, seen from a little above. */
const SAG = 4;

/** Where a point on the torso's surface shows: `a` radians round from the front (negative toward the
 *  candle), at height y. */
function bodyX(a: number, y: number, proud = 0): number {
  return (torsoHalf(y) + proud) * Math.sin(a);
}

function bodyY(a: number, y: number): number {
  return y + SAG * Math.cos(a);
}

/** A run of points round the body at height y, from angle a0 to a1. */
function aroundBody(y: number, a0: number, a1: number, steps: number, proud = 0): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps;
    pts.push(bodyX(a, y, proud), bodyY(a, y));
  }
  return pts;
}

/** Into the current path: a polyline given as flat [x0, y0, x1, y1, ...]. */
function addLine(c: Ctx, pts: readonly number[]): void {
  c.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
}

/** A spell's scorch on cloth or leather: soot blown out from where it struck, streaked outward and
 *  browned at its edge; `pit` burns a little hole through. */
function scorch(c: Ctx, x: number, y: number, r: number, seed: number, pit = 0): void {
  const q = rng(seed);
  c.save();
  // A browned ring where the heat spread, then the soot over it.
  c.fillStyle = rad(c, x, y, r * 0.5, x, y, r * 1.15, [[0, 'rgba(96,44,14,0.22)'], [0.6, 'rgba(96,44,14,0.1)'], [1, 'rgba(96,44,14,0)']]);
  c.beginPath();
  c.arc(x, y, r * 1.15, 0, TAU);
  c.fill();
  c.fillStyle = rad(c, x, y, 0, x, y, r, [[0, 'rgba(8,4,2,0.82)'], [0.25, 'rgba(10,5,2,0.6)'], [0.6, 'rgba(24,11,4,0.22)'], [1, 'rgba(24,11,4,0)']]);
  c.beginPath();
  c.arc(x, y, r, 0, TAU);
  c.fill();
  // Tongues of soot blown outward from the strike, soft-edged.
  const n = 7 + Math.floor(q() * 4);
  for (let i = 0; i < n; i++) {
    const a = q() * TAU;
    const len = r * (0.75 + q() * 0.7);
    const w = 0.18 + q() * 0.16;
    c.save();
    c.translate(x + Math.cos(a) * len * 0.5, y + Math.sin(a) * len * 0.5);
    c.rotate(a);
    c.scale(1, w);
    c.fillStyle = rad(c, 0, 0, 0, 0, 0, len * 0.55, [[0, `rgba(10,5,2,${(0.3 + q() * 0.2).toFixed(3)})`], [1, 'rgba(10,5,2,0)']]);
    c.beginPath();
    c.arc(0, 0, len * 0.55, 0, TAU);
    c.fill();
    c.restore();
  }
  speckle(c, x - r * 0.7, y - r * 0.7, x + r * 0.7, y + r * 0.7, seed + 7, Math.round(r * 3), ['#050302', '#3A1A08'], 0.15, 0.4, 0.55);
  if (pit > 0) {
    // A ragged hole, charred round its edge, the stuffing dark inside.
    c.beginPath();
    const n = 11;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * TAU;
      const rr = pit * (0.7 + q() * 0.5);
      if (i === 0) c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.8);
      else c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.8);
    }
    c.closePath();
    c.fillStyle = rad(c, x - pit * 0.3, y - pit * 0.3, 0, x, y, pit * 1.2, [[0, '#2A1A0A'], [0.6, '#0A0604'], [1, '#040302']]);
    c.fill();
    c.strokeStyle = 'rgba(120,58,20,0.55)';
    c.lineWidth = Math.max(0.3, pit * 0.16);
    c.stroke();
  }
  c.restore();
}

/** Straw poking out of a split seam at (x, y), along `angle`: fine strands in four shades of straw. */
function straw(c: Ctx, x: number, y: number, angle: number, n: number, len: number, seed: number): void {
  c.save();
  c.lineCap = 'round';
  const shades = ['#6E5424', PAL.strawDark, PAL.straw, '#E8D49A'];
  for (let k = 0; k < shades.length; k++) {
    const r = rng(seed + k * 31);
    c.strokeStyle = shades[k];
    c.lineWidth = 0.32 + k * 0.06;
    c.beginPath();
    for (let i = k; i < n; i += shades.length) {
      const a = angle + (r() - 0.5) * 0.9;
      const l = len * (0.45 + r() * 0.65);
      const bend = (r() - 0.5) * 0.5;
      const sx = x + (r() - 0.5) * 2.4;
      const sy = y + (r() - 0.5) * 1.6;
      c.moveTo(sx, sy);
      c.quadraticCurveTo(sx + Math.cos(a + bend) * l * 0.55, sy + Math.sin(a + bend) * l * 0.55, sx + Math.cos(a) * l, sy + Math.sin(a) * l);
    }
    c.stroke();
  }
  c.restore();
}

/** An iron bolt: a square nut on a round washer, lit from the upper left. */
function bolt(c: Ctx, x: number, y: number, r: number, turn = 0.3): void {
  c.fillStyle = 'rgba(4,3,2,0.55)';
  c.beginPath();
  c.arc(x + r * 0.3, y + r * 0.4, r * 1.45, 0, TAU);
  c.fill();
  c.fillStyle = sphere(c, x, y, r * 1.35, IRON);
  c.beginPath();
  c.arc(x, y, r * 1.35, 0, TAU);
  c.fill();
  c.save();
  c.translate(x, y);
  c.rotate(turn);
  c.fillStyle = lin(c, -r, -r, r, r, [[0, IRON.shine], [0.35, IRON.light], [0.7, IRON.dark], [1, IRON.deep]]);
  c.fillRect(-r * 0.82, -r * 0.82, r * 1.64, r * 1.64);
  c.strokeStyle = 'rgba(0,0,0,0.7)';
  c.lineWidth = Math.max(0.2, r * 0.18);
  c.strokeRect(-r * 0.82, -r * 0.82, r * 1.64, r * 1.64);
  c.fillStyle = 'rgba(200,196,200,0.4)';
  c.fillRect(-r * 0.82, -r * 0.82, r * 1.64, r * 0.3);
  c.restore();
}

// ------------------------------------------------------------------ the stand

/**
 * A squared oak timber from (xa, ya) to (xb, yb), `half` thick, seen from a little above: its top face
 * lit by the candle, its side face in shade, a chamfer catching the light between them, the grain along
 * it and a drying check. `near` shows its sawn end grain at (xa, ya), the end of a foot toward us, and
 * `band` (if set) puts a brass ferrule that far in from that end.
 */
function beam(c: Ctx, tile: Tile, xa: number, ya: number, xb: number, yb: number, half: number, seed: number, near = false, band = 0): void {
  // Drawn left to right so that its top face is up whichever way it runs.
  const flip = xb < xa;
  const x0 = flip ? xb : xa;
  const y0 = flip ? yb : ya;
  const x1 = flip ? xa : xb;
  const y1 = flip ? ya : yb;
  const len = Math.hypot(x1 - x0, y1 - y0);
  const a = Math.atan2(y1 - y0, x1 - x0);
  const ridge = -half * 0.2;
  const endX = flip ? len : 0;
  const out = flip ? 1 : -1;
  const q = rng(seed);
  c.save();
  c.translate(x0, y0);
  c.rotate(a);
  c.beginPath();
  c.rect(0, -half, len, half * 2);
  c.save();
  c.clip();
  // The top face, lit, brighter toward the candle; the side face below it, in shade.
  c.fillStyle = lin(c, 0, 0, len, 0, [[0, '#82603C'], [0.55, '#6A4A2C'], [1, '#4E3620']]);
  c.fillRect(0, -half, len, ridge + half);
  c.fillStyle = lin(c, 0, ridge, 0, half, [[0, '#4C341E'], [0.45, '#33220F'], [1, '#160D06']]);
  c.fillRect(0, ridge, len, half - ridge);
  woodGrain(c, 0, -half, len, half, seed, { color: PAL.oakDeep, alpha: 0.6, gap: 1.6, wave: 0.7, width: 0.4, stepX: 4 });
  woodGrain(c, 0, -half, len, ridge, seed + 3, { color: PAL.oakGlow, alpha: 0.14, gap: 2.6, wave: 0.6, width: 0.35, stepX: 5 });
  rayFleck(c, 0, -half, len, ridge, seed + 1, Math.round(len / 5), '#C49A64', 0.18, 2.4);
  grain(c, tile, 0.24, 8, a, 0, -half, len, half);
  // A drying check along the side face.
  const cx0 = len * (0.25 + q() * 0.3);
  const cl = len * (0.22 + q() * 0.2);
  const cy0 = ridge + (half - ridge) * (0.35 + q() * 0.3);
  c.strokeStyle = 'rgba(6,3,1,0.75)';
  c.lineWidth = 0.45;
  c.beginPath();
  c.moveTo(cx0, cy0);
  c.quadraticCurveTo(cx0 + cl * 0.5, cy0 + (q() - 0.5) * 1.2, cx0 + cl, cy0 + (q() - 0.5) * 1.2);
  c.stroke();
  // The chamfer between the faces catches the light.
  c.fillStyle = 'rgba(236,192,134,0.32)';
  c.fillRect(0, ridge - 0.7, len, 0.7);
  c.fillStyle = 'rgba(8,5,2,0.5)';
  c.fillRect(0, ridge, len, 0.45);
  c.restore();
  c.strokeStyle = 'rgba(6,4,2,0.88)';
  c.lineWidth = 0.75;
  c.strokeRect(0, -half, len, half * 2);
  c.strokeStyle = 'rgba(232,186,128,0.3)';
  c.lineWidth = 0.5;
  c.beginPath();
  c.moveTo(1, -half + 0.5);
  c.lineTo(len - 1, -half + 0.5);
  c.stroke();
  if (band > 0) {
    // A brass ferrule round the foot, a little proud of the wood, with a rivet in each face.
    const bx = flip ? len - band - 4 : band;
    c.fillStyle = 'rgba(4,2,1,0.5)';
    c.fillRect(bx + (flip ? -0.8 : 0.8), -half - 0.4, 4, half * 2 + 0.8);
    c.fillStyle = lin(c, 0, -half - 0.6, 0, half + 0.6, [[0, PAL.brassShine], [0.12, PAL.brassLight], [0.38, PAL.brass], [0.42, PAL.brassDark], [0.7, PAL.brass], [1, PAL.brassDeep]]);
    c.fillRect(bx, -half - 0.6, 4, half * 2 + 1.2);
    c.fillStyle = lin(c, bx, 0, bx + 4, 0, [[0, 'rgba(255,236,190,0.3)'], [0.4, 'rgba(0,0,0,0)'], [1, 'rgba(10,6,2,0.4)']]);
    c.fillRect(bx, -half - 0.6, 4, half * 2 + 1.2);
    c.strokeStyle = 'rgba(30,18,6,0.9)';
    c.lineWidth = 0.5;
    c.strokeRect(bx, -half - 0.6, 4, half * 2 + 1.2);
    rivet(c, bx + 2, -half * 0.6, 0.85);
    rivet(c, bx + 2, half * 0.45, 0.85);
  }
  c.restore();
  if (!near) return;
  // The sawn end toward us: end grain round an off-centre pith, with radial checks.
  const p = (u: number, v: number): readonly [number, number] => {
    // Local (u along, v across) to the beam's frame, then to the stand's.
    const x = x0 + Math.cos(a) * u - Math.sin(a) * v;
    const y = y0 + Math.sin(a) * u + Math.cos(a) * v;
    return [x, y];
  };
  const dx = out * 3.4;
  const face = () => {
    const [ax, ay] = p(endX, -half);
    const [bx, by] = p(endX, half);
    c.beginPath();
    c.moveTo(ax, ay);
    c.lineTo(bx, by);
    c.lineTo(bx + dx, by + 2.6);
    c.lineTo(ax + dx, ay + 2.6);
    c.closePath();
  };
  const [mx, my] = p(endX, half * 0.15);
  face();
  c.fillStyle = lin(c, mx + dx, my, mx, my, flip ? [[0, '#5E4024'], [1, '#8E6A44']] : [[0, '#A07A50'], [1, '#6A4A2C']]);
  c.fill();
  c.save();
  face();
  c.clip();
  const px = mx + dx * 0.45;
  const py = my + 1.6;
  c.strokeStyle = 'rgba(40,22,8,0.5)';
  c.lineWidth = 0.32;
  c.beginPath();
  for (let i = 1; i <= 6; i++) {
    c.moveTo(px + i * 0.9, py);
    c.ellipse(px, py, i * 0.9, i * 1.7, 0, 0, TAU);
  }
  c.stroke();
  c.strokeStyle = 'rgba(10,5,2,0.7)';
  c.lineWidth = 0.4;
  c.beginPath();
  c.moveTo(px, py);
  c.lineTo(px + dx * 0.3, py - half * 0.8);
  c.moveTo(px, py);
  c.lineTo(px - dx * 0.2, py + half * 0.9);
  c.stroke();
  c.restore();
  face();
  c.strokeStyle = 'rgba(6,4,2,0.88)';
  c.lineWidth = 0.7;
  c.stroke();
}

/** The socket block the post is wedged into: chamfered at its corners, a brass band round it, iron
 *  straps down its sides onto the feet. */
function paintSocket(c: Ctx, tile: Tile): void {
  const x0 = -18;
  const x1 = 18;
  const y0 = -45;
  const y1 = -10;
  const f = 3.2;
  // Faces: the lit chamfer, the front, the dark chamfer.
  c.fillStyle = lin(c, x0, 0, x0 + f, 0, [[0, '#6E4E30'], [1, '#8A6642']]);
  c.fillRect(x0, y0, f, y1 - y0);
  c.fillStyle = lin(c, x0 + f, 0, x1 - f, 0, [[0, '#64462A'], [0.5, '#4A321C'], [1, '#2A1B0E']]);
  c.fillRect(x0 + f, y0, x1 - x0 - 2 * f, y1 - y0);
  c.fillStyle = lin(c, x1 - f, 0, x1, 0, [[0, '#1A1008'], [0.8, '#120A05'], [1, '#34343A']]);
  c.fillRect(x1 - f, y0, f, y1 - y0);
  c.save();
  c.beginPath();
  c.rect(x0, y0, x1 - x0, y1 - y0);
  c.clip();
  c.save();
  c.translate(0, y0);
  c.rotate(Math.PI / 2);
  woodGrain(c, 0, -x1, y1 - y0, -x0, 209, { color: PAL.oakDeep, alpha: 0.5, gap: 1.7, wave: 0.5, width: 0.4, stepX: 3 });
  c.restore();
  grain(c, tile, 0.24, 6, Math.PI / 2, x0, y0, x1, y1);
  knot(c, -6, -20, 1.8, 2.6, 0.6);
  // Its top, seen from above: end grain round the post.
  c.fillStyle = lin(c, 0, y0, 0, y0 + 2.6, [[0, '#9A744C'], [1, '#6A4A2C']]);
  c.fillRect(x0, y0, x1 - x0, 2.6);
  c.restore();
  c.strokeStyle = 'rgba(232,186,128,0.3)';
  c.lineWidth = 0.5;
  c.beginPath();
  c.moveTo(x0 + f, y0 + 2.6);
  c.lineTo(x0 + f, y1);
  c.stroke();
  c.strokeStyle = 'rgba(6,4,2,0.88)';
  c.lineWidth = 0.8;
  c.strokeRect(x0, y0, x1 - x0, y1 - y0);
  // A hammered iron band round it, riveted.
  const by0 = -36;
  const bh = 6;
  c.fillStyle = 'rgba(4,2,1,0.5)';
  c.fillRect(x0 - 0.6, by0 + 1, x1 - x0 + 1.6, bh);
  c.fillStyle = cylinder(c, x0 - 0.8, x1 + 0.8, IRON, 1);
  c.fillRect(x0 - 0.8, by0, x1 - x0 + 1.6, bh);
  c.fillStyle = lin(c, 0, by0, 0, by0 + bh, [[0, 'rgba(200,200,210,0.3)'], [0.25, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.5)']]);
  c.fillRect(x0 - 0.8, by0, x1 - x0 + 1.6, bh);
  c.save();
  c.beginPath();
  c.rect(x0 - 0.8, by0, x1 - x0 + 1.6, bh);
  c.clip();
  speckle(c, x0 - 0.8, by0, x1 + 0.8, by0 + bh, 214, 60, [PAL.rust, '#0A0A0C', '#6A6870'], 0.3, 0.8, 0.45);
  c.restore();
  c.strokeStyle = 'rgba(0,0,0,0.85)';
  c.lineWidth = 0.5;
  c.strokeRect(x0 - 0.8, by0, x1 - x0 + 1.6, bh);
  for (const x of [x0 + 2.6, 0, x1 - 2.6]) rivet(c, x, by0 + bh / 2, 1.05, IRON);
}

/** An iron strap bent over a corner: down the socket's side and out along a foot, riveted. */
function bracket(c: Ctx, pts: readonly number[], w: number): void {
  c.save();
  c.lineJoin = 'miter';
  c.lineCap = 'butt';
  c.strokeStyle = 'rgba(4,3,2,0.55)';
  c.lineWidth = w;
  c.translate(0.6, 0.8);
  c.beginPath();
  addLine(c, pts);
  c.stroke();
  c.restore();
  c.save();
  c.lineJoin = 'miter';
  c.lineCap = 'butt';
  c.strokeStyle = IRON.mid;
  c.lineWidth = w;
  c.beginPath();
  addLine(c, pts);
  c.stroke();
  c.strokeStyle = IRON.dark;
  c.lineWidth = w * 0.45;
  c.translate(0.35, 0.45);
  c.stroke();
  c.restore();
  c.save();
  c.strokeStyle = 'rgba(150,150,160,0.45)';
  c.lineWidth = 0.4;
  c.translate(-w * 0.32, -w * 0.32);
  c.beginPath();
  addLine(c, pts);
  c.stroke();
  c.restore();
  speckle(c, Math.min(pts[0], pts[pts.length - 2]) - w, Math.min(pts[1], pts[pts.length - 1]) - w,
    Math.max(pts[0], pts[pts.length - 2]) + w, Math.max(pts[1], pts[pts.length - 1]) + w, 61 + pts.length, 10, [PAL.rust], 0.3, 0.6, 0.35);
}

function paintStand(c: Ctx, tile: Tile): void {
  // Two heavy beams crossed under the post, seen from a little above: the near ends low and toward
  // us, the far ends higher, behind. The far halves first, then the socket, then the near halves and
  // the braces.
  // The far halves, a ferrule near each far end.
  beam(c, tile, 58, -26, 0, -12, 8.5, 201, false, 3);
  beam(c, tile, -58, -26, 0, -12, 8.5, 202, false, 3);
  paintSocket(c, tile);
  beam(c, tile, -64, 6, 0, -12, 9, 203, true, 7);
  beam(c, tile, 64, 6, 0, -12, 9, 204, true, 7);
  // Iron straps from the socket's sides down onto the near feet.
  for (const s of [-1, 1]) {
    bracket(c, [s * 16.6, -30, s * 16.6, -15.2, s * 30, -11], 3);
    rivet(c, s * 16.6, -25, 0.9, IRON);
    rivet(c, s * 25.5, -12.6, 0.9, IRON);
  }
  // Braces from the near beams up to the post, bolted at both ends.
  for (const s of [-1, 1]) {
    beam(c, tile, s * 40, -5, s * 11, -64, 5.5, 205 + s);
    bolt(c, s * 36.5, -10.5, 1.5, 0.2 * s);
    bolt(c, s * 13.4, -58.5, 1.4, -0.25 * s);
  }
  // Where the foot meets the shelf, the light does not reach.
  c.fillStyle = lin(c, 0, -6, 0, 11, [[0, 'rgba(8,5,3,0)'], [1, 'rgba(8,5,3,0.5)']]);
  c.fillRect(-70, -6, 140, 17);
}

// ------------------------------------------------------------------ the torso

/** The torso's outline: broad padded shoulders, a full chest, a waist, and a padded skirt at the hem. */
function torsoPath(c: Ctx): void {
  c.beginPath();
  c.moveTo(0, -242);
  c.bezierCurveTo(-28, -243, -50, -238, -53, -220);
  c.bezierCurveTo(-57, -196, -56, -168, -48, -146);
  c.bezierCurveTo(-45, -134, -46, -122, -51, -106);
  c.quadraticCurveTo(-26, -98, 0, -100);
  c.quadraticCurveTo(26, -98, 51, -106);
  c.bezierCurveTo(46, -122, 45, -134, 48, -146);
  c.bezierCurveTo(56, -168, 57, -196, 53, -220);
  c.bezierCurveTo(50, -238, 28, -243, 0, -242);
  c.closePath();
}

/** The breastplate's half-width down the body: [y, half] pairs, collar to below the hem. */
const PANEL: readonly number[] = [
  -241, 21, -233, 25.5, -222, 30, -206, 33, -186, 34.4, -166, 34.4, -151, 32, -141, 28.4, -131, 26.8, -118, 27.4, -104, 29.6, -92, 31,
];
const PANEL_TOP = -241;
const PANEL_BOTTOM = -92;

function panelHalf(y: number): number {
  return smoothAt(PANEL, y);
}

/** The leather breastplate down the front: from the collar to the hem, waisted with the body. */
function panelPath(c: Ctx): void {
  c.beginPath();
  c.moveTo(-panelHalf(PANEL_TOP), PANEL_TOP);
  for (let y = PANEL_TOP + 3; y < PANEL_BOTTOM; y += 3) c.lineTo(-panelHalf(y), y);
  c.lineTo(-panelHalf(PANEL_BOTTOM), PANEL_BOTTOM);
  c.lineTo(panelHalf(PANEL_BOTTOM), PANEL_BOTTOM);
  for (let y = PANEL_BOTTOM - 3; y > PANEL_TOP; y -= 3) c.lineTo(panelHalf(y), y);
  c.lineTo(panelHalf(PANEL_TOP), PANEL_TOP);
  c.quadraticCurveTo(0, PANEL_TOP - 3.4, -panelHalf(PANEL_TOP), PANEL_TOP);
  c.closePath();
}

/** The points of a line `inset` inside the breastplate's edge on side `s`, from y0 down to y1. */
function panelEdge(s: number, inset: number, y0: number, y1: number): number[] {
  const pts: number[] = [];
  for (let y = y0; y <= y1 + 0.01; y += 2.5) pts.push(s * (panelHalf(y) - inset), y);
  return pts;
}

/** The belt round the waist: its top edge at the sides, its width, and its buckle's place round the
 *  body (radians from the front, toward the shade). */
const BELT = { top: -142, w: 11, buckle: 0.5 } as const;

function beltPath(c: Ctx, proud: number): void {
  const top = aroundBody(BELT.top, -Math.PI / 2, Math.PI / 2, 24, proud);
  const bottom = aroundBody(BELT.top + BELT.w, Math.PI / 2, -Math.PI / 2, 24, proud);
  c.beginPath();
  addLine(c, top);
  for (let i = 0; i < bottom.length; i += 2) c.lineTo(bottom[i], bottom[i + 1]);
  c.closePath();
}

/** The target roundel on the chest: its centre, and how much its circles are squashed seen from a
 *  little above. RING gives its radii, outside in: the bezel's rolled lip, its engraved flat and its
 *  bevel; the band of script; a brass fillet; the cream chapter ring; oxblood; soot; the boss and the
 *  inlay in it. */
const TARGET = { x: 0, y: -166.5, k: 0.97 } as const;
const RING = { lip: 24, flat: 22.9, bevel: 20.3, script: 19.5, fillet: 15.4, cream: 14.8, red: 11.4, soot: 7.4, boss: 6.2, inlay: 4.7 } as const;

function paintTorso(c: Ctx, tile: Tile): void {
  paintPost(c, tile);

  torsoPath(c);
  c.fillStyle = cylinder(c, -57, 57, CANVAS);
  c.fill();
  c.save();
  torsoPath(c);
  c.clip();
  weave(c, -58, -244, 58, -96, 1.9, PAL.canvasDeep, 0.2, 212);
  grain(c, tile, 0.22, 1, 0, -58, -244, 58, -96);
  paintQuilting(c);
  paintSkirt(c);
  paintPanel(c, tile);
  paintTarget(c, tile);
  // The padding swells toward the candle: light on the upper left of the body, the rest in shade,
  // deepest on the right, away from it, and darker toward the hem.
  c.fillStyle = rad(c, -26, -208, 2, -16, -188, 88, [[0, 'rgba(255,214,160,0.2)'], [0.5, 'rgba(255,214,160,0.05)'], [1, 'rgba(0,0,0,0)']]);
  c.fillRect(-58, -244, 116, 148);
  c.fillStyle = lin(c, -58, 0, 58, 0, [[0.42, 'rgba(8,6,12,0)'], [0.82, 'rgba(8,6,12,0.36)'], [0.95, 'rgba(8,6,12,0.3)'], [1, 'rgba(60,70,96,0.1)']]);
  c.fillRect(-58, -244, 116, 148);
  c.fillStyle = lin(c, 0, -138, 0, -98, [[0, 'rgba(6,4,2,0)'], [1, 'rgba(6,4,2,0.42)']]);
  c.fillRect(-58, -138, 116, 42);
  paintSigilGlow(c);
  c.restore();
  torsoPath(c);
  edgeLight(c, -57, 57, 1.6, 0.35, 0.35);
  torsoPath(c);
  c.strokeStyle = 'rgba(12,8,4,0.85)';
  c.lineWidth = 0.9;
  c.stroke();
  // Straw where seams have split: at the hem between the tabs, at a shoulder.
  straw(c, -40, -103.2, Math.PI * 0.62, 12, 9, 216);
  straw(c, -25.5, -101.4, Math.PI * 0.52, 9, 7, 217);
  straw(c, 40.5, -103.4, Math.PI * 0.4, 9, 8, 218);
  straw(c, -48, -230, -Math.PI * 0.8, 9, 8, 219);
  straw(c, 26, -239.5, -Math.PI * 0.42, 8, 7, 220);
  paintBelt(c, tile);
  paintCollar(c, tile);
}

/** The oak post where it shows: below the torso down into the socket, and above it up into the head.
 *  Squared, its arrises chamfered (lit toward the candle, dark away), the grain running its length, a
 *  check up its face; a brass ferrule where it goes into the socket and a strap round it under the
 *  skirt. */
function paintPost(c: Ctx, tile: Tile): void {
  const h = 10;
  const f = 6.4;
  for (const [y0, y1, seed] of [[-262, -232, 211], [-112, -38, 213]] as const) {
    c.fillStyle = lin(c, -h, 0, -f, 0, [[0, '#6E4E30'], [1, '#8C6844']]);
    c.fillRect(-h, y0, h - f, y1 - y0);
    c.fillStyle = lin(c, -f, 0, f, 0, [[0, '#63452A'], [0.5, '#4A321C'], [1, '#2E1F11']]);
    c.fillRect(-f, y0, 2 * f, y1 - y0);
    c.fillStyle = lin(c, f, 0, h, 0, [[0, '#1C120A'], [0.75, '#130B05'], [1, '#383840']]);
    c.fillRect(f, y0, h - f, y1 - y0);
    c.save();
    c.beginPath();
    c.rect(-h, y0, 2 * h, y1 - y0);
    c.clip();
    c.save();
    c.translate(0, y0);
    c.rotate(Math.PI / 2);
    woodGrain(c, 0, -h, y1 - y0, h, seed, { color: PAL.oakDeep, alpha: 0.55, gap: 1.5, wave: 0.45, width: 0.38, stepX: 4 });
    woodGrain(c, 0, -h, y1 - y0, h, seed + 1, { color: PAL.oakGlow, alpha: 0.1, gap: 2.8, wave: 0.4, width: 0.3, stepX: 5 });
    c.restore();
    grain(c, tile, 0.26, 10, Math.PI / 2, -h, y0, h, y1);
    c.restore();
    c.strokeStyle = 'rgba(240,196,140,0.32)';
    c.lineWidth = 0.5;
    c.beginPath();
    c.moveTo(-h + 0.4, y0);
    c.lineTo(-h + 0.4, y1);
    c.moveTo(-f, y0);
    c.lineTo(-f, y1);
    c.stroke();
    c.strokeStyle = 'rgba(8,5,2,0.6)';
    c.beginPath();
    c.moveTo(f, y0);
    c.lineTo(f, y1);
    c.stroke();
    c.strokeStyle = 'rgba(6,4,2,0.85)';
    c.lineWidth = 0.7;
    c.strokeRect(-h, y0, 2 * h, y1 - y0);
  }
  // A check up the face of the lower post.
  c.strokeStyle = 'rgba(8,4,2,0.75)';
  c.lineWidth = 0.4;
  c.beginPath();
  c.moveTo(-1.6, -86);
  c.quadraticCurveTo(-1.2, -74, -2, -60);
  c.stroke();
  // A leather strap round the post under the skirt, buckled in iron.
  const sy = -96.5;
  c.fillStyle = lin(c, 0, sy, 0, sy + 5.5, [[0, '#7A4E2A'], [0.4, PAL.leatherDark], [1, PAL.leatherDeep]]);
  c.fillRect(-10.6, sy, 21.2, 5.5);
  c.fillStyle = lin(c, -10.6, 0, 10.6, 0, [[0, 'rgba(255,210,150,0.18)'], [0.5, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.45)']]);
  c.fillRect(-10.6, sy, 21.2, 5.5);
  stitches(c, [-10, sy + 1, 10, sy + 1], 1.8, 1, 0.3);
  stitches(c, [-10, sy + 4.5, 10, sy + 4.5], 1.8, 1, 0.3);
  roundRectPath(c, -5.2, sy - 0.9, 5.6, 7.3, 1.2);
  c.strokeStyle = cylinder(c, -5.2, 0.4, IRON, 1);
  c.lineWidth = 1.3;
  c.stroke();
  c.fillStyle = IRON.light;
  c.fillRect(-2.9, sy + 0.4, 0.9, 4.6);
  // The torso's shadow on the post under it.
  c.fillStyle = lin(c, 0, -106, 0, -82, [[0, 'rgba(0,0,0,0.7)'], [1, 'rgba(0,0,0,0)']]);
  c.fillRect(-10, -106, 20, 24);
  // The ferrule where the post goes down into its socket.
  const fy = -51;
  c.fillStyle = 'rgba(4,2,1,0.5)';
  c.fillRect(-11, fy + 1.4, 23, 11);
  c.fillStyle = cylinder(c, -11.5, 11.5, BRASS, 1);
  c.fillRect(-11.5, fy, 23, 11);
  c.fillStyle = lin(c, 0, fy, 0, fy + 11, [[0, 'rgba(255,236,190,0.4)'], [0.18, 'rgba(0,0,0,0)'], [0.82, 'rgba(0,0,0,0.1)'], [1, 'rgba(10,6,2,0.5)']]);
  c.fillRect(-11.5, fy, 23, 11);
  c.strokeStyle = 'rgba(40,24,6,0.65)';
  c.lineWidth = 0.4;
  c.beginPath();
  c.moveTo(-11.5, fy + 2);
  c.lineTo(11.5, fy + 2);
  c.moveTo(-11.5, fy + 3.1);
  c.lineTo(11.5, fy + 3.1);
  c.stroke();
  c.strokeStyle = 'rgba(30,18,6,0.9)';
  c.lineWidth = 0.55;
  c.strokeRect(-11.5, fy, 23, 11);
  rivet(c, -6, fy + 6.8, 1);
  rivet(c, 6, fy + 6.8, 1);
  // A turned brass collar on the neck, above the torso.
  const ny = -249.5;
  c.fillStyle = cylinder(c, -11, 11, BRASS, 1);
  c.fillRect(-11, ny, 22, 4);
  c.fillStyle = lin(c, 0, ny, 0, ny + 4, [[0, 'rgba(255,236,190,0.35)'], [0.4, 'rgba(0,0,0,0)'], [1, 'rgba(10,6,2,0.5)']]);
  c.fillRect(-11, ny, 22, 4);
  c.strokeStyle = 'rgba(30,18,6,0.9)';
  c.lineWidth = 0.5;
  c.strokeRect(-11, ny, 22, 4);
}

/**
 * Diamond quilting over the canvas: channels stitched round the body in two directions, the padding
 * puffed up between them, a leather button tufted in at each crossing. Worked on a lattice round the
 * torso (angle, height) and shown with bodyX/bodyY, so it narrows as the body turns away.
 */
function paintQuilting(c: Ctx): void {
  const dA = Math.PI / 16;
  const dY = 10.5;
  const y0 = -244;
  const rows = 11;
  const at = (m: number, n: number): readonly [number, number] => {
    const a = m * dA;
    const y = y0 + n * dY;
    return [bodyX(a, y), bodyY(a, y)];
  };
  // Columns on show beside the breastplate, short of the silhouette (m = 8 or -8 is the body's edge).
  const visible = (m: number) => Math.abs(m) >= 2 && Math.abs(m) <= 7;
  // Only above the belt: the skirt below it is made otherwise.
  c.save();
  const mid = aroundBody(BELT.top + BELT.w / 2, Math.PI / 2, -Math.PI / 2, 24, 2);
  c.beginPath();
  c.moveTo(-60, -250);
  c.lineTo(60, -250);
  for (let i = 0; i < mid.length; i += 2) c.lineTo(mid[i], mid[i + 1]);
  c.closePath();
  c.clip();
  // The cells: each puffed up, lit on its upper left.
  for (let n = 0; n <= rows; n++) {
    for (let m = -8; m <= 8; m++) {
      if ((m + n) % 2 === 0 || !visible(m)) continue;
      const [lx, ly] = at(m - 1, n);
      const [tx, ty] = at(m, n - 1);
      const [rx, ry] = at(m + 1, n);
      const [bx, by] = at(m, n + 1);
      const [cx, cy] = at(m, n);
      const w = Math.max(1, (rx - lx) / 2);
      const lit = 0.5 - 0.5 * Math.sin(m * dA);
      // Shade gathers in the cell's lower right and round the tufts; light on its upper left swell.
      c.fillStyle = rad(c, cx - w * 0.32, cy - dY * 0.4, 0.3, cx + w * 0.12, cy + dY * 0.1, Math.max(w, dY) * 1.05, [
        [0, `rgba(255,236,200,${(0.2 + 0.24 * lit).toFixed(3)})`], [0.32, `rgba(255,236,200,${(0.06 + 0.08 * lit).toFixed(3)})`],
        [0.58, 'rgba(24,16,8,0.08)'], [0.84, 'rgba(24,16,8,0.36)'], [1, 'rgba(24,16,8,0.55)'],
      ]);
      c.beginPath();
      c.moveTo(lx, ly);
      c.quadraticCurveTo((lx + tx) / 2 - 0.6, (ly + ty) / 2 - 0.6, tx, ty);
      c.quadraticCurveTo((tx + rx) / 2 + 0.6, (ty + ry) / 2 - 0.6, rx, ry);
      c.quadraticCurveTo((rx + bx) / 2 + 0.6, (ry + by) / 2 + 0.6, bx, by);
      c.quadraticCurveTo((bx + lx) / 2 - 0.6, (by + ly) / 2 + 0.6, lx, ly);
      c.closePath();
      c.fill();
    }
  }
  // The stitched channels, both directions, sunk in soft grooves, then their stitches.
  const lines: number[][] = [];
  for (let start = -24; start <= 24; start++) {
    for (const dir of [-1, 1]) {
      const pts: number[] = [];
      for (let t = 0; t <= rows * 4; t++) {
        const n = t / 4;
        const m = start + dir * n;
        if (Math.abs(m) < 1.5 || Math.abs(m) > 8) continue;
        const [x, y] = at(m, n);
        pts.push(x, y);
      }
      if (pts.length >= 4) lines.push(pts);
    }
  }
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = 'rgba(26,18,8,0.16)';
  c.lineWidth = 2.6;
  c.beginPath();
  for (const pts of lines) addLine(c, pts);
  c.stroke();
  c.strokeStyle = 'rgba(22,14,6,0.2)';
  c.lineWidth = 0.8;
  c.stroke();
  // The stitches sink into the grooves, so they show only faintly.
  c.globalAlpha = 0.4;
  for (const pts of lines) stitches(c, pts, 2.4, 1.1, 0.24, 'rgba(226,210,176,0.5)');
  c.restore();
  // The tufts: a dimple pulled in at each crossing, a leather button at its heart.
  for (let n = 0; n <= rows; n++) {
    for (let m = -8; m <= 8; m++) {
      if ((m + n) % 2 !== 0 || !visible(m)) continue;
      const [x, y] = at(m, n);
      const squeeze = Math.max(0.3, Math.cos(m * dA));
      c.fillStyle = rad(c, x, y, 0, x, y, 4.2, [[0, 'rgba(12,8,3,0.72)'], [0.35, 'rgba(12,8,3,0.4)'], [1, 'rgba(12,8,3,0)']]);
      c.beginPath();
      c.ellipse(x, y, 4.2 * squeeze, 4.2, 0, 0, TAU);
      c.fill();
      c.fillStyle = sphere(c, x, y, 1.25, LEATHER);
      c.beginPath();
      c.ellipse(x, y, Math.max(0.35, 1.2 * squeeze), 1.2, 0, 0, TAU);
      c.fill();
      c.fillStyle = 'rgba(255,220,170,0.45)';
      c.beginPath();
      c.arc(x - 0.4 * squeeze, y - 0.45, 0.32, 0, TAU);
      c.fill();
    }
  }
  c.restore();
}

/** The hem's curve (torsoPath's bottom), raised by `lift`, from the left side round to the right. */
function hemLine(lift: number): number[] {
  const pts: number[] = [];
  for (const s of [-1, 1]) {
    for (let i = 0; i <= 8; i++) {
      const t = s < 0 ? i / 8 : 1 - i / 8;
      const u = 1 - t;
      const x = s * (u * u * 51 + 2 * u * t * 26);
      const y = u * u * -106 + 2 * u * t * -98 + t * t * -100 - lift;
      if (s > 0 && i === 0) continue;
      pts.push(x, y);
    }
  }
  return pts;
}

/** The skirt under the belt: padded tabs side by side round the hips, each stitched round, the padding
 *  rounding over at the hem. */
function paintSkirt(c: Ctx): void {
  const yTop = BELT.top + BELT.w - 1;
  const yBot = -96;
  const seams = [-1.32, -0.92, -0.52, 0.52, 0.92, 1.32];
  const edges = [-Math.PI / 2, ...seams, Math.PI / 2];
  for (let i = 0; i < edges.length - 1; i++) {
    const a0 = edges[i];
    const a1 = edges[i + 1];
    const am = (a0 + a1) / 2;
    const x0 = bodyX(a0, -116);
    const x1 = bodyX(a1, -116);
    const w = (x1 - x0) / 2;
    if (!(w > 0.3)) continue;
    const xm = bodyX(am, -118);
    const lit = 0.5 - 0.5 * Math.sin(am);
    // Each tab swells: lit high on its candle side, shaded toward its seams and where it rolls under.
    c.fillStyle = rad(c, xm - w * 0.4, -124, 0.5, xm, -115, Math.max(w * 1.25, 13), [
      [0, `rgba(255,236,200,${(0.12 + 0.18 * lit).toFixed(3)})`], [0.4, 'rgba(255,236,200,0.03)'], [0.72, 'rgba(20,14,6,0.16)'], [1, 'rgba(20,14,6,0.42)'],
    ]);
    c.fillRect(x0, yTop, x1 - x0, yBot - yTop);
  }
  c.save();
  c.lineCap = 'round';
  c.beginPath();
  const lines: number[][] = [];
  for (const a of seams) {
    const pts: number[] = [];
    for (let y = yTop; y <= yBot; y += 3) pts.push(bodyX(a, y), bodyY(a, y));
    lines.push(pts);
    addLine(c, pts);
  }
  c.strokeStyle = 'rgba(24,16,8,0.25)';
  c.lineWidth = 2.6;
  c.stroke();
  c.strokeStyle = 'rgba(16,10,4,0.6)';
  c.lineWidth = 0.8;
  c.stroke();
  c.restore();
  for (const pts of lines) {
    const off = pts.map((v, j) => (j % 2 === 0 ? v - 1.4 : v));
    const on = pts.map((v, j) => (j % 2 === 0 ? v + 1.4 : v));
    stitches(c, off, 2.4, 1.1, 0.3, 'rgba(226,210,176,0.4)');
    stitches(c, on, 2.4, 1.1, 0.3, 'rgba(226,210,176,0.4)');
  }
  // A row of stitching just above the hem, following it round, and the hem rolled under.
  stitches(c, hemLine(3), 2.6, 1.2, 0.32, 'rgba(226,210,176,0.4)');
  c.strokeStyle = 'rgba(10,6,2,0.4)';
  c.lineWidth = 2.4;
  c.beginPath();
  addLine(c, hemLine(0.6));
  c.stroke();
}

/** The breastplate: thick leather, tooled with a double border, nailed down its edges in brass,
 *  scuffed and creased and scorched. */
function paintPanel(c: Ctx, tile: Tile): void {
  // Its shadow on the quilting beside it.
  c.save();
  c.translate(1.2, 1);
  panelPath(c);
  c.fillStyle = 'rgba(8,5,2,0.4)';
  c.fill();
  c.restore();
  panelPath(c);
  c.fillStyle = cylinder(c, -35, 35, LEATHER);
  c.fill();
  c.save();
  panelPath(c);
  c.clip();
  grain(c, tile, 0.32, 1, 0, -35, -244, 35, -92);
  speckle(c, -35, -244, 35, -92, 221, 520, ['#2A170A', '#8E6440'], 0.2, 0.5, 0.3);
  // The leather darkens toward its edges, where hands and polish have not reached.
  panelPath(c);
  c.strokeStyle = 'rgba(16,8,3,0.45)';
  c.lineWidth = 7;
  c.stroke();
  // Scuffs and creases, light and dark.
  const r = rng(213);
  c.lineCap = 'round';
  for (let i = 0; i < 34; i++) {
    const x = -28 + r() * 56;
    const y = -232 + r() * 128;
    c.strokeStyle = `rgba(${r() < 0.5 ? '196,146,96' : '14,8,4'},${(0.1 + r() * 0.16).toFixed(3)})`;
    c.lineWidth = 0.3 + r() * 0.45;
    c.beginPath();
    c.moveTo(x, y);
    c.quadraticCurveTo(x + 2.5, y + (r() - 0.5) * 3, x + 3 + r() * 6, y + (r() - 0.5) * 4);
    c.stroke();
  }
  // The tooled border: two lines pressed in inside the edge, each a groove with a lit lower lip.
  for (const inset of [4.4, 5.9]) {
    for (const s of [-1, 1]) {
      const pts = panelEdge(s, inset, -236, -100);
      c.strokeStyle = 'rgba(10,5,2,0.6)';
      c.lineWidth = 0.55;
      c.beginPath();
      addLine(c, pts);
      c.stroke();
      c.strokeStyle = 'rgba(214,160,104,0.2)';
      c.lineWidth = 0.35;
      c.save();
      c.translate(0.45, 0.35);
      c.stroke();
      c.restore();
    }
  }
  // Little stamped flowers in the border's corners and down it, as a saddler tools them.
  c.fillStyle = 'rgba(12,6,2,0.45)';
  for (const s of [-1, 1]) {
    for (let y = -232; y <= -104; y += 12.4) {
      if (y > -146 && y < -124) continue;
      const x = s * (panelHalf(y) - 5.15);
      c.beginPath();
      for (let p = 0; p < 4; p++) {
        const a = (p / 4) * TAU + Math.PI / 4;
        const px = x + Math.cos(a) * 0.55;
        const py = y + Math.sin(a) * 0.55;
        c.moveTo(px + Math.cos(a) * 0.5, py + Math.sin(a) * 0.5);
        c.ellipse(px, py, 0.5, 0.22, a, 0, TAU);
      }
      c.fill();
    }
  }
  scorch(c, -21, -226, 7, 231);
  scorch(c, 26, -148, 6, 232);
  scorch(c, -11, -112, 5.5, 233, 1.8);
  c.restore();
  panelPath(c);
  c.strokeStyle = 'rgba(8,4,2,0.85)';
  c.lineWidth = 0.75;
  c.stroke();
  // Its edge catches the candle on the left.
  panelPath(c);
  edgeLight(c, -35, 35, 0.9, 0.4, 0.2);
  // Brass upholstery nails down both edges.
  for (const s of [-1, 1]) {
    for (let y = -234; y <= -101; y += 5.4) {
      if (y > BELT.top - 1 && y < BELT.top + BELT.w + 4) continue;
      rivet(c, s * (panelHalf(y) - 2.1), y, 0.95);
    }
  }
  straw(c, -14.5, -110, Math.PI * 0.8, 7, 5, 234);
}

/** The belt: a broad leather strap round the waist, stitched along both edges and studded, buckled in
 *  brass on the shaded side with its end through a keeper. */
function paintBelt(c: Ctx, tile: Tile): void {
  const y0 = BELT.top;
  const y1 = BELT.top + BELT.w;
  beltPath(c, 0.8);
  c.fillStyle = lin(c, 0, y0, 0, y1 + SAG, [[0, '#7A4E2A'], [0.25, '#5A3418'], [0.7, PAL.leatherDark], [1, PAL.leatherDeep]]);
  c.fill();
  c.save();
  beltPath(c, 0.8);
  c.clip();
  grain(c, tile, 0.3, 3, 0, -50, y0, 50, y1 + SAG);
  c.fillStyle = lin(c, -50, 0, 50, 0, [[0, 'rgba(255,206,150,0.16)'], [0.4, 'rgba(0,0,0,0)'], [0.85, 'rgba(6,4,8,0.45)'], [1, 'rgba(40,46,64,0.3)']]);
  c.fillRect(-50, y0, 100, BELT.w + SAG + 1);
  c.restore();
  beltPath(c, 0.8);
  c.strokeStyle = 'rgba(8,4,2,0.88)';
  c.lineWidth = 0.7;
  c.stroke();
  // A worn, lit top edge.
  c.strokeStyle = 'rgba(214,160,104,0.35)';
  c.lineWidth = 0.45;
  c.beginPath();
  addLine(c, aroundBody(y0 + 0.5, -1.45, 0.2, 16, 0.8));
  c.stroke();
  stitches(c, aroundBody(y0 + 1.7, -1.5, 1.5, 30, 0.8), 2, 1, 0.3);
  stitches(c, aroundBody(y1 - 1.7, -1.5, 1.5, 30, 0.8), 2, 1, 0.3);
  // Studs along the middle, on the front.
  for (let a = -1.25; a <= 0.25; a += 0.25) rivet(c, bodyX(a, y0 + BELT.w / 2, 0.8), bodyY(a, y0 + BELT.w / 2), 0.9);
  // The strap's end, from the buckle on round to its rounded tip, holes punched along it, through a
  // keeper.
  const ba = BELT.buckle;
  const tipA = 1.12;
  const mid = y0 + BELT.w / 2;
  const tongue = () => {
    const top = aroundBody(mid - 3.1, ba, tipA, 10, 1.5);
    const bot = aroundBody(mid + 3.1, tipA, ba, 10, 1.5);
    c.beginPath();
    addLine(c, top);
    const ex = bodyX(tipA + 0.1, mid, 1.5);
    c.quadraticCurveTo(ex, bodyY(tipA + 0.1, mid), bot[0], bot[1]);
    for (let i = 2; i < bot.length; i += 2) c.lineTo(bot[i], bot[i + 1]);
    c.closePath();
  };
  c.save();
  c.translate(0.6, 0.8);
  tongue();
  c.fillStyle = 'rgba(4,2,1,0.55)';
  c.fill();
  c.restore();
  tongue();
  c.fillStyle = lin(c, 0, mid - 3, 0, mid + 3 + SAG, [[0, '#6A4224'], [0.5, PAL.leatherDark], [1, PAL.leatherDeep]]);
  c.fill();
  c.strokeStyle = 'rgba(8,4,2,0.88)';
  c.lineWidth = 0.55;
  c.stroke();
  for (const a of [0.74, 0.86, 0.98]) {
    const x = bodyX(a, mid, 1.5);
    const y = bodyY(a, mid);
    c.fillStyle = '#080402';
    c.beginPath();
    c.ellipse(x, y, Math.max(0.3, 0.75 * Math.cos(a)), 0.75, 0, 0, TAU);
    c.fill();
    c.strokeStyle = 'rgba(214,160,104,0.3)';
    c.lineWidth = 0.25;
    c.stroke();
  }
  // The keeper loop over the tongue.
  const ka = 0.68;
  const kx = bodyX(ka, mid, 1.8);
  const ky = bodyY(ka, mid);
  c.fillStyle = lin(c, 0, ky - 4.2, 0, ky + 4.2, [[0, '#6E4628'], [1, PAL.leatherDeep]]);
  c.fillRect(kx - 1.1, ky - 4.4, 2.2, 8.8);
  c.strokeStyle = 'rgba(8,4,2,0.85)';
  c.lineWidth = 0.45;
  c.strokeRect(kx - 1.1, ky - 4.4, 2.2, 8.8);
  // The buckle: a brass frame with a bar and a tongue, standing proud of the strap.
  const bx = bodyX(ba, mid, 1.6);
  const by = bodyY(ba, mid);
  const fw = 7.6;
  const fh = 13.4;
  c.save();
  c.translate(1, 1.1);
  roundRectPath(c, bx - fw / 2, by - fh / 2, fw, fh, 2.2);
  c.strokeStyle = 'rgba(4,2,1,0.6)';
  c.lineWidth = 1.8;
  c.stroke();
  c.restore();
  roundRectPath(c, bx - fw / 2, by - fh / 2, fw, fh, 2.2);
  c.strokeStyle = lin(c, bx - fw / 2, by - fh / 2, bx + fw / 2, by + fh / 2, [[0, PAL.brassShine], [0.25, PAL.brassLight], [0.6, PAL.brass], [1, PAL.brassDeep]]);
  c.lineWidth = 1.7;
  c.stroke();
  c.strokeStyle = 'rgba(30,18,6,0.85)';
  c.lineWidth = 0.3;
  roundRectPath(c, bx - fw / 2 - 0.85, by - fh / 2 - 0.85, fw + 1.7, fh + 1.7, 2.8);
  c.stroke();
  roundRectPath(c, bx - fw / 2 + 0.85, by - fh / 2 + 0.85, fw - 1.7, fh - 1.7, 1.4);
  c.stroke();
  c.fillStyle = cylinder(c, bx - 0.9, bx + 0.9, BRASS, 1);
  c.fillRect(bx - 0.75, by - fh / 2 + 0.6, 1.5, fh - 1.2);
  // The prong lies across the frame into a hole.
  c.strokeStyle = lin(c, bx, by - 1, bx + fw / 2 + 1.6, by, [[0, PAL.brassLight], [1, PAL.brassDark]]);
  c.lineWidth = 0.9;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(bx, by);
  c.lineTo(bx + fw / 2 + 1.4, by + 0.2);
  c.stroke();
  c.fillStyle = 'rgba(255,244,214,0.75)';
  c.fillRect(bx - fw / 2 - 0.3, by - fh / 2 + 1.6, 0.6, 3.2);
}

/** A leather gorget round the neck where the post goes up into the head: it hugs the post at its top
 *  edge and spreads over the shoulders below, stitched, with two brass rivets. */
function paintCollar(c: Ctx, tile: Tile): void {
  const collar = () => {
    c.beginPath();
    c.moveTo(-18.5, -236.5);
    c.quadraticCurveTo(0, -246.5, 18.5, -236.5);
    c.quadraticCurveTo(21.5, -232, 20.5, -228.5);
    c.quadraticCurveTo(0, -222.5, -20.5, -228.5);
    c.quadraticCurveTo(-21.5, -232, -18.5, -236.5);
    c.closePath();
  };
  c.save();
  c.translate(0.8, 1);
  collar();
  c.fillStyle = 'rgba(4,2,1,0.5)';
  c.fill();
  c.restore();
  collar();
  c.fillStyle = cylinder(c, -21.5, 21.5, LEATHER);
  c.fill();
  c.save();
  collar();
  c.clip();
  grain(c, tile, 0.3, 1, 0, -22, -247, 22, -222);
  // Rolled over at the neck, so its top edge takes the light; darker where it spreads under the arms.
  c.fillStyle = lin(c, 0, -246, 0, -224, [[0, 'rgba(255,214,160,0.32)'], [0.35, 'rgba(255,214,160,0.04)'], [1, 'rgba(8,4,2,0.3)']]);
  c.fillRect(-22, -247, 44, 25);
  c.restore();
  collar();
  c.strokeStyle = 'rgba(8,4,2,0.85)';
  c.lineWidth = 0.6;
  c.stroke();
  // A row of stitches inside each edge (the edges are the parabolas the collar's curves trace).
  const top: number[] = [];
  const bot: number[] = [];
  for (let i = 0; i <= 12; i++) {
    const x = -15 + 30 * (i / 12);
    top.push(x, -235.2 - 5 * (1 - (x / 18.5) ** 2));
    bot.push(x * 1.15, -229.9 + 3 * (1 - ((x * 1.15) / 20.5) ** 2));
  }
  stitches(c, top, 1.9, 0.9, 0.28);
  stitches(c, bot, 1.9, 0.9, 0.28);
  rivet(c, -13, -233, 0.95);
  rivet(c, 13, -233, 0.95);
}

// ------------------------------------------------------------------ the target

/** The ring between radii r0 < r1 round the target's centre; fill or clip it with 'evenodd'. */
function ringPath(c: Ctx, r0: number, r1: number): void {
  const { x, y, k } = TARGET;
  c.beginPath();
  c.ellipse(x, y, r1, r1 * k, 0, 0, TAU);
  if (r0 > 0) {
    c.moveTo(x + r0, y);
    c.ellipse(x, y, r0, r0 * k, 0, 0, TAU);
  }
}

/** A point on the target at canvas angle a (0 to the right, clockwise) and radius r. */
function onTarget(a: number, r: number): readonly [number, number] {
  return [TARGET.x + Math.cos(a) * r, TARGET.y + Math.sin(a) * r * TARGET.k];
}

/**
 * Light round a turned brass ring, by angle: brightest where its face turns to the candle (the upper
 * left for a convex lip, the lower right for a bevel sloping in), darkest opposite, a faint cool return
 * of moonlight on the upper right, and the fine streaks a lathe leaves. A conic gradient where the
 * canvas has them, otherwise a diagonal linear one.
 */
function ringShade(c: Ctx, r: number, convex: boolean, lo: number, hi: number, seed: number): CanvasGradient {
  const { x, y } = TARGET;
  if (typeof c.createConicGradient === 'function') {
    const g = c.createConicGradient(0, x, y);
    const q = rng(seed);
    const n = 36;
    const jitter: number[] = [];
    for (let i = 0; i < n; i++) jitter.push((q() - 0.5) * 0.16);
    jitter.push(jitter[0]);
    const peak = convex ? Math.PI * 1.25 : Math.PI * 0.25;
    const moon = convex ? Math.PI * 1.75 : Math.PI * 0.75;
    const moonlight = [150, 164, 186] as const;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * TAU;
      const toward = Math.pow(0.5 + 0.5 * Math.cos(a - peak), 1.8);
      const v = lo + (hi - lo) * toward + jitter[i];
      const cool = Math.pow(Math.max(0, Math.cos(a - moon)), 6) * 0.3;
      const rgb = rampRgb(BRASS_RAMP, v);
      g.addColorStop(i / n, css([0, 1, 2].map((k) => rgb[k] + (moonlight[k] - rgb[k]) * cool) as unknown as Rgb));
    }
    return g;
  }
  const d = r * 0.72;
  const stops: Stops = convex
    ? [[0, ramp(BRASS_RAMP, hi)], [0.35, ramp(BRASS_RAMP, (lo + 2 * hi) / 3)], [0.7, ramp(BRASS_RAMP, (2 * lo + hi) / 3)], [1, ramp(BRASS_RAMP, lo)]]
    : [[0, ramp(BRASS_RAMP, lo)], [0.35, ramp(BRASS_RAMP, (2 * lo + hi) / 3)], [0.7, ramp(BRASS_RAMP, (lo + 2 * hi) / 3)], [1, ramp(BRASS_RAMP, hi)]];
  return lin(c, x - d, y - d, x + d, y + d, stops);
}

/**
 * One glyph of the roundel's invented script, added to the current path in a cell `h` tall centred on
 * (0, 0), its top toward -y. Every glyph is a leaning stem; its head is plain, ringed, forked, barred or
 * hooked, its foot plain, ringed, barred or hooked; then one or two marks beside or across it: a
 * branch, a chevron, a crescent facing it, a dot, a crossbar. All chosen by `r`: the rings, crescents
 * and dots make it a script of its own rather than any real alphabet.
 */
function glyph(c: Ctx, r: () => number, h: number): void {
  const u = h / 2;
  const lean = (r() - 0.5) * 0.36 * u;
  const ring = u * 0.27;
  const head = Math.floor(r() * 5);
  let foot = Math.floor(r() * 4);
  // Never ringed at both ends (it would read as a figure 8).
  if (head === 1 && foot === 1) foot = 3;
  const xAt = (y: number) => -lean * (y / u);
  const y0 = head === 1 ? -u + ring * 2 : head === 2 ? -u * 0.45 : -u;
  const y1 = foot === 1 ? u - ring * 2 : u;
  c.moveTo(xAt(y0), y0);
  c.lineTo(xAt(y1), y1);
  const hx = xAt(-u);
  const side = r() < 0.5 ? -1 : 1;
  switch (head) {
    case 1:
      c.moveTo(hx + ring, -u + ring);
      c.arc(hx, -u + ring, ring, 0, TAU);
      break;
    case 2:
      c.moveTo(hx - u * 0.46, -u);
      c.lineTo(xAt(y0), y0);
      c.lineTo(hx + u * 0.46, -u);
      break;
    case 3:
      c.moveTo(hx - u * 0.38, -u);
      c.lineTo(hx + u * 0.38, -u);
      break;
    case 4:
      c.moveTo(hx, -u);
      c.quadraticCurveTo(hx + side * u * 0.55, -u, hx + side * u * 0.5, -u * 0.5);
      break;
    default:
      break;
  }
  const fx = xAt(u);
  switch (foot) {
    case 1:
      c.moveTo(fx + ring, u - ring);
      c.arc(fx, u - ring, ring, 0, TAU);
      break;
    case 2:
      c.moveTo(fx - u * 0.34, u);
      c.lineTo(fx + u * 0.34, u);
      break;
    case 3:
      c.moveTo(fx, u);
      c.quadraticCurveTo(fx - side * u * 0.5, u, fx - side * u * 0.5, u * 0.58);
      break;
    default:
      break;
  }
  const marks = r() < 0.38 ? 2 : 1;
  let barred = false;
  for (let i = 0; i < marks; i++) {
    const s = i === 0 ? side : -side;
    const ym = (r() - 0.5) * u * 0.7;
    const xm = xAt(ym);
    let kind = Math.floor(r() * 5);
    if (kind === 4 && barred) kind = 0;
    // A ring at either end with a chevron or a bar across the stem would make a little stick figure
    // (the glyphs at the bottom of the ring stand on their heads): a crescent or a dot instead.
    if ((head === 1 || foot === 1) && (kind === 1 || kind === 4)) kind = kind === 1 ? 2 : 3;
    switch (kind) {
      case 0:
        c.moveTo(xm, ym + u * 0.18);
        c.lineTo(xm + s * u * 0.56, ym - u * 0.42);
        break;
      case 1:
        c.moveTo(xm - u * 0.44, ym + u * 0.3);
        c.lineTo(xm, ym - u * 0.16);
        c.lineTo(xm + u * 0.44, ym + u * 0.3);
        break;
      case 2:
        // A crescent facing the stem.
        c.moveTo(xm + s * u * 0.38, ym - u * 0.32);
        c.quadraticCurveTo(xm + s * u * 0.9, ym, xm + s * u * 0.38, ym + u * 0.32);
        break;
      case 3:
        c.moveTo(xm + s * u * 0.6 + u * 0.1, ym);
        c.arc(xm + s * u * 0.6, ym, u * 0.1, 0, TAU);
        break;
      default:
        barred = true;
        c.moveTo(xm - u * 0.42, ym);
        c.lineTo(xm + u * 0.42, ym);
        break;
    }
  }
}

/** The script round the dark band, added to the current path: words of glyphs with a small lozenge
 *  between them. The same seed gives the same words, so it can be laid twice (groove, then inlay). */
function scriptPath(c: Ctx, dx: number, dy: number): void {
  const q = rng(311);
  const slots = 25;
  const rr = (RING.script + RING.fillet) / 2;
  const h = (RING.script - RING.fillet) * 0.7;
  c.beginPath();
  for (let i = 0; i < slots; i++) {
    const a = (i / slots) * TAU - Math.PI / 2 + 0.05;
    const [x, y] = onTarget(a, rr);
    c.save();
    c.translate(x + dx, y + dy);
    c.rotate(a + Math.PI / 2);
    if (i % 6 === 5) {
      c.moveTo(0, -h * 0.28);
      c.lineTo(h * 0.18, 0);
      c.lineTo(0, h * 0.28);
      c.lineTo(-h * 0.18, 0);
      c.closePath();
    } else {
      glyph(c, q, h);
    }
    c.restore();
  }
}

/** The sigil at the heart, added to the current path: a small ring, eight rays long and short, and a
 *  circle broken where the long rays cross it, one ray forked. Made up for the dummy. */
function sigilPath(c: Ctx): void {
  const { x, y, k } = TARGET;
  c.beginPath();
  c.moveTo(x + 0.95, y);
  c.ellipse(x, y, 0.95, 0.95 * k, 0, 0, TAU);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU - Math.PI / 2;
    const r1 = i % 2 === 0 ? 3.85 : 2.6;
    c.moveTo(x + Math.cos(a) * 1.55, y + Math.sin(a) * 1.55 * k);
    c.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1 * k);
  }
  // The top ray forks.
  c.moveTo(x, y - 3.1 * k);
  c.lineTo(x - 0.75, y - 4.05 * k);
  c.moveTo(x, y - 3.1 * k);
  c.lineTo(x + 0.75, y - 4.05 * k);
  for (let i = 0; i < 4; i++) {
    const a0 = (i / 4) * TAU - Math.PI / 2 + 0.36;
    const a1 = a0 + Math.PI / 2 - 0.72;
    c.moveTo(x + Math.cos(a0) * 3.25, y + Math.sin(a0) * 3.25 * k);
    c.ellipse(x, y, 3.25, 3.25 * k, 0, a0, a1);
  }
}

/** The target roundel worked into the breastplate (the parts in light: everything but the sigil's
 *  glow, which is laid over the body's shading in paintSigilGlow). */
function paintTarget(c: Ctx, tile: Tile): void {
  const { x: cx, y: cy } = TARGET;
  const R = RING;
  // Set into the leather: its shadow on the lower right, the leather pressed down round it.
  c.fillStyle = rad(c, cx + 1.5, cy + 1.7, R.lip - 1.5, cx + 1.5, cy + 1.7, R.lip + 3.4, [[0, 'rgba(6,3,1,0.8)'], [0.4, 'rgba(6,3,1,0.42)'], [1, 'rgba(6,3,1,0)']]);
  c.beginPath();
  c.arc(cx + 1.5, cy + 1.7, R.lip + 3.4, 0, TAU);
  c.fill();

  // The bezel: a rolled lip, an engraved flat set with rivets, and a bevel down to the paint.
  ringPath(c, R.flat, R.lip);
  c.fillStyle = ringShade(c, R.lip, true, 0.12, 1.02, 301);
  c.fill('evenodd');
  ringPath(c, R.bevel, R.flat);
  c.fillStyle = ringShade(c, R.flat, true, 0.3, 0.8, 302);
  c.fill('evenodd');
  ringPath(c, R.script, R.bevel);
  c.fillStyle = ringShade(c, R.bevel, false, 0.08, 0.9, 303);
  c.fill('evenodd');
  c.save();
  ringPath(c, R.script, R.lip);
  c.clip('evenodd');
  speckle(c, cx - R.lip, cy - R.lip, cx + R.lip, cy + R.lip, 305, 90, [PAL.patina, PAL.brassDeep], 0.2, 0.55, 0.5);
  // The engraving: two fine lines round the flat, a twisted rope between them, broken by the rivets.
  c.strokeStyle = 'rgba(34,20,6,0.7)';
  c.lineWidth = 0.28;
  for (const rr of [R.flat - 0.35, R.bevel + 0.35]) {
    c.beginPath();
    c.ellipse(cx, cy, rr, rr * TARGET.k, 0, 0, TAU);
    c.stroke();
  }
  c.beginPath();
  const rivets = 12;
  for (let i = 0; i < 96; i++) {
    const a = (i / 96) * TAU;
    // Rivets sit at half steps round the ring: keep the rope clear of them.
    const nearest = Math.abs(((a / TAU) * rivets) % 1 - 0.5);
    if (nearest < 0.16) continue;
    const [x0, y0] = onTarget(a, R.bevel + 0.75);
    const [x1, y1] = onTarget(a + 0.035, R.flat - 0.75);
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
  }
  c.strokeStyle = 'rgba(40,24,6,0.6)';
  c.lineWidth = 0.3;
  c.stroke();
  c.restore();
  // Bright, worn edges where the lip has been rubbed, and a cool one where the moon finds it.
  c.lineWidth = 0.45;
  c.strokeStyle = 'rgba(255,240,200,0.7)';
  c.beginPath();
  c.ellipse(cx, cy, R.lip - 0.45, (R.lip - 0.45) * TARGET.k, 0, Math.PI * 1.02, Math.PI * 1.45);
  c.stroke();
  c.strokeStyle = 'rgba(190,206,236,0.35)';
  c.beginPath();
  c.ellipse(cx, cy, R.lip - 0.45, (R.lip - 0.45) * TARGET.k, 0, Math.PI * 1.66, Math.PI * 1.86);
  c.stroke();
  ringPath(c, 0, R.lip);
  c.strokeStyle = 'rgba(20,12,4,0.9)';
  c.lineWidth = 0.5;
  c.stroke();
  for (let i = 0; i < rivets; i++) {
    const a = ((i + 0.5) / rivets) * TAU;
    const [x, y] = onTarget(a, (R.flat + R.bevel) / 2);
    rivet(c, x, y, 0.9);
  }
  // Nicks in the bezel where spells have glanced off it.
  for (const [a, size] of [[-0.55, 1.5], [2.62, 1.2], [1.3, 1]] as const) {
    const [x0, y0] = onTarget(a - 0.06, R.lip);
    const [x1, y1] = onTarget(a, R.lip - size);
    const [x2, y2] = onTarget(a + 0.06, R.lip);
    c.fillStyle = 'rgba(16,9,3,0.9)';
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.lineTo(x2, y2);
    c.closePath();
    c.fill();
    const [x3, y3] = onTarget(a + 0.05, R.lip - 0.25);
    c.strokeStyle = 'rgba(255,236,190,0.6)';
    c.lineWidth = 0.28;
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x3, y3);
    c.stroke();
  }

  // The script band: soot-black enamel, the script inlaid round it in pale gold, chipped to the brass.
  ringPath(c, R.fillet, R.script);
  c.fillStyle = rad(c, cx - 7, cy - 7, 1, cx, cy, R.script, [[0, '#2C2622'], [0.75, '#1A1512'], [1, '#0C0908']]);
  c.fill('evenodd');
  c.save();
  ringPath(c, R.fillet, R.script);
  c.clip('evenodd');
  speckle(c, cx - R.script, cy - R.script, cx + R.script, cy + R.script, 312, 26, [PAL.brass, PAL.brassLight], 0.2, 0.5, 0.6);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  scriptPath(c, 0.22, 0.26);
  c.strokeStyle = 'rgba(0,0,0,0.85)';
  c.lineWidth = 0.7;
  c.stroke();
  // The inlay holds a little of the enchantment: a faint warmth round each mark, then the gold.
  scriptPath(c, 0, 0);
  c.strokeStyle = 'rgba(255,196,110,0.14)';
  c.lineWidth = 1.5;
  c.stroke();
  c.strokeStyle = lin(c, cx - 16, cy - 16, cx + 16, cy + 16, [[0, '#FFEDB8'], [0.35, '#E2C27C'], [0.75, '#A8843E'], [1, '#7A5E2A']]);
  c.lineWidth = 0.5;
  c.stroke();
  c.restore();

  // The fillet, a thin ring of brass between the script and the cream.
  ringPath(c, R.cream, R.fillet);
  c.fillStyle = ringShade(c, R.fillet, true, 0.15, 0.95, 304);
  c.fill('evenodd');

  // The cream chapter ring, aged and grimy, with its ticks, crazed where the paint has dried.
  ringPath(c, R.red, R.cream);
  c.fillStyle = rad(c, cx - 5, cy - 6, 1, cx, cy, R.cream, [[0, '#ECDFBA'], [0.55, '#D6C69C'], [1, '#A6926A']]);
  c.fill('evenodd');
  c.save();
  ringPath(c, R.red, R.cream);
  c.clip('evenodd');
  grain(c, tile, 0.25, 1, 0, cx - R.cream, cy - R.cream, cx + R.cream, cy + R.cream);
  const q = rng(321);
  c.strokeStyle = 'rgba(70,52,30,0.35)';
  c.lineWidth = 0.18;
  c.beginPath();
  for (let i = 0; i < 26; i++) {
    const a = q() * TAU;
    const r0 = R.red + q() * (R.cream - R.red);
    let [x, y] = onTarget(a, r0);
    c.moveTo(x, y);
    for (let j = 0; j < 3; j++) {
      x += (q() - 0.5) * 1.6;
      y += (q() - 0.5) * 1.6;
      c.lineTo(x, y);
    }
  }
  c.stroke();
  c.beginPath();
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * TAU - Math.PI / 2;
    const long = i % 5 === 0;
    const [x0, y0] = onTarget(a, R.cream - 0.2);
    const [x1, y1] = onTarget(a, R.cream - (long ? 2.5 : 1.25));
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
  }
  c.strokeStyle = 'rgba(40,24,12,0.82)';
  c.lineWidth = 0.3;
  c.stroke();
  c.restore();
  ringPath(c, 0, R.red);
  c.strokeStyle = 'rgba(30,16,8,0.8)';
  c.lineWidth = 0.35;
  c.stroke();

  // The oxblood ring, tooled with a double line, rubbed through to the leather here and there.
  ringPath(c, R.soot, R.red);
  c.fillStyle = rad(c, cx - 4, cy - 4.5, 0.5, cx, cy, R.red, [[0, '#A8394A'], [0.45, PAL.oxblood], [1, '#4C0E18']]);
  c.fill('evenodd');
  c.save();
  ringPath(c, R.soot, R.red);
  c.clip('evenodd');
  grain(c, tile, 0.22, 1, 0, cx - R.red, cy - R.red, cx + R.red, cy + R.red);
  speckle(c, cx - R.red, cy - R.red, cx + R.red, cy + R.red, 331, 24, ['#5A3418', '#3A1E0E'], 0.25, 0.75, 0.55);
  for (const [rr, color, w] of [[9.6, 'rgba(26,4,8,0.7)', 0.32], [9.15, 'rgba(255,170,160,0.18)', 0.22], [8.4, 'rgba(26,4,8,0.6)', 0.28]] as const) {
    c.strokeStyle = color;
    c.lineWidth = w;
    c.beginPath();
    c.ellipse(cx, cy, rr, rr * TARGET.k, 0, 0, TAU);
    c.stroke();
  }
  c.restore();

  // The soot ring, then the boss: a brass rim round a dark inlay, where the sigil is.
  ringPath(c, R.boss, R.soot);
  c.fillStyle = '#100C0A';
  c.fill('evenodd');
  ringPath(c, R.inlay, R.boss);
  c.fillStyle = ringShade(c, R.boss, true, 0.1, 1, 306);
  c.fill('evenodd');
  ringPath(c, 0, R.inlay);
  c.fillStyle = rad(c, cx - 1.5, cy - 1.8, 0.2, cx, cy, R.inlay, [[0, '#2A2430'], [0.6, '#15111A'], [1, '#07060A']]);
  c.fill();
  ringPath(c, 0, R.inlay);
  c.strokeStyle = 'rgba(10,6,2,0.9)';
  c.lineWidth = 0.35;
  c.stroke();
  // The sigil engraved in the inlay (its light comes later, over the body's shading).
  sigilPath(c);
  c.lineCap = 'round';
  c.strokeStyle = 'rgba(0,0,0,0.6)';
  c.lineWidth = 0.75;
  c.stroke();

  // Paint chipped off the cream and the oxblood down to the leather, each chip's far edge lit.
  const chips = rng(351);
  for (const [a, rr, size] of [[0.4, 13.2, 1.3], [2.1, 12.4, 1], [3.6, 13.6, 1.1], [4.9, 9.8, 1.2], [1.2, 8.6, 0.9], [5.6, 13, 0.8]] as const) {
    const [x, y] = onTarget(a, rr);
    c.beginPath();
    for (let i = 0; i < 6; i++) {
      const t = (i / 6) * TAU;
      const d = size * (0.55 + chips() * 0.6);
      if (i === 0) c.moveTo(x + Math.cos(t) * d, y + Math.sin(t) * d * 0.8);
      else c.lineTo(x + Math.cos(t) * d, y + Math.sin(t) * d * 0.8);
    }
    c.closePath();
    c.fillStyle = 'rgba(62,36,18,0.85)';
    c.fill();
    c.strokeStyle = 'rgba(255,238,206,0.28)';
    c.lineWidth = 0.22;
    c.stroke();
  }
  // Hits: a scorch blown across the lower right, a burnt pit in the cream, a smudge on the script,
  // a bright scratch where a spell skidded over the brass.
  scorch(c, cx + 8.5, cy + 7.5, 7.5, 341);
  scorch(c, cx - 12.8, cy - 3.6, 2.6, 342, 0.7);
  scorch(c, cx - 5.5, cy - 17.5, 3.4, 343);
  c.strokeStyle = 'rgba(255,236,196,0.4)';
  c.lineWidth = 0.25;
  c.beginPath();
  c.moveTo(cx - 21.6, cy - 8.2);
  c.quadraticCurveTo(cx - 20.6, cy - 6.9, cx - 19.8, cy - 6.4);
  c.stroke();
  // The roundel is very slightly domed: light gathers on its upper left.
  c.fillStyle = rad(c, cx - 8, cy - 9, 0.5, cx - 2, cy - 2, R.lip + 1, [[0, 'rgba(255,224,176,0.14)'], [0.55, 'rgba(255,224,176,0.02)'], [1, 'rgba(0,0,0,0.12)']]);
  ringPath(c, 0, R.lip);
  c.fill();
}

/** The sigil's own faint light, over everything the body's shading has darkened. */
function paintSigilGlow(c: Ctx): void {
  const { x, y } = TARGET;
  c.fillStyle = rad(c, x, y, 0, x, y, 8.5, [[0, 'rgba(255,214,140,0.5)'], [0.3, 'rgba(255,180,90,0.2)'], [0.7, 'rgba(255,150,60,0.06)'], [1, 'rgba(255,150,60,0)']]);
  c.beginPath();
  c.arc(x, y, 8.5, 0, TAU);
  c.fill();
  sigilPath(c);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = 'rgba(255,186,96,0.32)';
  c.lineWidth = 1.5;
  c.stroke();
  c.strokeStyle = 'rgba(255,224,160,0.9)';
  c.lineWidth = 0.6;
  c.stroke();
  c.strokeStyle = '#FFF8E4';
  c.lineWidth = 0.26;
  c.stroke();
}

// ------------------------------------------------------------------ the arms

/** A turned shaft along x from its profile, [x, half-thickness] pairs with x increasing, mirrored by
 *  `s`; smoothed through the midpoints so the beads and coves turn round. */
function turnedPath(c: Ctx, prof: readonly number[], s: number): void {
  const n = prof.length / 2;
  c.beginPath();
  c.moveTo(s * prof[0], -prof[1]);
  for (let i = 1; i < n - 1; i++) {
    c.quadraticCurveTo(s * prof[i * 2], -prof[i * 2 + 1], (s * (prof[i * 2] + prof[i * 2 + 2])) / 2, -(prof[i * 2 + 1] + prof[i * 2 + 3]) / 2);
  }
  c.lineTo(s * prof[(n - 1) * 2], -prof[(n - 1) * 2 + 1]);
  c.lineTo(s * prof[(n - 1) * 2], prof[(n - 1) * 2 + 1]);
  for (let i = n - 2; i > 0; i--) {
    c.quadraticCurveTo(s * prof[i * 2], prof[i * 2 + 1], (s * (prof[i * 2] + prof[i * 2 - 2])) / 2, (prof[i * 2 + 1] + prof[i * 2 - 1]) / 2);
  }
  c.lineTo(s * prof[0], prof[1]);
  c.closePath();
}

/** The profile's half-thickness at x (linear between its points). */
function profileAt(prof: readonly number[], x: number): number {
  if (x <= prof[0]) return prof[1];
  for (let i = 2; i < prof.length; i += 2) {
    if (x <= prof[i]) return prof[i - 1] + ((prof[i + 1] - prof[i - 1]) * (x - prof[i - 2])) / Math.max(1e-6, prof[i] - prof[i - 2]);
  }
  return prof[prof.length - 1];
}

/**
 * Turned beech along a profile, shaded slice by slice so every bead and cove is lit as round: a band
 * of light along its top toward the candle, the core shadow below the middle, a cool edge underneath,
 * and each bead's face toward the candle brighter than its back. Grain runs along it.
 */
function turned(c: Ctx, tile: Tile, prof: readonly number[], s: number, seed: number): void {
  const x0 = prof[0];
  const x1 = prof[prof.length - 2];
  const hMax = Math.max(...prof.filter((_, i) => i % 2 === 1));
  c.save();
  turnedPath(c, prof, s);
  c.clip();
  const step = 1.2;
  for (let x = x0; x < x1; x += step) {
    const h = profileAt(prof, x + step / 2);
    const slope = (profileAt(prof, x + step) - profileAt(prof, x)) / step;
    // The face of a bead toward the candle (on the left of the picture) is the brighter.
    const f = Math.max(-1, Math.min(1, slope * s * 0.9)) * 0.14 + (s < 0 ? 0.04 : -0.03);
    const t = (v: number) => ramp(BEECH_RAMP, v + f);
    c.fillStyle = lin(c, 0, -h, 0, h, [[0, t(0.45)], [0.12, t(0.78)], [0.27, t(0.97)], [0.42, t(0.72)], [0.62, t(0.48)], [0.8, t(0.24)], [0.91, t(0.36)], [1, t(0.08)]]);
    const xa = s > 0 ? x : -(x + step);
    c.fillRect(xa - 0.3, -hMax - 1, step + 0.6, hMax * 2 + 2);
  }
  woodGrain(c, s > 0 ? x0 : -x1, -hMax, s > 0 ? x1 : -x0, hMax, seed, { color: '#2E1B0D', alpha: 0.3, gap: 1.5, wave: 0.35, width: 0.3, stepX: 3 });
  grain(c, tile, 0.22, 9, 0, s > 0 ? x0 : -x1, -hMax, s > 0 ? x1 : -x0, hMax);
  c.restore();
  turnedPath(c, prof, s);
  c.strokeStyle = 'rgba(14,8,4,0.85)';
  c.lineWidth = 0.6;
  c.stroke();
}

/** Lines turned into the wood at x: an incised ring, dark with a lit edge. */
function incised(c: Ctx, prof: readonly number[], s: number, xs: readonly number[]): void {
  for (const x of xs) {
    const h = profileAt(prof, x) - 0.2;
    c.strokeStyle = 'rgba(20,10,4,0.75)';
    c.lineWidth = 0.4;
    c.beginPath();
    c.moveTo(s * x, -h);
    c.quadraticCurveTo(s * (x + 0.8), 0, s * x, h);
    c.stroke();
    c.strokeStyle = 'rgba(255,224,176,0.3)';
    c.lineWidth = 0.3;
    c.beginPath();
    c.moveTo(s * (x - 0.45), -h);
    c.quadraticCurveTo(s * (x + 0.35), 0, s * (x - 0.45), h * 0.3);
    c.stroke();
  }
}

/** A brass ferrule round a turned arm between x0 and x1, `h` its half-height. */
function ferrule(c: Ctx, s: number, x0: number, x1: number, h: number): void {
  const xa = Math.min(s * x0, s * x1);
  const w = Math.abs(x1 - x0);
  c.fillStyle = 'rgba(4,2,1,0.45)';
  c.fillRect(xa + 0.6, -h + 0.8, w, h * 2);
  c.fillStyle = lin(c, 0, -h, 0, h, [[0, PAL.brassDark], [0.1, PAL.brassLight], [0.24, PAL.brassShine], [0.4, PAL.brassLight], [0.62, PAL.brass], [0.82, PAL.brassDark], [0.92, '#6E6A5E'], [1, PAL.brassDeep]]);
  c.fillRect(xa, -h, w, h * 2);
  c.strokeStyle = 'rgba(40,24,6,0.6)';
  c.lineWidth = 0.3;
  c.beginPath();
  c.moveTo(xa + 0.9, -h);
  c.lineTo(xa + 0.9, h);
  c.moveTo(xa + w - 0.9, -h);
  c.lineTo(xa + w - 0.9, h);
  c.stroke();
  c.strokeStyle = 'rgba(30,18,6,0.9)';
  c.lineWidth = 0.45;
  c.strokeRect(xa, -h, w, h * 2);
}

const UPPER_ARM: readonly number[] = [
  15, 10.6, 18.4, 10.8, 19.6, 9.2, 21, 9.8, 22.4, 8.2, 26, 8.5, 33, 9.1, 40, 9.1, 45.5, 8.4, 47.6, 7.2, 49, 8.9, 53.5, 8.9,
];
const FOREARM: readonly number[] = [
  68.5, 7.8, 72.6, 8.1, 73.8, 6.9, 75.2, 7.6, 80.5, 7.7, 85.5, 7.1, 87.2, 6.2, 88.2, 7.4, 93, 7.4,
];

/** One arm from the shoulder out to its fist, `s` -1 (left) or 1: turned beech, a ferrule at the
 *  elbow and the wrist, the elbow a turned ball pinned in brass, and a carved fist. */
function paintArm(c: Ctx, tile: Tile, s: -1 | 1): void {
  turned(c, tile, UPPER_ARM, s, 230 + s);
  incised(c, UPPER_ARM, s, [19.6, 22.4, 45.5]);
  ferrule(c, s, 48.6, 53.2, 9);
  turned(c, tile, FOREARM, s, 233 + s);
  incised(c, FOREARM, s, [73.8, 85.5]);
  ferrule(c, s, 88, 93, 7.6);
  // The elbow: a turned ball, a brass pin through it on a washer.
  const ex = s * 62;
  c.fillStyle = 'rgba(4,2,1,0.45)';
  c.beginPath();
  c.arc(ex + 0.8, 1, 10, 0, TAU);
  c.fill();
  c.fillStyle = sphere(c, ex, 0, 9.8, BEECH);
  c.beginPath();
  c.arc(ex, 0, 9.8, 0, TAU);
  c.fill();
  c.save();
  c.beginPath();
  c.arc(ex, 0, 9.8, 0, TAU);
  c.clip();
  woodGrain(c, ex - 10, -10, ex + 10, 10, 236 + s, { color: '#2E1B0D', alpha: 0.24, gap: 1.6, wave: 1.4, width: 0.3, stepX: 2 });
  c.strokeStyle = 'rgba(30,16,6,0.4)';
  c.lineWidth = 0.35;
  c.beginPath();
  c.ellipse(ex, 0, 7.4, 7.4, 0, 0, TAU);
  c.stroke();
  c.restore();
  c.beginPath();
  c.arc(ex, 0, 9.8, 0, TAU);
  c.strokeStyle = 'rgba(14,8,4,0.85)';
  c.lineWidth = 0.6;
  c.stroke();
  c.fillStyle = sphere(c, ex, 0, 3.7, BRASS);
  c.beginPath();
  c.arc(ex, 0, 3.7, 0, TAU);
  c.fill();
  c.strokeStyle = 'rgba(30,18,6,0.85)';
  c.lineWidth = 0.35;
  c.stroke();
  c.beginPath();
  c.arc(ex, 0, 2.5, 0, TAU);
  c.stroke();
  c.fillStyle = sphere(c, ex, 0, 2.2, IRON);
  c.beginPath();
  c.arc(ex, 0, 2.2, 0, TAU);
  c.fill();
  c.strokeStyle = 'rgba(0,0,0,0.8)';
  c.lineWidth = 0.4;
  c.beginPath();
  c.moveTo(ex - 1.5, -0.6);
  c.lineTo(ex + 1.5, 0.6);
  c.stroke();
  paintFist(c, tile, s);
}

/** The fist: a carved hand closed on a grip, four fingers stacked from the index under the thumb to
 *  the little finger, their knuckles rounded at the outer end, the thumb wrapped over the top. */
function paintFist(c: Ctx, tile: Tile, s: -1 | 1): void {
  const bands = [[-8.6, -3.7], [-3.7, 1.1], [1.1, 5.9], [5.9, 10.6]] as const;
  const knuckle = (i: number) => 118.6 - Math.abs(i - 1.2) * 1.1;
  // Its outline: the back of the hand rising to the thumb, then a knuckle for each finger round the
  // outer end, and the underside back to the wrist.
  const outline = () => {
    c.beginPath();
    c.moveTo(s * 92, -8);
    c.quadraticCurveTo(s * 95.5, -12.6, s * 101, -12.8);
    c.quadraticCurveTo(s * 108.5, -13.8, s * 113, -11.4);
    c.quadraticCurveTo(s * 116, -10.2, s * (knuckle(0) - 1.5), bands[0][0]);
    for (let i = 0; i < bands.length; i++) {
      const [ya, yb] = bands[i];
      const next = i + 1 < bands.length ? Math.min(knuckle(i), knuckle(i + 1)) - 1.5 : knuckle(i) - 2.2;
      c.quadraticCurveTo(s * (knuckle(i) + 1.3), (ya + yb) / 2, s * next, yb);
    }
    c.quadraticCurveTo(s * 112, 14.2, s * 104, 13.6);
    c.quadraticCurveTo(s * 97, 12.6, s * 92, 8);
    c.closePath();
  };
  outline();
  c.fillStyle = sphere(c, s * 104, -1, 15, BEECH);
  c.fill();
  c.save();
  outline();
  c.clip();
  woodGrain(c, s > 0 ? 90 : -120, -14, s > 0 ? 120 : -90, 15, 238 + s, { color: '#2E1B0D', alpha: 0.26, gap: 1.6, wave: 0.6, width: 0.3, stepX: 3 });
  grain(c, tile, 0.2, 4, 0, s > 0 ? 90 : -120, -14, s > 0 ? 120 : -90, 15);
  // The fingers: each rounded, lit along its top; the grooves between them dark.
  for (let i = 0; i < bands.length; i++) {
    const [ya, yb] = bands[i];
    const xin = s * (100.5 - i * 0.6);
    const xout = s * knuckle(i);
    c.fillStyle = lin(c, 0, ya, 0, yb, [[0, 'rgba(255,226,180,0.3)'], [0.35, 'rgba(255,226,180,0.08)'], [0.75, 'rgba(30,16,6,0.16)'], [1, 'rgba(30,16,6,0.5)']]);
    c.beginPath();
    c.moveTo(xin, ya);
    c.lineTo(xout - s * 2.2, ya);
    c.quadraticCurveTo(xout + s * 0.4, (ya + yb) / 2, xout - s * 2.2, yb);
    c.lineTo(xin, yb);
    c.closePath();
    c.fill();
    // A knuckle crease across each finger, and its lit knuckle.
    c.strokeStyle = 'rgba(40,20,8,0.45)';
    c.lineWidth = 0.35;
    c.beginPath();
    c.moveTo(s * (109.5 - i * 0.3), ya + 0.8);
    c.quadraticCurveTo(s * (110.6 - i * 0.3), (ya + yb) / 2, s * (109.5 - i * 0.3), yb - 0.8);
    c.stroke();
    c.fillStyle = 'rgba(255,232,190,0.28)';
    c.beginPath();
    c.ellipse(xout - s * 2.4, ya + 1.3, 1.5, 0.8, 0, 0, TAU);
    c.fill();
  }
  c.strokeStyle = 'rgba(28,14,6,0.75)';
  c.lineWidth = 0.55;
  c.beginPath();
  for (let i = 1; i < bands.length; i++) {
    const y = bands[i][0];
    c.moveTo(s * (100 - i * 0.6), y + 0.3);
    c.quadraticCurveTo(s * 110, y - 0.3, s * (Math.min(knuckle(i - 1), knuckle(i)) - 1.2), y);
  }
  c.stroke();
  // The heel of the hand at the wrist, in shade under the thumb.
  c.fillStyle = lin(c, s * 92, 0, s * 101, 0, [[0, 'rgba(20,10,4,0.35)'], [1, 'rgba(20,10,4,0)']]);
  c.fillRect(s > 0 ? 92 : -101, -14, 9, 28);
  c.restore();
  outline();
  c.strokeStyle = 'rgba(14,8,4,0.88)';
  c.lineWidth = 0.65;
  c.stroke();
  // The thumb, wrapped over the index finger: a rounded lobe, its nail toward the outer end.
  const thumb = () => {
    c.beginPath();
    c.moveTo(s * 95.5, -10.8);
    c.quadraticCurveTo(s * 101, -14.6, s * 108, -13.3);
    c.quadraticCurveTo(s * 113.2, -12.2, s * 112.6, -9);
    c.quadraticCurveTo(s * 111.6, -6.6, s * 107, -7.4);
    c.quadraticCurveTo(s * 100.5, -8.2, s * 95.5, -7.6);
    c.closePath();
  };
  thumb();
  c.fillStyle = lin(c, 0, -14.4, 0, -6.8, [[0, BEECH.shine], [0.3, BEECH.light], [0.7, BEECH.mid], [1, BEECH.dark]]);
  c.fill();
  c.strokeStyle = 'rgba(14,8,4,0.8)';
  c.lineWidth = 0.5;
  c.stroke();
  c.strokeStyle = 'rgba(40,20,8,0.5)';
  c.lineWidth = 0.35;
  c.beginPath();
  c.moveTo(s * 108.4, -12.6);
  c.quadraticCurveTo(s * 110.8, -11.2, s * 110.6, -8.4);
  c.stroke();
}

function paintArms(c: Ctx, tile: Tile): void {
  for (const s of [-1, 1] as const) paintArm(c, tile, s);
  // The shoulder block they are pinned through: oak, its edges chamfered, a brass plate on its face,
  // and the iron bolt that holds it to the post.
  const hw = 17.5;
  const hh = 13.6;
  c.fillStyle = 'rgba(4,2,1,0.5)';
  roundRectPath(c, -hw + 1, -hh + 1.2, hw * 2, hh * 2, 2.5);
  c.fill();
  roundRectPath(c, -hw, -hh, hw * 2, hh * 2, 2.5);
  c.fillStyle = lin(c, -hw, -hh, hw, hh, [[0, '#8A6642'], [0.15, '#6A4A2C'], [0.6, '#46301B'], [1, '#22160C']]);
  c.fill();
  c.save();
  roundRectPath(c, -hw, -hh, hw * 2, hh * 2, 2.5);
  c.clip();
  woodGrain(c, -hw, -hh, hw, hh, 240, { color: PAL.oakDeep, alpha: 0.5, gap: 1.5, wave: 0.5, width: 0.35, stepX: 3 });
  rayFleck(c, -hw, -hh, hw, hh, 241, 14, '#C49A64', 0.16, 2);
  grain(c, tile, 0.24, 8, 0, -hw, -hh, hw, hh);
  // The chamfers: lit along the top and left, dark along the bottom and right.
  c.fillStyle = 'rgba(255,214,160,0.22)';
  c.fillRect(-hw, -hh, hw * 2, 2.2);
  c.fillRect(-hw, -hh, 2.2, hh * 2);
  c.fillStyle = 'rgba(6,3,1,0.45)';
  c.fillRect(-hw, hh - 2.2, hw * 2, 2.2);
  c.fillRect(hw - 2.2, -hh, 2.2, hh * 2);
  c.restore();
  roundRectPath(c, -hw, -hh, hw * 2, hh * 2, 2.5);
  c.strokeStyle = 'rgba(6,4,2,0.88)';
  c.lineWidth = 0.8;
  c.stroke();
  // The plate.
  const pw = 11.5;
  const ph = 8.6;
  c.fillStyle = 'rgba(4,2,1,0.5)';
  roundRectPath(c, -pw + 0.7, -ph + 0.9, pw * 2, ph * 2, 2);
  c.fill();
  roundRectPath(c, -pw, -ph, pw * 2, ph * 2, 2);
  c.fillStyle = lin(c, -pw, -ph, pw, ph, [[0, PAL.brassShine], [0.18, PAL.brassLight], [0.55, PAL.brass], [0.85, PAL.brassDark], [1, PAL.brassDeep]]);
  c.fill();
  c.save();
  roundRectPath(c, -pw, -ph, pw * 2, ph * 2, 2);
  c.clip();
  speckle(c, -pw, -ph, pw, ph, 243, 40, [PAL.patina, PAL.brassDeep], 0.2, 0.5, 0.45);
  c.restore();
  roundRectPath(c, -pw, -ph, pw * 2, ph * 2, 2);
  c.strokeStyle = 'rgba(30,18,6,0.9)';
  c.lineWidth = 0.5;
  c.stroke();
  roundRectPath(c, -pw + 1.4, -ph + 1.4, pw * 2 - 2.8, ph * 2 - 2.8, 1.2);
  c.strokeStyle = 'rgba(40,24,6,0.6)';
  c.lineWidth = 0.3;
  c.stroke();
  for (const [x, y] of [[-pw + 2.5, -ph + 2.5], [pw - 2.5, -ph + 2.5], [-pw + 2.5, ph - 2.5], [pw - 2.5, ph - 2.5]] as const) rivet(c, x, y, 0.85);
  bolt(c, 0, 0, 2.6, 0.12);
  c.fillStyle = sphere(c, 0, 0, 1.3, IRON);
  c.beginPath();
  c.arc(0, 0, 1.3, 0, TAU);
  c.fill();
}

// ------------------------------------------------------------------ the head

/** The head's outline: a stuffed sack, a little lumpy, gathered in at the bottom where it is tied on. */
function headPath(c: Ctx): void {
  const r = DUMMY_JOINTS.headRadius;
  c.beginPath();
  c.moveTo(0, -r);
  c.bezierCurveTo(r * 0.62, -r * 1.02, r * 1.04, -r * 0.62, r * 0.99, -r * 0.05);
  c.bezierCurveTo(r * 0.98, r * 0.42, r * 0.7, r * 0.78, r * 0.3, r * 0.92);
  c.quadraticCurveTo(0, r * 0.98, -r * 0.3, r * 0.92);
  c.bezierCurveTo(-r * 0.72, r * 0.8, -r * 1.02, r * 0.4, -r * 1.0, -r * 0.08);
  c.bezierCurveTo(-r * 0.98, -r * 0.64, -r * 0.6, -r * 1.0, 0, -r);
  c.closePath();
}

/** The leather cap sewn over the crown, from one side of the head to the other. */
const CAP = { x0: -0.86, y0: -0.4, c0x: -0.6, c0y: -1.12, c1x: 0.6, c1y: -1.12, x1: 0.88, y1: -0.42, under: -0.56 } as const;

/** The sack's half-width at height y (a little flattened ball), for its seams. */
function headHalf(y: number): number {
  const r = DUMMY_JOINTS.headRadius;
  const t = Math.min(1, Math.abs(y) / r);
  return r * 0.99 * Math.sqrt(Math.max(0, 1 - t * t)) * (y > 0 ? 1 - 0.18 * t : 1);
}

/** A seam of the sack, `phi` radians round from the front: crown to neck. */
function headSeam(phi: number, y0: number, y1: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= 16; i++) {
    const y = y0 + ((y1 - y0) * i) / 16;
    pts.push(headHalf(y) * Math.sin(phi), y);
  }
  return pts;
}

function paintHead(c: Ctx, tile: Tile): void {
  const r = DUMMY_JOINTS.headRadius;
  const K = CAP;
  headPath(c);
  c.fillStyle = sphere(c, 0, -2, r, CANVAS);
  c.fill();
  c.save();
  headPath(c);
  c.clip();
  weave(c, -r, -r, r, r, 1.9, PAL.canvasDeep, 0.22, 251);
  grain(c, tile, 0.22, 1, 0, -r, -r, r, r);
  // Sewn from gores: each panel stuffed full between its seams, lit across its swell.
  const seams = [-1.48, -0.36, 0.86];
  const mids = [-0.92, 0.25, 1.35];
  for (const phi of mids) {
    const x = headHalf(4) * Math.sin(phi);
    const w = Math.max(6, headHalf(4) * Math.cos(phi) * 0.75);
    const lit = 0.5 - 0.5 * Math.sin(phi);
    c.fillStyle = rad(c, x - w * 0.3, -8, 1, x, 2, w * 1.4, [[0, `rgba(255,232,190,${(0.14 + 0.2 * lit).toFixed(3)})`], [0.55, 'rgba(255,232,190,0)'], [1, 'rgba(20,12,4,0.3)']]);
    c.fillRect(x - w * 1.5, -r, w * 3, r * 2);
  }
  // Old grime low on the sack where hands have held it. (No spots or rings on its front: anything
  // round there would start to read as a feature.)
  c.fillStyle = lin(c, 0, r * 0.2, 0, r, [[0, 'rgba(40,28,12,0)'], [1, 'rgba(40,28,12,0.4)']]);
  c.fillRect(-r, r * 0.2, r * 2, r * 0.8);
  c.save();
  c.lineCap = 'round';
  c.strokeStyle = 'rgba(40,28,12,0.55)';
  c.lineWidth = 1.1;
  c.beginPath();
  for (const phi of seams) addLine(c, headSeam(phi, -r * 0.62, r * 0.86));
  c.stroke();
  c.restore();
  for (const phi of seams) stitches(c, headSeam(phi, -r * 0.6, r * 0.84), 3.2, 1.6, 0.36);
  // A patch sewn over a split, on the side away from the candle, round toward the back.
  c.save();
  c.translate(r * 0.7, r * 0.26);
  c.rotate(0.62);
  c.scale(0.55, 1);
  roundRectPath(c, -4.6, -3.6, 9.2, 7.2, 1.6);
  c.fillStyle = 'rgba(92,76,50,0.55)';
  c.fill();
  c.strokeStyle = 'rgba(30,20,8,0.5)';
  c.lineWidth = 0.4;
  c.stroke();
  c.strokeStyle = 'rgba(214,196,160,0.4)';
  c.lineWidth = 0.3;
  c.beginPath();
  for (let i = -3.6; i <= 3.6; i += 1.8) {
    c.moveTo(i, -4.3);
    c.lineTo(i + 0.7, -2.9);
    c.moveTo(i, 4.3);
    c.lineTo(i + 0.7, 2.9);
  }
  c.stroke();
  c.restore();
  // A cap of leather sewn over the crown, where the hits land, scorched where one did.
  const capPath = () => {
    c.beginPath();
    c.moveTo(K.x0 * r, K.y0 * r);
    c.bezierCurveTo(K.c0x * r, K.c0y * r, K.c1x * r, K.c1y * r, K.x1 * r, K.y1 * r);
    c.bezierCurveTo(r * 0.5, K.under * r, -r * 0.5, K.under * r, K.x0 * r, K.y0 * r);
    c.closePath();
  };
  c.save();
  c.translate(0.6, 1.2);
  capPath();
  c.fillStyle = 'rgba(10,6,2,0.45)';
  c.fill();
  c.restore();
  capPath();
  c.fillStyle = sphere(c, -4, -r * 0.7, r * 0.9, LEATHER);
  c.fill();
  c.save();
  capPath();
  c.clip();
  grain(c, tile, 0.3, 1, 0, -r, -r, r, -r * 0.3);
  speckle(c, -r, -r, r, -r * 0.3, 254, 120, ['#2A170A', '#8E6440'], 0.2, 0.45, 0.3);
  // A seam over the top of the cap, and its tooled edge.
  c.strokeStyle = 'rgba(14,8,4,0.55)';
  c.lineWidth = 0.6;
  c.beginPath();
  c.moveTo(-r * 0.12, -r * 1.02);
  c.quadraticCurveTo(-r * 0.04, -r * 0.8, r * 0.04, -r * 0.55);
  c.stroke();
  scorch(c, r * 0.36, -r * 0.66, 6.5, 255);
  c.restore();
  capPath();
  c.strokeStyle = 'rgba(16,8,3,0.85)';
  c.lineWidth = 0.6;
  c.stroke();
  // Light and shade over the whole sack.
  c.fillStyle = rad(c, -10, -10, r * 0.3, 0, 0, r * 1.05, [[0, 'rgba(10,6,4,0)'], [0.7, 'rgba(10,6,4,0.2)'], [1, 'rgba(10,6,4,0.55)']]);
  c.fillRect(-r, -r, r * 2, r * 2);
  c.fillStyle = lin(c, -r, 0, r, 0, [[0.4, 'rgba(8,6,12,0)'], [0.88, 'rgba(8,6,12,0.32)'], [1, 'rgba(8,6,12,0.18)']]);
  c.fillRect(-r, -r, r * 2, r * 2);
  // Gathered in at the neck: folds drawn in toward the tie.
  c.strokeStyle = 'rgba(30,20,8,0.4)';
  c.lineWidth = 0.5;
  c.beginPath();
  for (let i = -4; i <= 4; i++) {
    const x = i * 3.4;
    c.moveTo(x * 1.25, r * 0.6);
    c.quadraticCurveTo(x * 0.9, r * 0.76, x * 0.42, r * 0.88);
  }
  c.stroke();
  c.restore();
  headPath(c);
  edgeLight(c, -r, r, 1.5, 0.35, 0.4);
  // The cap's stitched lower edge.
  const cap: number[] = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const u = 1 - t;
    cap.push(r * (K.x1 * u * u * u + 0.5 * 3 * u * u * t - 0.5 * 3 * u * t * t + K.x0 * t * t * t),
      r * (K.y1 * u * u * u + K.under * 3 * u * u * t + K.under * 3 * u * t * t + K.y0 * t * t * t));
  }
  stitches(c, cap, 2.6, 1.6, 0.42);
  const capIn = cap.map((v, i) => (i % 2 === 1 ? v - 1.6 : v * 0.97));
  c.strokeStyle = 'rgba(12,6,2,0.45)';
  c.lineWidth = 0.35;
  c.beginPath();
  addLine(c, capIn);
  c.stroke();
  headPath(c);
  c.strokeStyle = 'rgba(16,10,4,0.82)';
  c.lineWidth = 0.9;
  c.stroke();
  // Tied on at the neck with a cord wound three times and knotted, the straw stuffing showing below.
  straw(c, -8, r * 0.88, Math.PI * 0.62, 11, 9, 252);
  straw(c, 7, r * 0.88, Math.PI * 0.4, 9, 8, 253);
  for (let i = 0; i < 3; i++) {
    const y = r * 0.84 + i * 1.75;
    const rx = r * (0.33 - i * 0.012);
    c.lineWidth = 1.7;
    c.strokeStyle = lin(c, -rx, 0, rx, 0, [[0, '#D2B474'], [0.45, '#9A7A46'], [1, '#4A361C']]);
    c.beginPath();
    c.ellipse(0, y, rx, 1.9, 0, 0.12, Math.PI - 0.12);
    c.stroke();
    // The twist of the cord.
    c.strokeStyle = 'rgba(50,32,12,0.6)';
    c.lineWidth = 0.3;
    c.beginPath();
    for (let a = 0.25; a < Math.PI - 0.2; a += 0.17) {
      const x = Math.cos(a) * rx;
      const yy = y + Math.sin(a) * 1.9;
      c.moveTo(x - 0.5, yy - 0.75);
      c.lineTo(x + 0.4, yy + 0.75);
    }
    c.stroke();
  }
  // The knot and its two ends hanging on the candle's side.
  c.fillStyle = sphere(c, -r * 0.3, r * 0.92, 1.8, { deep: '#3A2810', dark: '#5E4420', mid: '#8E7040', light: '#C8A86A', shine: '#E8D4A0', rim: '#6A6050' });
  c.beginPath();
  c.arc(-r * 0.3, r * 0.92, 1.8, 0, TAU);
  c.fill();
  c.strokeStyle = '#8E7040';
  c.lineWidth = 0.9;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(-r * 0.3, r * 0.95);
  c.quadraticCurveTo(-r * 0.36, r * 1.02, -r * 0.33, r * 1.1);
  c.moveTo(-r * 0.29, r * 0.96);
  c.quadraticCurveTo(-r * 0.24, r * 1.03, -r * 0.27, r * 1.09);
  c.stroke();
}

// ------------------------------------------------------------------ the wand

function paintWand(c: Ctx, tile: Tile): void {
  // A wooden wand: origin at the grip, pointing up. A carved handle with a spiral groove, a bone ring
  // and a pommel, a shaft tapering to a pale tip, lit down its left side.
  const L = DUMMY_JOINTS.wandLength;
  const g = DUMMY_JOINTS.wandHalf;
  const shaft = () => {
    c.beginPath();
    c.moveTo(-g, 8);
    c.lineTo(-g * 0.95, -16);
    c.lineTo(-1.2, -L + 2);
    c.quadraticCurveTo(0, -L - 0.8, 1.2, -L + 2);
    c.lineTo(g * 0.95, -16);
    c.lineTo(g, 8);
    c.closePath();
  };
  shaft();
  c.fillStyle = lin(c, -g, 0, g, 0, [[0, '#E2C495'], [0.3, '#B88A5A'], [0.7, '#7A5230'], [1, '#3E2410']]);
  c.fill();
  c.save();
  shaft();
  c.clip();
  grain(c, tile, 0.2, 12, Math.PI / 2, -g, -L, g, 10);
  c.strokeStyle = 'rgba(60,34,14,0.35)';
  c.lineWidth = 0.3;
  c.beginPath();
  c.moveTo(-0.9, -18);
  c.quadraticCurveTo(-0.4, -46, -0.5, -L + 6);
  c.stroke();
  // The handle, darker, carved in a spiral.
  c.fillStyle = lin(c, -g, 0, g, 0, [[0, '#8A5E36'], [0.35, '#5E3C1E'], [1, '#26160A']]);
  c.fillRect(-g - 1, -15, g * 2 + 2, 25);
  c.strokeStyle = 'rgba(16,8,2,0.85)';
  c.lineWidth = 0.6;
  c.beginPath();
  for (let y = 8; y > -14; y -= 2.6) {
    c.moveTo(-g, y + 1.3);
    c.lineTo(g, y - 1.3);
  }
  c.stroke();
  c.strokeStyle = 'rgba(255,220,170,0.32)';
  c.lineWidth = 0.4;
  c.beginPath();
  for (let y = 8.8; y > -13; y -= 2.6) {
    c.moveTo(-g, y + 1.3);
    c.lineTo(-0.4, y + 0.2);
  }
  c.stroke();
  // A ring of bone where the handle meets the shaft.
  c.fillStyle = lin(c, -g, 0, g, 0, [[0, '#FFF6E0'], [0.35, '#E6D9BC'], [1, '#8E826C']]);
  c.fillRect(-g - 1, -17, g * 2 + 2, 2.2);
  c.strokeStyle = 'rgba(255,240,210,0.55)';
  c.lineWidth = 0.6;
  c.beginPath();
  c.moveTo(-g * 0.5, -18);
  c.lineTo(-0.5, -L + 6);
  c.stroke();
  c.restore();
  shaft();
  c.strokeStyle = 'rgba(16,8,2,0.92)';
  c.lineWidth = 0.7;
  c.stroke();
  // The pale tip.
  c.beginPath();
  c.moveTo(-1.4, -L + 7);
  c.lineTo(-1.2, -L + 2);
  c.quadraticCurveTo(0, -L - 0.8, 1.2, -L + 2);
  c.lineTo(1.4, -L + 7);
  c.closePath();
  c.fillStyle = '#F1E6CC';
  c.fill();
  // Pommel.
  c.fillStyle = sphere(c, 0, 10, 4.2, { deep: '#1E1006', dark: '#3E2410', mid: '#6A4426', light: '#9A6E44', shine: '#E0C090', rim: '#5A4A40' });
  c.beginPath();
  c.arc(0, 10, 4.2, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = 'rgba(16,8,2,0.85)';
  c.lineWidth = 0.6;
  c.stroke();
}

// ------------------------------------------------------------------ costumes and chalk

function paintHat(c: Ctx, tile: Tile): void {
  // A paper party hat, origin at the crown; tilted so it sits jauntily. Card printed in stripes with
  // little gilt stars, rolled into a cone and glued down a seam, a gold-foil zigzag round the brim and
  // a tissue pom-pom on top.
  const cone = () => {
    c.beginPath();
    c.moveTo(-19, 2);
    c.lineTo(9, -56);
    c.lineTo(19, 2);
    c.ellipse(0, 2, 19, 4.5, 0, 0, Math.PI, false);
    c.closePath();
  };
  cone();
  c.fillStyle = '#D9A93C';
  c.fill();
  c.save();
  cone();
  c.clip();
  c.fillStyle = '#7E1F2E';
  for (let k = -10; k < 10; k++) {
    c.beginPath();
    c.moveTo(-30 + k * 12, 10);
    c.lineTo(-24 + k * 12, 10);
    c.lineTo(20 + k * 12, -62);
    c.lineTo(14 + k * 12, -62);
    c.closePath();
    c.fill();
  }
  // Gilt stars printed down the gold stripes.
  c.fillStyle = 'rgba(255,240,190,0.75)';
  c.beginPath();
  for (let k = -4; k < 5; k++) {
    for (let j = 0; j < 8; j++) {
      // Down the middle of the k-th gold stripe, which runs from (-21 + 12k, 10) up to (23 + 12k, -62).
      const u = 0.06 + j * 0.12;
      const x = -21 + k * 12 + 44 * u;
      const y = 10 - 72 * u;
      for (let p = 0; p <= 8; p++) {
        const a = (p / 8) * TAU - Math.PI / 2;
        const rr = p % 2 === 0 ? 1.15 : 0.42;
        if (p === 0) c.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        else c.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
    }
  }
  c.fill();
  grain(c, tile, 0.2, 1, 0, -20, -60, 20, 8);
  c.fillStyle = cylinder(c, -19, 19, {
    deep: 'rgba(0,0,0,0.55)', dark: 'rgba(0,0,0,0.36)', mid: 'rgba(0,0,0,0.1)', light: 'rgba(255,236,200,0.16)',
    shine: 'rgba(255,240,210,0.36)', rim: 'rgba(150,170,210,0.24)',
  });
  c.fillRect(-20, -60, 40, 66);
  // The glued seam where the card overlaps itself: a lip with a shadow under it.
  c.strokeStyle = 'rgba(30,8,4,0.4)';
  c.lineWidth = 0.7;
  c.beginPath();
  c.moveTo(12.6, 6.4);
  c.lineTo(9.4, -54);
  c.stroke();
  c.strokeStyle = 'rgba(255,230,190,0.12)';
  c.lineWidth = 0.3;
  c.beginPath();
  c.moveTo(12.1, 6.4);
  c.lineTo(9.15, -54);
  c.stroke();
  c.restore();
  cone();
  c.strokeStyle = 'rgba(60,20,10,0.6)';
  c.lineWidth = 0.6;
  c.stroke();
  // The gold-foil zigzag along the brim.
  const zig = () => {
    c.beginPath();
    for (let i = 0; i <= 16; i++) {
      const a = Math.PI - (i / 16) * Math.PI;
      const rr = i % 2 === 0 ? 1 : 0.88;
      const x = Math.cos(a) * 19.5;
      const y = 2 + Math.sin(a) * 4.8 * rr - (i % 2 === 0 ? 0 : 2.6);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
  };
  zig();
  c.lineJoin = 'round';
  c.strokeStyle = 'rgba(40,20,4,0.6)';
  c.lineWidth = 2;
  c.stroke();
  c.strokeStyle = lin(c, -19, 0, 19, 0, [[0, PAL.goldLight], [0.2, '#FFF3CF'], [0.45, PAL.gold], [0.8, PAL.goldDark], [1, PAL.goldRecess]]);
  c.lineWidth = 1.3;
  c.stroke();
  // Pom-pom: a burst of cut tissue round a tight core.
  const r = rng(81);
  c.lineCap = 'round';
  for (const [color, width, n] of [['#B8AE96', 0.7, 26], ['#E9DFC7', 0.6, 30], ['#FFFBEF', 0.45, 22]] as const) {
    c.strokeStyle = color;
    c.lineWidth = width;
    c.beginPath();
    for (let i = 0; i < n; i++) {
      const a = r() * TAU;
      const l = 4.4 + r() * 2.4;
      const sx = 9 + (r() - 0.5) * 2;
      const sy = -57 + (r() - 0.5) * 2;
      // The candle side is the lit side: the strands there are drawn last and brightest.
      const lean = color === '#FFFBEF' ? Math.PI + (r() - 0.5) * 2.2 : a;
      c.moveTo(sx, sy);
      c.lineTo(sx + Math.cos(lean) * l, sy + Math.sin(lean) * l);
    }
    c.stroke();
  }
  c.fillStyle = sphere(c, 9, -57, 3.4, { deep: '#9F9580', dark: '#C9BFA6', mid: PAL.vellum, light: '#F7F1E2', shine: '#FFFFFF', rim: '#B8BCC8' });
  c.beginPath();
  c.arc(9, -57, 3.4, 0, Math.PI * 2);
  c.fill();
  // The thin elastic looping under the head (the head's centre is a radius below the crown).
  const k = DUMMY_JOINTS.headRadius / COSTUME_SCALE;
  c.strokeStyle = 'rgba(244,236,218,0.75)';
  c.lineWidth = 0.6;
  c.beginPath();
  c.moveTo(-17, 4);
  c.bezierCurveTo(-30, k * 0.9, -22, k * 1.95, 0, k * 2 + 0.5);
  c.bezierCurveTo(22, k * 1.95, 30, k * 0.9, 17, 4);
  c.stroke();
}

function paintRuff(c: Ctx, tile: Tile): void {
  // A starched linen ruff, origin at the neck: a ring of rounded pleats, each lit on its candle side
  // and shadowed in the folds between, edged with a little lace; the back half behind the neck in
  // shade, the front half nearer and brighter.
  const n = 26;
  const rx = 44;
  const ry = 12;
  const lobe = (i: number) => {
    const a0 = (i / n) * TAU;
    const a1 = ((i + 0.5) / n) * TAU;
    const a2 = ((i + 1) / n) * TAU;
    c.beginPath();
    c.moveTo(Math.cos(a0) * 12.5, Math.sin(a0) * 3.8);
    c.lineTo(Math.cos(a0) * rx * 0.94, Math.sin(a0) * ry * 0.94);
    c.quadraticCurveTo(Math.cos(a1) * rx * 1.1, Math.sin(a1) * ry * 1.14, Math.cos(a2) * rx * 0.94, Math.sin(a2) * ry * 0.94);
    c.lineTo(Math.cos(a2) * 12.5, Math.sin(a2) * 3.8);
    c.closePath();
  };
  // Back pleats first (behind the neck), then the front ones over them.
  const order: number[] = [];
  for (let i = 0; i < n; i++) if (Math.sin(((i + 0.5) / n) * TAU) < 0) order.push(i);
  for (let i = 0; i < n; i++) if (Math.sin(((i + 0.5) / n) * TAU) >= 0) order.push(i);
  for (const i of order) {
    const a0 = (i / n) * TAU;
    const a2 = ((i + 1) / n) * TAU;
    const am = ((i + 0.5) / n) * TAU;
    const front = Math.sin(am) >= 0;
    // Lit toward the candle (the left), so each pleat's left edge is brighter on that side.
    const toward = 0.5 - 0.5 * Math.cos(am);
    const hi = front ? 0.95 - 0.25 * (1 - toward) : 0.7 - 0.25 * (1 - toward);
    const lo = hi - 0.32;
    // Across the pleat from its edge nearer the candle (the left) to the other.
    const ea = [Math.cos(a0) * rx * 0.9, Math.sin(a0) * ry * 0.9] as const;
    const eb = [Math.cos(a2) * rx * 0.9, Math.sin(a2) * ry * 0.9] as const;
    const [l, rt] = ea[0] <= eb[0] ? [ea, eb] : [eb, ea];
    const linen = ['#6E6656', '#9C927C', '#C6BCA8', '#EDE6D6', '#FFFDF6'];
    lobe(i);
    c.fillStyle = lin(c, l[0], l[1], rt[0], rt[1], [[0, ramp(linen, hi)], [0.45, ramp(linen, hi - 0.08)], [0.85, ramp(linen, lo)], [1, ramp(linen, lo - 0.12)]]);
    c.fill();
    c.strokeStyle = 'rgba(90,80,64,0.55)';
    c.lineWidth = 0.4;
    c.stroke();
  }
  // The linen's weave, inside the ruff's scalloped outline only.
  c.save();
  c.beginPath();
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * TAU;
    const a1 = ((i + 0.5) / n) * TAU;
    const a2 = ((i + 1) / n) * TAU;
    if (i === 0) c.moveTo(Math.cos(a0) * rx * 0.94, Math.sin(a0) * ry * 0.94);
    c.quadraticCurveTo(Math.cos(a1) * rx * 1.1, Math.sin(a1) * ry * 1.14, Math.cos(a2) * rx * 0.94, Math.sin(a2) * ry * 0.94);
  }
  c.closePath();
  c.clip();
  grain(c, tile, 0.14, 1, 0, -rx * 1.12, -ry * 1.2, rx * 1.12, ry * 1.2);
  c.restore();
  // Lace along the front edge: a row of little loops.
  c.strokeStyle = 'rgba(255,253,246,0.85)';
  c.lineWidth = 0.35;
  c.beginPath();
  for (let k = 0; k <= 60; k++) {
    const a = (k / 60) * Math.PI;
    const x = Math.cos(a) * rx * 1.02;
    const y = Math.sin(a) * ry * 1.05 + 0.4;
    c.moveTo(x + 0.6, y);
    c.arc(x, y, 0.6, 0, Math.PI);
  }
  c.stroke();
  ellipsePath(c, 0, -0.5, 13, 4);
  c.fillStyle = 'rgba(40,30,18,0.65)';
  c.fill();
}

function paintBow(c: Ctx, tile: Tile): void {
  // A polka-dot satin bow, origin at the neck: two tails hanging behind, two loops gathered into
  // folds at a wrapped knot, the satin's sheen running along the folds and the dots dipping into them.
  const tail = (s: number) => {
    c.beginPath();
    c.moveTo(s * 1.5, 2);
    c.quadraticCurveTo(s * 6, 6, s * 9.5, 12.5);
    c.lineTo(s * 7, 11.6);
    c.lineTo(s * 5.2, 13.6);
    c.quadraticCurveTo(s * 3, 8, -s * 1.5, 4);
    c.closePath();
  };
  for (const s of [-1, 1]) {
    tail(s);
    c.fillStyle = lin(c, 0, 2, 0, 14, [[0, '#8E1C2C'], [1, '#4E0A16']]);
    c.fill();
    c.strokeStyle = 'rgba(40,4,10,0.7)';
    c.lineWidth = 0.5;
    c.stroke();
  }
  const wing = (s: number) => {
    c.beginPath();
    c.moveTo(s * 3, -3);
    c.bezierCurveTo(s * 14, -15, s * 30, -15, s * 31, -2);
    c.bezierCurveTo(s * 32, 10, s * 16, 13, s * 3, 3);
    c.closePath();
  };
  for (const s of [-1, 1]) {
    wing(s);
    c.fillStyle = lin(c, 0, -13, 0, 12, [[0, '#C23448'], [0.6, '#9E2234'], [1, '#64101E']]);
    c.fill();
    c.save();
    wing(s);
    c.clip();
    c.fillStyle = '#EFE3C8';
    for (let y = -12; y <= 12; y += 6) {
      for (let x = -32; x <= 32; x += 7) {
        c.beginPath();
        c.arc(x + ((y / 6) % 2 ? 3.5 : 0), y, 1.7, 0, Math.PI * 2);
        c.fill();
      }
    }
    grain(c, tile, 0.12, 6, 0, -33, -15, 33, 13);
    // The folds, gathered in toward the knot: a shadow in each, the satin's sheen on each crest.
    for (const [y0, y1, dark] of [[-2.5, -9.5, true], [-0.6, -3.4, false], [1.2, 6.5, true], [-4.6, -12.5, false]] as const) {
      c.strokeStyle = dark ? 'rgba(50,4,12,0.42)' : 'rgba(255,214,214,0.32)';
      c.lineWidth = dark ? 2.2 : 1.3;
      c.beginPath();
      c.moveTo(s * 4, y0 * 0.4);
      c.quadraticCurveTo(s * 16, y0 + (y1 - y0) * 0.35, s * 29, y1);
      c.stroke();
    }
    // The loop turns away from the candle on the right: darker there, a cool rim at its far edge.
    c.fillStyle = lin(c, -32, 0, 32, 0, [[0, 'rgba(255,220,200,0.12)'], [0.4, 'rgba(0,0,0,0)'], [0.85, 'rgba(10,0,4,0.32)'], [1, 'rgba(120,130,170,0.18)']]);
    c.fillRect(-33, -15, 66, 28);
    c.restore();
    wing(s);
    c.strokeStyle = 'rgba(60,8,16,0.7)';
    c.lineWidth = 0.6;
    c.stroke();
  }
  // The knot: a band of the same satin wrapped round, creased where it is pulled tight.
  roundRectPath(c, -4.6, -6, 9.2, 12, 3);
  c.fillStyle = lin(c, -4.6, 0, 4.6, 0, [[0, '#C23448'], [0.3, '#A62638'], [0.65, '#7E1726'], [1, '#4E0A16']]);
  c.fill();
  c.strokeStyle = 'rgba(60,8,16,0.75)';
  c.lineWidth = 0.6;
  c.stroke();
  c.strokeStyle = 'rgba(40,2,8,0.5)';
  c.lineWidth = 0.45;
  c.beginPath();
  c.moveTo(-3.4, -4.2);
  c.quadraticCurveTo(-1, -1, -3.2, 4.4);
  c.moveTo(2.6, -4.6);
  c.quadraticCurveTo(0.8, 0, 2.8, 4.6);
  c.stroke();
  c.strokeStyle = 'rgba(255,214,214,0.4)';
  c.lineWidth = 0.6;
  c.beginPath();
  c.moveTo(-2.6, -5);
  c.quadraticCurveTo(-1.6, 0, -2.4, 4.8);
  c.stroke();
}

function paintChalk(c: Ctx): void {
  // Someone has kept score in chalk: a tally of hits with a stroke through four of them, a little star
  // beside it, and a scrawled cross on the target. Rough, doubled strokes, as chalk leaves them.
  // Positions are relative to DUMMY_JOINTS.chest.
  const r = rng(91);
  const J = DUMMY_JOINTS;
  c.lineCap = 'round';
  const mark = (x0: number, y0: number, x1: number, y1: number) => {
    for (let pass = 0; pass < 2; pass++) {
      c.lineWidth = pass === 0 ? 3.2 : 1.4;
      c.strokeStyle = pass === 0 ? 'rgba(242,244,248,0.2)' : 'rgba(242,244,248,0.92)';
      c.beginPath();
      c.moveTo(x0 + (r() - 0.5) * 0.6, y0 + (r() - 0.5) * 0.6);
      c.quadraticCurveTo((x0 + x1) / 2 + (r() - 0.5) * 1.4, (y0 + y1) / 2, x1 + (r() - 0.5) * 0.6, y1 + (r() - 0.5) * 0.6);
      c.stroke();
    }
  };
  // The tally, beside the target on the right (the arms hide the chest above it).
  for (let i = 0; i < 4; i++) mark(29 + i * 4.4, -11, 28 + i * 4.4, 3);
  mark(26.5, 1, 45, -9);
  mark(47.5, -11, 47, 3);
  // A five-pointed star drawn in one stroke, low and to the left, above the belt.
  const pts: number[] = [];
  for (let i = 0; i <= 5; i++) {
    const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
    pts.push(-39 + Math.cos(a) * 7, 21 + Math.sin(a) * 7);
  }
  for (let i = 2; i < pts.length; i += 2) mark(pts[i - 2], pts[i - 1], pts[i], pts[i + 1]);
  // A cross on the target's heart.
  const tx = TARGET.x - J.chest.x;
  const ty = TARGET.y - J.chest.y;
  mark(tx - 5, ty - 5, tx + 5, ty + 5);
  mark(tx + 5, ty - 5, tx - 5, ty + 5);
}
