// The mantel: a dark oak shelf along the bottom of the mirror (Section 7.8, 10.3; art brief "The stage").
// From the top: the shelf's soft shadow on the glass, the top board the props stand on, its rounded
// front edge, a carved moulding under it (a cove and a row of beads), and the frieze below with two
// carved corbels near the ends. The candle's light comes from the left, so the oak warms toward the
// candle and sinks into shadow toward the right. Old use is written into it: wax where the candle
// stands, ink by the quill, a ring from the cup.
// Coordinates in mH with y = 0 at SHELF_TOP; x runs from 0 to the canvas width in mH.

import { paintSprite, type CanvasFactory, type Sprite } from './canvas';
import { OAK, PAL, ellipsePath, grain, knot, lin, noiseTile, rad, rayFleck, rng, sphere, woodGrain, type Ctx } from './paint';

/** Rows of the shelf, in mH from the line the props stand on. */
export const SHELF_ROWS = {
  /** The shadow on the glass begins this far above. */
  shadowTop: -84,
  /** Back edge of the top board (against the glass). */
  back: -24,
  /** Front edge of the top board. */
  front: 12,
  /** Bottom of the rounded edge (the board's thickness). */
  lip: 23,
  /** The cove under the board. */
  cove: 29,
  /** The row of carved beads. */
  bead: 38,
  /** The frieze starts here. */
  frieze: 41,
} as const;

/** Where the candle, the quill's nib and the cup usually stand (mH from the left edge), so the shelf can
 *  carry their old marks. Absent: a clean shelf. */
export interface ShelfMarks {
  candle: number;
  nib: number;
  teacup: number;
}

/** How much light reaches x (0..1): the candle's pool, an ambient floor, and the ends falling away. */
function lightAt(x: number, w: number, candleX: number): number {
  const d = (x - candleX) / 520;
  const key = 1 / (1 + d * d);
  const end = Math.min(1, x / 140, (w - x) / 140);
  return (0.42 + 0.58 * key) * (0.55 + 0.45 * Math.max(0, end));
}

/** Multiply the clipped area by the light across x (warm where lit). */
function lightPass(c: Ctx, w: number, y0: number, y1: number, candleX: number, floor: number): void {
  const g = c.createLinearGradient(0, 0, w, 0);
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const x = (i / n) * w;
    const v = floor + (1 - floor) * lightAt(x, w, candleX);
    const r = Math.round(255 * v);
    const gg = Math.round(255 * v * 0.94);
    const b = Math.round(255 * v * 0.86);
    g.addColorStop(i / n, `rgb(${r},${gg},${b})`);
  }
  c.save();
  c.globalCompositeOperation = 'multiply';
  c.fillStyle = g;
  c.fillRect(0, y0, w, y1 - y0);
  c.restore();
}

/** Paint the mantel `widthMh` wide, reaching `bottomMh` below the line (to the bottom of the canvas). */
export function buildShelfArt(factory: CanvasFactory, res: number, widthMh: number, bottomMh: number, marks?: ShelfMarks): Sprite | null {
  const R = SHELF_ROWS;
  const w = Math.max(10, widthMh);
  const bottom = Math.max(R.frieze + 20, bottomMh);
  const tile = noiseTile(factory);
  // Without marks the light still comes from the left, as if from just beyond the glass.
  const candleX = marks ? marks.candle : Math.min(w * 0.12, 260);
  return paintSprite(factory, res, { x0: 0, y0: R.shadowTop, x1: w, y1: bottom }, (c) => {
    // The shelf's shadow on the glass, so the props sit in front of the room rather than on it.
    c.fillStyle = lin(c, 0, R.shadowTop, 0, R.back, [[0, 'rgba(5,4,7,0)'], [0.55, 'rgba(5,4,7,0.24)'], [0.9, 'rgba(5,4,7,0.5)'], [1, 'rgba(5,4,7,0.66)']]);
    c.fillRect(0, R.shadowTop, w, R.back - R.shadowTop);

    paintTop(c, w, tile, candleX);
    paintEdge(c, w, tile, candleX);
    paintFrieze(c, w, bottom, tile, candleX);
    // The corbels stand in front of the moulding and the frieze, under the board, lit by the candle
    // as the rest is: the one far from it sinks into shadow.
    const inset = Math.min(w * 0.25, Math.max(70, w * 0.052));
    c.save();
    c.beginPath();
    c.rect(0, R.lip, w, bottom - R.lip);
    c.clip();
    for (const x of [inset, w - inset]) paintCorbel(c, x, tile, 0.3 + 0.7 * lightAt(x, w, candleX));
    c.restore();
    if (marks) paintMarks(c, marks);
  });
}

