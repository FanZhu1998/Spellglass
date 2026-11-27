// The teacup: fine bone china on its saucer, a flared bowl on a little foot with a looped handle, gilt
// at the rim, the foot and the saucer's edge, and a cobalt band round the bowl painted with gilt stars
// and crescent moons. China is glossy and thin: a sharp highlight on the lit side, warm grey shade, a
// cool edge of moonlight, light glowing through the rim. Cracked, it has dark hairlines running down
// from a chipped rim; Reparo knits them away from the foot up while a gold copy glows at the mending
// edge, and leaves a gold seam where the crack was, as mended china is (a separate sprite each).
// Hidden detail (Revelio): a pressed violet lying in the cup, painted in its own colors on the shade
// layer (pale light would not show on the china). Coordinates in mH, origin at the middle of the
// saucer's base.

import { paintSprite, type CanvasFactory, type Sprite } from './canvas';
import { paintHeap, type Solid } from './common';
import { CHINA, GOLD, PAL, bandPath, cylinder, ellipsePath, lin, polyline, rad, type Ctx } from './paint';

export const TEACUP_DUST = '#F1EFEA';
/** The crack runs from the rim (top) to here; knitting moves from bottom to top. */
export const CRACK_TOP = -100;
export const CRACK_BOTTOM = -50;
/** Box covering the crack sprite, for clipping while it knits. */
export const CRACK_BOX = { x0: -32, y0: -110, x1: -4, y1: -46 } as const;

export interface TeacupArt {
  body: Sprite;
  crack: Sprite;
  crackGold: Sprite;
  /** The mended crack: a fine seam of gold on the china (shade layer), there from the knit on. */
  seam: Sprite;
  ink: Sprite;
  hidden: null;
  heap: Sprite;
}

const RIM_Y = -105;
const RIM_RX = 56;
const RIM_RY = 10.5;
/** The bowl's foot, where it stands on its pedestal. */
const BOWL_Y = -30;
const BOWL_RX = 26;
const SAUCER = { y: -13, rx: 80, ry: 13.5, footY: -4.5, footRx: 44, footRy: 4.5 } as const;

/** Roughly where the cup and saucer are (common.ts Solid), for cutting Reducto's pieces: the bowl, its
 *  rim and foot, the saucer and the handle. */
export const TEACUP_SOLID: readonly Solid[] = (() => {
  const bowl: number[] = [];
  for (let y = RIM_Y; y <= BOWL_Y; y += 5) bowl.push(-bowlHalf(y), y);
  for (let y = BOWL_Y; y >= RIM_Y; y -= 5) bowl.push(bowlHalf(y), y);
  return [
    { poly: bowl },
    { ellipse: [0, RIM_Y, RIM_RX, RIM_RY] },
    { ellipse: [0, BOWL_Y + 6, BOWL_RX + 4, 10] },
    { ellipse: [0, SAUCER.y, SAUCER.rx, SAUCER.ry + 4] },
    { ellipse: [66, -77, 19, 25] },
  ];
})();

/** Where the pressed flower lies (Revelio's halo and glint); a soft halo, over bright china. */
export const TEACUP_SECRET = { x: 4, y: RIM_Y + 0.8, halo: 96, haloAlpha: 0.2 } as const;

export function buildTeacupArt(factory: CanvasFactory, res: number): TeacupArt | null {
  const body = paintSprite(factory, res, { x0: -84, y0: -118, x1: 88, y1: 1 }, paintTeacup);
  const crack = paintSprite(factory, res, CRACK_BOX, (c) => paintCrack(c, 'crack'));
  const crackGold = paintSprite(factory, res, CRACK_BOX, (c) => paintCrack(c, 'glow'));
  const seam = paintSprite(factory, res, CRACK_BOX, (c) => paintCrack(c, 'seam'));
  const ink = paintSprite(factory, res, { x0: -54, y0: -116, x1: 54, y1: -94 }, paintFlower);
  const heap = paintHeap(factory, res, 100, TEACUP_DUST, 47);
  if (!body || !crack || !crackGold || !seam || !ink || !heap) return null;
  return { body, crack, crackGold, seam, ink, hidden: null, heap };
}

