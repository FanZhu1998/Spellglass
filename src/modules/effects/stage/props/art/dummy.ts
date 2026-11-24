// The training dummy: a wooden duelling dummy. A sturdy oak post stands in a cross foot with two braces;
// on it a padded torso of stitched leather and canvas, with a target worked into the leather of its
// chest, straw poking from its seams and scorch marks where spells have hit it; carved wooden arms
// pegged through the post at the shoulders, with a wooden wand gripped in the left fist; a plain padded
// head. Parts are separate sprites so the dummy can rock, topple, swing its arms and lose its wand.
// Costumes (Riddikulus, all original): a paper party hat, a ruff collar, a polka-dot bow. Hidden
// detail (Revelio): someone's chalked tally of hits, and a little star, on the torso. Coordinates in
// mH; each part has its own origin (below).
//
// The head has no face on purpose. The dummy is a thing to practise on, never a character: the
// restricted section's curses are "drawn as abstract light and sound on the wooden dummy" (Section 8),
// and a face that recoils or drops would undo that. A plain padded head also makes it the "wooden
// training dummy" of Section 7.8.

import { makeOutline, makeTinted, paintSprite, type CanvasFactory, type Sprite } from './canvas';
import {
  BEECH, CANVAS, IRON, LEATHER, OAK, PAL, cylinder, edgeLight, ellipsePath, grain, lin, noiseTile, rad, rayFleck, rivet, rng,
  roundRectPath, sphere, stitches, weave, woodGrain, type Ctx,
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
  const stand = paintSprite(factory, res, { x0: -70, y0: -66, x1: 70, y1: 11 }, (c) => paintStand(c, tile));
  const torso = paintSprite(factory, res, { x0: -54, y0: -262, x1: 54, y1: -24 }, (c) => paintTorso(c, tile));
  const arms = paintSprite(factory, res, { x0: -124, y0: -26, x1: 124, y1: 26 }, (c) => paintArms(c, tile));
  const head = paintSprite(factory, res, { x0: -44, y0: -44, x1: 44, y1: 44 }, (c) => paintHead(c, tile));
  const wand = paintSprite(factory, res, { x0: -6, y0: -J.wandLength - 4, x1: 6, y1: 16 }, paintWand);
  if (!stand || !torso || !arms || !head || !wand) return null;
  return { stand, torso, arms, head, wand };
}

export function buildDummyExtras(factory: CanvasFactory, res: number): DummyExtras | null {
  const s = COSTUME_SCALE;
  const hat = paintSprite(factory, res, { x0: -24 * s, y0: -66 * s, x1: 28 * s, y1: 66 * s }, (c) => scaled(c, paintHat));
  const ruff = paintSprite(factory, res, { x0: -48 * s, y0: -16 * s, x1: 48 * s, y1: 16 * s }, (c) => scaled(c, paintRuff));
  const bow = paintSprite(factory, res, { x0: -35 * s, y0: -16 * s, x1: 35 * s, y1: 16 * s }, (c) => scaled(c, paintBow));
  const chalk = paintSprite(factory, res, { x0: -48, y0: -44, x1: 48, y1: 44 }, paintChalk);
  if (!hat || !ruff || !bow || !chalk) return null;
  return { hat, ruff, bow, chalk };
}