function paintTop(c: Ctx, w: number, tile: ReturnType<typeof noiseTile>, candleX: number): void {
  const R = SHELF_ROWS;
  const h = R.front - R.back;
  c.save();
  c.beginPath();
  c.rect(0, R.back, w, h);
  c.clip();
  // Seen from a little above: the board darkens toward the glass and catches light at its front.
  c.fillStyle = lin(c, 0, R.back, 0, R.front, [[0, '#0E0905'], [0.35, '#24170D'], [0.8, '#3E2915'], [1, '#4E3420']]);
  c.fillRect(0, R.back, w, h);
  woodGrain(c, 0, R.back, w, R.front, 101, { color: PAL.oakDeep, alpha: 0.55, gap: 1.7, wave: 0.7, width: 0.5, stepX: 8 });
  woodGrain(c, 0, R.back, w, R.front, 102, { color: PAL.oakGlow, alpha: 0.12, gap: 3.4, wave: 0.6, width: 0.45, stepX: 8 });
  rayFleck(c, 0, R.back + 4, w, R.front - 1, 103, Math.round(w / 9), '#C9A06A', 0.12, 4);
  grain(c, tile, 0.22, 14, 0, 0, R.back, w, R.front);
  lightPass(c, w, R.back, R.front, candleX, 0.18);
  // The candle's warm pool on the board itself.
  c.save();
  c.translate(candleX, 2);
  c.scale(1, 0.09);
  c.fillStyle = rad(c, 0, 0, 0, 0, 0, 420, [[0, 'rgba(255,170,84,0.22)'], [0.5, 'rgba(255,150,70,0.07)'], [1, 'rgba(255,150,70,0)']]);
  c.fillRect(-420, -420, 840, 840);
  c.restore();
  // Where the board meets the glass, light cannot get in.
  c.fillStyle = lin(c, 0, R.back, 0, R.back + 9, [[0, 'rgba(0,0,0,0.75)'], [1, 'rgba(0,0,0,0)']]);
  c.fillRect(0, R.back, w, 9);
  // Wear: fine pale scratches from a century of things set down.
  const r = rng(104);
  c.lineCap = 'round';
  for (let i = 0; i < w / 26; i++) {
    const x = r() * w;
    const y = R.back + 8 + r() * (h - 10);
    const l = 3 + r() * 10;
    c.strokeStyle = `rgba(214,176,122,${0.05 + r() * 0.08})`;
    c.lineWidth = 0.3 + r() * 0.3;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + l, y + (r() - 0.5) * 1.6);
    c.stroke();
  }
  c.restore();
}