/** The bowl's half-width at height y, from its foot to its rim (a flared curve). */
function bowlHalf(y: number): number {
  const u = Math.max(0, Math.min(1, (BOWL_Y - y) / (BOWL_Y - RIM_Y)));
  return BOWL_RX + (RIM_RX - BOWL_RX) * (1 - (1 - u) ** 1.9);
}

function cupPath(c: Ctx): void {
  c.beginPath();
  c.moveTo(-BOWL_RX, BOWL_Y);
  for (let y = BOWL_Y - 4; y >= RIM_Y; y -= 4) c.lineTo(-bowlHalf(y), y);
  c.lineTo(-RIM_RX, RIM_Y);
  c.ellipse(0, RIM_Y, RIM_RX, RIM_RY, 0, Math.PI, 0, true);
  for (let y = RIM_Y + 4; y <= BOWL_Y; y += 4) c.lineTo(bowlHalf(y), y);
  c.ellipse(0, BOWL_Y, BOWL_RX, 4.6, 0, 0, Math.PI, false);
  c.closePath();
}

function paintSaucer(c: Ctx): void {
  const S = SAUCER;
  // The underside, curving in to its foot ring.
  bandPath(c, S.y, S.rx, S.ry, S.footY, S.footRx, S.footRy);
  c.fillStyle = cylinder(c, -S.rx, S.rx, CHINA);
  c.fill();
  c.fillStyle = lin(c, 0, S.y, 0, 0, [[0, 'rgba(80,72,64,0)'], [1, 'rgba(60,54,50,0.45)']]);
  c.fill();
  bandPath(c, S.footY, S.footRx, S.footRy, 0, S.footRx - 1, S.footRy * 0.7);
  c.fillStyle = cylinder(c, -S.footRx, S.footRx, CHINA);
  c.fill();
  // The top: a broad gleaming rim, the painted band, and the well the cup stands in.
  ellipsePath(c, 0, S.y, S.rx, S.ry);
  c.fillStyle = rad(c, -30, S.y - 6, 3, 0, S.y, S.rx * 1.05, [[0, '#FFFFFF'], [0.35, PAL.chinaLight], [0.75, PAL.china], [1, PAL.chinaShadow]]);
  c.fill();
  c.lineWidth = 4.6;
  c.strokeStyle = lin(c, -S.rx, 0, S.rx, 0, [[0, PAL.cobalt], [0.3, '#2A4A86'], [1, PAL.cobaltDeep]]);
  ellipsePath(c, 0, S.y + 0.2, S.rx - 9.5, S.ry - 2.6);
  c.stroke();
  c.lineWidth = 0.6;
  c.strokeStyle = PAL.gilt;
  ellipsePath(c, 0, S.y + 0.2, S.rx - 6.8, S.ry - 2.1);
  c.stroke();
  ellipsePath(c, 0, S.y + 0.2, S.rx - 12.2, S.ry - 3.1);
  c.stroke();
  // Little gilt stars round the saucer's band, crowding together toward the sides as it turns away.
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2;
    const x = Math.cos(a) * (S.rx - 9.5);
    const y = S.y + 0.2 + Math.sin(a) * (S.ry - 2.6);
    star(c, x, y, 1.1, 0.55);
  }
  ellipsePath(c, 0, S.y + 0.6, 40, 6.6);
  c.fillStyle = lin(c, 0, S.y - 6, 0, S.y + 7, [[0, 'rgba(110,100,92,0.45)'], [1, 'rgba(255,255,255,0.25)']]);
  c.fill();
  // The gilt edge, bright where it faces the candle.
  c.lineWidth = 1.3;
  c.strokeStyle = lin(c, -S.rx, 0, S.rx, 0, [[0, GOLD.light], [0.25, GOLD.shine], [0.5, GOLD.mid], [1, GOLD.dark]]);
  ellipsePath(c, 0, S.y, S.rx - 0.6, S.ry - 0.3);
  c.stroke();
  // The cup's shadow in the well, thrown a little right.
  ellipsePath(c, 7, S.y + 0.8, 34, 5.4);
  c.fillStyle = 'rgba(50,44,40,0.4)';
  c.fill();
}

