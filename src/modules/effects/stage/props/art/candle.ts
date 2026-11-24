// The candle: a tall ivory beeswax candle, its top melted into a crater with a worn, curled wick and
// drips run down its sides, in a heavy brass chamberstick (a wide pan with a rolled rim, a turned stem
// and socket, and a finger loop with a thumb rest). The brass is old: dark in its hollows, bright where
// hands have worn it. The flame is a separate sprite for the light layer, layered as a real one is: a
// blue root, a white core, gold, and an orange tip. Hidden detail (Revelio): a name scratched into the
// front of the pan, "Wren" (an original invented name), revealed as a dark engraving (shade layer)
// that glows silver (light layer).
// Coordinates in mH, origin at the middle of the base on the shelf, y up is negative.

import { paintSprite, type CanvasFactory, type Sprite } from './canvas';
import { paintHeap, type Solid } from './common';
import {
  BRASS, PAL, bandPath, cylinder, edgeLight, ellipsePath, grain, lin, noiseTile, polyline, rad, speckle, type Ctx, type Stops,
} from './paint';

/** Where the flame stands: the top of the wick. */
export const WICK_TOP = { x: 1.6, y: -199 } as const;
/** Top of the wax, for the glow of the melted pool. */
export const WAX_TOP_Y = -190;
export const CANDLE_DUST = '#E0CFA6';

export interface CandleArt {
  body: Sprite;
  /** Teardrop flame, origin at its base, for the light layer. */
  flame: Sprite;
  ink: Sprite;
  hidden: Sprite;
  heap: Sprite;
}

/** The pan: its rim, the wall below it, and where it meets the shelf. */
const PAN = { rimY: -27, rimRx: 62, rimRy: 13.5, footY: -11, footRx: 55, footRy: 11 } as const;
/** The socket's lip, where the candle stands in it. */
const SOCKET_TOP = -68;
/** The candle's half-width at its foot and at its top. */
const WAX_R0 = 13.6;
const WAX_R1 = 12.8;

/** Roughly where the candle and its stick are (common.ts Solid), for cutting Reducto's pieces. */
export const CANDLE_SOLID: readonly Solid[] = [
  { rect: [-WAX_R0, WAX_TOP_Y - 2, WAX_R0, SOCKET_TOP + 2] },
  { rect: [-17, SOCKET_TOP - 2, 17, PAN.rimY + 1] },
  { ellipse: [0, -20, PAN.rimRx, 20] },
  { ellipse: [70, PAN.rimY, 13, 13] },
];

/** Where the scratched name sits on the pan (Revelio's halo and glint); a faint halo, on bright brass. */
export const CANDLE_SECRET = { x: -2, y: -18, halo: 84, haloAlpha: 0.12 } as const;

export function buildCandleArt(factory: CanvasFactory, res: number): CandleArt | null {
  const tile = noiseTile(factory);
  const body = paintSprite(factory, res, { x0: -66, y0: -204, x1: 88, y1: 1 }, (c) => paintBody(c, tile));
  const flame = paintSprite(factory, res, { x0: -20, y0: -74, x1: 20, y1: 10 }, paintFlame);
  const nameBox = { x0: -24, y0: -26, x1: 22, y1: -8 };
  const ink = paintSprite(factory, res, nameBox, (c) => paintName(c, 'engraved'));
  const hidden = paintSprite(factory, res, nameBox, (c) => paintName(c, 'glow'));
  const heap = paintHeap(factory, res, 84, CANDLE_DUST, 11);
  if (!body || !flame || !ink || !hidden || !heap) return null;
  return { body, flame, ink, hidden, heap };
}

type Tile = ReturnType<typeof noiseTile>;

function paintBody(c: Ctx, tile: Tile): void {
  paintPan(c, tile);
  paintLoop(c);
  paintStem(c, tile);
  paintWax(c, tile);
  paintSocketLip(c);
  paintWick(c);
}

