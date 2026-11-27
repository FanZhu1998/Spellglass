// The plant: a curious original plant in a glazed earthenware pot. The pot is round-bellied, glazed a
// deep green that has run in drips toward its unglazed foot, with a painted band of ochre slip round
// its shoulder and a little moss over the rim. From the moss rise arching fronds whose tips are still
// curled into spirals, two young croziers, and an arching stem hung with pale bell-shaped flowers.
// Hidden detail (Revelio): a tiny brass key lying on the shelf, its bit under the pot and its bow
// peeking out. It is drawn at the pot's home before the pot, so the pot hides its bit, and it stays on
// the shelf when the plant flies off. Coordinates in mH, origin at the middle of the pot's base (the key
// sprites: the pot's home on the shelf line).

import { paintSprite, type CanvasFactory, type Sprite } from './canvas';
import { paintHeap, type Solid } from './common';
import {
  GLAZE, PAL, TERRACOTTA, bandPath, cylinder, edgeLight, ellipsePath, grain, lin, noiseTile, rad, rivet, rng, speckle, type Ctx,
} from './paint';

export const PLANT_DUST = '#7A4A2E';
export const LEAF_DUST = '#3F6A4C';

export interface PlantArt {
  body: Sprite;
  /** The key draws itself before the pot (see the plant), not as ink over the body. */
  ink: null;
  /** The key as a brass object (shade layer) and its glow (light layer). */
  key: Sprite;
  hidden: Sprite;
  heap: Sprite;
}

/** The key's bow, where Revelio's halo and glint sit (relative to the pot's home on the shelf). */
export const PLANT_SECRET = { x: 70, y: -4.5, halo: 56 } as const;

const KEY_BOX = { x0: 18, y0: -14, x1: 80, y1: 3 };

/** The pot's profile: half-widths at heights (from its foot up to the rim). */
const POT = { footY: -7, footRx: 36, bellyY: -42, bellyRx: 52, neckY: -80, neckRx: 44, rimY: -88, rimRx: 51, rimTop: -96 } as const;

/** Roughly where the pot and the plant are (common.ts Solid), for cutting Reducto's pieces: the pot's
 *  outline, and the fronds and bells above it. */
export const PLANT_SOLID: readonly Solid[] = (() => {
  const pot: number[] = [];
  for (let y = POT.rimTop; y <= POT.footY; y += 4) pot.push(-(y < POT.rimY ? POT.rimRx : potHalf(y)), y);
  pot.push(-POT.footRx, 0, POT.footRx, 0);
  for (let y = POT.footY; y >= POT.rimTop; y -= 4) pot.push(y < POT.rimY ? POT.rimRx : potHalf(y), y);
  return [{ poly: pot }, { ellipse: [0, -160, 80, 70] }];
})();

/** Where the glaze stops running toward the foot. */
const GLAZE_EDGE = -16;
const SOIL_Y = POT.rimTop + 1;

export function buildPlantArt(factory: CanvasFactory, res: number): PlantArt | null {
  const tile = noiseTile(factory);
  const body = paintSprite(factory, res, { x0: -92, y0: -232, x1: 92, y1: 1 }, (c) => paintPlant(c, tile));
  const key = paintSprite(factory, res, KEY_BOX, paintKey);
  const hidden = paintSprite(factory, res, KEY_BOX, paintKeyGlow);
  const heap = paintHeap(factory, res, 96, PLANT_DUST, 53);
  if (!body || !key || !hidden || !heap) return null;
  return { body, ink: null, key, hidden, heap };
}

type Tile = ReturnType<typeof noiseTile>;

/** The pot's half-width at height y. */
function potHalf(y: number): number {
  const P = POT;
  if (y >= P.bellyY) {
    const u = (y - P.bellyY) / (P.footY - P.bellyY);
    return P.bellyRx - (P.bellyRx - P.footRx) * u * u;
  }
  const u = (P.bellyY - y) / (P.bellyY - P.neckY);
  return P.bellyRx - (P.bellyRx - P.neckRx) * Math.sin((u * Math.PI) / 2);
}