/** A crescent moon in gilt: what lies inside a disc and outside a second disc set to its right (the
 *  two arcs meet where the circles cross). `sx` narrows it where the bowl turns away. */
function crescent(c: Ctx, x: number, y: number, r: number, sx: number): void {
  const a = (58.2 * Math.PI) / 180;
  const b = (88.1 * Math.PI) / 180;
  c.save();
  c.translate(x, y);
  c.scale(sx, 1);
  c.fillStyle = PAL.goldLight;
  c.beginPath();
  c.arc(0, 0, r, a, Math.PI * 2 - a, false);
  c.arc(r * 0.5, 0, r * 0.85, Math.PI * 2 - b, b, true);
  c.closePath();
  c.fill();
  c.restore();
}

/** A tiny four-pointed star in gilt. */
function star(c: Ctx, x: number, y: number, r: number, squash: number): void {
  c.fillStyle = PAL.goldLight;
  c.beginPath();
  c.moveTo(x, y - r);
  c.lineTo(x + r * 0.3, y - r * 0.3 * squash);
  c.lineTo(x + r, y);
  c.lineTo(x + r * 0.3, y + r * 0.3 * squash);
  c.lineTo(x, y + r);
  c.lineTo(x - r * 0.3, y + r * 0.3 * squash);
  c.lineTo(x - r, y);
  c.lineTo(x - r * 0.3, y - r * 0.3 * squash);
  c.closePath();
  c.fill();
}

function paintHandle(c: Ctx): void {
  const outer = () => {
    c.beginPath();
    c.moveTo(51, -97);
    c.bezierCurveTo(66, -103, 86, -98, 84, -80);
    c.bezierCurveTo(82.5, -64, 66, -56, 46, -50);
    c.lineTo(45.5, -57);
    c.bezierCurveTo(62, -62, 75, -68, 76, -80);
    c.bezierCurveTo(77, -92, 64, -95, 53, -90.5);
    c.closePath();
  };
  outer();
  c.fillStyle = lin(c, 46, -100, 86, -52, [[0, PAL.chinaLight], [0.35, PAL.china], [0.75, PAL.chinaShadow], [1, PAL.chinaDeep]]);
  c.fill();
  c.strokeStyle = 'rgba(80,72,66,0.55)';
  c.lineWidth = 0.6;
  c.stroke();
  // The thumb rest on top of the loop, and a line of gilt along its outer edge.
  c.beginPath();
  c.moveTo(60, -100.5);
  c.quadraticCurveTo(68, -106, 75, -102.5);
  c.quadraticCurveTo(68, -101.5, 62, -98.4);
  c.closePath();
  c.fillStyle = lin(c, 0, -106, 0, -98, [[0, '#FFFFFF'], [1, PAL.chinaShadow]]);
  c.fill();
  c.strokeStyle = PAL.gilt;
  c.lineWidth = 0.9;
  c.beginPath();
  c.moveTo(54, -96);
  c.bezierCurveTo(67, -101, 84, -96, 82.5, -80);
  c.bezierCurveTo(81, -66, 66, -58.5, 48, -52.5);
  c.stroke();
  c.strokeStyle = 'rgba(255,255,255,0.85)';
  c.lineWidth = 0.9;
  c.beginPath();
  c.moveTo(58, -97.5);
  c.bezierCurveTo(68, -99.5, 78, -95, 79.5, -86);
  c.stroke();
}

