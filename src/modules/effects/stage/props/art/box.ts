// The box: an oak casket with a domed lid, bound with wrought-iron straps and rivets, its corners capped
// in brass, standing on four bracket feet. An ornate brass escutcheon frames the keyhole and the hasp
// drops over its staple. The lid swings back on a hinge at the rear of the rim, so its faces are
// separate sprites that the prop stretches as they foreshorten (see BOX_GEOMETRY and lidFaces()).
// Inside: oxblood velvet, which catches a faint glow when it opens. Hidden detail (Revelio): an
// original rune inlaid in the lid. Coordinates in mH, origin at the middle of the front base edge.

import { drawSprite, paintSprite, type CanvasFactory, type Sprite } from './canvas';
import {
  BRASS, IRON, PAL, cylinder, edgeLight, ellipsePath, grain, knot, lin, noiseTile, polyline, rad, rayFleck, rivet, rng, roundRectPath,
  speckle, woodGrain, type Ctx,
} from './paint';

/** Box proportions. The view is from slightly above: a horizontal surface of depth d shows as E·d. */
export const BOX_GEOMETRY = {
  /** Half the width. */
  hw: 94,
  /** Height of the body's front face (the rim the lid closes on). */
  rim: 82,
  /** Thickness of the lid's front band, below the dome. */
  band: 26,
  /** Depth front to back. */
  depth: 100,
  /** Elevation factor of the view. */
  e: 0.42,
  /** How far the lid swings open, radians. */
  open: 1.83,
} as const;

const G = BOX_GEOMETRY;
const HINGE_Y = -G.rim - G.e * G.depth;
const LID_TOP_Y = -G.rim - G.band;
const LID_BACK_Y = LID_TOP_Y - G.e * G.depth;
/** The iron straps' centres across the front, and their width. */
const STRAP_X = 60;
const STRAP_W = 9;

export const BOX_DUST = '#6A4A2C';

export interface BoxArt {
  /** The whole box shut (front, lid band, dome): the base class's body; a shattered box's outline is
   *  made from it. */
  body: Sprite;
  /** The rune is silver light on dark wood, so it needs no ink (the box draws it on the lid itself). */
  ink: null;
  /** The rune as it sits on the shut lid. */
  hidden: Sprite;
  front: Sprite;
  opening: Sprite;
  lidTop: Sprite;
  lidBand: Sprite;
  lidInner: Sprite;
  hasp: Sprite;
  runeTop: Sprite;
  runeInner: Sprite;
  heap: null;
}

/** Screen y (mH) of the lid's edges at angle θ, and which faces show. Pure, for the prop to draw with. */
export interface LidFaces {
  hingeY: number;
  frontBottomY: number;
  frontTopY: number;
  backTopY: number;
}

/** Project the lid at angle θ (0 closed). A lid point at height h above the hinge and z toward the
 *  viewer rotates to h' = h·cosθ + z·sinθ, z' = −h·sinθ + z·cosθ; screen y = −(rim + h') + e·(z' − depth). */
export function lidFaces(theta: number, out: LidFaces): LidFaces {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const y = (h: number, z: number) => -(G.rim + h * c + z * s) + G.e * (-h * s + z * c - G.depth);
  out.hingeY = y(0, 0);
  out.frontBottomY = y(0, G.depth);
  out.frontTopY = y(G.band, G.depth);
  out.backTopY = y(G.band, 0);
  return out;
}

export function buildBoxArt(factory: CanvasFactory, res: number): BoxArt | null {
  const hw = G.hw;
  const tile = noiseTile(factory);
  const front = paintSprite(factory, res, { x0: -hw - 3, y0: -G.rim - 1, x1: hw + 3, y1: 1 }, (c) => paintFront(c, tile));
  const opening = paintSprite(factory, res, { x0: -hw, y0: HINGE_Y, x1: hw, y1: -G.rim }, (c) => paintOpening(c, tile));
  const lidTop = paintSprite(factory, res, { x0: -hw - 3, y0: LID_BACK_Y, x1: hw + 3, y1: LID_TOP_Y }, (c) => paintDome(c, tile));
  const lidBand = paintSprite(factory, res, { x0: -hw - 3, y0: LID_TOP_Y, x1: hw + 3, y1: -G.rim }, (c) => paintLidBand(c, tile));
  const lidInner = paintSprite(factory, res, { x0: -hw, y0: -G.depth, x1: hw, y1: 0 }, (c) => paintLidInner(c, tile));
  const hasp = paintSprite(factory, res, { x0: -9, y0: -4, x1: 9, y1: 34 }, paintHasp);
  const runeTop = paintSprite(factory, res, { x0: -hw, y0: LID_BACK_Y, x1: hw, y1: LID_TOP_Y }, (c) => {
    c.translate(0, (LID_BACK_Y + LID_TOP_Y) / 2 + 2);
    c.scale(1.3, G.e * 1.3);
    paintRune(c);
  });
  const runeInner = paintSprite(factory, res, { x0: -hw, y0: -G.depth, x1: hw, y1: 0 }, (c) => {
    c.translate(0, -G.depth / 2);
    c.scale(1.5, 1.5);
    paintRune(c);
  });
  if (!front || !lidTop || !lidBand) return null;
  // The shut box is the three faces it shows, copied together once rather than painted again.
  const closed = paintSprite(factory, res, { x0: -hw - 3, y0: LID_BACK_Y - 1, x1: hw + 3, y1: 1 }, (c) => {
    drawSprite(c, front);
    drawSprite(c, lidBand);
    drawSprite(c, lidTop);
  });
  if (!opening || !lidInner || !hasp || !runeTop || !runeInner || !closed) return null;
  // Shattered, the box leaves its wreck (buildBoxWreck), not a heap of dust.
  return { body: closed, ink: null, hidden: runeTop, front, opening, lidTop, lidBand, lidInner, hasp, runeTop, runeInner, heap: null };
}

type Tile = ReturnType<typeof noiseTile>;

