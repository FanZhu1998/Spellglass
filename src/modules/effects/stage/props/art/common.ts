// Small sprites every prop shares: the soft contact shadow, the glint of a mend or a click, and the
// little heap of dust a shattered prop leaves on the shelf.

import { drawSprite, paintSprite, type CanvasFactory, type Sprite, type Surface } from './canvas';
import { ellipsePath, lin, rad, rng, type Ctx } from './paint';

export interface CommonArt {
  /** A soft round shadow, drawn stretched in pixels under each prop. */
  shadow: Surface;
  /** A four-point star with a soft core, 36 mH across: Reparo's glint, the box latch's click. */
  glint: Sprite;
}

/** Painted once: both sprites are soft, so one resolution serves every mirror size. */
export class CommonArtCache {
  private art: CommonArt | null = null;
  private failed = false;

  get(factory: CanvasFactory): CommonArt | null {
    if (this.art || this.failed) return this.art;
    const shadow = factory(64, 64);
    const glint = paintSprite(factory, 3, { x0: -18, y0: -18, x1: 18, y1: 18 }, paintGlint);
    if (!shadow || !glint) {
      this.failed = true;
      return null;
    }
    const c = shadow.ctx;
    c.fillStyle = rad(c, 32, 32, 0, 32, 32, 32, [[0, 'rgba(4,3,2,0.8)'], [0.45, 'rgba(4,3,2,0.45)'], [1, 'rgba(4,3,2,0)']]);
    c.fillRect(0, 0, 64, 64);
    this.art = { shadow, glint };
    return this.art;
  }
}

function ray(c: Ctx, len: number, w: number, angle: number): void {
  c.save();
  c.rotate(angle);
  c.fillStyle = lin(c, -len, 0, len, 0, [[0, 'rgba(255,226,160,0)'], [0.5, 'rgba(255,255,250,1)'], [1, 'rgba(255,226,160,0)']]);
  c.beginPath();
  c.moveTo(-len, 0);
  c.lineTo(0, -w);
  c.lineTo(len, 0);
  c.lineTo(0, w);
  c.closePath();
  c.fill();
  c.restore();
}

function paintGlint(c: Ctx): void {
  c.fillStyle = rad(c, 0, 0, 0, 0, 0, 9, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,240,205,0.6)'], [1, 'rgba(255,214,140,0)']]);
  c.beginPath();
  c.arc(0, 0, 9, 0, Math.PI * 2);
  c.fill();
  ray(c, 17, 1.5, 0);
  ray(c, 17, 1.5, Math.PI / 2);
  ray(c, 8, 0.9, Math.PI / 4);
  ray(c, 8, 0.9, -Math.PI / 4);
}

// ------------------------------------------------------------------ shards (Reducto)

export interface ShardOptions {
  seed: number;
  /** How many pieces it breaks into. */
  pieces: number;
  /** How far either side of its home the pieces come to rest, mH. */
  spread: number;
  /** A fresh break in its material: the pale of china or wax, the dark of torn clay and leaves; null
   *  for things that tear rather than break (a feather). */
  edge: string | null;
  /** How ragged the breaks are, mH: china and clay break sharply, wax and quill more cleanly. */
  jag?: number;
  /** Where the body is painted (Solid); without it the whole box counts. */
  solid?: readonly Solid[];
}

/** A convex piece of the body's box, in its mH: flat [x, y, ...] corners, and for each, whether the edge
 *  from it to the next is a break (true) or the box's own side (false). */
interface Piece {
  pts: number[];
  cut: boolean[];
}

/** Split a convex piece along the line through (px, py) heading (dx, dy). */
function split(p: Piece, px: number, py: number, dx: number, dy: number): [Piece, Piece] {
  const a: Piece = { pts: [], cut: [] };
  const b: Piece = { pts: [], cut: [] };
  const n = p.pts.length / 2;
  const side = (i: number): number => (p.pts[2 * i] - px) * dy - (p.pts[2 * i + 1] - py) * dx;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const si = side(i);
    const sj = side(j);
    const inA = si >= 0;
    (inA ? a : b).pts.push(p.pts[2 * i], p.pts[2 * i + 1]);
    (inA ? a : b).cut.push(p.cut[i]);
    if (inA !== sj >= 0) {
      const t = si / (si - sj);
      const x = p.pts[2 * i] + (p.pts[2 * j] - p.pts[2 * i]) * t;
      const y = p.pts[2 * i + 1] + (p.pts[2 * j + 1] - p.pts[2 * i + 1]) * t;
      // The side the edge leaves turns along the break here; the other picks the old edge up again.
      (inA ? a : b).pts.push(x, y);
      (inA ? a : b).cut.push(true);
      (inA ? b : a).pts.push(x, y);
      (inA ? b : a).cut.push(p.cut[i]);
    }
  }
  return [a, b];
}