function paintEdge(c: Ctx, w: number, tile: ReturnType<typeof noiseTile>, candleX: number): void {
  const R = SHELF_ROWS;
  // The rounded front edge: a bright crown where it turns toward the candle, falling into shadow below.
  c.save();
  c.beginPath();
  c.rect(0, R.front, w, R.frieze - R.front);
  c.clip();
  c.fillStyle = lin(c, 0, R.front, 0, R.lip, [
    [0, '#5E3E22'], [0.16, '#A27850'], [0.3, '#87603C'], [0.6, '#4A3019'], [0.85, '#23160C'], [1, '#100A05'],
  ]);
  c.fillRect(0, R.front, w, R.lip - R.front);
  woodGrain(c, 0, R.front, w, R.lip, 105, { color: PAL.oakDeep, alpha: 0.4, gap: 1.4, wave: 0.5, width: 0.4, stepX: 8 });
  // The shadow line under the overhang, then the cove, darkest at its top.
  c.fillStyle = '#070403';
  c.fillRect(0, R.lip, w, 1.6);
  c.fillStyle = lin(c, 0, R.lip + 1.6, 0, R.cove, [[0, '#0A0604'], [0.55, '#20140B'], [1, '#3A2615']]);
  c.fillRect(0, R.lip + 1.6, w, R.cove - R.lip - 1.6);
  // A row of carved beads, each a little sphere lit from the upper left, with dark hollows between.
  c.fillStyle = '#0C0805';
  c.fillRect(0, R.cove, w, R.bead - R.cove);
  const br = (R.bead - R.cove) / 2 - 0.25;
  const pitch = br * 2 + 1.5;
  const by = (R.cove + R.bead) / 2;
  for (let x = pitch / 2; x < w + br; x += pitch) {
    c.fillStyle = sphere(c, x, by, br, OAK);
    c.beginPath();
    c.ellipse(x, by, br, br * 0.96, 0, 0, Math.PI * 2);
    c.fill();
  }
  // The fillet under the beads, lit along its top.
  c.fillStyle = lin(c, 0, R.bead, 0, R.frieze, [[0, '#6A4828'], [0.4, '#4A3019'], [1, '#1C120A']]);
  c.fillRect(0, R.bead, w, R.frieze - R.bead);
  grain(c, tile, 0.2, 10, 0, 0, R.front, w, R.frieze);
  lightPass(c, w, R.front, R.frieze, candleX, 0.12);
  // The crown's highlight: warm where the candle is, a faint cool moonlight far to the right.
  c.fillStyle = lin(c, 0, 0, w, 0, [
    [0, 'rgba(255,214,160,0.1)'], [Math.min(0.9, (candleX + 80) / w), 'rgba(255,214,160,0.42)'], [0.55, 'rgba(230,214,190,0.14)'],
    [0.85, 'rgba(176,192,220,0.1)'], [1, 'rgba(176,192,220,0.05)'],
  ]);
  c.fillRect(0, R.front + 1.7, w, 0.9);
  // Nicks and dents along the crown, where things were knocked against it.
  const r = rng(106);
  for (let i = 0; i < w / 60; i++) {
    const x = r() * w;
    c.fillStyle = `rgba(10,6,3,${0.35 + r() * 0.3})`;
    c.beginPath();
    c.ellipse(x, R.front + 2 + r() * 4, 0.8 + r() * 1.8, 0.4 + r() * 0.6, 0, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}

function paintFrieze(c: Ctx, w: number, bottom: number, tile: ReturnType<typeof noiseTile>, candleX: number): void {
  const R = SHELF_ROWS;
  c.save();
  c.beginPath();
  c.rect(0, R.frieze, w, bottom - R.frieze);
  c.clip();
  c.fillStyle = lin(c, 0, R.frieze, 0, Math.min(bottom, R.frieze + 90), [[0, '#2A1B0F'], [0.5, '#1C120A'], [1, '#0D0805']]);
  c.fillRect(0, R.frieze, w, bottom - R.frieze);
  woodGrain(c, 0, R.frieze, w, bottom, 107, { color: PAL.oakDeep, alpha: 0.6, gap: 2.2, wave: 1.4, width: 0.55, stepX: 8 });
  woodGrain(c, 0, R.frieze, w, bottom, 108, { color: PAL.oakGlow, alpha: 0.1, gap: 4.5, wave: 1.2, width: 0.5, stepX: 8 });
  rayFleck(c, 0, R.frieze + 3, w, bottom, 109, Math.round(w / 7), '#B58C5A', 0.1, 5);
  const r = rng(110);
  for (let x = 180 + r() * 300; x < w - 60; x += 460 + r() * 520) knot(c, x, R.frieze + 14 + r() * 14, 3.6 + r() * 3, 1.8 + r() * 1.1, 0.6);
  grain(c, tile, 0.24, 14, 0, 0, R.frieze, w, bottom);
  // The overhang's shadow on the frieze.
  c.fillStyle = lin(c, 0, R.frieze, 0, R.frieze + 10, [[0, 'rgba(0,0,0,0.7)'], [1, 'rgba(0,0,0,0)']]);
  c.fillRect(0, R.frieze, w, 10);
  lightPass(c, w, R.frieze, bottom, candleX, 0.1);
  // It falls into shadow toward the floor.
  c.fillStyle = lin(c, 0, R.frieze + 8, 0, Math.min(bottom, R.frieze + 70), [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.55)']]);
  c.fillRect(0, R.frieze + 8, w, bottom - R.frieze - 8);
  c.restore();
}

/** A carved console under the shelf, seen from the front: a cap against the underside of the board, a
 *  roll scrolled into a volute at each end, and a face that tapers down under an acanthus leaf. It
 *  reaches below the bottom of the mirror on most screens; what shows is its head. Lit from the left. */
function paintCorbel(c: Ctx, cx: number, tile: ReturnType<typeof noiseTile>, light: number): void {
  const top = SHELF_ROWS.lip;
  c.save();
  c.translate(cx, top);
  // Its shadow on the moulding and the frieze, thrown to the right by the candle.
  c.fillStyle = 'rgba(0,0,0,0.5)';
  c.beginPath();
  c.moveTo(-22, 4);
  c.lineTo(34, 4);
  c.lineTo(33, 24);
  c.quadraticCurveTo(26, 60, 16, 104);
  c.lineTo(-6, 104);
  c.closePath();
  c.fill();
  // The face below the roll, tapering, with the leaf carved on it.
  const face = () => {
    c.beginPath();
    c.moveTo(-19, 18);
    c.lineTo(19, 18);
    c.bezierCurveTo(19, 46, 13, 74, 10, 104);
    c.lineTo(-10, 104);
    c.bezierCurveTo(-13, 74, -19, 46, -19, 18);
    c.closePath();
  };
  face();
  c.fillStyle = lin(c, -19, 0, 19, 0, [[0, '#8E6640'], [0.22, '#7A5432'], [0.55, '#4A3019'], [0.85, '#24170D'], [1, '#2E2622']]);
  c.fill();
  c.save();
  face();
  c.clip();
  c.fillStyle = lin(c, 0, 18, 0, 104, [[0, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.55)']]);
  c.fillRect(-20, 18, 40, 86);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const pass of [{ d: 0.8, col: 'rgba(0,0,0,0.65)', w: 1.5 }, { d: 0, col: 'rgba(222,178,122,0.4)', w: 0.8 }]) {
    c.strokeStyle = pass.col;
    c.lineWidth = pass.w;
    c.beginPath();
    c.moveTo(pass.d, 22 + pass.d);
    c.lineTo(pass.d, 96 + pass.d);
    for (const sgn of [-1, 1]) {
      const x = (v: number) => pass.d + sgn * v;
      c.moveTo(x(1.5), 24 + pass.d);
      c.bezierCurveTo(x(12), 27 + pass.d, x(15), 37 + pass.d, x(10), 45 + pass.d);
      c.bezierCurveTo(x(14), 50 + pass.d, x(12), 60 + pass.d, x(7), 66 + pass.d);
      c.quadraticCurveTo(x(9), 76 + pass.d, x(3), 84 + pass.d);
    }
    c.stroke();
  }
  grain(c, tile, 0.22, 4, Math.PI / 2, -20, 18, 20, 104);
  c.restore();
  face();
  c.strokeStyle = 'rgba(6,4,2,0.85)';
  c.lineWidth = 0.8;
  c.stroke();
  // The roll across the top, lit along its upper left, and the volute it scrolls into at each end.
  c.fillStyle = lin(c, 0, 5, 0, 21, [[0, '#A27850'], [0.3, '#7A5432'], [0.7, '#3A2616'], [1, '#160E07']]);
  c.fillRect(-21, 5, 42, 16);
  c.save();
  c.beginPath();
  c.rect(-21, 5, 42, 16);
  c.clip();
  grain(c, tile, 0.22, 8, 0, -21, 5, 21, 21);
  c.restore();
  for (const sgn of [-1, 1]) {
    const vx = sgn * 21;
    const vy = 13;
    const lit = sgn < 0;
    c.fillStyle = rad(c, vx - 3, vy - 3, 0.5, vx, vy, 9.5, lit
      ? [[0, '#C49A64'], [0.4, '#8A6240'], [0.85, '#3A2616'], [1, '#160E07']]
      : [[0, '#6A4828'], [0.4, '#4A3019'], [0.85, '#1C120A'], [1, '#0C0805']]);
    c.beginPath();
    c.arc(vx, vy, 9, 0, Math.PI * 2);
    c.fill();
    // The spiral groove, winding in to the eye.
    c.strokeStyle = 'rgba(6,4,2,0.9)';
    c.lineWidth = 1;
    c.beginPath();
    for (let t = 0; t <= 2.7 * Math.PI; t += 0.22) {
      const rr = 8.2 * (1 - t / (3.2 * Math.PI));
      const ang = sgn * t - Math.PI / 2;
      const px = vx + Math.cos(ang) * rr;
      const py = vy + Math.sin(ang) * rr;
      if (t === 0) c.moveTo(px, py);
      else c.lineTo(px, py);
    }
    c.stroke();
    if (lit) {
      c.strokeStyle = 'rgba(240,200,140,0.45)';
      c.lineWidth = 0.7;
      c.beginPath();
      c.arc(vx, vy, 8, Math.PI * 1.02, Math.PI * 1.62);
      c.stroke();
    }
    c.fillStyle = lit ? '#4A3019' : '#160E07';
    c.beginPath();
    c.arc(vx, vy, 1.7, 0, Math.PI * 2);
    c.fill();
  }
  // The cap it carries the board on.
  c.fillStyle = lin(c, 0, 0, 0, 5, [[0, '#A27850'], [0.4, '#6A4828'], [1, '#24170D']]);
  c.fillRect(-27, 0, 54, 5);
  c.fillStyle = 'rgba(255,214,160,0.28)';
  c.fillRect(-27, 0.4, 54, 0.8);
  c.strokeStyle = 'rgba(6,4,2,0.8)';
  c.lineWidth = 0.6;
  c.strokeRect(-27, 0, 54, 5);
  // How much of the candle's light reaches it, over its own outline only.
  c.beginPath();
  c.rect(-27, 0, 54, 5);
  c.rect(-21, 5, 42, 16);
  for (const sgn of [-1, 1]) {
    c.moveTo(sgn * 21 + 9, 13);
    c.arc(sgn * 21, 13, 9, 0, Math.PI * 2);
  }
  c.moveTo(-19, 18);
  c.lineTo(19, 18);
  c.bezierCurveTo(19, 46, 13, 74, 10, 104);
  c.lineTo(-10, 104);
  c.bezierCurveTo(-13, 74, -19, 46, -19, 18);
  c.closePath();
  c.save();
  c.clip();
  const v = Math.round(255 * Math.min(1, light));
  c.globalCompositeOperation = 'multiply';
  c.fillStyle = `rgb(${v},${Math.round(v * 0.94)},${Math.round(v * 0.86)})`;
  c.fillRect(-32, 0, 64, 106);
  c.restore();
  c.restore();
}

/** Old wax by the candle (one drip has run over the edge), ink spots by the quill's nib, a tea ring. */
function paintMarks(c: Ctx, m: ShelfMarks): void {
  const R = SHELF_ROWS;
  // Wax: little hardened puddles on the board, old and yellowed, with a soft shadow.
  for (const [dx, dy, rx] of [[-58, 4, 4.6], [50, 6, 3.4]] as const) {
    const x = m.candle + dx;
    c.fillStyle = 'rgba(8,5,3,0.4)';
    ellipsePath(c, x + 0.8, dy + 0.9, rx, rx * 0.34);
    c.fill();
    c.fillStyle = lin(c, 0, dy - rx * 0.35, 0, dy + rx * 0.35, [[0, '#B8A67C'], [1, '#6A583A']]);
    ellipsePath(c, x, dy, rx, rx * 0.32);
    c.fill();
    c.fillStyle = 'rgba(255,240,206,0.45)';
    ellipsePath(c, x - rx * 0.3, dy - rx * 0.12, rx * 0.35, rx * 0.08);
    c.fill();
  }
  // A drip that ran over the front edge and set on the bullnose.
  const dx = m.candle - 30;
  c.fillStyle = 'rgba(6,4,2,0.35)';
  c.beginPath();
  c.ellipse(dx + 1.2, R.front + 7, 2.6, 7, 0, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.moveTo(dx - 3.2, R.front - 1.5);
  c.quadraticCurveTo(dx - 2.6, R.front + 6, dx - 2.2, R.front + 9.5);
  c.quadraticCurveTo(dx, R.front + 13.5, dx + 2.2, R.front + 9.5);
  c.quadraticCurveTo(dx + 2.4, R.front + 5, dx + 3.2, R.front - 1.5);
  c.closePath();
  c.fillStyle = lin(c, dx - 3, 0, dx + 3, 0, [[0, '#DCCBA0'], [0.5, '#B8A47A'], [1, '#6E5A3C']]);
  c.fill();
  // Ink: two dark spots where the nib was laid down wet.
  for (const [ox, oy, rr] of [[-16, 4, 2.4], [-9, 7, 1.3], [-22, 6.5, 0.9]] as const) {
    c.fillStyle = 'rgba(12,10,20,0.72)';
    ellipsePath(c, m.nib + ox, oy, rr, rr * 0.38);
    c.fill();
  }
  // A faint ring where a cup once stood.
  c.strokeStyle = 'rgba(30,16,6,0.4)';
  c.lineWidth = 1.1;
  ellipsePath(c, m.teacup + 92, 5, 24, 3.8);
  c.stroke();
  c.strokeStyle = 'rgba(120,80,40,0.12)';
  c.lineWidth = 0.6;
  ellipsePath(c, m.teacup + 92, 4.6, 22.6, 3.3);
  c.stroke();
}
