// The feather: a long white goose-feather quill lying on the shelf. A curved shaft carries a broad
// trailing vane and a narrow leading one, both made of fine barbs that have parted here and there;
// a faint satin sheen runs along the lit vane; down curls at its base; the bare barrel is translucent
// and the cut nib is dark with old ink. Hidden detail (Revelio): a letter S written into the vane, like
// a watermark, in blue-violet ink on the shade layer (pale light on the screen-blended layer cannot
// show on a white vane). Authored along a straight frame (shaft on x), then laid down with a small tilt
// so it rests on the underside of its vane and its nib. Coordinates in mH; the sprite's origin is the
// middle of its base.

import { paintSprite, type ArtBox, type CanvasFactory, type Sprite } from './canvas';
import { paintHeap, type Solid } from './common';
import { grain, lin, noiseTile, rng, type Ctx } from './paint';

export const FEATHER_DUST = '#EFEDE6';

export interface FeatherArt {
  body: Sprite;
  ink: Sprite;
  hidden: null;
  heap: Sprite;
}

const NIB_X = -114;
const VANE_X = -62;
const TIP_X = 112;
/** How far the shaft curls up toward the tip. */
const CURL = 21;
/** The lying tilt, radians (negative lifts the tip). */
const LIE = -0.06;

const shaftY = (x: number): number => -CURL * ((x - NIB_X) / (TIP_X - NIB_X)) ** 2;
const vaneU = (x: number): number => (x - VANE_X) / (TIP_X - VANE_X);
/** Vane width profile: quick to widen near the base, widest a little before the middle, a rounded tip. */
const profile = (u: number): number => (u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u ** 0.82) ** 0.55 * (1 - 0.18 * u));
const upperW = (x: number): number => 23 * profile(vaneU(x));
const lowerW = (x: number): number => 11 * profile(Math.min(1, vaneU(x) * 1.04));

interface Layout {
  /** Translation that puts the laid-down feather's lowest point on y = 0, centred on x = 0. */
  dx: number;
  dy: number;
  box: ArtBox;
}

/** Lay the outline down and measure it, so the sprite stands exactly on the shelf. */
function layout(): Layout {
  const cos = Math.cos(LIE);
  const sin = Math.sin(LIE);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const visit = (x: number, y: number) => {
    const rx = x * cos - y * sin;
    const ry = x * sin + y * cos;
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry;
    if (ry > maxY) maxY = ry;
  };
  for (let x = NIB_X; x <= TIP_X; x += 2) {
    visit(x, shaftY(x) - upperW(x));
    visit(x, shaftY(x) + Math.max(lowerW(x), 1.8));
  }
  const dx = -(minX + maxX) / 2;
  const dy = -maxY;
  return { dx, dy, box: { x0: minX + dx - 4, y0: minY + dy - 4, x1: maxX + dx + 4, y1: 1 } };
}

const LAYOUT = layout();

/** Height of the laid-down feather in mH (the props use it to pivot and hang the feather). */
export const FEATHER_HEIGHT = -LAYOUT.box.y0;
/** Where the nib lies, mH right of the sprite's origin (negative: to the left). The shelf keeps a spot
 *  of old ink there. */
export const FEATHER_NIB_X = LAYOUT.dx + NIB_X * Math.cos(LIE) - shaftY(NIB_X) * Math.sin(LIE);
/** Half the laid-down feather's length, for its footprint. */
export const FEATHER_HALF = (LAYOUT.box.x1 - LAYOUT.box.x0) / 2 - 4;

/** Where the letter sits in the vane, in the shaft's frame. */
const LETTER_X = 34;
const LETTER_Y = (): number => shaftY(LETTER_X) - 11;

/** The letter's place in the laid-down sprite (Revelio's halo and glint). */
export const FEATHER_SECRET = (() => {
  const x = LETTER_X;
  const y = LETTER_Y();
  return {
    x: LAYOUT.dx + x * Math.cos(LIE) - y * Math.sin(LIE),
    y: LAYOUT.dy + x * Math.sin(LIE) + y * Math.cos(LIE),
    halo: 64,
  };
})();

/** Roughly where the feather is (common.ts Solid), laid down as its sprite is, for cutting Reducto's
 *  pieces: the vane either side of the shaft, from the nib to the tip. */