/** Oak boards: base color, grain, ray fleck, fibre, and the candle's light from the left. */
function oakBoard(c: Ctx, tile: Tile, x0: number, y0: number, x1: number, y1: number, seed: number, top = '#5A3B22', bottom = '#2A1B0F'): void {
  c.fillStyle = lin(c, 0, y0, 0, y1, [[0, top], [1, bottom]]);
  c.fillRect(x0, y0, x1 - x0, y1 - y0);
  woodGrain(c, x0, y0, x1, y1, seed, { color: PAL.oakDeep, alpha: 0.6, gap: 2.4, wave: 1.5, width: 0.6, stepX: 5 });
  woodGrain(c, x0, y0, x1, y1, seed + 1, { color: PAL.oakGlow, alpha: 0.13, gap: 4.6, wave: 1.2, width: 0.5, stepX: 5 });
  rayFleck(c, x0, y0, x1, y1, seed + 2, Math.round(((x1 - x0) * (y1 - y0)) / 90), '#C49A64', 0.18, 3.2);
  grain(c, tile, 0.26, 10, 0, x0, y0, x1, y1);
  sideLight(c, x0, x1, y0, y1);
}

/** Warm light from the left (the candle's side), cool shade deepening to the right, and a thin edge of
 *  moonlight at the far right. */
function sideLight(c: Ctx, x0: number, x1: number, y0: number, y1: number, strength = 1): void {
  c.fillStyle = lin(c, x0, 0, x1, 0, [
    [0, `rgba(255,196,128,${0.24 * strength})`], [0.35, 'rgba(0,0,0,0)'], [0.6, `rgba(8,8,16,${0.18 * strength})`],
    [0.93, `rgba(6,6,14,${0.55 * strength})`], [0.975, `rgba(90,104,140,${0.3 * strength})`], [1, `rgba(6,6,14,${0.4 * strength})`],
  ]);
  c.fillRect(x0, y0, x1 - x0, y1 - y0);
}

/** A wrought-iron strap from (x0, y0) to (x1, y1), axis-aligned, with domed rivets along it. */
function strap(c: Ctx, x0: number, y0: number, x1: number, y1: number, rivetGap: number, seed: number): void {
  const vertical = x1 - x0 < y1 - y0;
  c.fillStyle = 'rgba(4,3,2,0.5)';
  c.fillRect(x0 + 1, y0 + 1, x1 - x0, y1 - y0);
  c.fillStyle = vertical ? cylinder(c, x0, x1, IRON, 1) : lin(c, 0, y0, 0, y1, [[0, IRON.light], [0.3, IRON.mid], [0.75, IRON.dark], [1, IRON.deep]]);
  c.fillRect(x0, y0, x1 - x0, y1 - y0);
  // Hammer marks and a little rust where damp has sat.
  c.save();
  c.beginPath();
  c.rect(x0, y0, x1 - x0, y1 - y0);
  c.clip();
  speckle(c, x0, y0, x1, y1, seed, Math.round(((x1 - x0) * (y1 - y0)) / 16), [PAL.rust, '#0A0A0C', '#6A6870'], 0.35, 1, 0.4);
  c.restore();
  c.strokeStyle = 'rgba(150,150,158,0.35)';
  c.lineWidth = 0.5;
  c.beginPath();
  if (vertical) {
    c.moveTo(x0 + 0.5, y0);
    c.lineTo(x0 + 0.5, y1);
  } else {
    c.moveTo(x0, y0 + 0.5);
    c.lineTo(x1, y0 + 0.5);
  }
  c.stroke();
  const len = vertical ? y1 - y0 : x1 - x0;
  const n = Math.max(1, Math.round(len / rivetGap));
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 0.5 : (i + 0.5) / (n + 1);
    const x = vertical ? (x0 + x1) / 2 : x0 + t * (x1 - x0);
    const y = vertical ? y0 + t * (y1 - y0) : (y0 + y1) / 2;
    rivet(c, x, y, 1.7, IRON);
  }
}

/** A brass corner cap: an L of metal with a lobed inner edge; (sx, sy) point into the face. */
function cornerCap(c: Ctx, x: number, y: number, sx: number, sy: number, leg = 17, w = 5.5): void {
  c.beginPath();
  c.moveTo(x, y);
  c.lineTo(x + sx * leg, y);
  c.quadraticCurveTo(x + sx * (leg - 1), y + sy * w * 0.9, x + sx * (w + 2.5), y + sy * w);
  c.quadraticCurveTo(x + sx * w * 1.6, y + sy * w * 1.6, x + sx * w, y + sy * (w + 2.5));
  c.quadraticCurveTo(x + sx * w * 0.9, y + sy * (leg - 1), x, y + sy * leg);
  c.closePath();
  c.fillStyle = 'rgba(4,3,2,0.45)';
  c.save();
  c.translate(1, 1);
  c.fill();
  c.restore();
  c.fillStyle = lin(c, x, y, x + sx * leg, y + sy * leg, [[0, PAL.brassShine], [0.3, PAL.brassLight], [0.65, PAL.brass], [1, PAL.brassDark]]);
  c.fill();
  c.strokeStyle = 'rgba(30,18,6,0.8)';
  c.lineWidth = 0.6;
  c.stroke();
  rivet(c, x + sx * 3, y + sy * 3, 1.3);
}