/** The finger loop on the right of the pan, the arm that joins it on, and the thumb rest on top. */
function paintLoop(c: Ctx): void {
  const cx = 70;
  const cy = -27;
  const ro = 12.5;
  const ri = 7.2;
  // The arm that joins the loop to the pan.
  c.fillStyle = cylinder(c, 54, 62, BRASS, 1);
  c.fillRect(53, cy - 3.6, 9, 7.2);
  c.beginPath();
  c.arc(cx, cy, ro, 0, Math.PI * 2);
  c.arc(cx, cy, ri, 0, Math.PI * 2, true);
  c.fillStyle = rad(c, cx - 6, cy - 7, 1, cx, cy, ro + 1, [[0, PAL.brassShine], [0.35, PAL.brassLight], [0.6, PAL.brass], [0.8, PAL.brassDark], [1, PAL.brassDeep]]);
  c.fill();
  // The inner edge of the ring is in its own shadow; the outer catches the candle on the left.
  c.strokeStyle = 'rgba(20,12,4,0.65)';
  c.lineWidth = 0.9;
  c.beginPath();
  c.arc(cx, cy, ri + 0.4, 0, Math.PI * 2);
  c.stroke();
  c.strokeStyle = 'rgba(255,228,170,0.55)';
  c.lineWidth = 1;
  c.beginPath();
  c.arc(cx, cy, ro - 1, Math.PI * 0.95, Math.PI * 1.5);
  c.stroke();
  c.strokeStyle = 'rgba(175,192,220,0.3)';
  c.beginPath();
  c.arc(cx, cy, ro - 1, -0.5, 0.6);
  c.stroke();
  // The thumb rest: a flat leaf of brass on top of the ring, seen almost edge on, scalloped at its tip.
  c.beginPath();
  c.moveTo(58, cy - ro + 1.5);
  c.quadraticCurveTo(66, cy - ro - 3.5, 76, cy - ro - 4.6);
  c.quadraticCurveTo(81, cy - ro - 5.4, 84, cy - ro - 3.2);
  c.quadraticCurveTo(82.4, cy - ro - 1.6, 84, cy - ro + 0.2);
  c.quadraticCurveTo(78, cy - ro + 0.8, 70, cy - ro + 1.8);
  c.closePath();
  c.fillStyle = lin(c, 0, cy - ro - 5.4, 0, cy - ro + 2, [[0, PAL.brassShine], [0.45, PAL.brassLight], [1, PAL.brassDark]]);
  c.fill();
  c.strokeStyle = 'rgba(30,18,6,0.7)';
  c.lineWidth = 0.6;
  c.stroke();
}