export const FEATHER_SOLID: readonly Solid[] = (() => {
  const cos = Math.cos(LIE);
  const sin = Math.sin(LIE);
  const pts: number[] = [];
  const put = (x: number, y: number): void => {
    pts.push(LAYOUT.dx + x * cos - y * sin, LAYOUT.dy + x * sin + y * cos);
  };
  for (let x = NIB_X; x <= TIP_X; x += 6) put(x, shaftY(x) - Math.max(upperW(x), 1.8));
  for (let x = TIP_X; x >= NIB_X; x -= 6) put(x, shaftY(x) + Math.max(lowerW(x), 1.8));
  return [{ poly: pts }];
})();

function laid(c: Ctx, paint: (c: Ctx) => void): void {
  c.save();
  c.translate(LAYOUT.dx, LAYOUT.dy);
  c.rotate(LIE);
  paint(c);
  c.restore();
}

export function buildFeatherArt(factory: CanvasFactory, res: number): FeatherArt | null {
  const tile = noiseTile(factory);
  const body = paintSprite(factory, res, LAYOUT.box, (c) => laid(c, (cc) => paintFeather(cc, tile)));
  const ink = paintSprite(factory, res, LAYOUT.box, (c) => laid(c, paintLetter));
  const heap = paintHeap(factory, res, 84, FEATHER_DUST, 23);
  if (!body || !ink || !heap) return null;
  return { body, ink, hidden: null, heap };
}

function upperPath(c: Ctx): void {
  const step = 2.5;
  c.beginPath();
  c.moveTo(VANE_X, shaftY(VANE_X));
  for (let x = VANE_X + step; x <= TIP_X; x += step) c.lineTo(x, shaftY(x) - upperW(x));
  c.quadraticCurveTo(TIP_X + 3, shaftY(TIP_X) - 1.5, TIP_X + 0.5, shaftY(TIP_X) + 0.4);
  for (let x = TIP_X; x >= VANE_X; x -= step) c.lineTo(x, shaftY(x));
  c.closePath();
}

function lowerPath(c: Ctx): void {
  const step = 2.5;
  c.beginPath();
  c.moveTo(VANE_X, shaftY(VANE_X));
  for (let x = VANE_X; x <= TIP_X; x += step) c.lineTo(x, shaftY(x));
  c.lineTo(TIP_X + 0.5, shaftY(TIP_X) + 0.4);
  for (let x = TIP_X - step; x >= VANE_X; x -= step) c.lineTo(x, shaftY(x) + lowerW(x));
  c.closePath();
}

/** Where the barbs have parted: a fraction along the vane, and which side. */
const SPLITS: readonly (readonly [number, 1 | -1])[] = [[0.34, 1], [0.58, 1], [0.79, 1], [0.48, -1]];

/** One barb from the shaft at x out to the edge of the vane on `side` (1 the broad upper vane, -1 the
 *  narrow lower one), as a quadratic curve sweeping toward the tip. */
function barb(c: Ctx, x: number, side: 1 | -1, out: number): void {
  const u = vaneU(x);
  const reach = side === 1 ? upperW : lowerW;
  const sweep = (side === 1 ? 12 : 7.5) * (1 - 0.4 * u);
  const ex = x + sweep;
  c.beginPath();
  c.moveTo(x, shaftY(x));
  c.quadraticCurveTo(x + sweep * 0.35, shaftY(x + sweep * 0.35) - side * reach(ex) * 0.72, ex, shaftY(ex) - side * reach(ex) * out);
}