function paintTeacup(c: Ctx): void {
  paintSaucer(c);
  paintHandle(c);

  // The pedestal foot, its gilt line catching the light.
  bandPath(c, BOWL_Y + 1, BOWL_RX - 2, 4.4, SAUCER.y + 1, BOWL_RX + 3, 5.2);
  c.fillStyle = cylinder(c, -BOWL_RX - 3, BOWL_RX + 3, CHINA, 1);
  c.fill();
  c.strokeStyle = PAL.gilt;
  c.lineWidth = 1;
  c.beginPath();
  c.ellipse(0, SAUCER.y - 1.5, BOWL_RX + 2, 5, 0, 0.1, Math.PI - 0.1);
  c.stroke();

  // The bowl: glossy, lit from the left, its foot in the saucer's reflected light.
  cupPath(c);
  c.fillStyle = cylinder(c, -RIM_RX, RIM_RX, CHINA, 1);
  c.fill();
  c.save();
  cupPath(c);
  c.clip();
  c.fillStyle = lin(c, 0, RIM_Y, 0, BOWL_Y, [[0, 'rgba(255,250,240,0.1)'], [0.55, 'rgba(90,80,74,0)'], [0.85, 'rgba(90,80,74,0.3)'], [1, 'rgba(200,196,190,0.25)']]);
  c.fillRect(-RIM_RX, RIM_Y, RIM_RX * 2, BOWL_Y - RIM_Y);
  paintBand(c);
  // A sharp window of light on the glaze, where the candle is reflected.
  for (const [x0, x1, a] of [[-40, -33, 0.85], [-29, -27, 0.4]] as const) {
    c.fillStyle = lin(c, x0, 0, x1, 0, [[0, 'rgba(255,255,255,0)'], [0.45, `rgba(255,253,246,${a})`], [1, 'rgba(255,255,255,0)']]);
    c.beginPath();
    c.moveTo(x0, RIM_Y + 6);
    c.lineTo(x1, RIM_Y + 6);
    c.quadraticCurveTo(x1 + 6, -66, x1 + 12, -42);
    c.lineTo(x0 + 12, -42);
    c.quadraticCurveTo(x0 + 6, -66, x0, RIM_Y + 6);
    c.closePath();
    c.fill();
  }
  // Moonlight along the far side.
  c.fillStyle = lin(c, RIM_RX - 12, 0, RIM_RX, 0, [[0, 'rgba(175,192,220,0)'], [1, 'rgba(175,192,220,0.3)']]);
  c.fillRect(RIM_RX - 12, RIM_Y, 12, BOWL_Y - RIM_Y);
  c.restore();
  cupPath(c);
  c.strokeStyle = 'rgba(80,72,66,0.5)';
  c.lineWidth = 0.6;
  c.stroke();

  // The rim and the inside of the cup: the far wall lit, the near wall in its own shadow.
  ellipsePath(c, 0, RIM_Y, RIM_RX, RIM_RY);
  c.fillStyle = PAL.chinaLight;
  c.fill();
  ellipsePath(c, 0, RIM_Y + 0.5, RIM_RX - 2.4, RIM_RY - 1.4);
  c.fillStyle = lin(c, 0, RIM_Y - RIM_RY, 0, RIM_Y + RIM_RY, [[0, '#FBF8F2'], [0.45, '#DCD4C8'], [1, '#A49A8E']]);
  c.fill();
  // The thin rim glows where the candle shines through it.
  c.lineWidth = 0.8;
  c.strokeStyle = 'rgba(255,226,176,0.55)';
  c.beginPath();
  c.ellipse(0, RIM_Y, RIM_RX - 1.2, RIM_RY - 0.6, 0, Math.PI * 0.55, Math.PI * 1.05);
  c.stroke();
  c.lineWidth = 1.5;
  c.strokeStyle = lin(c, -RIM_RX, 0, RIM_RX, 0, [[0, GOLD.light], [0.22, GOLD.shine], [0.5, GOLD.mid], [1, GOLD.dark]]);
  c.beginPath();
  c.ellipse(0, RIM_Y, RIM_RX, RIM_RY, 0, 0.03, Math.PI - 0.03, false);
  c.stroke();
  c.lineWidth = 0.7;
  c.strokeStyle = PAL.gilt;
  c.beginPath();
  c.ellipse(0, RIM_Y + 4.5, RIM_RX - 1.6, RIM_RY - 0.4, 0, Math.PI * 1.04, Math.PI * 1.96, false);
  c.stroke();
}