function paintFront(c: Ctx, tile: Tile): void {
  const hw = G.hw;
  const top = -G.rim;
  const foot = 7;
  // The body: two boards with a seam between them, standing on a plinth with bracket feet.
  c.save();
  c.beginPath();
  c.rect(-hw, top, hw * 2, G.rim - foot);
  c.clip();
  oakBoard(c, tile, -hw, top, hw, -44, 31, '#5E3E24', '#3A2616');
  oakBoard(c, tile, -hw, -44, hw, -foot, 34, '#56381F', '#24170D');
  knot(c, -34, -26, 4.2, 2.2, 0.7);
  c.fillStyle = 'rgba(6,4,2,0.85)';
  c.fillRect(-hw, -44.6, hw * 2, 1.2);
  c.fillStyle = 'rgba(214,170,116,0.18)';
  c.fillRect(-hw, -43.4, hw * 2, 0.6);
  // The lid's shadow along the top of the front.
  c.fillStyle = lin(c, 0, top, 0, top + 7, [[0, 'rgba(0,0,0,0.6)'], [1, 'rgba(0,0,0,0)']]);
  c.fillRect(-hw, top, hw * 2, 7);
  c.restore();
  // The plinth: a moulded rail along the foot, cut away between the feet.
  c.beginPath();
  c.moveTo(-hw - 2.5, -foot - 4);
  c.lineTo(hw + 2.5, -foot - 4);
  c.lineTo(hw + 2.5, 0);
  c.lineTo(hw - 20, 0);
  c.quadraticCurveTo(hw - 24, -4, hw - 32, -4.4);
  c.lineTo(-hw + 32, -4.4);
  c.quadraticCurveTo(-hw + 24, -4, -hw + 20, 0);
  c.lineTo(-hw - 2.5, 0);
  c.closePath();
  c.fillStyle = lin(c, 0, -foot - 4, 0, 0, [[0, '#8A6240'], [0.25, '#5A3B22'], [1, '#170E07']]);
  c.fill();
  c.save();
  c.clip();
  grain(c, tile, 0.24, 10, 0, -hw - 3, -foot - 4, hw + 3, 0);
  sideLight(c, -hw - 3, hw + 3, -foot - 4, 0);
  c.restore();
  c.strokeStyle = 'rgba(6,4,2,0.85)';
  c.lineWidth = 0.8;
  c.stroke();
  // Edges of the body: a lit arris on the left, darkness on the right.
  c.strokeStyle = 'rgba(8,5,3,0.9)';
  c.lineWidth = 1;
  c.strokeRect(-hw, top, hw * 2, G.rim - foot - 4);
  c.strokeStyle = 'rgba(226,176,116,0.35)';
  c.lineWidth = 0.8;
  c.beginPath();
  c.moveTo(-hw + 0.9, top + 4);
  c.lineTo(-hw + 0.9, -foot - 6);
  c.stroke();

  // Iron: a band under the rim, one above the plinth, and two uprights.
  strap(c, -hw, top + 3, hw, top + 3 + STRAP_W * 0.8, 15, 41);
  strap(c, -hw, -foot - 4 - STRAP_W * 0.8, hw, -foot - 4, 15, 42);
  for (const s of [-1, 1]) strap(c, s * STRAP_X - STRAP_W / 2, top + 3, s * STRAP_X + STRAP_W / 2, -foot - 4, 13, 43 + s);
  cornerCap(c, -hw, -foot - 4, 1, -1);
  cornerCap(c, hw, -foot - 4, -1, -1);
  cornerCap(c, -hw, top, 1, 1, 14, 5);
  cornerCap(c, hw, top, -1, 1, 14, 5);
  paintEscutcheon(c);
}

/** The escutcheon: a brass cartouche with scrolled sides round the keyhole, and the staple the hasp
 *  drops over at its top. */
function paintEscutcheon(c: Ctx): void {
  const cx = 0;
  const cy = -46;
  const plate = () => {
    c.beginPath();
    c.moveTo(cx, cy - 26);
    c.bezierCurveTo(cx + 7, cy - 26, cx + 9, cy - 21, cx + 14, cy - 21);
    c.bezierCurveTo(cx + 21, cy - 21, cx + 22, cy - 13, cx + 17, cy - 11);
    c.bezierCurveTo(cx + 13, cy - 9.5, cx + 13, cy - 4, cx + 17, cy - 1);
    c.bezierCurveTo(cx + 22, cy + 3, cx + 19, cy + 12, cx + 12, cy + 12);
    c.bezierCurveTo(cx + 8, cy + 12, cx + 6, cy + 17, cx, cy + 22);
    c.bezierCurveTo(cx - 6, cy + 17, cx - 8, cy + 12, cx - 12, cy + 12);
    c.bezierCurveTo(cx - 19, cy + 12, cx - 22, cy + 3, cx - 17, cy - 1);
    c.bezierCurveTo(cx - 13, cy - 4, cx - 13, cy - 9.5, cx - 17, cy - 11);
    c.bezierCurveTo(cx - 22, cy - 13, cx - 21, cy - 21, cx - 14, cy - 21);
    c.bezierCurveTo(cx - 9, cy - 21, cx - 7, cy - 26, cx, cy - 26);
    c.closePath();
  };
  c.save();
  c.translate(1.6, 1.8);
  plate();
  c.fillStyle = 'rgba(4,2,1,0.55)';
  c.fill();
  c.restore();
  plate();
  c.fillStyle = rad(c, cx - 8, cy - 14, 1, cx, cy - 2, 30, [[0, PAL.brassShine], [0.25, PAL.brassLight], [0.6, PAL.brass], [0.85, PAL.brassDark], [1, PAL.brassDeep]]);
  c.fill();
  c.save();
  plate();
  c.clip();
  speckle(c, cx - 22, cy - 26, cx + 22, cy + 22, 51, 60, [PAL.patina, PAL.brassDeep], 0.3, 0.8, 0.45);
  c.restore();
  plate();
  c.strokeStyle = 'rgba(30,18,6,0.9)';
  c.lineWidth = 0.8;
  c.stroke();
  // An engraved line inside the edge, and scrolls curling in the lobes.
  c.save();
  c.translate(cx, cy - 2);
  c.scale(0.8, 0.82);
  c.translate(-cx, -(cy - 2));
  plate();
  c.restore();
  c.strokeStyle = 'rgba(40,24,6,0.6)';
  c.lineWidth = 0.6;
  c.stroke();
  c.strokeStyle = 'rgba(255,236,186,0.4)';
  c.lineWidth = 0.4;
  c.save();
  c.translate(0.4, 0.5);
  c.stroke();
  c.restore();
  for (const s of [-1, 1]) {
    c.strokeStyle = 'rgba(40,24,6,0.7)';
    c.lineWidth = 0.6;
    c.beginPath();
    c.arc(cx + s * 15.5, cy - 15, 2.6, 0, Math.PI * 1.6 * s);
    c.stroke();
    c.beginPath();
    c.arc(cx + s * 15, cy + 5.5, 2.4, Math.PI, Math.PI + Math.PI * 1.5 * s);
    c.stroke();
  }
  // The keyhole: a round head and a flared slot, deep and dark.
  c.fillStyle = '#080402';
  c.beginPath();
  c.arc(cx, cy - 3, 3.6, 0, Math.PI * 2);
  c.moveTo(cx - 1.7, cy - 1.5);
  c.lineTo(cx - 3, cy + 7.5);
  c.lineTo(cx + 3, cy + 7.5);
  c.lineTo(cx + 1.7, cy - 1.5);
  c.closePath();
  c.fill();
  c.strokeStyle = 'rgba(255,236,186,0.55)';
  c.lineWidth = 0.5;
  c.beginPath();
  c.moveTo(cx - 3, cy + 7.9);
  c.lineTo(cx + 3, cy + 7.9);
  c.stroke();
  // The staple: a little loop of brass the hasp falls over.
  roundRectPath(c, cx - 3.6, cy - 25, 7.2, 6, 2.4);
  c.fillStyle = lin(c, cx - 3.6, 0, cx + 3.6, 0, [[0, PAL.brassLight], [0.5, PAL.brass], [1, PAL.brassDeep]]);
  c.fill();
  c.fillStyle = PAL.brassDeep;
  c.fillRect(cx - 1.6, cy - 23.5, 3.2, 3.2);
  for (const [x, y] of [[cx - 10, cy - 15], [cx + 10, cy - 15], [cx - 8, cy + 8], [cx + 8, cy + 8]] as const) rivet(c, x, y, 1.15);
}