function paintFeather(c: Ctx, tile: ReturnType<typeof noiseTile>): void {
  const r = rng(7);

  // The broad trailing vane faces the light; the narrow leading vane is turned a little from it.
  upperPath(c);
  c.fillStyle = lin(c, 0, -30, 0, 0, [[0, '#CFCDCC'], [0.3, '#ECE8E0'], [0.72, '#FAF6EE'], [1, '#FFFCF6']]);
  c.fill();
  lowerPath(c);
  c.fillStyle = lin(c, 0, -2, 0, 12, [[0, '#E2DDD3'], [0.55, '#BDBAB8'], [1, '#8E92A0']]);
  c.fill();

  for (const side of [1, -1] as const) {
    c.save();
    if (side === 1) upperPath(c);
    else lowerPath(c);
    c.clip();
    // Toward the tip the vane thins and greys; near the candle it warms.
    c.fillStyle = lin(c, VANE_X, 0, TIP_X, 0, [[0, 'rgba(255,226,180,0.2)'], [0.35, 'rgba(255,255,255,0)'], [0.75, 'rgba(140,146,170,0.1)'], [1, 'rgba(130,136,160,0.36)']]);
    c.fillRect(VANE_X, -40, TIP_X - VANE_X + 6, 60);
    // Barbs: a fine pale ridge for each, lit on its upper side...
    c.lineWidth = 0.42;
    for (let x = VANE_X + 0.5; x < TIP_X - 1.5; x += 1.25) {
      c.strokeStyle = `rgba(255,255,255,${0.3 + r() * 0.35})`;
      barb(c, x, side, 1.03);
      c.stroke();
    }
    // ...lying in soft clumps, with a darker parting every few barbs: what makes a vane read as
    // feather rather than as paper.
    for (let x = VANE_X + 1.5; x < TIP_X - 2; x += 2 + r() * 1.6) {
      c.lineWidth = 0.5 + r() * 0.35;
      c.strokeStyle = side === 1 ? `rgba(104,102,114,${0.22 + r() * 0.22})` : `rgba(70,74,92,${0.26 + r() * 0.2})`;
      barb(c, x, side, 1.03);
      c.stroke();
    }
    // The satin sheen of a clean feather, a soft band near the shaft on the lit vane.
    if (side === 1) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      for (let x = VANE_X + 8; x < TIP_X - 8; x += 3) {
        const u = vaneU(x);
        c.fillStyle = `rgba(255,244,222,${0.06 * Math.sin(Math.PI * u)})`;
        c.beginPath();
        c.ellipse(x, shaftY(x) - upperW(x) * 0.36, 3.2, upperW(x) * 0.16 + 0.3, -0.5, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    }
    grain(c, tile, 0.08, 3, -0.9, VANE_X, -32, TIP_X + 4, 14);
    c.restore();
  }

  // Partings where barbs have come unzipped, and the fringed edge of the vane, where the barb tips
  // stand apart, looser toward the base: so its outline is never a clean curve.
  c.save();
  c.globalCompositeOperation = 'destination-out';
  for (const [u, side] of SPLITS) {
    const sx = VANE_X + u * (TIP_X - VANE_X);
    const reach = side === 1 ? upperW : lowerW;
    const ex = sx + (side === 1 ? 8.5 : 5);
    c.globalAlpha = 0.9;
    c.beginPath();
    c.moveTo(sx + 3.5, shaftY(sx) - side * reach(sx) * 0.55);
    c.lineTo(ex - 0.5, shaftY(ex) - side * (reach(ex) + 1.2));
    c.lineTo(ex + 0.9, shaftY(ex) - side * (reach(ex) + 1.2));
    c.closePath();
    c.fill();
  }
  for (let x = VANE_X + 2; x < TIP_X - 3; x += 1.4 + r() * 1.6) {
    const side = r() < 0.72 ? 1 : -1;
    const reach = side === 1 ? upperW : lowerW;
    const loose = 1 - vaneU(x);
    const y = shaftY(x + 2) - side * reach(x + 2) * 1.02;
    c.globalAlpha = 0.5 + r() * 0.4;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + 1.4, y + side * (0.5 + r() * 1.2 + loose * 2.2));
    c.lineTo(x + 2.2, y);
    c.closePath();
    c.fill();
  }
  c.restore();

  // A soft edge so the white vane holds against a pale room, darker underneath.
  upperPath(c);
  c.strokeStyle = 'rgba(110,110,122,0.28)';
  c.lineWidth = 0.45;
  c.stroke();
  lowerPath(c);
  c.strokeStyle = 'rgba(60,64,84,0.45)';
  c.stroke();

  // Down near the base: soft curling wisps, faint so they read as fluff, not as marks.
  c.lineCap = 'round';
  for (let i = 0; i < 40; i++) {
    const x = VANE_X - 8 + i * 0.62 + r() * 1.5;
    const up = i % 4 === 0 ? 1 : -1;
    const len = 7 + r() * 9;
    const curl = (r() - 0.3) * 6;
    c.lineWidth = 0.3 + r() * 0.35;
    c.strokeStyle = `rgba(250,248,244,${0.14 + r() * 0.2})`;
    c.beginPath();
    c.moveTo(x, shaftY(x));
    c.bezierCurveTo(x + 2.5, shaftY(x) + up * len * 0.35, x + curl, shaftY(x) + up * len * 0.8, x + 3 + curl, shaftY(x) + up * len);
    c.stroke();
  }

  // The rachis: a tapering ivory shaft along the vane, lit on top.
  c.beginPath();
  for (let x = VANE_X; x <= TIP_X; x += 4) c.lineTo(x, shaftY(x) - 1.7 * (1 - 0.82 * vaneU(x)));
  for (let x = TIP_X; x >= VANE_X; x -= 4) c.lineTo(x, shaftY(x) + 1.4 * (1 - 0.82 * vaneU(x)));
  c.closePath();
  c.fillStyle = lin(c, 0, -2, 0, 2, [[0, '#FFF8E6'], [0.5, '#E4D7B8'], [1, '#9E9070']]);
  c.fill();
  c.strokeStyle = 'rgba(255,255,248,0.8)';
  c.lineWidth = 0.4;
  c.beginPath();
  for (let x = VANE_X; x <= TIP_X - 10; x += 6) c.lineTo(x, shaftY(x) - 0.9 * (1 - 0.82 * vaneU(x)));
  c.stroke();

  // The barrel: bare quill, translucent, with the pith showing through and a bright reflection.
  const bx0 = NIB_X + 9;
  c.beginPath();
  c.moveTo(VANE_X + 1, shaftY(VANE_X) - 2);
  c.lineTo(bx0, shaftY(bx0) - 1.9);
  c.lineTo(NIB_X, shaftY(NIB_X) + 0.6);
  c.lineTo(bx0 - 1, shaftY(bx0 - 1) + 2);
  c.lineTo(VANE_X + 1, shaftY(VANE_X) + 2);
  c.closePath();
  c.fillStyle = lin(c, 0, -2.2, 0, 2.2, [[0, '#FFF6DC'], [0.35, '#E8D9AE'], [0.7, '#C2A877'], [1, '#8C744C']]);
  c.fill();
  c.strokeStyle = 'rgba(110,88,52,0.55)';
  c.lineWidth = 0.45;
  c.stroke();
  c.strokeStyle = 'rgba(140,112,70,0.35)';
  c.lineWidth = 0.7;
  c.beginPath();
  c.moveTo(VANE_X - 2, shaftY(VANE_X) + 0.5);
  c.lineTo(NIB_X + 16, shaftY(NIB_X + 16) + 0.4);
  c.stroke();
  c.strokeStyle = 'rgba(255,255,250,0.85)';
  c.lineWidth = 0.55;
  c.beginPath();
  c.moveTo(VANE_X - 3, shaftY(VANE_X) - 1.1);
  c.lineTo(NIB_X + 14, shaftY(NIB_X + 14) - 1);
  c.stroke();
  // Ink has soaked up from the nib and darkened the end of the quill.
  c.save();
  c.beginPath();
  c.moveTo(NIB_X + 24, shaftY(NIB_X + 24) - 2);
  c.lineTo(NIB_X, shaftY(NIB_X) + 0.6);
  c.lineTo(NIB_X + 24, shaftY(NIB_X + 24) + 2.2);
  c.closePath();
  c.fillStyle = lin(c, NIB_X, 0, NIB_X + 24, 0, [[0, 'rgba(16,14,26,0.95)'], [0.35, 'rgba(24,22,40,0.7)'], [1, 'rgba(30,28,48,0)']]);
  c.fill();
  c.restore();
  // The cut of the nib, its scoop catching a glint of wet ink, and its slit.
  c.fillStyle = 'rgba(190,196,230,0.55)';
  c.beginPath();
  c.ellipse(NIB_X + 4, shaftY(NIB_X + 4) - 0.4, 2.2, 0.5, -0.2, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = 'rgba(8,8,14,0.9)';
  c.lineWidth = 0.4;
  c.beginPath();
  c.moveTo(NIB_X + 1.2, shaftY(NIB_X + 1.2) + 0.5);
  c.lineTo(NIB_X + 10, shaftY(NIB_X + 10) + 0.3);
  c.stroke();
}

function paintLetter(c: Ctx): void {
  // A serif S inside the broad half of the vane, a little past the middle, in blue-violet ink that
  // has soaked into the barbs (a soft wash) with a crisper stroke over it.
  c.save();
  c.translate(LETTER_X, LETTER_Y());
  c.rotate(-0.25);
  c.scale(1.4, 1.4);
  c.lineCap = 'round';
  for (const pass of [{ w: 3, a: 0.2 }, { w: 1.2, a: 0.88 }]) {
    c.lineWidth = pass.w;
    c.strokeStyle = `rgba(62,72,146,${pass.a})`;
    c.beginPath();
    c.moveTo(3.2, -4.6);
    c.bezierCurveTo(1.6, -6.4, -3.4, -6.2, -3.3, -3.2);
    c.bezierCurveTo(-3.2, -0.4, 3.4, -0.6, 3.4, 2.6);
    c.bezierCurveTo(3.4, 6.0, -2.4, 6.4, -3.6, 4.2);
    c.stroke();
    // Serifs.
    c.beginPath();
    c.moveTo(3.2, -4.6);
    c.lineTo(3.6, -6.2);
    c.moveTo(-3.6, 4.2);
    c.lineTo(-4.0, 5.9);
    c.stroke();
  }
  c.restore();
}