function inside(pts: readonly number[], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = pts.length - 2; i < pts.length; j = i, i += 2) {
    const yi = pts[i + 1];
    const yj = pts[j + 1];
    if (yi > y !== yj > y && x < ((pts[j] - pts[i]) * (y - yi)) / (yj - yi) + pts[i]) hit = !hit;
  }
  return hit;
}

/** The piece's outline with each break made ragged, and the ragged breaks on their own for the pale edge. */
function raggedOutline(p: Piece, r: () => number, jag: number): { outline: number[]; breaks: number[][] } {
  const outline: number[] = [];
  const breaks: number[][] = [];
  const n = p.pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = p.pts[2 * i], y0 = p.pts[2 * i + 1], x1 = p.pts[2 * j], y1 = p.pts[2 * j + 1];
    outline.push(x0, y0);
    if (!p.cut[i]) continue;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(2, Math.round(len / (jag * 2.2)));
    const nx = -(y1 - y0) / (len || 1);
    const ny = (x1 - x0) / (len || 1);
    const line = [x0, y0];
    for (let s = 1; s < steps; s++) {
      const t = (s + (r() - 0.5) * 0.6) / steps;
      const off = (r() - 0.5) * 2 * jag;
      line.push(x0 + (x1 - x0) * t + nx * off, y0 + (y1 - y0) * t + ny * off);
    }
    line.push(x1, y1);
    for (let k = 2; k < line.length - 2; k += 2) outline.push(line[k], line[k + 1]);
    breaks.push(line);
  }
  return { outline, breaks };
}

/** A rough shape of where a body is painted, in its mH: rectangles [x0, y0, x1, y1], ellipses [cx, cy,
 *  rx, ry] and polygons (flat x, y). The pieces are chosen and laid down by what they hold, not by their
 *  empty corners, and the art says where it is rather than have its pixels read back, which stalls a
 *  GPU canvas. */
export type Solid =
  | { readonly rect: readonly [number, number, number, number] }
  | { readonly ellipse: readonly [number, number, number, number] }
  | { readonly poly: readonly number[] };

function inSolid(s: Solid, x: number, y: number): boolean {
  if ('rect' in s) return x >= s.rect[0] && x <= s.rect[2] && y >= s.rect[1] && y <= s.rect[3];
  if ('ellipse' in s) {
    const [cx, cy, rx, ry] = s.ellipse;
    const dx = (x - cx) / rx;
    const dy = (y - cy) / ry;
    return dx * dx + dy * dy <= 1;
  }
  return inside(s.poly, x, y);
}

/** Points on a coarse grid over the body's box where it is painted (all of them, without a shape). */
function sampleBody(body: Sprite, solid: readonly Solid[] | undefined): { x: number[]; y: number[] } {
  const b = body.box;
  const cols = 28;
  const rows = Math.max(8, Math.round((cols * (b.y1 - b.y0)) / Math.max(1, b.x1 - b.x0)));
  const xs: number[] = [];
  const ys: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = b.x0 + ((i + 0.5) / cols) * (b.x1 - b.x0);
      const y = b.y0 + ((j + 0.5) / rows) * (b.y1 - b.y0);
      if (solid && !solid.some((s) => inSolid(s, x, y))) continue;
      xs.push(x);
      ys.push(y);
    }
  }
  return { x: xs, y: ys };
}

interface Laid {
  piece: Piece;
  /** Its centre of paint, in the body's mH. */
  cx: number;
  cy: number;
  /** Where its centre of paint is drawn, how it is turned, the middle and half-width of what it covers
   *  lying there, and the line it rests on, mH. */
  x: number;
  y: number;
  turn: number;
  mid: number;
  half: number;
  rest: number;
}

/**
 * What Reducto leaves of a prop that breaks: its own painted body cut into ragged pieces, each lying on
 * the shelf on its longest side, with a pale fresh break along every edge where it broke, a soft shadow
 * under it, and the heap of dust beneath them all. Painted the first time the prop is shattered.
 */