function paintPan(c: Ctx, tile: Tile): void {
  const P = PAN;
  // The wall of the pan, flaring out to its rolled rim.
  bandPath(c, P.rimY, P.rimRx, P.rimRy, P.footY, P.footRx, P.footRy);
  c.fillStyle = cylinder(c, -P.rimRx, P.rimRx, BRASS, 1);
  c.fill();
  c.save();
  bandPath(c, P.rimY, P.rimRx, P.rimRy, P.footY, P.footRx, P.footRy);
  c.clip();
  // Lathe lines round the wall, and the grime that settles where it meets the shelf.
  grain(c, tile, 0.32, 9, 0, -P.rimRx, P.rimY - P.rimRy, P.rimRx, 0);
  c.strokeStyle = 'rgba(30,18,6,0.32)';
  c.lineWidth = 0.5;
  for (const y of [-21, -17.5, -14.5]) {
    c.beginPath();
    c.ellipse(0, y, P.footRx + (P.rimRx - P.footRx) * ((y - P.footY) / (P.rimY - P.footY)), P.footRy + 1.5, 0, 0.05, Math.PI - 0.05);
    c.stroke();
  }
  c.fillStyle = lin(c, 0, -14, 0, 2, [[0, 'rgba(14,9,4,0)'], [1, 'rgba(14,9,4,0.7)']]);
  c.fillRect(-P.rimRx, -14, P.rimRx * 2, 16);
  c.restore();
  bandPath(c, P.rimY, P.rimRx, P.rimRy, P.footY, P.footRx, P.footRy);
  edgeLight(c, -P.rimRx, P.rimRx, 1.4, 0.5, 0.35);

  // The well inside the rim: darker toward the back, where the rim shades it.
  ellipsePath(c, 0, P.rimY, P.rimRx, P.rimRy);
  c.fillStyle = rad(c, -20, P.rimY - 4, 2, 0, P.rimY, P.rimRx, [[0, PAL.brassLight], [0.35, PAL.brass], [0.75, PAL.brassDark], [1, PAL.brassDeep]]);
  c.fill();
  ellipsePath(c, 0, P.rimY + 0.8, P.rimRx - 5, P.rimRy - 2.6);
  c.fillStyle = lin(c, 0, P.rimY - P.rimRy, 0, P.rimY + P.rimRy, [[0, PAL.brassDeep], [0.45, PAL.brassDark], [1, PAL.brass]]);
  c.fill();
  c.save();
  ellipsePath(c, 0, P.rimY + 0.8, P.rimRx - 5, P.rimRy - 2.6);
  c.clip();
  speckle(c, -P.rimRx, P.rimY - P.rimRy, P.rimRx, P.rimY + P.rimRy, 21, 70, [PAL.patina, '#1A1206'], 0.3, 1.1, 0.4);
  // Old wax that ran down and set in the pan.
  for (const [x, y, rx] of [[-17, P.rimY + 4, 9], [21, P.rimY + 2.5, 6], [4, P.rimY + 6.5, 5]] as const) {
    c.fillStyle = lin(c, 0, y - 2, 0, y + 2, [[0, '#EEE2C0'], [1, '#A48D64']]);
    ellipsePath(c, x, y, rx, rx * 0.3);
    c.fill();
  }
  c.restore();
  // The rolled rim: a bright worn bead on the lit side, dark on the far side.
  c.lineWidth = 2.6;
  c.strokeStyle = lin(c, -P.rimRx, 0, P.rimRx, 0, [[0, PAL.brassLight], [0.2, PAL.brassShine], [0.45, PAL.brassLight], [0.75, PAL.brassDark], [1, PAL.brassDeep]]);
  ellipsePath(c, 0, P.rimY, P.rimRx - 1.3, P.rimRy - 0.6);
  c.stroke();
  c.lineWidth = 0.8;
  c.strokeStyle = 'rgba(255,240,200,0.8)';
  c.beginPath();
  c.ellipse(0, P.rimY, P.rimRx - 1.6, P.rimRy - 0.8, 0, 2.2, 3.5);
  c.stroke();
  c.strokeStyle = 'rgba(20,12,4,0.6)';
  c.lineWidth = 0.6;
  c.beginPath();
  c.ellipse(0, P.rimY, P.rimRx, P.rimRy, 0, 0.05, Math.PI - 0.05);
  c.stroke();
}