function potPath(c: Ctx): void {
  const P = POT;
  c.beginPath();
  c.moveTo(-P.footRx, P.footY);
  for (let y = P.footY - 3; y >= P.neckY; y -= 3) c.lineTo(-potHalf(y), y);
  c.lineTo(P.neckRx, P.neckY);
  for (let y = P.neckY + 3; y <= P.footY; y += 3) c.lineTo(potHalf(y), y);
  c.ellipse(0, P.footY, P.footRx, 6.5, 0, 0, Math.PI, false);
  c.closePath();
}

/** The glaze covers the pot down to a wavering edge with drips hanging from it. */
function glazePath(c: Ctx): void {
  const P = POT;
  const r = rng(71);
  c.beginPath();
  c.moveTo(-potHalf(P.neckY) - 1, P.neckY);
  c.lineTo(potHalf(P.neckY) + 1, P.neckY);
  for (let y = P.neckY; y <= GLAZE_EDGE; y += 3) c.lineTo(potHalf(y) + 0.5, y);
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const x = potHalf(GLAZE_EDGE) * (1 - 2 * u);
    const drip = i % 3 === 1 ? 4 + r() * 5 : r() * 2;
    c.lineTo(x, GLAZE_EDGE + 6.5 * Math.sin(Math.PI * u) + drip);
  }
  for (let y = GLAZE_EDGE; y >= P.neckY; y -= 3) c.lineTo(-potHalf(y) - 0.5, y);
  c.closePath();
}

function paintPot(c: Ctx, tile: Tile): void {
  const P = POT;
  // The body: unglazed terracotta first (it shows at the foot), then the glaze over it.
  potPath(c);
  c.fillStyle = cylinder(c, -P.bellyRx, P.bellyRx, TERRACOTTA);
  c.fill();
  c.save();
  potPath(c);
  c.clip();
  speckle(c, -P.bellyRx, GLAZE_EDGE - 4, P.bellyRx, 0, 61, 140, ['#2A1207', '#C98A60'], 0.25, 0.7, 0.4);
  grain(c, tile, 0.3, 1, 0, -P.bellyRx, P.neckY, P.bellyRx, 0);
  glazePath(c);
  c.fillStyle = cylinder(c, -P.bellyRx, P.bellyRx, GLAZE, 1);
  c.fill();
  c.save();
  glazePath(c);
  c.clip();
  // Glaze pools darker toward the foot, where it ran thick before it set.
  c.fillStyle = lin(c, 0, -40, 0, GLAZE_EDGE + 10, [[0, 'rgba(6,14,10,0)'], [1, 'rgba(6,14,10,0.6)']]);
  c.fillRect(-P.bellyRx, -40, P.bellyRx * 2, 60);
  paintBand(c);
  grain(c, tile, 0.14, 1, 0, -P.bellyRx, P.neckY, P.bellyRx, GLAZE_EDGE + 12);
  // A broad reflection of the candle in the glaze, and a sharp one.
  c.fillStyle = rad(c, -30, -52, 1, -30, -52, 22, [[0, 'rgba(255,230,190,0.28)'], [1, 'rgba(255,230,190,0)']]);
  c.fillRect(-56, -80, 50, 60);
  c.fillStyle = 'rgba(255,248,230,0.75)';
  c.beginPath();
  c.ellipse(-35, -56, 2.2, 7.5, 0.22, 0, Math.PI * 2);
  c.fill();
  c.restore();
  // The shadow the rim throws on the shoulder, and the dark where the pot meets the shelf.
  c.fillStyle = lin(c, 0, P.neckY, 0, P.neckY + 10, [[0, 'rgba(4,8,6,0.7)'], [1, 'rgba(4,8,6,0)']]);
  c.fillRect(-P.bellyRx, P.neckY, P.bellyRx * 2, 10);
  c.fillStyle = lin(c, 0, -10, 0, 1, [[0, 'rgba(8,4,2,0)'], [1, 'rgba(8,4,2,0.65)']]);
  c.fillRect(-P.bellyRx, -10, P.bellyRx * 2, 11);
  c.restore();
  potPath(c);
  edgeLight(c, -P.bellyRx, P.bellyRx, 1.3, 0.4, 0.35);
  potPath(c);
  c.strokeStyle = 'rgba(4,6,4,0.7)';
  c.lineWidth = 0.7;
  c.stroke();

  // The rolled rim, glazed, with a bright bead along its lit front.
  bandPath(c, P.rimTop + 4, P.rimRx, 9, P.rimY + 3, P.rimRx - 1, 8.5);
  c.fillStyle = cylinder(c, -P.rimRx, P.rimRx, GLAZE, 1);
  c.fill();
  c.strokeStyle = 'rgba(4,6,4,0.7)';
  c.lineWidth = 0.7;
  c.stroke();
  c.lineWidth = 1.1;
  c.strokeStyle = 'rgba(214,240,222,0.55)';
  c.beginPath();
  c.ellipse(0, P.rimTop + 6, P.rimRx - 1, 9, 0, Math.PI * 0.55, Math.PI * 0.9);
  c.stroke();
  ellipsePath(c, 0, P.rimTop + 4, P.rimRx, 9);
  c.fillStyle = lin(c, 0, P.rimTop - 5, 0, P.rimTop + 13, [[0, PAL.glazeDeep], [0.6, PAL.glaze], [1, PAL.glazeLight]]);
  c.fill();
  // Soil, and moss over it, spilling a little over the front of the rim on the left.
  ellipsePath(c, 0, SOIL_Y + 4, P.rimRx - 6, 6.6);
  c.fillStyle = rad(c, 0, SOIL_Y + 4, 2, 0, SOIL_Y + 4, 44, [[0, '#2A1C12'], [0.7, '#170F08'], [1, '#0A0604']]);
  c.fill();
  paintMoss(c);
}