export function paintShards(factory: CanvasFactory, body: Sprite, heap: Sprite | null, o: ShardOptions): Sprite | null {
  const r = rng(o.seed);
  const b = body.box;
  const samples = sampleBody(body, o.solid);
  const total = samples.x.length;
  if (total === 0) return null;
  const hold = (p: Piece): number[] => {
    const idx: number[] = [];
    for (let k = 0; k < total; k++) if (inside(p.pts, samples.x[k], samples.y[k])) idx.push(k);
    return idx;
  };
  // Break the box along lines through the paint, the biggest piece first, until there are enough.
  let pieces: { piece: Piece; idx: number[] }[] = [{
    piece: { pts: [b.x0, b.y0, b.x1, b.y0, b.x1, b.y1, b.x0, b.y1], cut: [false, false, false, false] },
    idx: samples.x.map((_, k) => k),
  }];
  for (let n = 1; n < o.pieces; n++) {
    pieces.sort((p, q) => q.idx.length - p.idx.length);
    const big = pieces[0];
    let done = false;
    for (let attempt = 0; attempt < 6 && !done; attempt++) {
      const k = big.idx[Math.floor(r() * big.idx.length)];
      const a = r() * Math.PI;
      const [p1, p2] = split(big.piece, samples.x[k], samples.y[k], Math.cos(a), Math.sin(a));
      const i1 = hold(p1);
      const i2 = hold(p2);
      if (Math.min(i1.length, i2.length) < big.idx.length * 0.18) continue;
      pieces = [{ piece: p1, idx: i1 }, { piece: p2, idx: i2 }, ...pieces.slice(1)];
      done = true;
    }
    if (!done) break;
  }
  // Lay each down along its longest side, the biggest nearest home, the rest either side of it.
  pieces.sort((p, q) => q.idx.length - p.idx.length);
  const laid: Laid[] = [];
  let leftEdge = 0;
  let rightEdge = 0;
  pieces.forEach(({ piece, idx }, n) => {
    if (idx.length === 0) return;
    const sx = idx.map((k) => samples.x[k]);
    const sy = idx.map((k) => samples.y[k]);
    const cx = sx.reduce((s, v) => s + v, 0) / sx.length;
    const cy = sy.reduce((s, v) => s + v, 0) / sy.length;
    let xx = 0, yy = 0, xy = 0;
    for (let k = 0; k < sx.length; k++) {
      const dx = sx[k] - cx;
      const dy = sy[k] - cy;
      xx += dx * dx;
      yy += dy * dy;
      xy += dx * dy;
    }
    const major = 0.5 * Math.atan2(2 * xy, xx - yy);
    const turn = -major + (r() - 0.5) * 0.5 + (r() < 0.5 ? Math.PI : 0);
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < sx.length; k++) {
      const dx = sx[k] - cx;
      const dy = sy[k] - cy;
      const rx = dx * c - dy * s;
      const ry = dx * s + dy * c;
      minX = Math.min(minX, rx);
      maxX = Math.max(maxX, rx);
      maxY = Math.max(maxY, ry);
    }
    const half = (maxX - minX) / 2 + 2;
    // Bigger pieces a little further back on the board, smaller ones nearer its front edge.
    const rest = 1 + Math.min(9, n * 1.8) + r() * 2;
    let x = 0;
    if (n === 0) {
      x = (r() - 0.5) * 16;
      leftEdge = x - half;
      rightEdge = x + half;
    } else if ((n % 2 === 1) === r() < 0.75) {
      x = Math.max(-o.spread, leftEdge - half * (0.35 + r() * 0.5));
      leftEdge = Math.min(leftEdge, x - half);
    } else {
      x = Math.min(o.spread, rightEdge + half * (0.35 + r() * 0.5));
      rightEdge = Math.max(rightEdge, x + half);
    }
    laid.push({ piece, cx, cy, x: x - (minX + maxX) / 2, y: rest - maxY, turn, mid: x, half, rest });
  });
  if (laid.length === 0) return null;
  // The area they cover, with the heap's.
  let x0 = heap ? heap.box.x0 : 0;
  let x1 = heap ? heap.box.x1 : 0;
  let y0 = heap ? heap.box.y0 : 0;
  let y1 = heap ? heap.box.y1 : 0;
  for (const l of laid) {
    const c = Math.cos(l.turn);
    const s = Math.sin(l.turn);
    for (let k = 0; k < l.piece.pts.length; k += 2) {
      const dx = l.piece.pts[k] - l.cx;
      const dy = l.piece.pts[k + 1] - l.cy;
      const px = l.x + dx * c - dy * s;
      const py = l.y + dx * s + dy * c;
      x0 = Math.min(x0, px);
      x1 = Math.max(x1, px);
      y0 = Math.min(y0, py);
      y1 = Math.max(y1, py);
    }
  }
  const area = { x0: x0 - 4, y0: y0 - 4, x1: x1 + 4, y1: Math.min(y1, 16) + 4 };
  const res = body.res;
  // Each piece is cut out on its own canvas first, so its pale break is laid only over its own paint.
  const cutouts = laid.map((l) => {
    const { outline, breaks } = raggedOutline(l.piece, r, o.jag ?? 1.6);
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let k = 0; k < outline.length; k += 2) {
      bx0 = Math.min(bx0, outline[k]);
      bx1 = Math.max(bx1, outline[k]);
      by0 = Math.min(by0, outline[k + 1]);
      by1 = Math.max(by1, outline[k + 1]);
    }
    return paintSprite(factory, res, { x0: bx0, y0: by0, x1: bx1, y1: by1 }, (c) => {
      c.beginPath();
      c.moveTo(outline[0], outline[1]);
      for (let k = 2; k < outline.length; k += 2) c.lineTo(outline[k], outline[k + 1]);
      c.closePath();
      c.save();
      c.clip();
      drawSprite(c, body);
      c.globalCompositeOperation = 'source-atop';
      c.lineJoin = 'round';
      if (o.edge) {
        c.strokeStyle = o.edge;
        c.lineWidth = 2.2;
        for (const line of breaks) {
          c.beginPath();
          c.moveTo(line[0], line[1]);
          for (let k = 2; k < line.length; k += 2) c.lineTo(line[k], line[k + 1]);
          c.stroke();
        }
      }
      // The break's far lip, in shadow.
      c.strokeStyle = 'rgba(20,14,10,0.35)';
      c.lineWidth = 0.6;
      for (const line of breaks) {
        c.beginPath();
        c.moveTo(line[0] + 0.9, line[1] + 0.9);
        for (let k = 2; k < line.length; k += 2) c.lineTo(line[k] + 0.9, line[k + 1] + 0.9);
        c.stroke();
      }
      c.restore();
    });
  });
  return paintSprite(factory, res, area, (c) => {
    if (heap) drawSprite(c, heap);
    laid.forEach((l, k) => {
      const cut = cutouts[k];
      if (!cut) return;
      // Its shadow on the board, a little away from the candle, then the piece itself.
      const sx = l.mid + l.half * 0.1;
      c.fillStyle = rad(c, sx, l.rest, 0, sx, l.rest, l.half, [[0, 'rgba(4,3,2,0.5)'], [0.6, 'rgba(4,3,2,0.22)'], [1, 'rgba(4,3,2,0)']]);
      ellipsePath(c, sx, l.rest, l.half, 3.2);
      c.fill();
      c.save();
      c.translate(l.x, l.y);
      c.rotate(l.turn);
      c.translate(-l.cx, -l.cy);
      drawSprite(c, cut);
      c.restore();
    });
  });
}