/** A turned stem: a collar on the pan, a round knop, a waist, then the socket cup. */
function paintStem(c: Ctx, tile: Tile): void {
  const y0 = PAN.rimY + 1.5;
  // The stem's shadow on the well, thrown right by the candle.
  c.fillStyle = 'rgba(16,10,4,0.5)';
  ellipsePath(c, 12, y0 + 1, 22, 4.4);
  c.fill();
  const sections: readonly (readonly [number, number, number, number])[] = [
    // top y, top half-width, bottom y, bottom half-width (front view, bottom to top)
    [y0 - 5, 15, y0, 19],
    [y0 - 8, 9.5, y0 - 5, 13],
    [y0 - 19, 11.5, y0 - 8, 9.5],
    [y0 - 25, 6.5, y0 - 19, 11.5],
    [y0 - 31, 7.5, y0 - 25, 6.5],
    [SOCKET_TOP, 13.5, y0 - 31, 9],
  ];
  for (const [ty, tw, by, bw] of sections) {
    c.beginPath();
    c.moveTo(-tw, ty);
    c.bezierCurveTo(-tw, ty + (by - ty) * 0.5, -bw, by - (by - ty) * 0.35, -bw, by);
    c.ellipse(0, by, Math.max(0.01, bw), Math.max(0.01, bw * 0.22), 0, Math.PI, 0, true);
    c.bezierCurveTo(bw, by - (by - ty) * 0.35, tw, ty + (by - ty) * 0.5, tw, ty);
    c.ellipse(0, ty, Math.max(0.01, tw), Math.max(0.01, tw * 0.22), 0, 0, Math.PI, false);
    c.closePath();
    const half = Math.max(tw, bw);
    c.fillStyle = cylinder(c, -half, half, BRASS, 1);
    c.fill();
    c.save();
    c.clip();
    grain(c, tile, 0.28, 8, 0, -half, ty - half * 0.22, half, by + bw * 0.22);
    // Patina gathers in the turned grooves where the cloth never reached.
    c.fillStyle = lin(c, 0, ty, 0, by, [[0, 'rgba(40,44,22,0.35)'], [0.25, 'rgba(40,44,22,0)'], [0.8, 'rgba(40,44,22,0)'], [1, 'rgba(20,14,4,0.45)']]);
    c.fillRect(-half, ty, half * 2, by - ty);
    c.restore();
    c.strokeStyle = 'rgba(24,14,4,0.55)';
    c.lineWidth = 0.5;
    c.beginPath();
    c.ellipse(0, by, Math.max(0.01, bw), Math.max(0.01, bw * 0.22), 0, 0.1, Math.PI - 0.1);
    c.stroke();
  }
  // A specular sparkle on the knop, where the candle catches it.
  c.fillStyle = rad(c, -6, y0 - 14, 0, -6, y0 - 14, 3.2, [[0, 'rgba(255,250,228,0.95)'], [1, 'rgba(255,250,228,0)']]);
  c.fillRect(-10, y0 - 18, 8, 8);
  // The socket's mouth, dark behind the candle.
  ellipsePath(c, 0, SOCKET_TOP, 13.5, 3.2);
  c.fillStyle = PAL.brassDeep;
  c.fill();
}

/** The socket's flared drip lip, in front of the candle's foot, with wax that ran down onto it. */
function paintSocketLip(c: Ctx): void {
  bandPath(c, SOCKET_TOP - 1.5, 17.5, 4, SOCKET_TOP + 1.6, 14.5, 3.4);
  c.fillStyle = cylinder(c, -17.5, 17.5, BRASS, 1);
  c.fill();
  c.lineWidth = 0.9;
  c.strokeStyle = 'rgba(255,238,190,0.75)';
  c.beginPath();
  c.ellipse(0, SOCKET_TOP - 1.5, 17.4, 4, 0, 2.3, 3.4);
  c.stroke();
  c.strokeStyle = 'rgba(24,14,4,0.6)';
  c.lineWidth = 0.6;
  c.beginPath();
  c.ellipse(0, SOCKET_TOP + 1.6, 14.5, 3.4, 0, 0.15, Math.PI - 0.15);
  c.stroke();
  // The long drip on the right has set in a lump over the lip.
  c.beginPath();
  c.moveTo(6, SOCKET_TOP - 3);
  c.bezierCurveTo(7, SOCKET_TOP + 1, 9.5, SOCKET_TOP + 4.8, 13, SOCKET_TOP + 4.2);
  c.bezierCurveTo(16.5, SOCKET_TOP + 3.6, 17.5, SOCKET_TOP, 15.5, SOCKET_TOP - 2.5);
  c.closePath();
  c.fillStyle = lin(c, 6, 0, 17, 0, [[0, '#F0E4C4'], [0.55, '#CDB98E'], [1, '#8A7450']]);
  c.fill();
}