/** The cobalt band round the bowl with gilt stars and crescent moons on it, edged in gilt. The motifs
 *  narrow toward the sides, where the bowl turns away. */
function paintBand(c: Ctx): void {
  const top = RIM_Y + 8;
  const bottom = RIM_Y + 20;
  const edge = (y: number, dir: 1 | -1) => {
    const hw = bowlHalf(y) + 1;
    c.ellipse(0, y, hw, RIM_RY * 0.95, 0, dir === 1 ? Math.PI : 0, dir === 1 ? 0 : Math.PI, dir === 1);
  };
  c.beginPath();
  c.moveTo(-bowlHalf(top) - 1, top);
  edge(top, 1);
  c.lineTo(bowlHalf(bottom) + 1, bottom);
  edge(bottom, -1);
  c.closePath();
  c.fillStyle = lin(c, -RIM_RX, 0, RIM_RX, 0, [[0, '#2C4C8A'], [0.25, '#3B5FA2'], [0.5, PAL.cobalt], [0.85, PAL.cobaltDeep], [1, '#22355E']]);
  c.fill();
  for (const y of [top, bottom]) {
    c.lineWidth = 0.9;
    c.strokeStyle = PAL.gilt;
    c.beginPath();
    c.ellipse(0, y, bowlHalf(y) + 0.6, RIM_RY * 0.95, 0, 0.05, Math.PI - 0.05);
    c.stroke();
  }
  const mid = (top + bottom) / 2;
  for (let i = 0; i < 9; i++) {
    const a = Math.PI * (0.08 + (i / 8) * 0.84);
    const x = -Math.cos(a) * (bowlHalf(mid) - 1);
    const y = mid + Math.sin(a) * RIM_RY * 0.95;
    const k = Math.sin(a);
    if (i % 2 === 0) star(c, x, y, 2.2 * k + 0.4, 1);
    else crescent(c, x, y, 2.6, Math.max(0.25, k));
  }
}

const CRACK = [-14, -103, -12.5, -96, -17, -89, -14, -82, -19.5, -74, -16, -66, -21, -58, -18, -50] as const;
const BRANCH = [-14, -82, -8, -77, -9.5, -70] as const;
const BRANCH2 = [-19.5, -74, -26, -70.5] as const;
const CHIP = [-20, -104.8, -9.5, -104.6, -14.4, -98] as const;

/** 'crack': the hairlines and the chip, for the shade layer. 'glow': bright gold along them, for the
 *  light layer while it knits. 'seam': the mended seam, gold lacquer on the china (shade layer). */
function paintCrack(c: Ctx, style: 'crack' | 'glow' | 'seam'): void {
  c.lineJoin = 'miter';
  c.lineCap = 'round';
  const lines = () => {
    polyline(c, CRACK);
    polyline(c, BRANCH);
    polyline(c, BRANCH2);
  };
  const chip = () => {
    c.beginPath();
    c.moveTo(CHIP[0], CHIP[1]);
    c.lineTo(CHIP[4], CHIP[5]);
    c.lineTo(CHIP[2], CHIP[3]);
  };
  if (style === 'glow') {
    for (const pass of [{ w: 5, a: 0.3 }, { w: 2, a: 1 }]) {
      c.lineWidth = pass.w;
      c.strokeStyle = `rgba(255,214,128,${pass.a})`;
      lines();
      chip();
      c.stroke();
    }
    return;
  }
  if (style === 'seam') {
    // The chip filled with gold, then the seam: a dark edge, the gold, and a bright line of light on it.
    chip();
    c.closePath();
    c.fillStyle = lin(c, CHIP[0], CHIP[1], CHIP[2], CHIP[5], [[0, GOLD.shine], [0.4, GOLD.light], [1, GOLD.dark]]);
    c.fill();
    c.lineWidth = 2.1;
    c.strokeStyle = 'rgba(70,46,12,0.7)';
    lines();
    c.lineWidth = 1.4;
    c.strokeStyle = lin(c, 0, -104, 0, -50, [[0, GOLD.light], [0.5, GOLD.mid], [1, GOLD.dark]]);
    lines();
    c.save();
    c.translate(-0.35, -0.3);
    c.lineWidth = 0.45;
    c.strokeStyle = 'rgba(255,246,214,0.9)';
    lines();
    c.restore();
    return;
  }
  // The chip: a nick out of the rim showing the cup's far wall through it.
  chip();
  c.closePath();
  c.fillStyle = '#B2AA9E';
  c.fill();
  c.strokeStyle = 'rgba(52,44,40,0.75)';
  c.lineWidth = 0.6;
  c.stroke();
  // The crack: a dark hairline with a bright lip beside it, as glaze cracks look.
  c.strokeStyle = 'rgba(36,30,28,0.92)';
  c.lineWidth = 1.3;
  polyline(c, CRACK);
  c.lineWidth = 0.9;
  polyline(c, BRANCH);
  polyline(c, BRANCH2);
  c.save();
  c.translate(0.8, 0.35);
  c.strokeStyle = 'rgba(255,255,255,0.7)';
  c.lineWidth = 0.5;
  lines();
  c.restore();
}