function paintOpening(c: Ctx, tile: Tile): void {
  const hw = G.hw;
  const y0 = HINGE_Y;
  const y1 = -G.rim;
  // The back wall's lining, deepening toward the front where the front wall shades it.
  c.fillStyle = lin(c, 0, y0, 0, y1, [[0, PAL.velvetLight], [0.3, PAL.velvet], [1, PAL.velvetDeep]]);
  c.fillRect(-hw, y0, hw * 2, y1 - y0);
  speckle(c, -hw, y0, hw, y1, 41, 160, ['#A0404F', '#1A0408'], 0.25, 0.6, 0.35);
  // Pleats in the lining.
  for (let x = -hw + 14; x < hw - 8; x += 16) {
    c.fillStyle = lin(c, x - 4, 0, x + 4, 0, [[0, 'rgba(0,0,0,0)'], [0.5, 'rgba(18,2,6,0.35)'], [1, 'rgba(0,0,0,0)']]);
    c.fillRect(x - 4, y0 + 4, 8, y1 - y0 - 4);
  }
  grain(c, tile, 0.18, 1, 0, -hw, y0, hw, y1);
  // The side walls seen edge on, the back wall's top edge, and the lit top edge of the front wall.
  c.fillStyle = lin(c, -hw, 0, -hw + 9, 0, [[0, PAL.oakDark], [1, 'rgba(40,20,10,0.2)']]);
  c.fillRect(-hw, y0, 9, y1 - y0);
  c.fillStyle = lin(c, hw - 9, 0, hw, 0, [[0, 'rgba(40,20,10,0.2)'], [1, PAL.oakDeep]]);
  c.fillRect(hw - 9, y0, 9, y1 - y0);
  c.fillStyle = lin(c, 0, y0, 0, y0 + 4, [[0, PAL.oakLight], [1, PAL.oak]]);
  c.fillRect(-hw, y0, hw * 2, 4);
  c.fillStyle = lin(c, 0, y1 - 4, 0, y1, [[0, PAL.oakGlow], [0.5, PAL.oakMid], [1, PAL.oak]]);
  c.fillRect(-hw, y1 - 4, hw * 2, 4);
  c.strokeStyle = 'rgba(8,4,2,0.85)';
  c.lineWidth = 0.8;
  c.strokeRect(-hw, y0, hw * 2, y1 - y0);
}

function paintLidBand(c: Ctx, tile: Tile): void {
  const hw = G.hw;
  const y0 = LID_TOP_Y;
  const y1 = -G.rim;
  c.save();
  c.beginPath();
  c.rect(-hw, y0, hw * 2, G.band);
  c.clip();
  oakBoard(c, tile, -hw, y0, hw, y1, 37, '#6E4A2C', '#3A2616');
  // It rounds over into the dome at the top.
  c.fillStyle = lin(c, 0, y0, 0, y0 + 8, [[0, 'rgba(255,214,160,0.22)'], [1, 'rgba(255,214,160,0)']]);
  c.fillRect(-hw, y0, hw * 2, 8);
  c.fillStyle = 'rgba(0,0,0,0.55)';
  c.fillRect(-hw, y1 - 1.6, hw * 2, 1.6);
  c.restore();
  c.strokeStyle = 'rgba(8,5,3,0.9)';
  c.lineWidth = 1;
  c.strokeRect(-hw, y0, hw * 2, G.band);
  // An iron edge along the lid's lip, and the uprights running on over the dome.
  strap(c, -hw, y1 - STRAP_W * 0.8 - 1, hw, y1 - 1, 15, 45);
  for (const s of [-1, 1]) strap(c, s * STRAP_X - STRAP_W / 2, y0, s * STRAP_X + STRAP_W / 2, y1 - STRAP_W * 0.8 - 1, 12, 46 + s);
  cornerCap(c, -hw, y1, 1, -1, 13, 4.5);
  cornerCap(c, hw, y1, -1, -1, 13, 4.5);
}

/** The dome's outline seen from the front: highest in the middle, falling toward the ends. */
const DOME_SHOULDER = LID_TOP_Y - (LID_TOP_Y - LID_BACK_Y) * 0.5;
const DOME_CTRL = { x: G.hw * 0.72, y: LID_BACK_Y - 1 } as const;

function domePath(c: Ctx): void {
  const hw = G.hw;
  c.beginPath();
  c.moveTo(-hw, LID_TOP_Y);
  c.lineTo(-hw, DOME_SHOULDER);
  c.bezierCurveTo(-DOME_CTRL.x, DOME_CTRL.y, DOME_CTRL.x, DOME_CTRL.y, hw, DOME_SHOULDER);
  c.lineTo(hw, LID_TOP_Y);
  c.closePath();
}

/** The height of the dome's outline above x, found along its curve. */
function domeTopAt(x: number): number {
  const hw = G.hw;
  let best = DOME_SHOULDER;
  let bestD = Infinity;
  for (let i = 0; i <= 64; i++) {
    const t = i / 64;
    const u = 1 - t;
    const bx = -hw * u * u * u - DOME_CTRL.x * 3 * u * u * t + DOME_CTRL.x * 3 * u * t * t + hw * t * t * t;
    const by = DOME_SHOULDER * (u * u * u + t * t * t) + DOME_CTRL.y * 3 * u * t;
    const d = Math.abs(bx - x);
    if (d < bestD) {
      bestD = d;
      best = by;
    }
  }
  return best;
}