/** One drip: where it leaves the rim, where its bead ends, and its width at the bead. */
interface Drip { x: number; end: number; w: number }
const DRIPS: readonly Drip[] = [
  { x: -12, end: -148, w: 5.2 },
  { x: -3.5, end: -174, w: 4.2 },
  { x: 5, end: -142, w: 5.4 },
  { x: 11.2, end: -82, w: 5.4 },
];

/** Beeswax across the candle, lit from the left: the colors a drip takes where it hangs. */
const WAX_STOPS: Stops = [
  [0, '#B09670'], [0.06, '#F7ECD2'], [0.2, '#EBDCB8'], [0.45, '#CFBA8E'], [0.7, '#9E835A'], [0.86, '#6E5636'],
  [0.95, '#8C8E92'], [1, '#5A4630'],
];

function waxX(y: number, side: -1 | 1): number {
  const u = (y - SOCKET_TOP) / (WAX_TOP_Y - SOCKET_TOP);
  return side * (WAX_R0 + (WAX_R1 - WAX_R0) * u);
}

function waxPath(c: Ctx): void {
  const top = WAX_TOP_Y;
  c.beginPath();
  c.moveTo(waxX(SOCKET_TOP + 2, -1), SOCKET_TOP + 2);
  c.lineTo(waxX(top + 3, -1), top + 3);
  // The rim has melted unevenly: high on the lit side, and broken down in a notch on the right where
  // the long drip ran over.
  c.bezierCurveTo(-WAX_R1 + 0.4, top - 2.4, -8, top - 3.4, -3.5, top - 2.6);
  c.bezierCurveTo(0, top - 2, 3, top - 2.8, 6, top - 1.6);
  c.bezierCurveTo(7.6, top - 0.8, 8.4, top + 3.6, 10.2, top + 4.2);
  c.bezierCurveTo(11.6, top + 4.6, WAX_R1, top + 3, waxX(top + 6, 1), top + 6);
  c.lineTo(waxX(SOCKET_TOP + 2, 1), SOCKET_TOP + 2);
  c.closePath();
}