/** A band of ochre slip round the shoulder with a running wave and dots in brown, under the glaze, so
 *  it is tinged green and glossed with it. */
function paintBand(c: Ctx): void {
  const top = -72;
  const bottom = -60;
  c.beginPath();
  c.moveTo(-potHalf(top), top);
  c.lineTo(potHalf(top), top);
  c.lineTo(potHalf(bottom), bottom);
  c.lineTo(-potHalf(bottom), bottom);
  c.closePath();
  c.fillStyle = lin(c, -POT.bellyRx, 0, POT.bellyRx, 0, [[0, '#7E7448'], [0.18, '#C9B27A'], [0.4, '#A8935E'], [0.75, '#4E4A2C'], [1, '#2E3420']]);
  c.fill();
  c.save();
  c.clip();
  c.strokeStyle = 'rgba(44,28,12,0.85)';
  c.lineWidth = 1.1;
  c.beginPath();
  for (let x = -56; x <= 56; x += 1.5) {
    // The wave narrows toward the sides as the pot turns away.
    const k = Math.sqrt(Math.max(0, 1 - (x / 54) ** 2));
    const y = (top + bottom) / 2 + Math.sin(x * 0.32) * 3 * k;
    if (x === -56) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.stroke();
  c.fillStyle = 'rgba(44,28,12,0.8)';
  for (let x = -46; x <= 46; x += 9.8) {
    const k = Math.sqrt(Math.max(0, 1 - (x / 54) ** 2));
    for (const s of [-1, 1]) {
      c.beginPath();
      c.ellipse(x + 4.9, (top + bottom) / 2 + s * 3.6 * k, 0.9 * k + 0.2, 0.9, 0, 0, Math.PI * 2);
      c.fill();
    }
  }
  c.restore();
  for (const y of [top, bottom]) {
    c.strokeStyle = 'rgba(30,20,8,0.6)';
    c.lineWidth = 0.7;
    c.beginPath();
    c.moveTo(-potHalf(y), y);
    c.lineTo(potHalf(y), y);
    c.stroke();
  }
}

function paintMoss(c: Ctx): void {
  const r = rng(91);
  const y = SOIL_Y + 3;
  // Cushions of moss: soft dark mounds with bright tips where the light catches.
  for (let i = 0; i < 16; i++) {
    const x = -40 + r() * 76;
    const rx = 5 + r() * 7;
    c.fillStyle = rad(c, x - 2, y - 3, 0.5, x, y, rx, [[0, '#7E9A44'], [0.5, PAL.moss], [1, 'rgba(30,44,18,0)']]);
    c.beginPath();
    c.ellipse(x, y + r() * 3, rx, rx * 0.5, 0, 0, Math.PI * 2);
    c.fill();
  }
  speckle(c, -42, y - 4, 38, y + 5, 92, 90, ['#A8C26A', '#2E4418', '#C8D88C'], 0.25, 0.7, 0.6);
  // A fringe of it over the rim at the front left.
  c.fillStyle = PAL.moss;
  for (let i = 0; i < 9; i++) {
    const x = -34 + i * 3.4 + r() * 1.5;
    const len = 3 + r() * 5;
    c.beginPath();
    c.ellipse(x, POT.rimTop + 13 + len * 0.4, 1.6, len * 0.6, 0, 0, Math.PI * 2);
    c.fill();
  }
  speckle(c, -36, POT.rimTop + 11, -4, POT.rimTop + 19, 93, 24, ['#9DB866', '#26380F'], 0.25, 0.6, 0.7);
}

interface Frond {
  /** Degrees from upright, positive to the right. */
  angle: number;
  /** Length along its rachis, and how hard it arches over. */
  len: number;
  bend: number;
  /** Where it leaves the moss. */
  sx: number;
  front: boolean;
  seed: number;
}

/** It leans toward the candle, as a plant on a sill leans to its window. */
const FRONDS: readonly Frond[] = [
  { angle: -56, len: 116, bend: -1.0, sx: -14, front: false, seed: 301 },
  { angle: 30, len: 100, bend: 0.95, sx: 10, front: false, seed: 302 },
  { angle: -20, len: 138, bend: -0.55, sx: -5, front: false, seed: 303 },
  { angle: -74, len: 94, bend: -1.3, sx: -18, front: true, seed: 304 },
  { angle: -4, len: 126, bend: -0.4, sx: 0, front: true, seed: 305 },
  { angle: 48, len: 88, bend: 1.15, sx: 14, front: true, seed: 306 },
];

/** A point and heading along a frond at u (0 base, 1 tip). */
function frondAt(f: Frond, u: number, out: { x: number; y: number; a: number }): void {
  const a0 = (f.angle * Math.PI) / 180;
  // The heading turns steadily as it arches; the curve is integrated in a few straight steps.
  let x = f.sx;
  let y = SOIL_Y + 2;
  const steps = 16;
  const n = Math.max(1, Math.round(steps * u));
  for (let i = 1; i <= n; i++) {
    const t = i / steps;
    const h = a0 + f.bend * t * t * 1.3;
    x += Math.sin(h) * (f.len / steps);
    y -= Math.cos(h) * (f.len / steps);
  }
  out.x = x;
  out.y = y;
  out.a = a0 + f.bend * u * u * 1.3;
}

function paintFrond(c: Ctx, f: Frond): void {
  const p = { x: 0, y: 0, a: 0 };
  const r = rng(f.seed);
  const dark = f.front ? PAL.frondDark : PAL.frondDeep;
  const mid = f.front ? PAL.frond : PAL.frondDark;
  const light = f.front ? PAL.frondLight : PAL.frond;
  // Leaflets along the rachis, a little staggered side to side and never quite alike: longest a third
  // of the way up, shrinking toward the curled tip.
  const pairs = 12;
  for (let i = 1; i < pairs; i++) {
    for (const s of [-1, 1]) {
      const u = (i + (s === 1 ? 0.35 : 0)) / pairs;
      frondAt(f, u * 0.84, p);
      const len = (24 * Math.sin(Math.PI * Math.min(1, u * 1.25)) ** 0.7 * (1 - u * 0.45) + 3) * (0.78 + r() * 0.36);
      const curl = (r() - 0.5) * 0.5 + s * 0.15;
      // The side toward the candle is lit; the far side turns into shade.
      const lit = (s === -1) === (Math.sin(p.a) > -0.3);
      c.save();
      c.translate(p.x, p.y);
      c.rotate(p.a + s * (1.0 - u * 0.25) + (r() - 0.5) * 0.12);
      c.beginPath();
      c.moveTo(0, 0);
      c.bezierCurveTo(-len * 0.22, -len * 0.3, -len * (0.12 - curl * 0.3), -len * 0.82, len * curl * 0.4, -len);
      c.bezierCurveTo(len * (0.2 + curl * 0.3), -len * 0.72, len * 0.2, -len * 0.28, 0, 0);
      c.closePath();
      c.fillStyle = lin(c, 0, 0, 0, -len, [[0, dark], [0.5, lit ? mid : dark], [1, lit ? light : mid]]);
      c.fill();
      c.strokeStyle = 'rgba(4,12,6,0.55)';
      c.lineWidth = 0.4;
      c.stroke();
      c.strokeStyle = `rgba(190,224,176,${lit ? 0.38 : 0.14})`;
      c.lineWidth = 0.35;
      c.beginPath();
      c.moveTo(0, -1);
      c.quadraticCurveTo(-len * 0.04, -len * 0.5, len * curl * 0.35, -len * 0.88);
      c.stroke();
      c.restore();
    }
  }
  // The rachis itself, lit along its upper side.
  c.lineCap = 'round';
  for (const [w, col] of [[2, f.front ? '#2E5236' : '#1E3A28'], [0.7, f.front ? 'rgba(170,210,150,0.5)' : 'rgba(120,160,110,0.35)']] as const) {
    c.strokeStyle = col;
    c.lineWidth = w;
    c.beginPath();
    for (let i = 0; i <= 20; i++) {
      frondAt(f, (i / 20) * 0.88, p);
      if (i === 0) c.moveTo(p.x - (w < 1 ? 0.4 : 0), p.y);
      else c.lineTo(p.x - (w < 1 ? 0.4 : 0), p.y);
    }
    c.stroke();
  }
  // The tip, still coiled into a fiddlehead.
  frondAt(f, 0.88, p);
  crozier(c, p.x, p.y, p.a, 6.4, Math.sign(f.bend) || 1, f.front);
}

/** A fiddlehead: the unopened tip of a frond, a fat coil that tapers as it winds in, furred pale on
 *  its lit side. `turn` is 1 for a clockwise curl, -1 the other way. */
function crozier(c: Ctx, x: number, y: number, heading: number, r: number, turn: number, front: boolean): void {
  c.save();
  c.translate(x, y);
  c.rotate(heading);
  c.lineCap = 'round';
  let px = 0;
  let py = 0;
  const end = Math.PI * 2.3;
  for (let t = 0.2; t <= end; t += 0.2) {
    const rr = r * (1 - t / (Math.PI * 2.8));
    const nx = turn * (r - Math.cos(t) * rr);
    const ny = -Math.sin(t) * rr - t * 0.3;
    const k = 1 - t / end;
    c.strokeStyle = front ? (k > 0.5 ? '#3E6A44' : '#5E8A5A') : (k > 0.5 ? '#244630' : '#36583E');
    c.lineWidth = 1.4 + 3 * k;
    c.beginPath();
    c.moveTo(px, py);
    c.lineTo(nx, ny);
    c.stroke();
    px = nx;
    py = ny;
  }
  c.strokeStyle = 'rgba(214,236,196,0.35)';
  c.lineWidth = 0.6;
  c.beginPath();
  for (let t = 0; t <= end * 0.7; t += 0.2) {
    const rr = r * (1 - t / (Math.PI * 2.8)) + 1;
    const nx = turn * (r - Math.cos(t) * rr);
    const ny = -Math.sin(t) * rr - t * 0.3;
    if (t === 0) c.moveTo(nx, ny);
    else c.lineTo(nx, ny);
  }
  c.stroke();
  c.restore();
}

/** An arching stem hung with bells, each veined, flared and scalloped at its lip, dark in its throat. */
function paintBells(c: Ctx): void {
  const stem = (t: number) => ({ x: -6 - t * 66 + Math.sin(t * 2.4) * 8, y: SOIL_Y - 2 - Math.sin(t * Math.PI * 0.86) * 112 + t * 34 });
  c.lineCap = 'round';
  for (const [w, col] of [[1.8, '#2E4A2A'], [0.6, 'rgba(160,200,140,0.45)']] as const) {
    c.strokeStyle = col;
    c.lineWidth = w;
    c.beginPath();
    for (let i = 0; i <= 26; i++) {
      const p = stem(i / 26);
      if (i === 0) c.moveTo(p.x - (w < 1 ? 0.5 : 0), p.y);
      else c.lineTo(p.x - (w < 1 ? 0.5 : 0), p.y);
    }
    c.stroke();
  }
  for (const [t, size] of [[0.5, 1.25], [0.66, 1.15], [0.81, 1.02], [0.95, 0.86]] as const) {
    const p = stem(t);
    // A little pedicel, then the bell hanging from it.
    const bx = p.x - 2.5;
    const by = p.y + 10 * size;
    c.strokeStyle = '#2E4A2A';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(p.x, p.y);
    c.quadraticCurveTo(p.x - 4, p.y + 2, bx, by - 9.5 * size);
    c.stroke();
    paintBell(c, bx, by, size);
  }
}

function paintBell(c: Ctx, x: number, y: number, k: number): void {
  const w = 8.5 * k;
  const h = 14 * k;
  c.save();
  c.translate(x, y);
  c.rotate(0.14);
  const shape = () => {
    c.beginPath();
    c.moveTo(-w * 0.32, -h * 0.62);
    c.bezierCurveTo(-w * 0.86, -h * 0.5, -w * 0.78, h * 0.12, -w * 1.12, h * 0.42);
    // A scalloped lip of five points.
    for (let i = 0; i < 5; i++) {
      const x0 = -w * 1.12 + (i * w * 2.24) / 5;
      const x1 = x0 + (w * 2.24) / 5;
      c.quadraticCurveTo((x0 + x1) / 2, h * (i % 2 ? 0.3 : 0.34), x1, h * 0.42 + (i === 4 ? 0 : h * 0.06));
    }
    c.bezierCurveTo(w * 0.78, h * 0.12, w * 0.86, -h * 0.5, w * 0.32, -h * 0.62);
    c.closePath();
  };
  shape();
  c.fillStyle = lin(c, -w, 0, w, 0, [[0, '#FFF8EA'], [0.3, PAL.bell], [0.7, PAL.bellShade], [1, '#4E3E62']]);
  c.fill();
  c.save();
  shape();
  c.clip();
  // Fine veins down the bell, and the darker throat showing under the flared lip.
  c.strokeStyle = 'rgba(96,74,128,0.4)';
  c.lineWidth = 0.4;
  for (const vx of [-0.55, -0.15, 0.25, 0.62]) {
    c.beginPath();
    c.moveTo(vx * w * 0.4, -h * 0.58);
    c.quadraticCurveTo(vx * w * 0.9, -h * 0.1, vx * w * 1.1, h * 0.42);
    c.stroke();
  }
  c.restore();
  c.fillStyle = rad(c, 0, h * 0.45, 0.5, 0, h * 0.45, w * 0.95, [[0, PAL.bellThroat], [1, 'rgba(62,42,85,0)']]);
  c.beginPath();
  c.ellipse(0, h * 0.44, w * 0.78, h * 0.13, 0, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = 'rgba(240,226,190,0.8)';
  c.lineWidth = 0.6;
  c.beginPath();
  c.moveTo(0.5, h * 0.34);
  c.lineTo(0.8, h * 0.58);
  c.stroke();
  shape();
  c.strokeStyle = 'rgba(40,26,60,0.55)';
  c.lineWidth = 0.45;
  c.stroke();
  // A cap of green where it hangs.
  c.fillStyle = '#3E6236';
  c.beginPath();
  c.ellipse(0, -h * 0.6, w * 0.42, h * 0.12, 0, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

function paintPlant(c: Ctx, tile: Tile): void {
  // Behind the pot's rim: the back fronds and the bells' stem.
  for (const f of FRONDS) if (!f.front) paintFrond(c, f);
  paintBells(c);
  paintPot(c, tile);
  // Two young fiddleheads rising from the moss, then the front fronds over the rim.
  c.strokeStyle = '#3E6A44';
  c.lineWidth = 2.2;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(-8, SOIL_Y + 2);
  c.quadraticCurveTo(-13, SOIL_Y - 6, -11, SOIL_Y - 14);
  c.moveTo(13, SOIL_Y + 2);
  c.quadraticCurveTo(17, SOIL_Y - 4, 16, SOIL_Y - 11);
  c.stroke();
  crozier(c, -11, SOIL_Y - 14, -0.2, 6.5, 1, true);
  crozier(c, 16, SOIL_Y - 11, 0.3, 5.5, -1, true);
  for (const f of FRONDS) if (f.front) paintFrond(c, f);
}

// The key, lying on its side along the shelf: a toothed bit at the left (under the pot), a shaft, a
// collar, and a round bow with a hole at the right.
const KEY = { bitX: 24, shaftY: -4.5, shaftHalf: 1.6, collarX: 60, bowX: 70, bowR: 6.8, holeR: 3 } as const;

/** One path for the whole key, filled with the nonzero rule: every part winds the same way (as rect()
 *  does) so overlaps stay solid, and the bow's hole winds the other way so it stays open. */
function keyShape(c: Ctx): void {
  const k = KEY;
  const y0 = k.shaftY;
  c.beginPath();
  // Shaft.
  c.rect(k.bitX, y0 - k.shaftHalf, k.collarX - k.bitX, k.shaftHalf * 2);
  // The bit hangs below the shaft at its tip, with a notch between two teeth.
  c.moveTo(k.bitX, y0);
  c.lineTo(k.bitX + 9, y0);
  c.lineTo(k.bitX + 9, y0 + 5.6);
  c.lineTo(k.bitX + 5.2, y0 + 5.6);
  c.lineTo(k.bitX + 5.2, y0 + 3.6);
  c.lineTo(k.bitX + 2.8, y0 + 3.6);
  c.lineTo(k.bitX + 2.8, y0 + 5.6);
  c.lineTo(k.bitX, y0 + 5.6);
  c.closePath();
  // Collar.
  c.rect(k.collarX, y0 - 3, 3.2, 6);
  // Bow, and its hole.
  c.moveTo(k.bowX + k.bowR, y0);
  c.arc(k.bowX, y0, k.bowR, 0, Math.PI * 2);
  c.moveTo(k.bowX + k.holeR, y0);
  c.arc(k.bowX, y0, k.holeR, 0, Math.PI * 2, true);
}

function paintKey(c: Ctx): void {
  const k = KEY;
  // Its shadow on the shelf, then the brass, lit from above, with a bright edge along the top.
  ellipsePath(c, (k.bitX + k.bowX) / 2 + 3, 0.5, (k.bowX - k.bitX) / 2 + 8, 2);
  c.fillStyle = 'rgba(8,4,2,0.5)';
  c.fill();
  keyShape(c);
  c.fillStyle = lin(c, 0, k.shaftY - k.bowR, 0, k.shaftY + k.bowR, [
    [0, PAL.brassShine], [0.3, PAL.brassLight], [0.65, PAL.brass], [1, PAL.brassDark],
  ]);
  c.fill();
  c.strokeStyle = 'rgba(255,244,208,0.6)';
  c.lineWidth = 0.6;
  c.beginPath();
  c.moveTo(k.bitX + 0.5, k.shaftY - k.shaftHalf + 0.4);
  c.lineTo(k.collarX - 0.5, k.shaftY - k.shaftHalf + 0.4);
  c.stroke();
  c.beginPath();
  c.arc(k.bowX, k.shaftY, k.bowR - 0.7, Math.PI * 1.05, Math.PI * 1.7);
  c.stroke();
  rivet(c, k.collarX + 1.6, k.shaftY, 0.9);
}

function paintKeyGlow(c: Ctx): void {
  // The key's own warm glimmer, for the light layer (the shelf is dark, so light shows on it).
  c.lineJoin = 'round';
  c.lineWidth = 2.8;
  c.strokeStyle = 'rgba(255,226,160,0.3)';
  keyShape(c);
  c.stroke();
  c.lineWidth = 0.8;
  c.strokeStyle = 'rgba(255,240,200,0.8)';
  keyShape(c);
  c.stroke();
}