function paintDome(c: Ctx, tile: Tile): void {
  const hw = G.hw;
  const y0 = LID_BACK_Y;
  const y1 = LID_TOP_Y;
  c.save();
  domePath(c);
  c.clip();
  oakBoard(c, tile, -hw, y0, hw, y1, 39, '#2E1E11', '#6A4729');
  // Rounded: lit along its crown on the candle's side, falling away behind.
  c.fillStyle = rad(c, -hw * 0.45, y0 + (y1 - y0) * 0.55, 2, -hw * 0.3, y0 + (y1 - y0) * 0.6, hw * 1.3, [
    [0, 'rgba(255,206,146,0.28)'], [0.4, 'rgba(255,206,146,0.08)'], [1, 'rgba(0,0,0,0)'],
  ]);
  c.fillRect(-hw, y0, hw * 2, y1 - y0);
  c.fillStyle = lin(c, 0, y0, 0, y1, [[0, 'rgba(0,0,0,0.5)'], [0.35, 'rgba(0,0,0,0)'], [0.85, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.35)']]);
  c.fillRect(-hw, y0, hw * 2, y1 - y0);
  // The uprights continue over the dome to its outline (clipped there, so they follow the curve).
  for (const s of [-1, 1]) {
    const x = s * STRAP_X;
    strap(c, x - STRAP_W / 2, domeTopAt(x) - 2, x + STRAP_W / 2, y1, 9, 48 + s);
  }
  c.restore();
  domePath(c);
  c.strokeStyle = 'rgba(8,5,3,0.9)';
  c.lineWidth = 1;
  c.stroke();
  domePath(c);
  edgeLight(c, -hw, hw, 1.2, 0.45, 0.3);
  // Brass caps over the dome's front corners.
  for (const s of [-1, 1]) {
    c.beginPath();
    c.moveTo(s * hw, y1);
    c.lineTo(s * (hw - 15), y1);
    c.quadraticCurveTo(s * (hw - 4), y1 - 4, s * hw, y1 - 13);
    c.closePath();
    c.fillStyle = lin(c, s * hw, y1 - 13, s * (hw - 15), y1, [[0, PAL.brassShine], [0.5, PAL.brass], [1, PAL.brassDark]]);
    c.fill();
    c.strokeStyle = 'rgba(30,18,6,0.8)';
    c.lineWidth = 0.6;
    c.stroke();
  }
}

function paintLidInner(c: Ctx, tile: Tile): void {
  const hw = G.hw;
  const d = G.depth;
  c.save();
  c.beginPath();
  c.rect(-hw, -d, hw * 2, d);
  c.clip();
  oakBoard(c, tile, -hw, -d, hw, 0, 36, '#4A3019', '#2A1B0F');
  c.restore();
  // A quilted velvet panel with little buttons.
  const px = -hw + 9;
  const py = -d + 9;
  const pw = hw * 2 - 18;
  const ph = d - 18;
  c.fillStyle = rad(c, -14, -d / 2 - 8, 4, 0, -d / 2, hw, [[0, PAL.velvetLight], [0.55, PAL.velvet], [1, PAL.velvetDeep]]);
  c.fillRect(px, py, pw, ph);
  c.save();
  c.beginPath();
  c.rect(px, py, pw, ph);
  c.clip();
  speckle(c, px, py, px + pw, py + ph, 43, 160, ['#A0404F', '#1A0408'], 0.25, 0.6, 0.3);
  const step = 21;
  const slope = 0.8;
  const rowGap = step / (2 * slope);
  // Each diamond of the quilting swells between its seams: a soft light on its upper left.
  for (let n = 0; n * rowGap < ph; n++) {
    const y = py + (n + 0.5) * rowGap;
    for (let j = -6; j <= 6; j++) {
      const x = j * step + ((n + 1) % 2 ? step / 2 : 0);
      c.fillStyle = rad(c, x - 3, y - 2.5, 0.5, x, y, rowGap * 0.95, [[0, 'rgba(196,84,100,0.3)'], [0.6, 'rgba(150,50,66,0.08)'], [1, 'rgba(20,2,6,0.18)']]);
      c.beginPath();
      c.ellipse(x, y, step * 0.5, rowGap, 0, 0, Math.PI * 2);
      c.fill();
    }
  }
  // The panel sinks into shadow toward its frame.
  c.fillStyle = rad(c, -10, py + ph * 0.45, 4, 0, py + ph / 2, pw * 0.62, [[0, 'rgba(0,0,0,0)'], [0.7, 'rgba(10,0,3,0.2)'], [1, 'rgba(10,0,3,0.6)']]);
  c.fillRect(px, py, pw, ph);
  c.strokeStyle = 'rgba(16,2,6,0.55)';
  c.lineWidth = 0.8;
  c.beginPath();
  for (let k = -12; k <= 12; k++) {
    c.moveTo(k * step, py);
    c.lineTo(k * step + ph * slope, py + ph);
    c.moveTo(k * step, py);
    c.lineTo(k * step - ph * slope, py + ph);
  }
  c.stroke();
  c.strokeStyle = 'rgba(200,110,120,0.16)';
  c.lineWidth = 0.6;
  c.beginPath();
  for (let k = -12; k <= 12; k++) {
    c.moveTo(k * step + 1.2, py);
    c.lineTo(k * step + 1.2 + ph * slope, py + ph);
  }
  c.stroke();
  grain(c, tile, 0.16, 1, 0, px, py, px + pw, py + ph);
  c.restore();
  for (let n = 1; n * rowGap < ph - 3; n++) {
    for (let j = -6; j <= 6; j++) {
      const x = j * step + (n % 2 ? step / 2 : 0);
      if (Math.abs(x) > pw / 2 - 4) continue;
      c.fillStyle = rad(c, x - 0.5, py + n * rowGap - 0.5, 0.1, x, py + n * rowGap, 1.8, [[0, '#E0B070'], [0.5, PAL.gold], [1, PAL.goldRecess]]);
      c.beginPath();
      c.arc(x, py + n * rowGap, 1.5, 0, Math.PI * 2);
      c.fill();
    }
  }
  c.strokeStyle = 'rgba(10,5,2,0.75)';
  c.lineWidth = 0.9;
  c.strokeRect(px, py, pw, ph);
  c.strokeStyle = 'rgba(8,5,3,0.9)';
  c.lineWidth = 1;
  c.strokeRect(-hw, -d, hw * 2, d);
  // Hinge leaves at the bottom (the hinge line).
  for (const s of [-1, 1]) {
    c.fillStyle = cylinder(c, s * 62 - 9, s * 62 + 9, BRASS, 1);
    c.fillRect(s * 62 - 9, -7, 18, 6);
    rivet(c, s * 62 - 4.5, -4, 1.1);
    rivet(c, s * 62 + 4.5, -4, 1.1);
  }
}

function paintHasp(c: Ctx): void {
  // Hinge knuckle, an iron strap with a shaped end, and the slot that drops over the staple.
  roundRectPath(c, -8, -3.4, 16, 6.8, 3.4);
  c.fillStyle = lin(c, 0, -3.4, 0, 3.4, [[0, IRON.shine], [0.4, IRON.light], [1, IRON.deep]]);
  c.fill();
  c.strokeStyle = 'rgba(0,0,0,0.8)';
  c.lineWidth = 0.6;
  c.stroke();
  c.beginPath();
  c.moveTo(-5, 2);
  c.lineTo(5, 2);
  c.lineTo(5.6, 24);
  c.quadraticCurveTo(7.5, 27, 4, 29);
  c.lineTo(0, 33);
  c.lineTo(-4, 29);
  c.quadraticCurveTo(-7.5, 27, -5.6, 24);
  c.closePath();
  c.fillStyle = cylinder(c, -6, 6, IRON, 1);
  c.fill();
  c.stroke();
  roundRectPath(c, -2, 17, 4, 8, 1.4);
  c.fillStyle = '#050505';
  c.fill();
  rivet(c, 0, 7, 1.4, IRON);
}

// ------------------------------------------------------------------ the wreck (Reducto)

/** Where the wreck is painted, in mH round the box's home (y = 0 the shelf line at its front base; the
 *  shelf's top board shows from y = −24 at the glass to y = +12 at its front edge). */
export const BOX_WRECK_AREA = { x0: -136, y0: -68, x1: 140, y1: 15 } as const;

/** Fresh oak where it has just been torn: paler than the old polished surface. */
const RAW = 'rgba(200,154,100,0.7)';

/**
 * The box after Reducto, as it lies on the shelf until Reparo: a corner of the front still bound by its
 * strap and brass caps, leaning on a piece of the domed lid that fell behind it, two broken staves, a bent
 * iron strap, the escutcheon, the hasp and a corner cap lying loose, with chips, splinters and sawdust
 * round them. Lit from the candle's side and shadowed on the shelf like everything else on it. Painted
 * the first time the box is shattered (most boxes never are).
 */
export function buildBoxWreck(factory: CanvasFactory, res: number): Sprite | null {
  const tile = noiseTile(factory);
  return paintSprite(factory, res, BOX_WRECK_AREA, (c) => paintWreck(c, tile));
}

/** A soft shadow on the shelf under something resting there. */
function restShadow(c: Ctx, x: number, y: number, rx: number, ry: number, alpha: number): void {
  c.fillStyle = rad(c, x, y, 0, x, y, rx, [[0, `rgba(4,3,2,${alpha})`], [0.55, `rgba(4,3,2,${alpha * 0.5})`], [1, 'rgba(4,3,2,0)']]);
  c.save();
  c.translate(x, y);
  c.scale(1, ry / rx);
  c.translate(-x, -y);
  c.beginPath();
  c.arc(x, y, rx, 0, Math.PI * 2);
  c.fill();
  c.restore();
}

/** One end of a board broken across its grain, from (x, y0) to (x, y1), the break slanting a little:
 *  splinters stand out of it along the grain, each a narrow sliver to a sharp point, most short, a few
 *  long, never evenly spaced. `dir` is the way the board's end faces. Flat [x, y, ...] points, top to
 *  bottom. */
function tornEnd(r: () => number, x: number, y0: number, y1: number, dir: 1 | -1, reach: number): number[] {
  const span = y1 - y0;
  const slant = (r() - 0.5) * reach * 1.6;
  const at = (t: number): number => x + dir * slant * (t - 0.5);
  const pts: number[] = [at(0), y0];
  let t = 0;
  while (t < 1) {
    const step = Math.min(1 - t, 0.07 + r() * 0.24);
    const long = r() < 0.22 ? 1.5 + r() * 1.5 : 0.25 + r() * 0.75;
    // Out to the sliver's point, bent a little, then back to the break a little further on.
    const tip = t + step * (0.3 + r() * 0.4);
    pts.push(at(tip) + dir * reach * long * 0.7, y0 + span * tip + (r() - 0.5) * span * 0.04);
    t += step;
    pts.push(at(t) - dir * reach * r() * 0.22, y0 + span * t);
  }
  return pts;
}

/** The pale, torn fibre of a fresh break along `end`, a few mH into the wood. Call inside the piece's
 *  clip, so only the inner half of the stroke shows. */
function rawBand(c: Ctx, end: readonly number[]): void {
  c.save();
  c.lineJoin = 'round';
  c.strokeStyle = 'rgba(170,124,74,0.42)';
  c.lineWidth = 3.6;
  polyline(c, end);
  c.restore();
}

/** The break's fine pale edge, over the piece's outline. */
function rawEdge(c: Ctx, end: readonly number[]): void {
  c.lineJoin = 'round';
  c.strokeStyle = RAW;
  c.lineWidth = 0.7;
  polyline(c, end);
}

interface Board {
  /** Half its length along the grain, its face's height, and the edge showing below the face. */
  hl: number;
  face: number;
  edge: number;
  leftTorn: boolean;
  rightTorn: boolean;
  seed: number;
  top: string;
  bottom: string;
}

/** A stave of the box in its own frame: grain along x, its face from y = −face to 0, its thickness
 *  showing below as a darker edge, broken ends splintered and pale. */
function board(c: Ctx, tile: Tile, r: () => number, b: Board): void {
  const left = b.leftTorn ? tornEnd(r, -b.hl, -b.face, b.edge, -1, b.face * 0.45) : [-b.hl, -b.face, -b.hl, b.edge];
  const right = b.rightTorn ? tornEnd(r, b.hl, -b.face, b.edge, 1, b.face * 0.45) : [b.hl, -b.face, b.hl, b.edge];
  const outline = (): void => {
    c.beginPath();
    c.moveTo(left[0], left[1]);
    for (let i = 0; i < right.length; i += 2) c.lineTo(right[i], right[i + 1]);
    for (let i = left.length - 2; i >= 0; i -= 2) c.lineTo(left[i], left[i + 1]);
    c.closePath();
  };
  const x0 = -b.hl - b.face;
  const x1 = b.hl + b.face;
  // Its shadow on whatever it lies across, thrown away from the candle.
  c.save();
  c.translate(2.4, 2);
  outline();
  c.fillStyle = 'rgba(4,3,2,0.42)';
  c.fill();
  c.restore();
  c.save();
  outline();
  c.clip();
  oakBoard(c, tile, x0, -b.face, x1, 0, b.seed, b.top, b.bottom);
  // The edge: end-on to us, darker, its corner with the face caught by the light.
  c.fillStyle = lin(c, 0, 0, 0, b.edge, [[0, '#3E2816'], [1, '#160D06']]);
  c.fillRect(x0, 0, x1 - x0, b.edge);
  c.fillStyle = 'rgba(232,184,124,0.38)';
  c.fillRect(x0, -0.5, x1 - x0, 0.7);
  c.fillStyle = 'rgba(255,214,160,0.16)';
  c.fillRect(x0, -b.face, x1 - x0, 1);
  // Torn fibres at the breaks: paler wood, and dark splits running back along the grain.
  c.strokeStyle = 'rgba(40,26,14,0.55)';
  c.lineWidth = 0.45;
  for (const [end, torn, inward] of [[left, b.leftTorn, 1], [right, b.rightTorn, -1]] as const) {
    if (!torn) continue;
    rawBand(c, end);
    c.beginPath();
    for (let i = 2; i < end.length; i += 4) {
      c.moveTo(end[i], end[i + 1]);
      c.lineTo(end[i] + inward * (3 + r() * 7), end[i + 1] + (r() - 0.5) * 0.8);
    }
    c.stroke();
  }
  c.restore();
  outline();
  c.strokeStyle = 'rgba(8,5,3,0.85)';
  c.lineWidth = 0.7;
  c.stroke();
  if (b.leftTorn) rawEdge(c, left);
  if (b.rightTorn) rawEdge(c, right);
}

/** A piece of the domed lid that fell behind: its front band with the iron lip, the dome above with an
 *  upright strap and a brass cap at its whole end, broken off at the other. Base on y = 0. */
function lidPiece(c: Ctx, tile: Tile, r: () => number): void {
  const hw = 52;
  const band = G.band;
  const right = tornEnd(r, hw, -band - 18, 0, 1, 9);
  const dome = (): void => {
    c.beginPath();
    c.moveTo(-hw, 0);
    c.lineTo(-hw, -band - 6);
    c.bezierCurveTo(-hw * 0.6, -band - 22, hw * 0.2, -band - 24, right[0], right[1]);
    for (let i = 2; i < right.length; i += 2) c.lineTo(right[i], right[i + 1]);
    c.closePath();
  };
  c.save();
  dome();
  c.clip();
  oakBoard(c, tile, -hw - 4, -band - 26, hw + 12, -band, 39, '#2E1E11', '#6A4729');
  oakBoard(c, tile, -hw - 4, -band, hw + 12, 0, 37, '#6E4A2C', '#3A2616');
  // The dome rounds away from the band; its crown catches the candle on the left.
  c.fillStyle = lin(c, 0, -band - 26, 0, -band, [[0, 'rgba(0,0,0,0.45)'], [0.6, 'rgba(255,206,146,0.12)'], [1, 'rgba(0,0,0,0.3)']]);
  c.fillRect(-hw - 4, -band - 26, hw * 2 + 16, 26);
  strap(c, -hw - 4, -STRAP_W * 0.8 - 1, hw + 12, -1, 15, 61);
  strap(c, -22 - STRAP_W / 2, -band - 26, -22 + STRAP_W / 2, -STRAP_W * 0.8 - 1, 10, 62);
  rawBand(c, right);
  // It lies at the back of the pile, in the shadow of everything in front of it.
  c.fillStyle = lin(c, 0, -band - 26, 0, 0, [[0, 'rgba(6,4,2,0.12)'], [0.55, 'rgba(6,4,2,0.3)'], [1, 'rgba(6,4,2,0.62)']]);
  c.fillRect(-hw - 4, -band - 26, hw * 2 + 16, band + 26);
  c.restore();
  dome();
  c.strokeStyle = 'rgba(8,5,3,0.9)';
  c.lineWidth = 0.9;
  c.stroke();
  rawEdge(c, right);
  cornerCap(c, -hw, -1, 1, -1, 13, 4.5);
}

/** The front's left corner, still bound: oak boards, the upright strap, the rail of iron under the rim
 *  and the brass caps at both corners, torn away along its right and lower right. Its foot on y = 0. */
function cornerPiece(c: Ctx, tile: Tile, r: () => number): void {
  const w = 58;
  const h = 62;
  const right = tornEnd(r, w, -h, -10, 1, 10);
  const shape = (): void => {
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(0, -h);
    for (let i = 0; i < right.length; i += 2) c.lineTo(right[i], right[i + 1]);
    c.lineTo(w * 0.62, -4);
    c.lineTo(w * 0.4, 0);
    c.closePath();
  };
  // Its shadow on the lid behind it.
  c.save();
  c.translate(3, 1.5);
  shape();
  c.fillStyle = 'rgba(4,3,2,0.45)';
  c.fill();
  c.restore();
  c.save();
  shape();
  c.clip();
  oakBoard(c, tile, -2, -h, w + 14, -26, 31, '#5E3E24', '#3A2616');
  oakBoard(c, tile, -2, -26, w + 14, 0, 34, '#56381F', '#24170D');
  c.fillStyle = 'rgba(6,4,2,0.85)';
  c.fillRect(0, -26.6, w + 14, 1.2);
  strap(c, 0, -h + 3, w + 14, -h + 3 + STRAP_W * 0.8, 15, 63);
  strap(c, 34 - STRAP_W / 2, -h + 3, 34 + STRAP_W / 2, -2, 13, 64);
  rawBand(c, right);
  c.restore();
  shape();
  c.strokeStyle = 'rgba(8,5,3,0.9)';
  c.lineWidth = 1;
  c.stroke();
  rawEdge(c, right);
  // A lit arris down the whole edge, and the caps.
  c.strokeStyle = 'rgba(226,176,116,0.4)';
  c.lineWidth = 0.8;
  c.beginPath();
  c.moveTo(0.9, -h + 4);
  c.lineTo(0.9, -3);
  c.stroke();
  cornerCap(c, 0, -h, 1, 1, 14, 5);
  cornerCap(c, 0, 0, 1, -1);
}

/** An iron strap bent where the blast caught it: two runs at an angle, rivets still in it, its end torn
 *  through a rivet hole. Starts at the origin, running right. */
function bentStrap(c: Ctx, len1: number, len2: number, bend: number): void {
  const w = STRAP_W * 0.75;
  strap(c, 0, -w / 2, len1 + 1, w / 2, 14, 65);
  c.save();
  c.translate(len1, 0);
  c.rotate(bend);
  strap(c, 0, -w / 2, len2, w / 2, 14, 66);
  // Torn through its last hole: a ragged end and an empty eye.
  c.fillStyle = '#0A0908';
  c.beginPath();
  c.arc(len2 - 3, 0, 1.3, 0, Math.PI * 2);
  c.fill();
  c.restore();
  // The bend itself catches the light.
  c.fillStyle = 'rgba(190,190,196,0.35)';
  c.beginPath();
  c.ellipse(len1, -w * 0.2, 2.2, w * 0.4, bend / 2, 0, Math.PI * 2);
  c.fill();
}

function paintWreck(c: Ctx, tile: Tile): void {
  const r = rng(4417);
  // The pile's shadow on the shelf, deepest in the middle and leaning away from the candle.
  restShadow(c, 10, 3, 132, 12, 0.5);
  restShadow(c, 6, 1, 84, 7, 0.4);
  // Sawdust under everything.
  speckle(c, -118, -3, 124, 10, 71, 240, ['#8A6240', '#4A3019', '#B88A58'], 0.35, 0.95, 0.75);

  // At the back: the piece of the lid, propped on the rubble at its broken end.
  restShadow(c, -40, -7, 62, 5, 0.45);
  c.save();
  c.translate(-44, -8);
  c.rotate(-0.13);
  lidPiece(c, tile, r);
  c.restore();

  // The front's corner, leaning back against the lid.
  restShadow(c, -96, 4, 34, 4.5, 0.5);
  c.save();
  c.translate(-124, 4);
  c.rotate(0.46);
  cornerPiece(c, tile, r);
  c.restore();

  // A short stave propped up at the right, and a long one fallen across the front.
  restShadow(c, 86, 3, 34, 4, 0.45);
  c.save();
  c.translate(88, -12);
  c.rotate(-0.42);
  board(c, tile, r, { hl: 30, face: 12, edge: 4, leftTorn: true, rightTorn: true, seed: 81, top: '#5E3E24', bottom: '#2E1E11' });
  c.restore();
  restShadow(c, 24, 6, 70, 5, 0.5);
  c.save();
  c.translate(22, 3);
  c.rotate(0.05);
  board(c, tile, r, { hl: 64, face: 14, edge: 4.5, leftTorn: true, rightTorn: true, seed: 83, top: '#6A4729', bottom: '#3A2616' });
  c.restore();

  // Iron and brass, lying loose in front.
  c.save();
  c.translate(2, 10.5);
  c.rotate(-0.05);
  bentStrap(c, 50, 32, -0.5);
  c.restore();
  restShadow(c, -34, 11, 19, 4, 0.55);
  c.save();
  c.translate(-36, 9);
  c.rotate(0.18);
  c.scale(0.74, 0.36);
  c.translate(0, 46);
  paintEscutcheon(c);
  c.restore();
  c.save();
  c.translate(-62, 11.5);
  c.rotate(1.48);
  c.scale(0.72, 0.72);
  paintHasp(c);
  c.restore();
  restShadow(c, 116, 9, 9, 2.5, 0.5);
  c.save();
  c.translate(110, 9);
  c.rotate(-0.5);
  c.scale(1, 0.55);
  cornerCap(c, 0, 0, 1, -1, 15, 5);
  c.restore();

  // Chips of oak, each with its own small shadow, splinters, and rivets torn out of the straps.
  const tones = ['#8A6240', '#6A4729', '#4A3019', '#B88A58'];
  for (let i = 0; i < 34; i++) {
    const x = (r() * 2 - 1) * 126;
    const y = 8 - r() * 12 * Math.max(0, 1 - Math.abs(x) / 150);
    const s = 1.2 + r() * 2.6;
    const a = r() * Math.PI;
    c.save();
    c.translate(x, y);
    c.rotate(a);
    c.fillStyle = 'rgba(4,3,2,0.45)';
    c.fillRect(-s * 0.5 + 0.7, -s * 0.3 + 0.6, s, s * 0.6);
    c.fillStyle = tones[i % tones.length];
    c.beginPath();
    c.moveTo(-s * 0.55, -s * 0.2);
    c.lineTo(s * 0.1, -s * 0.38);
    c.lineTo(s * 0.55, s * 0.12);
    c.lineTo(-s * 0.15, s * 0.32);
    c.closePath();
    c.fill();
    c.restore();
  }
  c.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    const x = (r() * 2 - 1) * 118;
    const y = 9 - r() * 9;
    const len = 5 + r() * 11;
    const a = (r() - 0.5) * 0.9 + (r() < 0.5 ? 0 : Math.PI);
    const dx = Math.cos(a) * len;
    const dy = Math.sin(a) * len * 0.5;
    c.strokeStyle = 'rgba(4,3,2,0.45)';
    c.lineWidth = 1.4;
    c.beginPath();
    c.moveTo(x + 0.6, y + 0.8);
    c.lineTo(x + dx + 0.6, y + dy + 0.8);
    c.stroke();
    c.strokeStyle = i % 3 === 0 ? RAW : '#7A5634';
    c.lineWidth = 0.6 + r() * 0.7;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + dx, y + dy);
    c.stroke();
  }
  for (const [x, y] of [[-8, 9], [58, 10], [-100, 9], [96, 7]] as const) rivet(c, x, y, 1.5, IRON);
}

/** An original sigil: a stem crowned with a ring, two raised branches, a chevron root, two dots, and a
 *  broken circle around it. */
function paintRune(c: Ctx): void {
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const pass of [{ w: 3.2, a: 0.22 }, { w: 1.25, a: 1 }]) {
    c.lineWidth = pass.w;
    c.strokeStyle = `rgba(220,229,245,${pass.a})`;
    c.beginPath();
    c.moveTo(0, -8);
    c.lineTo(0, 11);
    c.moveTo(0, -1);
    c.lineTo(-8, -8);
    c.moveTo(0, -1);
    c.lineTo(8, -8);
    c.moveTo(-7, 12);
    c.lineTo(0, 5.5);
    c.lineTo(7, 12);
    c.stroke();
    c.beginPath();
    c.arc(0, -11.2, 3.2, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.arc(0, 0, 17, -1.25, 1.25);
    c.stroke();
    c.beginPath();
    c.arc(0, 0, 17, Math.PI - 1.25, Math.PI + 1.25);
    c.stroke();
  }
  c.fillStyle = 'rgba(220,229,245,1)';
  for (const x of [-11.5, 11.5]) {
    ellipsePath(c, x, 1, 1.4, 1.4);
    c.fill();
  }
}