function paintWax(c: Ctx, tile: Tile): void {
  const top = WAX_TOP_Y;
  const r = WAX_R0;
  waxPath(c);
  c.fillStyle = lin(c, -r, 0, r, 0, WAX_STOPS);
  c.fill();
  c.save();
  waxPath(c);
  c.clip();
  // Beeswax lets light in: the top, thin and near the flame, is paler and warmer, and a warm glow
  // lies just inside the lit edge.
  c.fillStyle = lin(c, 0, top - 4, 0, top + 34, [[0, 'rgba(255,232,186,0.42)'], [1, 'rgba(255,232,186,0)']]);
  c.fillRect(-r, top - 4, r * 2, 38);
  c.fillStyle = lin(c, -r, 0, r, 0, [[0, 'rgba(255,214,150,0)'], [0.08, 'rgba(255,214,150,0.22)'], [0.24, 'rgba(255,214,150,0)']]);
  c.fillRect(-r, top - 4, r * 2, SOCKET_TOP - top + 6);
  // Streaks from dipping, and the shadow the socket throws up the foot of the candle.
  grain(c, tile, 0.2, 10, Math.PI / 2, -r, top - 4, r, SOCKET_TOP + 2);
  c.fillStyle = lin(c, 0, SOCKET_TOP - 20, 0, SOCKET_TOP + 2, [[0, 'rgba(40,26,10,0)'], [1, 'rgba(40,26,10,0.55)']]);
  c.fillRect(-r, SOCKET_TOP - 20, r * 2, 22);
  // Each drip throws a soft shadow to its right and below its bead, onto the candle.
  for (const d of DRIPS) {
    const sx = d.x + d.w * 0.45;
    c.fillStyle = lin(c, sx - 0.4, 0, sx + 3.2, 0, [[0, 'rgba(60,40,16,0.45)'], [1, 'rgba(60,40,16,0)']]);
    c.fillRect(sx - 0.4, top + 4, 3.6, d.end - top - 2);
    c.fillStyle = rad(c, d.x + 1, d.end + 2.6, 0.2, d.x + 1, d.end + 2.6, d.w * 0.9, [[0, 'rgba(60,40,16,0.4)'], [1, 'rgba(60,40,16,0)']]);
    c.fillRect(d.x - d.w, d.end - 2, d.w * 2.4, d.w * 1.6);
  }
  c.restore();

  // The crater the flame has melted: its far wall in shade, the pool, the near lip lit.
  c.beginPath();
  c.ellipse(0, top + 0.6, WAX_R1 - 1.4, 2.9, 0, 0, Math.PI * 2);
  c.fillStyle = lin(c, 0, top - 2.4, 0, top + 3.5, [[0, '#7A6442'], [0.55, '#B8A276'], [1, '#F4E8CA']]);
  c.fill();
  ellipsePath(c, 0.8, top + 1.1, 6.4, 1.5);
  c.fillStyle = 'rgba(104,78,42,0.6)';
  c.fill();
  c.strokeStyle = 'rgba(255,242,210,0.8)';
  c.lineWidth = 0.7;
  c.beginPath();
  c.ellipse(0, top + 0.6, WAX_R1 - 1.6, 2.9, 0, 0.35, Math.PI - 0.25);
  c.stroke();

  for (const d of DRIPS) paintDrip(c, d);
  // Where the candle goes into the socket, a ring of soft wax.
  c.fillStyle = lin(c, -r, 0, r, 0, [[0, '#E6D6B0'], [0.4, '#C2AC82'], [1, '#6A5636']]);
  ellipsePath(c, 0, SOCKET_TOP + 0.5, r + 0.8, 2.8);
  c.fill();
}

/** A drip: thin where it left the rim, swelling as it slowed, and ending in a round bead. It takes
 *  the candle's light where it hangs, with a bright edge on its lit side and a dark one on the other.
 *  One at an edge bulges past the outline, which is what makes the candle's silhouette lumpy. */
function paintDrip(c: Ctx, d: Drip): void {
  const top = WAX_TOP_Y + 1;
  const edge = Math.abs(d.x) > 9 ? Math.sign(d.x) * 2.2 : 0;
  const len = d.end - top;
  const at = (u: number) => d.x + edge * u * u;
  const half = (u: number) => d.w * (0.26 + 0.24 * u);
  c.beginPath();
  c.moveTo(at(0) - half(0), top);
  for (let i = 1; i <= 8; i++) {
    const u = i / 8;
    c.lineTo(at(u) - half(u), top + len * u * 0.92);
  }
  // The bead.
  const bx = at(1);
  const by = d.end - d.w * 0.3;
  c.arc(bx, by, d.w * 0.55, Math.PI, 0, true);
  for (let i = 8; i >= 0; i--) {
    const u = i / 8;
    c.lineTo(at(u) + half(u), top + len * u * 0.92);
  }
  c.closePath();
  const u0 = Math.max(0, Math.min(1, (d.x - d.w + WAX_R0) / (WAX_R0 * 2)));
  const u1 = Math.max(0, Math.min(1, (d.x + d.w + WAX_R0) / (WAX_R0 * 2)));
  const g = c.createLinearGradient(d.x - d.w, 0, d.x + d.w + edge, 0);
  // The drip's own roundness, over the candle's light where it hangs.
  for (const [o, col] of WAX_STOPS) if (o >= u0 && o <= u1) g.addColorStop((o - u0) / Math.max(0.01, u1 - u0), col);
  g.addColorStop(0, u0 < 0.3 ? '#FFF6E2' : '#E2D2AA');
  g.addColorStop(1, u1 > 0.7 ? '#5E4A2E' : '#A88E62');
  c.fillStyle = g;
  c.fill();
  c.strokeStyle = 'rgba(70,50,22,0.4)';
  c.lineWidth = 0.4;
  c.stroke();
  // A point of light on the bead, and a thin glint down the drip's lit side.
  c.fillStyle = 'rgba(255,252,238,0.85)';
  ellipsePath(c, bx - d.w * 0.2, by - d.w * 0.1, d.w * 0.16, d.w * 0.22);
  c.fill();
  c.strokeStyle = 'rgba(255,250,232,0.55)';
  c.lineWidth = 0.4;
  c.beginPath();
  c.moveTo(at(0.15) - half(0.15) + 0.5, top + len * 0.15 * 0.92);
  c.lineTo(at(0.85) - half(0.85) + 0.6, top + len * 0.85 * 0.92);
  c.stroke();
}