function scaled(c: Ctx, paint: (c: Ctx) => void): void {
  c.save();
  c.scale(COSTUME_SCALE, COSTUME_SCALE);
  paint(c);
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

/** An oak beam between two points, `half` thick, lit from the upper left, with its end grain shown at
 *  (x0, y0) when `endFace` is set. */
function beam(c: Ctx, tile: Tile, x0: number, y0: number, x1: number, y1: number, half: number, seed: number, endFace: boolean): void {
  const len = Math.hypot(x1 - x0, y1 - y0);
  const a = Math.atan2(y1 - y0, x1 - x0);
  c.save();
  c.translate(x0, y0);
  c.rotate(a);
  c.beginPath();
  c.rect(0, -half, len, half * 2);
  c.fillStyle = lin(c, 0, -half, 0, half, [[0, '#8A6240'], [0.18, '#6A4729'], [0.55, '#3A2616'], [1, '#170E07']]);
  c.fill();
  c.save();
  c.clip();
  woodGrain(c, 0, -half, len, half, seed, { color: PAL.oakDeep, alpha: 0.6, gap: 1.9, wave: 0.8, width: 0.5, stepX: 4 });
  rayFleck(c, 0, -half, len, half, seed + 1, Math.round(len / 7), '#C49A64', 0.16, 2.6);
  grain(c, tile, 0.24, 8, a, 0, -half, len, half);
  c.restore();
  c.strokeStyle = 'rgba(6,4,2,0.85)';
  c.lineWidth = 0.8;
  c.strokeRect(0, -half, len, half * 2);
  c.strokeStyle = 'rgba(232,186,128,0.35)';
  c.lineWidth = 0.6;
  c.beginPath();
  c.moveTo(1, -half + 0.6);
  c.lineTo(len - 1, -half + 0.6);
  c.stroke();
  c.restore();
  if (!endFace) return;
  // The sawn end: lighter, with its growth rings.
  c.save();
  c.translate(x0, y0);
  c.rotate(a);
  c.beginPath();
  c.moveTo(0, -half);
  c.lineTo(-4.5, -half + 2.5);
  c.lineTo(-4.5, half + 2.5);
  c.lineTo(0, half);
  c.closePath();
  c.fillStyle = lin(c, -4.5, 0, 0, 0, [[0, '#9A7048'], [1, '#6A4729']]);
  c.fill();
  c.strokeStyle = 'rgba(40,24,10,0.5)';
  c.lineWidth = 0.4;
  for (let i = 1; i <= 3; i++) {
    c.beginPath();
    c.ellipse(-2.6, 1.5 + half * 0.5, 1.2 * i, 2.2 * i, 0, 0, Math.PI * 2);
    c.stroke();
  }
  c.strokeStyle = 'rgba(6,4,2,0.85)';
  c.lineWidth = 0.7;
  c.beginPath();
  c.moveTo(0, -half);
  c.lineTo(-4.5, -half + 2.5);
  c.lineTo(-4.5, half + 2.5);
  c.lineTo(0, half);
  c.stroke();
  c.restore();
}

function paintStand(c: Ctx, tile: Tile): void {
  // Two heavy beams crossed under the post, seen from a little above: the near ends low and toward
  // us, the far ends higher, behind. The far halves first, then the socket, then the near halves and
  // the braces.
  beam(c, tile, 0, -12, 58, -26, 8.5, 201, false);
  beam(c, tile, 0, -12, -58, -26, 8.5, 202, false);
  // The socket block the post is wedged into, with an iron band round it.
  roundRectPath(c, -18, -44, 36, 34, 2.5);
  c.fillStyle = cylinder(c, -18, 18, OAK);
  c.fill();
  c.save();
  roundRectPath(c, -18, -44, 36, 34, 2.5);
  c.clip();
  woodGrain(c, -18, -44, 18, -10, 209, { color: PAL.oakDeep, alpha: 0.4, gap: 2.2, wave: 0.6, width: 0.45, stepX: 3 });
  grain(c, tile, 0.24, 6, Math.PI / 2, -18, -44, 18, -10);
  c.restore();
  c.strokeStyle = 'rgba(6,4,2,0.85)';
  c.lineWidth = 0.8;
  roundRectPath(c, -18, -44, 36, 34, 2.5);
  c.stroke();
  c.fillStyle = cylinder(c, -18.5, 18.5, IRON, 1);
  c.fillRect(-18.5, -36, 37, 6);
  rivet(c, -11, -33, 1.6, IRON);
  rivet(c, 11, -33, 1.6, IRON);
  beam(c, tile, -64, 6, 0, -12, 9, 203, true);
  beam(c, tile, 64, 6, 0, -12, 9, 204, true);
  // Braces from the near beams up to the post.
  for (const s of [-1, 1]) beam(c, tile, s * 40, -5, s * 11, -64, 5.5, 205 + s, false);
  // Where the foot meets the shelf, the light does not reach.
  c.fillStyle = lin(c, 0, -6, 0, 11, [[0, 'rgba(8,5,3,0)'], [1, 'rgba(8,5,3,0.5)']]);
  c.fillRect(-70, -6, 140, 17);
}

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

/** The leather panel down the front: from the collar to the hem, waisted with the body. */
function panelPath(c: Ctx): void {
  c.beginPath();
  c.moveTo(-22, -240);
  c.bezierCurveTo(-31, -200, -31, -162, -26, -142);
  c.bezierCurveTo(-24, -128, -26, -112, -29, -102);
  c.quadraticCurveTo(0, -97, 29, -102);
  c.bezierCurveTo(26, -112, 24, -128, 26, -142);
  c.bezierCurveTo(31, -162, 31, -200, 22, -240);
  c.quadraticCurveTo(0, -243, -22, -240);
  c.closePath();
}

/** Straw poking from a seam at (x, y), fanning out along `angle`: three shades of straw, one path each. */
function straw(c: Ctx, x: number, y: number, angle: number, n: number, len: number, seed: number): void {
  c.save();
  c.lineCap = 'round';
  const shades = [PAL.strawDark, PAL.straw, '#E2C98A'];
  for (let k = 0; k < shades.length; k++) {
    const r = rng(seed + k * 31);
    c.strokeStyle = shades[k];
    c.lineWidth = 0.6 + k * 0.12;
    c.beginPath();
    for (let i = k; i < n; i += shades.length) {
      const a = angle + (r() - 0.5) * 1.1;
      const l = len * (0.5 + r() * 0.7);
      c.moveTo(x + (r() - 0.5) * 3, y + (r() - 0.5) * 2);
      c.quadraticCurveTo(x + Math.cos(a) * l * 0.5 + (r() - 0.5) * 2, y + Math.sin(a) * l * 0.5, x + Math.cos(a) * l, y + Math.sin(a) * l);
    }
    c.stroke();
  }
  c.restore();
}

function paintTorso(c: Ctx, tile: Tile): void {
  // The post: below the torso down into the socket, and above it up into the head.
  for (const [y0, y1] of [[-262, -232], [-112, -38]] as const) {
    c.fillStyle = cylinder(c, -10, 10, OAK);
    c.fillRect(-10, y0, 20, y1 - y0);
    c.save();
    c.beginPath();
    c.rect(-10, y0, 20, y1 - y0);
    c.clip();
    woodGrain(c, -10, y0, 10, y1, 211, { color: PAL.oakDeep, alpha: 0.4, gap: 2, wave: 0.4, width: 0.4, stepX: 4 });
    grain(c, tile, 0.26, 10, Math.PI / 2, -10, y0, 10, y1);
    c.restore();
    c.strokeStyle = 'rgba(6,4,2,0.85)';
    c.lineWidth = 0.7;
    c.strokeRect(-10, y0, 20, y1 - y0);
    c.strokeStyle = 'rgba(232,186,128,0.3)';
    c.beginPath();
    c.moveTo(-9.2, y0 + 1);
    c.lineTo(-9.2, y1 - 1);
    c.stroke();
  }
  // The torso's shadow on the post under it.
  c.fillStyle = lin(c, 0, -106, 0, -80, [[0, 'rgba(0,0,0,0.65)'], [1, 'rgba(0,0,0,0)']]);
  c.fillRect(-10, -106, 20, 26);

  // Canvas over the whole body, then the leather panel down the front.
  torsoPath(c);
  c.fillStyle = cylinder(c, -57, 57, CANVAS);
  c.fill();
  c.save();
  torsoPath(c);
  c.clip();
  weave(c, -58, -244, 58, -96, 2.1, PAL.canvasDeep, 0.24, 212);
  grain(c, tile, 0.22, 1, 0, -58, -244, 58, -96);
  // Quilted channels in the padding, each swelling between its stitch lines.
  for (const x of [-46, -37, 37, 46]) {
    c.fillStyle = lin(c, x - 4.5, 0, x + 4.5, 0, [[0, 'rgba(30,22,10,0)'], [0.5, 'rgba(30,22,10,0.32)'], [1, 'rgba(30,22,10,0)']]);
    c.fillRect(x - 4.5, -236, 9, 132);
  }
  panelPath(c);
  c.fillStyle = cylinder(c, -31, 31, LEATHER);
  c.fill();
  c.save();
  panelPath(c);
  c.clip();
  grain(c, tile, 0.3, 1, 0, -31, -243, 31, -97);
  // Scuffs and creases in the leather, and scorches where spells have struck it.
  const r = rng(213);
  for (let i = 0; i < 30; i++) {
    const x = -26 + r() * 52;
    const y = -236 + r() * 132;
    c.strokeStyle = `rgba(${r() < 0.5 ? '190,140,90' : '14,8,4'},${0.12 + r() * 0.16})`;
    c.lineWidth = 0.4 + r() * 0.5;
    c.beginPath();
    c.moveTo(x, y);
    c.quadraticCurveTo(x + 3, y + (r() - 0.5) * 3, x + 4 + r() * 6, y + (r() - 0.5) * 4);
    c.stroke();
  }
  paintTarget(c);
  for (const [x, y, rr] of [[17, -204, 11], [-15, -132, 8], [10, -146, 5]] as const) {
    c.fillStyle = rad(c, x, y, 0, x, y, rr, [[0, 'rgba(10,6,4,0.75)'], [0.5, 'rgba(24,12,6,0.4)'], [1, 'rgba(24,12,6,0)']]);
    c.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  c.restore();
  // The padding swells toward the candle: light on the upper left of the body, the rest in shade,
  // deepest on the right, away from it.
  c.fillStyle = rad(c, -24, -206, 2, -14, -186, 84, [[0, 'rgba(255,214,160,0.24)'], [0.5, 'rgba(255,214,160,0.05)'], [1, 'rgba(0,0,0,0)']]);
  c.fillRect(-58, -244, 116, 148);
  c.fillStyle = lin(c, -58, 0, 58, 0, [[0.45, 'rgba(8,6,12,0)'], [0.85, 'rgba(8,6,12,0.34)'], [1, 'rgba(8,6,12,0.2)']]);
  c.fillRect(-58, -244, 116, 148);
  c.fillStyle = lin(c, 0, -150, 0, -98, [[0, 'rgba(6,4,2,0)'], [1, 'rgba(6,4,2,0.45)']]);
  c.fillRect(-58, -150, 116, 54);
  c.restore();
  torsoPath(c);
  edgeLight(c, -57, 57, 1.6, 0.35, 0.35);
  torsoPath(c);
  c.strokeStyle = 'rgba(12,8,4,0.85)';
  c.lineWidth = 0.9;
  c.stroke();
  // The seams either side of the panel, stitched, with straw where they have split.
  for (const s of [-1, 1]) {
    stitches(c, [s * 22, -238, s * 30, -200, s * 29.5, -162, s * 25.5, -140, s * 26, -118, s * 29, -104], 5.4, 3, 0.55);
  }
  stitches(c, [-49, -106, -24, -99.5, 0, -100.5, 24, -99.5, 49, -106], 5.2, 2.8, 0.55);
  straw(c, -30, -202, Math.PI, 10, 13, 214);
  straw(c, 28, -150, 0, 8, 11, 215);
  straw(c, -38, -102, Math.PI * 0.62, 11, 14, 216);
  straw(c, 6, -99, Math.PI * 0.5, 10, 13, 217);
  straw(c, 42, -104, Math.PI * 0.38, 9, 12, 218);
  straw(c, -18, -240, -Math.PI * 0.62, 9, 12, 219);
  straw(c, 18, -240, -Math.PI * 0.4, 8, 11, 220);
  // A leather belt round the waist with an iron buckle.
  c.save();
  torsoPath(c);
  c.clip();
  c.fillStyle = lin(c, 0, -142, 0, -131, [[0, '#6E4524'], [0.4, PAL.leatherDark], [1, PAL.leatherDeep]]);
  c.beginPath();
  c.moveTo(-58, -143);
  c.quadraticCurveTo(0, -137, 58, -143);
  c.lineTo(58, -132);
  c.quadraticCurveTo(0, -126, -58, -132);
  c.closePath();
  c.fill();
  c.restore();
  stitches(c, [-46, -140.4, 0, -135.2, 46, -140.4], 3.8, 2.1, 0.45);
  roundRectPath(c, 26, -143.5, 12, 12.5, 1.8);
  c.strokeStyle = cylinder(c, 26, 38, IRON, 1);
  c.lineWidth = 2.4;
  c.stroke();
  c.fillStyle = IRON.light;
  c.fillRect(31.4, -141.5, 1.4, 8);
  // A collar of leather at the neck, where the post goes up into the head.
  c.beginPath();
  c.moveTo(-18, -236);
  c.quadraticCurveTo(0, -245, 18, -236);
  c.lineTo(16, -227);
  c.quadraticCurveTo(0, -234, -16, -227);
  c.closePath();
  c.fillStyle = cylinder(c, -18, 18, LEATHER);
  c.fill();
  c.strokeStyle = 'rgba(8,4,2,0.8)';
  c.lineWidth = 0.6;
  c.stroke();
}

/** The target worked into the chest: leather rings stitched one inside the other, dark and pale by
 *  turns, with an oxblood heart. */
function paintTarget(c: Ctx): void {
  const cx = 1;
  const cy = -176;
  for (const [rr, fill] of [[22, '#9A7448'], [15.5, '#3A2212'], [9.5, '#A8805A'], [4.6, PAL.oxblood]] as const) {
    c.fillStyle = rad(c, cx - rr * 0.35, cy - rr * 0.35, 0.5, cx, cy, rr, [[0, fill], [1, fill]]);
    c.beginPath();
    c.ellipse(cx, cy, rr, rr * 0.96, 0, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = 'rgba(8,4,2,0.6)';
    c.lineWidth = 0.6;
    c.stroke();
    const pts: number[] = [];
    for (let i = 0; i <= 28; i++) {
      const a = (i / 28) * Math.PI * 2;
      pts.push(cx + Math.cos(a) * (rr - 1.6), cy + Math.sin(a) * (rr - 1.6) * 0.96);
    }
    if (rr > 5) stitches(c, pts, 3.8, 1.8, 0.4, 'rgba(226,206,168,0.6)');
  }
  // The target is lit on its upper left like the rest of the padding.
  c.fillStyle = rad(c, cx - 9, cy - 9, 0.5, cx, cy, 23, [[0, 'rgba(255,220,170,0.25)'], [0.6, 'rgba(255,220,170,0)'], [1, 'rgba(0,0,0,0.3)']]);
  c.beginPath();
  c.arc(cx, cy, 22, 0, Math.PI * 2);
  c.fill();
}

/** One carved arm from the shoulder out to its fist, with its elbow peg; `s` is -1 (left) or 1. */
function paintArm(c: Ctx, tile: Tile, s: -1 | 1): void {
  const upper = () => {
    c.beginPath();
    c.moveTo(s * 16, -10.5);
    c.quadraticCurveTo(s * 40, -12, s * 62, -9);
    c.lineTo(s * 62, 9.5);
    c.quadraticCurveTo(s * 40, 12, s * 16, 10.5);
    c.closePath();
  };
  const fore = () => {
    c.beginPath();
    c.moveTo(s * 62, -8.6);
    c.quadraticCurveTo(s * 76, -10, s * 92, -7.4);
    c.lineTo(s * 92, 8);
    c.quadraticCurveTo(s * 76, 10, s * 62, 8.6);
    c.closePath();
  };
  for (const part of [upper, fore]) {
    part();
    c.fillStyle = lin(c, 0, -12, 0, 12, [[0, BEECH.shine], [0.18, BEECH.light], [0.5, BEECH.mid], [0.82, BEECH.dark], [1, BEECH.deep]]);
    c.fill();
    c.save();
    part();
    c.clip();
    woodGrain(c, -124, -12, 124, 12, 230 + s, { color: '#2E1B0D', alpha: 0.45, gap: 1.9, wave: 0.5, width: 0.4, stepX: 4 });
    grain(c, tile, 0.24, 9, 0, s < 0 ? -120 : 14, -12, s < 0 ? -14 : 120, 12);
    // Light falls along the arm from the candle's side.
    c.fillStyle = lin(c, -124, 0, 124, 0, [[0, 'rgba(255,200,140,0.18)'], [0.5, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,10,0.32)']]);
    c.fillRect(-124, -12, 248, 24);
    c.restore();
    part();
    c.strokeStyle = 'rgba(14,8,4,0.85)';
    c.lineWidth = 0.7;
    c.stroke();
  }
  // The elbow: a turned knuckle with an oak peg through it.
  c.fillStyle = sphere(c, s * 62, 0, 10.5, BEECH);
  c.beginPath();
  c.arc(s * 62, 0, 10.5, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = 'rgba(14,8,4,0.8)';
  c.lineWidth = 0.6;
  c.stroke();
  c.fillStyle = sphere(c, s * 62, 0, 3.6, OAK);
  c.beginPath();
  c.arc(s * 62, 0, 3.6, 0, Math.PI * 2);
  c.fill();
  // The fist: a carved block of a hand, its fingers grooved, the thumb along the top.
  const fx = s * 104;
  c.beginPath();
  c.moveTo(s * 90, -9.5);
  c.quadraticCurveTo(fx, -14, s * 114, -8.5);
  c.quadraticCurveTo(s * 118.5, 0, s * 114, 9);
  c.quadraticCurveTo(fx, 14, s * 90, 9.4);
  c.closePath();
  c.fillStyle = sphere(c, fx, 0, 14, BEECH);
  c.fill();
  c.strokeStyle = 'rgba(14,8,4,0.85)';
  c.lineWidth = 0.7;
  c.stroke();
  c.strokeStyle = 'rgba(30,16,6,0.6)';
  c.lineWidth = 0.7;
  for (const k of [-1, 0, 1]) {
    c.beginPath();
    c.moveTo(s * (102 + k * 4.2), -3.5);
    c.quadraticCurveTo(s * (103 + k * 4.2), 3, s * (102 + k * 4.2), 10);
    c.stroke();
  }
  c.strokeStyle = 'rgba(255,224,180,0.35)';
  c.beginPath();
  c.moveTo(s * 92, -8.8);
  c.quadraticCurveTo(fx, -12.4, s * 112, -7.8);
  c.stroke();
}

function paintArms(c: Ctx, tile: Tile): void {
  for (const s of [-1, 1] as const) paintArm(c, tile, s);
  // The shoulder block they are pegged through, and the iron bolt that holds it to the post.
  roundRectPath(c, -19, -14, 38, 28, 3);
  c.fillStyle = cylinder(c, -19, 19, OAK);
  c.fill();
  c.save();
  roundRectPath(c, -19, -14, 38, 28, 3);
  c.clip();
  woodGrain(c, -19, -14, 19, 14, 240, { color: PAL.oakDeep, alpha: 0.5, gap: 1.8, wave: 0.5, width: 0.4, stepX: 3 });
  grain(c, tile, 0.24, 8, 0, -19, -14, 19, 14);
  c.restore();
  roundRectPath(c, -19, -14, 38, 28, 3);
  c.strokeStyle = 'rgba(6,4,2,0.85)';
  c.lineWidth = 0.8;
  c.stroke();
  rivet(c, 0, 0, 4, IRON);
  c.strokeStyle = 'rgba(0,0,0,0.6)';
  c.lineWidth = 0.7;
  c.beginPath();
  c.moveTo(-2.4, 0);
  c.lineTo(2.4, 0);
  c.stroke();
}

/** The head's outline: a stuffed canvas sack, a little lumpy, gathered in at the bottom where it is
 *  tied on. */
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

function paintHead(c: Ctx, tile: Tile): void {
  const r = DUMMY_JOINTS.headRadius;
  const K = CAP;
  headPath(c);
  c.fillStyle = sphere(c, 0, -2, r, CANVAS);
  c.fill();
  c.save();
  headPath(c);
  c.clip();
  weave(c, -r, -r, r, r, 2.1, PAL.canvasDeep, 0.24, 251);
  grain(c, tile, 0.22, 1, 0, -r, -r, r, r);
  // Stuffed: it bulges between the seams, each bulge with its own light and shade.
  for (const [x, y, rr, a] of [[-15, -12, 22, 0.24], [14, -14, 20, 0.08], [-6, 16, 22, 0.1]] as const) {
    c.fillStyle = rad(c, x, y, 1, x, y, rr, [[0, `rgba(255,232,190,${a})`], [1, 'rgba(255,232,190,0)']]);
    c.fillRect(x - rr, y - rr, rr * 2, rr * 2);
  }
  // A cap of leather sewn over the crown, where the hits land.
  c.beginPath();
  c.moveTo(K.x0 * r, K.y0 * r);
  c.bezierCurveTo(K.c0x * r, K.c0y * r, K.c1x * r, K.c1y * r, K.x1 * r, K.y1 * r);
  c.bezierCurveTo(r * 0.5, K.under * r, -r * 0.5, K.under * r, K.x0 * r, K.y0 * r);
  c.closePath();
  c.fillStyle = sphere(c, -4, -r * 0.7, r * 0.9, LEATHER);
  c.fill();
  c.fillStyle = rad(c, 12, -r * 0.62, 0, 12, -r * 0.62, 8, [[0, 'rgba(8,4,2,0.6)'], [1, 'rgba(8,4,2,0)']]);
  c.fillRect(4, -r, 16, 16);
  c.fillStyle = rad(c, -10, -10, r * 0.3, 0, 0, r * 1.05, [[0, 'rgba(10,6,4,0)'], [0.7, 'rgba(10,6,4,0.2)'], [1, 'rgba(10,6,4,0.55)']]);
  c.fillRect(-r, -r, r * 2, r * 2);
  c.fillStyle = lin(c, -r, 0, r, 0, [[0.4, 'rgba(8,6,12,0)'], [0.88, 'rgba(8,6,12,0.32)'], [1, 'rgba(8,6,12,0.18)']]);
  c.fillRect(-r, -r, r * 2, r * 2);
  c.restore();
  headPath(c);
  edgeLight(c, -r, r, 1.5, 0.35, 0.4);
  // The cap's stitched lower edge, and a seam down the side of the sack.
  const cap: number[] = [];
  const side: number[] = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const u = 1 - t;
    cap.push(r * (K.x1 * u * u * u + 0.5 * 3 * u * u * t - 0.5 * 3 * u * t * t + K.x0 * t * t * t),
      r * (K.y1 * u * u * u + K.under * 3 * u * u * t + K.under * 3 * u * t * t + K.y0 * t * t * t));
    side.push(r * 0.5 + Math.sin(t * Math.PI) * r * 0.18, -r * 0.5 + t * r * 1.32);
  }
  stitches(c, cap, 4.4, 2.4, 0.5);
  c.strokeStyle = 'rgba(40,28,12,0.6)';
  c.lineWidth = 1.2;
  c.beginPath();
  c.moveTo(side[0], side[1]);
  for (let i = 2; i < side.length; i += 2) c.lineTo(side[i], side[i + 1]);
  c.stroke();
  stitches(c, side, 4.6, 2.4, 0.5);
  headPath(c);
  c.strokeStyle = 'rgba(16,10,4,0.82)';
  c.lineWidth = 0.9;
  c.stroke();
  // Tied on at the neck with a cord, the straw stuffing showing below it.
  straw(c, -8, r * 0.86, Math.PI * 0.6, 8, 10, 252);
  straw(c, 8, r * 0.86, Math.PI * 0.4, 7, 9, 253);
  c.lineWidth = 2.6;
  c.strokeStyle = lin(c, -14, 0, 14, 0, [[0, '#C8A86A'], [0.5, '#8E7040'], [1, '#4E3A1E']]);
  c.beginPath();
  c.ellipse(0, r * 0.88, r * 0.34, 2.6, 0, 0.1, Math.PI - 0.1);
  c.stroke();
  c.strokeStyle = 'rgba(60,40,16,0.7)';
  c.lineWidth = 0.5;
  for (let i = -4; i <= 4; i++) {
    c.beginPath();
    c.moveTo(i * 2.6 - 0.8, r * 0.88 + 0.8);
    c.lineTo(i * 2.6 + 0.8, r * 0.88 + 3.2);
    c.stroke();
  }
}

function paintWand(c: Ctx): void {
  // A wooden wand: origin at the grip, pointing up. A carved handle with rings and a pommel, a shaft
  // tapering to a pale tip, lit down its left side.
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
  // The handle, darker, carved in rings.
  c.fillStyle = lin(c, -g, 0, g, 0, [[0, '#8A5E36'], [0.35, '#5E3C1E'], [1, '#26160A']]);
  c.fillRect(-g - 1, -16, g * 2 + 2, 26);
  c.strokeStyle = 'rgba(16,8,2,0.85)';
  c.lineWidth = 0.7;
  for (const y of [4, -1.5, -7, -12.5]) {
    c.beginPath();
    c.moveTo(-g, y + 0.5);
    c.lineTo(g, y - 0.5);
    c.stroke();
  }
  c.strokeStyle = 'rgba(255,220,170,0.35)';
  c.lineWidth = 0.5;
  for (const y of [5, -0.5, -6, -11.5]) {
    c.beginPath();
    c.moveTo(-g, y + 0.5);
    c.lineTo(0, y);
    c.stroke();
  }
  c.strokeStyle = 'rgba(255,240,210,0.55)';
  c.lineWidth = 0.6;
  c.beginPath();
  c.moveTo(-g * 0.5, -17);
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

function paintHat(c: Ctx): void {
  // A paper party hat, origin at the crown; tilted so it sits jauntily.
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
  c.fillStyle = cylinder(c, -19, 19, {
    deep: 'rgba(0,0,0,0.5)', dark: 'rgba(0,0,0,0.32)', mid: 'rgba(0,0,0,0.1)', light: 'rgba(255,236,200,0.14)',
    shine: 'rgba(255,240,210,0.3)', rim: 'rgba(150,170,210,0.2)',
  });
  c.fillRect(-20, -60, 40, 66);
  c.restore();
  cone();
  c.strokeStyle = 'rgba(60,20,10,0.6)';
  c.lineWidth = 0.6;
  c.stroke();
  // Zigzag paper trim along the brim.
  c.beginPath();
  for (let i = 0; i <= 16; i++) {
    const a = Math.PI - (i / 16) * Math.PI;
    const rr = i % 2 === 0 ? 1 : 0.88;
    const x = Math.cos(a) * 19.5;
    const y = 2 + Math.sin(a) * 4.8 * rr - (i % 2 === 0 ? 0 : 2.6);
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.strokeStyle = PAL.vellum;
  c.lineWidth = 1.3;
  c.stroke();
  // Pom-pom.
  const r = rng(81);
  c.fillStyle = PAL.vellum;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    c.beginPath();
    c.arc(9 + Math.cos(a) * 4.2, -57 + Math.sin(a) * 4.2, 2.6 + r() * 0.8, 0, Math.PI * 2);
    c.fill();
  }
  c.fillStyle = sphere(c, 9, -57, 5.2, { deep: '#9F9580', dark: '#C9BFA6', mid: PAL.vellum, light: '#F7F1E2', shine: '#FFFFFF', rim: '#B8BCC8' });
  c.beginPath();
  c.arc(9, -57, 5.2, 0, Math.PI * 2);
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

function paintRuff(c: Ctx): void {
  // A white pleated ruff: scalloped outer edge, pleat lines, origin at the neck.
  const n = 26;
  const rx = 44;
  const ry = 12;
  const edge = () => {
    c.beginPath();
    for (let i = 0; i <= n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 0.5) / n) * Math.PI * 2;
      const a2 = ((i + 1) / n) * Math.PI * 2;
      const x0 = Math.cos(a0) * rx * 0.94;
      const y0 = Math.sin(a0) * ry * 0.94;
      if (i === 0) c.moveTo(x0, y0);
      if (i < n) c.quadraticCurveTo(Math.cos(a1) * rx * 1.08, Math.sin(a1) * ry * 1.12, Math.cos(a2) * rx * 0.94, Math.sin(a2) * ry * 0.94);
    }
    c.closePath();
  };
  edge();
  c.fillStyle = rad(c, -14, -6, 2, 0, 0, 48, [[0, '#FFFDF6'], [0.45, '#EDE6D6'], [0.85, '#C6BCA8'], [1, '#9C927C']]);
  c.fill();
  c.strokeStyle = 'rgba(110,100,82,0.7)';
  c.lineWidth = 0.6;
  c.stroke();
  c.strokeStyle = 'rgba(130,118,98,0.55)';
  c.lineWidth = 0.5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    c.beginPath();
    c.moveTo(Math.cos(a) * 13, Math.sin(a) * 4);
    c.lineTo(Math.cos(a) * rx * 0.93, Math.sin(a) * ry * 0.93);
    c.stroke();
  }
  ellipsePath(c, 0, -0.5, 13, 4);
  c.fillStyle = 'rgba(60,46,30,0.55)';
  c.fill();
}

function paintBow(c: Ctx): void {
  // A polka-dot bow, origin at the neck.
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
    c.strokeStyle = 'rgba(60,8,16,0.45)';
    c.lineWidth = 0.8;
    c.beginPath();
    c.moveTo(s * 4, -1);
    c.quadraticCurveTo(s * 16, -4, s * 26, -9);
    c.moveTo(s * 4, 1);
    c.quadraticCurveTo(s * 16, 4, s * 25, 7);
    c.stroke();
    c.restore();
    wing(s);
    c.strokeStyle = 'rgba(60,8,16,0.7)';
    c.lineWidth = 0.6;
    c.stroke();
  }
  roundRectPath(c, -4.6, -6, 9.2, 12, 3);
  c.fillStyle = lin(c, -4.6, 0, 4.6, 0, [[0, '#B8303F'], [0.5, '#8E1C2C'], [1, '#5E0E1A']]);
  c.fill();
  c.strokeStyle = 'rgba(60,8,16,0.7)';
  c.stroke();
}

function paintChalk(c: Ctx): void {
  // Someone has kept score in chalk: a tally of hits with a stroke through four of them, a little star
  // beside it, and a scrawled cross on the target. Rough, doubled strokes, as chalk leaves them.
  const r = rng(91);
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
  for (let i = 0; i < 4; i++) mark(22 + i * 4.6, -12, 21 + i * 4.6, 2);
  mark(19, 0, 39, -10);
  mark(42, -12, 41.5, 2);
  // A five-pointed star drawn in one stroke, low and to the left.
  const pts: number[] = [];
  for (let i = 0; i <= 5; i++) {
    const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5;
    pts.push(-26 + Math.cos(a) * 8, 28 + Math.sin(a) * 8);
  }
  for (let i = 2; i < pts.length; i += 2) mark(pts[i - 2], pts[i - 1], pts[i], pts[i + 1]);
  // A cross on the target's heart.
  mark(-4, -8, 6, 2);
  mark(6, -8, -4, 2);
}