/** A low heap of dust in the prop's own color, `width` mH across, sitting on y = 0. */
export function paintHeap(factory: CanvasFactory, res: number, width: number, color: string, seed: number): Sprite | null {
  const hw = width / 2;
  return paintSprite(factory, res, { x0: -hw - 2, y0: -16, x1: hw + 2, y1: 3 }, (c) => {
    c.fillStyle = rad(c, 0, 2, 0, 0, 2, hw, [[0, 'rgba(0,0,0,0.45)'], [1, 'rgba(0,0,0,0)']]);
    ellipsePath(c, 0, 1, hw, 3.5);
    c.fill();
    c.save();
    c.beginPath();
    c.moveTo(-hw, 1);
    c.bezierCurveTo(-hw * 0.6, -6, -hw * 0.25, -12, 0, -12);
    c.bezierCurveTo(hw * 0.3, -12, hw * 0.65, -5, hw, 1);
    c.closePath();
    c.fillStyle = lin(c, 0, -12, 0, 1, [[0, color], [1, 'rgba(40,30,20,0.9)']]);
    c.globalAlpha = 0.9;
    c.fill();
    c.restore();
    // Grains scattered around the heap.
    const r = rng(seed);
    for (let i = 0; i < 46; i++) {
      const x = (r() * 2 - 1) * hw * 1.15;
      const lift = Math.max(0, 1 - Math.abs(x) / (hw * 1.15));
      const y = 1.5 - r() * 11 * lift;
      c.globalAlpha = 0.35 + r() * 0.6;
      c.fillStyle = r() < 0.5 ? color : 'rgba(30,22,14,1)';
      c.beginPath();
      c.arc(x, y, 0.4 + r() * 1.1, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;
  });
}