/** The wick: charred, curled over at its tip, with a bead of carbon. */
function paintWick(c: Ctx): void {
  c.lineCap = 'round';
  c.strokeStyle = '#1A120C';
  c.lineWidth = 1.7;
  c.beginPath();
  c.moveTo(0.6, WAX_TOP_Y + 0.6);
  c.bezierCurveTo(0.2, WAX_TOP_Y - 3, 0.4, WAX_TOP_Y - 6.5, WICK_TOP.x, WICK_TOP.y + 1.2);
  c.stroke();
  c.strokeStyle = '#2E2218';
  c.lineWidth = 1.1;
  c.beginPath();
  c.moveTo(WICK_TOP.x, WICK_TOP.y + 1.2);
  c.quadraticCurveTo(WICK_TOP.x + 1.4, WICK_TOP.y - 0.6, WICK_TOP.x + 3, WICK_TOP.y + 0.6);
  c.stroke();
  c.fillStyle = '#0A0705';
  c.beginPath();
  c.arc(WICK_TOP.x + 3, WICK_TOP.y + 0.8, 1, 0, Math.PI * 2);
  c.fill();
}

function flamePath(c: Ctx, k: number, lift: number): void {
  c.beginPath();
  c.moveTo(0, 4 * k + lift);
  c.bezierCurveTo(-11.5 * k, 0.5 * k + lift, -10.5 * k, -18 * k + lift, -4.6 * k, -33 * k + lift);
  c.bezierCurveTo(-2.2 * k, -42 * k + lift, -0.7 * k, -51 * k + lift, 0.2, -61 * k + lift);
  c.bezierCurveTo(0.9 * k, -51 * k + lift, 2.4 * k, -42 * k + lift, 4.8 * k, -33 * k + lift);
  c.bezierCurveTo(10.5 * k, -18 * k + lift, 11.5 * k, 0.5 * k + lift, 0, 4 * k + lift);
  c.closePath();
}