/** The crack's x at height y, for placing the glow at the knitting edge. */
export function crackXAt(y: number): number {
  for (let i = 2; i < CRACK.length; i += 2) {
    const y0 = CRACK[i - 1];
    const y1 = CRACK[i + 1];
    if ((y <= y1 && y >= y0) || (y >= y1 && y <= y0)) {
      const t = y1 === y0 ? 0 : (y - y0) / (y1 - y0);
      return CRACK[i - 2] + (CRACK[i] - CRACK[i - 2]) * t;
    }
  }
  return y < CRACK[1] ? CRACK[0] : CRACK[CRACK.length - 2];
}

/** Where the chip is, for the glint that closes the crack. */
export const CHIP_AT = { x: (CHIP[0] + CHIP[2]) / 2, y: CHIP[5] - 2 } as const;

function paintFlower(c: Ctx): void {
  // A pressed violet lying in the cup, foreshortened as the inside is seen from above: a faded stem
  // with two leaves, five petals with a vein each, and a yellow eye.
  c.save();
  ellipsePath(c, 0, RIM_Y + 0.5, RIM_RX - 2.6, RIM_RY - 1.5);
  c.clip();
  c.translate(TEACUP_SECRET.x, TEACUP_SECRET.y + 0.2);
  c.scale(1.3, 0.55);
  c.lineCap = 'round';
  c.strokeStyle = 'rgba(88,116,70,0.92)';
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(-3, 3);
  c.bezierCurveTo(-9, 7, -15, 6, -23, 11);
  c.stroke();
  c.fillStyle = 'rgba(100,134,78,0.92)';
  for (const [x, y, a] of [[-11, 8.8, 0.45], [-18.5, 6.4, -0.55]] as const) {
    c.beginPath();
    c.ellipse(x, y, 4.8, 2, a, 0, Math.PI * 2);
    c.fill();
  }
  for (let i = 0; i < 5; i++) {
    c.save();
    c.rotate((i / 5) * Math.PI * 2 + 0.3);
    c.beginPath();
    c.ellipse(5.6, 0, 5.8, 3.3, 0, 0, Math.PI * 2);
    c.fillStyle = lin(c, 0, 0, 11.5, 0, [[0, '#5E4290'], [0.55, '#8467B8'], [1, '#A28BD0']]);
    c.fill();
    c.strokeStyle = 'rgba(58,34,96,0.55)';
    c.lineWidth = 0.5;
    c.stroke();
    c.beginPath();
    c.moveTo(1.6, 0);
    c.lineTo(8.8, 0);
    c.strokeStyle = 'rgba(52,30,90,0.45)';
    c.stroke();
    c.restore();
  }
  c.fillStyle = '#E6C255';
  c.beginPath();
  c.arc(0, 0, 2.2, 0, Math.PI * 2);
  c.fill();
  c.restore();
}