function paintFlame(c: Ctx): void {
  // A warm aura round the whole flame.
  c.fillStyle = rad(c, 0, -22, 1, 0, -22, 38, [[0, 'rgba(255,170,70,0.36)'], [0.6, 'rgba(255,120,40,0.1)'], [1, 'rgba(255,100,30,0)']]);
  c.beginPath();
  c.ellipse(0, -22, 18, 38, 0, 0, Math.PI * 2);
  c.fill();
  // The outer envelope: orange, reddening at the tip.
  flamePath(c, 1, 0);
  c.fillStyle = lin(c, 0, -62, 0, 4, [[0, 'rgba(214,92,30,0)'], [0.12, 'rgba(232,112,36,0.75)'], [0.4, 'rgba(255,170,60,0.95)'], [0.8, 'rgba(255,196,96,0.9)'], [1, 'rgba(255,170,80,0.5)']]);
  c.fill();
  // Gold, then the white core low in the flame.
  flamePath(c, 0.72, -2);
  c.fillStyle = rad(c, 0, -14, 0, 0, -16, 34, [[0, 'rgba(255,252,236,1)'], [0.35, 'rgba(255,232,150,0.95)'], [1, 'rgba(255,196,84,0)']]);
  c.fill();
  flamePath(c, 0.4, -5);
  c.fillStyle = rad(c, 0, -12, 0, 0, -12, 16, [[0, 'rgba(255,255,255,1)'], [0.6, 'rgba(255,250,232,0.9)'], [1, 'rgba(255,240,200,0)']]);
  c.fill();
  // The darker zone round the wick, where the wax vapour has not caught yet.
  c.fillStyle = rad(c, 0, -3, 0, 0, -3, 5, [[0, 'rgba(60,30,10,0.55)'], [1, 'rgba(60,30,10,0)']]);
  c.beginPath();
  c.ellipse(0, -3, 3.4, 5.5, 0, 0, Math.PI * 2);
  c.fill();
  // The blue root.
  c.fillStyle = rad(c, 0, 1, 0, 0, 0, 8, [[0, 'rgba(90,130,255,0.15)'], [0.5, 'rgba(90,130,255,0.55)'], [1, 'rgba(80,110,255,0)']]);
  c.beginPath();
  c.ellipse(0, 0.5, 7.5, 6, 0, 0, Math.PI * 2);
  c.fill();
}

// "Wren", scratched with a pin: angular strokes along the pan's front, with a flourish under it.
// Drawn in a box with its baseline at 0, capitals 7 high and small letters 4.5, then widened, slanted
// and set on the wall of the pan (which runs from its rim down to its foot at the front).
const NAME_BASE = -14.5;
const NAME_SLANT = 0.2;
const NAME_WIDEN = 1.7;
const NAME_SCALE = 1.25;
const NAME_MID = 9.4;
const NAME_STROKES: readonly (readonly number[])[] = [
  [0, -7, 1.5, 0, 3.1, -4.4, 4.7, 0, 6.3, -7],
  [7.7, -4.5, 7.7, 0],
  [7.7, -3.1, 8.9, -4.5, 10.2, -4.3],
  [11.1, -2.3, 14.1, -2.7, 13.8, -4.4, 12.3, -4.8, 11.1, -3.1, 11.5, -0.8, 12.9, 0, 14.5, -0.7],
  [15.7, -4.6, 15.7, 0],
  [15.7, -3.4, 17, -4.8, 18.4, -4.4, 18.8, -3, 18.8, 0],
  [-0.8, 1.6, 9.2, 2.2, 19.6, 1.4],
];

function nameStrokes(c: Ctx, dx: number, dy: number): void {
  const pts: number[] = [];
  for (const s of NAME_STROKES) {
    pts.length = 0;
    for (let i = 0; i < s.length; i += 2) {
      const ly = s[i + 1] * NAME_SCALE;
      const y = NAME_BASE + ly;
      pts.push((s[i] - NAME_MID) * NAME_WIDEN + NAME_SLANT * -ly + dx, y + dy);
    }
    polyline(c, pts);
  }
}

/** 'engraved': dark grooves with a bright lip, for the shade layer. 'glow': silver light along them. */
function paintName(c: Ctx, style: 'engraved' | 'glow'): void {
  c.lineCap = 'round';
  c.lineJoin = 'round';
  if (style === 'engraved') {
    c.lineWidth = 1.4;
    c.strokeStyle = 'rgba(30,16,4,0.95)';
    nameStrokes(c, 0, 0);
    c.lineWidth = 0.55;
    c.strokeStyle = 'rgba(255,236,190,0.6)';
    nameStrokes(c, 0.55, 0.6);
    return;
  }
  // The brass is bright already: the light only lifts the grooves a little, or the name would
  // bloom into a white smear on the screen-blended layer.
  for (const pass of [{ w: 2.8, a: 0.1 }, { w: 0.9, a: 0.5 }]) {
    c.lineWidth = pass.w;
    c.strokeStyle = `rgba(220,229,245,${pass.a})`;
    nameStrokes(c, 0, 0);
  }
}
