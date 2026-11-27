// Finding the wand in the hand that holds it (hand.mode 'wand'): the shaft as a straight bar leaving the
// fist, and its tip where the bar ends. Pure functions over a luma plane, so the worker, the tests and the
// clip studies run exactly this code.
//
// Why: the bright-tip tracker (routes A and C) needs the tip to glint, which takes a light pressed against
// the lens and a dim room, or an infrared camera. With an ordinary webcam on automatic exposure in a lit
// room there is nothing for it to find, and the hand tracker's grip mode only guesses a point a fixed
// distance past the knuckles. Here the hand model says where the hand is, and the frame itself says where
// the wand is: a thin, straight bar, darker or lighter than what is behind it, that leaves the fist and
// runs for one to four palm lengths. Its far end is the tip.
//
// Per frame, in the hand worker, after the landmarks:
//  1. The grip frame (gripFrame): an anchor between the thumb and the index finger, where a held wand
//     leaves the fist in every common grip, and the palm (wrist to middle knuckle) for scale and
//     direction. Everything below is measured in palm lengths, so it holds at any distance.
//  2. A working image: the region around the hand, box-averaged so the palm is about WAND.workPalm
//     pixels long (a 1080p frame at arm's length: 3 x 3 blocks). The shaft is then 3 to 6 pixels wide.
//  3. Lines through the grip: every edge pixel outside the hand (the landmarks' hull, padded) votes for
//     the lines through it at its own orientation, within a couple of degrees, that pass within
//     WAND.rhoMax of the anchor and leave it on the far side: a Hough transform restricted to lines a held
//     wand can lie on. The forearm's directions are left out, and with a prior (the wand's place in the
//     hand from the last frames, tracking.ts) only directions near the predicted one count.
//  4. Each strong line is checked along its length: at every pixel step, the profile across the line must
//     show a bar, darker or lighter than both sides (an edge, a boundary between two areas, is not a bar).
//     The bar must start where the line leaves the hand and run on, with short gaps allowed; the line is
//     refitted through the bar's centre and checked again. The far end of the run is the tip.
//  5. A glint: if the tip is lit (a light beside the lens, as route A), a small bright spot at the end
//     of the shaft marks the tip more exactly than the end of the bar does.
//
// What this does not see: a shaft smeared by a fast stroke (at 1/30 s a flick draws it as a faint band),
// a wand pointed at the camera (foreshortened to a stub), a wand no different from what is behind it.
// tracking.ts carries the tip through those frames from the wand's last place in the hand.

/** Constants of the finder, in palm lengths (wrist to middle knuckle, about 9.5 cm on an adult hand)
 *  unless stated. */
export const WAND = {
  /** Palm length in working pixels (step 2). */
  workPalm: 36,
  /** Half the side of the region read around the anchor. */
  roiReach: 4.8,
  /** Farthest the visible tip can be from the anchor (a 38 cm wand is about 4 palm lengths). */
  reach: 4.6,
  /** Padding of the landmarks' hull: the fingers' half-width and a margin. */
  hullPad: 0.16,
  /** How far from the anchor a wand's line may pass. */
  rhoMax: 0.5,
  /** Edge pixels nearer the anchor than this, along the line, do not vote (their side is unclear). */
  minAlong: 0.2,
  /** Directions within this of the forearm (radians) are never the wand's. */
  forearmCone: (50 * Math.PI) / 180,
  /** With a prior, the search keeps to directions within this of the predicted one (radians). */
  priorCone: (25 * Math.PI) / 180,
  /** Shortest visible shaft (a wand pointed towards the camera shortens to a stub). */
  minLength: 0.5,
  /** The bar must start within this of where its line leaves the hand. */
  startSlack: 0.5,
  /** Longest gap inside the bar (a knot in the wood, a highlight, a crossing edge behind it). */
  gap: 0.22,
  /** Lines checked per search. */
  peaks: 5,
  /** A search around the prior that finds nothing better than this searches every direction. */
  priorEnough: 0.3,
  /** Weakest edge that votes (Sobel of the working image, luma levels). A shaft's edge, 15 levels or more
   *  against what is behind it, gives 60 or more; the texture of a papered wall gives about 13, and
   *  letting it vote multiplied the voters by thirty (synthetic rooms: 8,500 voters a search at a floor
   *  of 12, 280 at 30, every scene found either way). */
  gradFloor: 24,
} as const;

/** A luma plane of the region read (plane pixel (0, 0) is frame pixel (x0, y0)). */
export interface LumaPlane {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
  /** Bytes per row. */
  stride: number;
  x0: number;
  y0: number;
  /** The levels are video range, 16 to 235 (the Y plane of most webcams' YUV frames); the finder stretches
   *  them to the full range its levels are stated in, which is what a canvas reads. Absent: full range. */
  limited?: boolean;
}

/** Video range (16 to 235) to full range. */
const LIMITED = 255 / 219;

/** The grip as the wand sees it, in whatever units the landmarks were scaled to. */
export interface GripFrame {
  /** Anchor: between the thumb and the index finger. */
  ax: number;
  ay: number;
  /** Unit vector along the palm, wrist to middle knuckle. */
  ux: number;
  uy: number;
  /** Palm length. */
  palm: number;
}

/** MediaPipe landmarks used here. */
const L = { WRIST: 0, THUMB_MCP: 2, THUMB_IP: 3, INDEX_MCP: 5, INDEX_PIP: 6, MIDDLE_MCP: 9, PINKY_MCP: 17 } as const;

/** The knuckle span (index to little finger) is about 0.8 of the palm length; seen edge-on it shrinks,
 *  as the palm does when the hand points at the camera, so the larger of the two estimates is the palm. */
const SPAN_TO_PALM = 1.25;

/**
 * The grip frame of a hand. `pts` holds the 21 landmarks flat, `stride` numbers per landmark (3 for
 * MediaPipe's x, y, z; 2 for x, y), scaled by sx and sy: frame width and height for pixels, or 1 and
 * 1 ÷ aspect for the isotropic frame widths of geometry.ts.
 */
export function gripFrame(pts: ArrayLike<number>, stride: number, sx: number, sy: number): GripFrame {
  const x = (i: number) => pts[i * stride] * sx;
  const y = (i: number) => pts[i * stride + 1] * sy;
  const ax = (x(L.THUMB_MCP) + x(L.THUMB_IP) + x(L.INDEX_MCP) + x(L.INDEX_PIP)) / 4;
  const ay = (y(L.THUMB_MCP) + y(L.THUMB_IP) + y(L.INDEX_MCP) + y(L.INDEX_PIP)) / 4;
  let dx = x(L.MIDDLE_MCP) - x(L.WRIST), dy = y(L.MIDDLE_MCP) - y(L.WRIST);
  let len = Math.hypot(dx, dy);
  const span = Math.hypot(x(L.INDEX_MCP) - x(L.PINKY_MCP), y(L.INDEX_MCP) - y(L.PINKY_MCP));
  if (!(len > 1e-9)) {
    // A degenerate palm: the knuckles' midpoint from the wrist, or straight up.
    dx = (x(L.INDEX_MCP) + x(L.PINKY_MCP)) / 2 - x(L.WRIST);
    dy = (y(L.INDEX_MCP) + y(L.PINKY_MCP)) / 2 - y(L.WRIST);
    len = Math.hypot(dx, dy);
    if (!(len > 1e-9)) {
      dx = 0;
      dy = -1;
      len = 1;
    }
  }
  return { ax, ay, ux: dx / len, uy: dy / len, palm: Math.max(Math.hypot(x(L.MIDDLE_MCP) - x(L.WRIST), y(L.MIDDLE_MCP) - y(L.WRIST)), SPAN_TO_PALM * span, 1e-9) };
}

/** A point in grip coordinates: (a, b) palm lengths from the anchor, along the palm and across it. */
export function toGrip(g: GripFrame, x: number, y: number): { a: number; b: number } {
  const dx = x - g.ax, dy = y - g.ay;
  return { a: (dx * g.ux + dy * g.uy) / g.palm, b: (-dx * g.uy + dy * g.ux) / g.palm };
}

/** The point at grip coordinates (a, b). */
export function fromGrip(g: GripFrame, a: number, b: number): { x: number; y: number } {
  return { x: g.ax + g.palm * (a * g.ux - b * g.uy), y: g.ay + g.palm * (a * g.uy + b * g.ux) };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The frame region to read for a hand (frame pixels): a square of WAND.roiReach palm lengths around the
 *  anchor, inside the frame, on even coordinates (4:2:0 frames are copied by 2 x 2 blocks). */
export function wandRegion(g: GripFrame, frameWidth: number, frameHeight: number): Rect {
  const r = WAND.roiReach * g.palm;
  const even = (v: number) => 2 * Math.floor(v / 2);
  const x0 = Math.max(0, even(g.ax - r)), y0 = Math.max(0, even(g.ay - r));
  const x1 = Math.min(even(frameWidth), even(g.ax + r + 2)), y1 = Math.min(even(frameHeight), even(g.ay + r + 2));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** Where the wand is, in frame pixels (unmirrored). */
export interface WandFound {
  tip: { x: number; y: number };
  /** Where the visible shaft leaves the hand. */
  base: { x: number; y: number };
  /** 0..1: how sure the finder is that this is a wand, and that its end is the tip. */
  quality: number;
  /** Mean bar contrast along the shaft, luma levels (working image). */
  contrast: number;
  /** Visible length ÷ palm length. */
  length: number;
  /** Share of the run where the bar was seen. */
  support: number;
  /** The shaft ran out of the region or the frame: the tip may be further on. */
  cut: boolean;
  /** A small bright spot at the end of the shaft (a lit tip), frame pixels. */
  glint: { x: number; y: number } | null;
  /** Found around the prior, or by searching every direction. */
  search: 'prior' | 'wide';
}

interface Line {
  theta: number;
  rho: number;
}

interface Run {
  line: Line;
  /** Distances along the line (working px from the line's foot nearest the anchor). */
  exit: number;
  start: number;
  end: number;
  on: number;
  span: number;
  sum: number;
  score: number;
  cut: boolean;
  /** Fit of the bar's centre across the line, o = alpha + beta * r, over the run. */
  alpha: number;
  beta: number;
}

interface Judged {
  run: Run;
  quality: number;
  contrast: number;
  /** Evidence for this line against the others of one search. */
  rank: number;
}

/** Past the tip, a sample under this share of the shaft's running contrast is background (a quarter let
 *  the texture of a wall carry a faint wand, 27 levels, a quarter palm too far). */
const BAR_SHARE = 0.35;

/** The profile across a line is read this many working pixels each side of it... */
const PROFILE = 10;
/** ...and a bar must stand out from the profile this far each side of its centre: from a sharp tip 3 px
 *  wide to a shaft smeared across by a stroke to 15 px (synthetic scenes: with sides at 2 to 4 px only, a
 *  smear of a sixth of a palm hid every shaft). */
const SIDES = [2, 3, 4, 6, 8] as const;

/** The quality of a find cut off by the frame's edge is scaled by this (judge). */
const CUT_SHARE = 0.7;

/** The refit may turn a line this far (radians): the bins are a degree wide, and a farther turn is another
 *  bar... */
const REFIT_TURN = (8 * Math.PI) / 180;
/** ... and only a run of this many bar samples may turn it at all. */
const REFIT_SAMPLES = 6;

/** Squared gradient at i when this search computed it there, else 0. */
function magAt(gx: Float32Array, gy: Float32Array, mark: Int32Array, stamp: number, i: number): number {
  return mark[i] === stamp ? gx[i] * gx[i] + gy[i] * gy[i] : 0;
}

const TAU = 2 * Math.PI;
const THETA_BINS = 360;
const COS = new Float64Array(THETA_BINS), SIN = new Float64Array(THETA_BINS);
for (let i = 0; i < THETA_BINS; i++) {
  const a = ((i + 0.5) / THETA_BINS) * TAU - Math.PI;
  COS[i] = Math.cos(a);
  SIN[i] = Math.sin(a);
}
const binTheta = (i: number) => ((i + 0.5) / THETA_BINS) * TAU - Math.PI;
const wrapPi = (a: number) => a - TAU * Math.floor((a + Math.PI) / TAU);

/**
 * The finder, with its scratch buffers (one per worker). find() is the whole of steps 2 to 5.
 */
export class WandFinder {
  private work = new Float32Array(0);
  private hull = new Uint8Array(0);
  private acc = new Float32Array(0);
  private tmp = new Float32Array(0);
  /** Gradients of the pixels that may vote, and the search that computed each (mark === stamp). */
  private gx = new Float32Array(0);
  private gy = new Float32Array(0);
  private mark = new Int32Array(0);
  private stamp = 0;
  /** Pixels that cleared the gradient floor in pass 1 of a search. */
  private cand = new Int32Array(4096);
  private noiseHist = new Uint32Array(1024);
  private w = 0;
  private h = 0;
  private f = 1;
  private plane: LumaPlane | null = null;
  // Per-run sample buffers (verify).
  private sR = new Float32Array(512);
  private sV = new Float32Array(512);
  private sO = new Float32Array(512);
  private sHidden = new Uint8Array(512);
  private prof = new Float64Array(2 * PROFILE + 1);

  /**
   * Find the wand. `hand` is the 21 landmarks in frame pixels (x, y pairs, unmirrored), `prior` the
   * wand tip's grip coordinates from the last frames, or null to search every direction.
   */
  find(plane: LumaPlane, hand: ArrayLike<number>, prior: { a: number; b: number } | null): WandFound | null {
    const g = gripFrame(hand, 2, 1, 1);
    if (!(g.palm > 4) || plane.width < 8 || plane.height < 8) return null;
    this.plane = plane;
    const f = Math.max(1, Math.round(g.palm / WAND.workPalm));
    this.f = f;
    this.downsample(plane, f);
    // Working coordinates: working pixel (i, j) has its centre at (i, j).
    const toWx = (x: number) => (x - plane.x0) / f - 0.5;
    const toWy = (y: number) => (y - plane.y0) / f - 0.5;
    const ax = toWx(g.ax), ay = toWy(g.ay), P = g.palm / f;
    const pts: number[] = [];
    for (let i = 0; i < 21; i++) pts.push(toWx(hand[i * 2]), toWy(hand[i * 2 + 1]));
    this.rasterHull(pts, WAND.hullPad * P);
    const sigma = this.noise();
    // A bar must stand out from both sides by this much (luma levels, working image).
    const tauR = Math.max(4, 3 * sigma);
    // Forearm direction, from the anchor towards the wrist.
    const fore = Math.atan2(-g.uy, -g.ux);

    let priorTheta: number | null = null;
    if (prior && Number.isFinite(prior.a) && Number.isFinite(prior.b)) {
      const p = fromGrip({ ...g, ax, ay, palm: P }, prior.a, prior.b);
      if (Math.hypot(p.x - ax, p.y - ay) > 0.3 * P) priorTheta = Math.atan2(p.y - ay, p.x - ax);
    }

    let best: Judged | null = null;
    let search: WandFound['search'] = 'wide';
    if (priorTheta !== null) {
      best = this.search(ax, ay, P, fore, priorTheta, sigma, tauR);
      search = 'prior';
    }
    if (!best || best.quality < WAND.priorEnough) {
      const wide = this.search(ax, ay, P, fore, null, sigma, tauR);
      if (wide && (!best || wide.quality > best.quality)) {
        best = wide;
        search = 'wide';
      }
    }
    if (!best) return null;

    const { run } = best;
    const { theta, rho } = run.line;
    const ux = Math.cos(theta), uy = Math.sin(theta), nx = -uy, ny = ux;
    const bx = ax + rho * nx, by = ay + rho * ny;
    const at = (r: number) => {
      const o = run.alpha + run.beta * r;
      return { x: bx + r * ux + o * nx, y: by + r * uy + o * ny };
    };
    const tipW = at(run.end + 0.5), baseW = at(run.start);
    const toFx = (x: number) => (x + 0.5) * f + plane.x0;
    const toFy = (y: number) => (y + 0.5) * f + plane.y0;
    const tip = { x: toFx(tipW.x), y: toFy(tipW.y) };
    // The working image's noise is the frame's averaged over f x f pixels: f times less.
    const glint = this.glint(tip.x, tip.y, ux, uy, g.palm, sigma * f);
    return {
      tip,
      base: { x: toFx(baseW.x), y: toFy(baseW.y) },
      quality: round3(best.quality),
      contrast: round3(best.contrast),
      length: round3((run.end - run.start) / P),
      support: round3(run.on / Math.max(1, run.span)),
      cut: run.cut,
      glint,
      search,
    };
  }

  // ------------------------------------------------------------------------------------ steps

  /** Step 2: the working image, full range. */
  private downsample(plane: LumaPlane, f: number): void {
    this.pool(plane, f);
    if (!plane.limited) return;
    // Video range stretched to full range, the range every level below is stated in (the canvas path reads
    // full range; without this the same scene was judged 14% stricter on the camera's own frames). The
    // stretch is linear, so stretching the averages is stretching the pixels, at a ninth of the work.
    const out = this.work, n = this.w * this.h;
    for (let i = 0; i < n; i++) {
      const v = (out[i] - 16) * LIMITED;
      out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }

  /** Box-average the plane by f into the working image. The common factors (2 at 720p, 3 at 1080p) have
   *  their own loops; a whole 1080p region is about a million source pixels. */
  private pool(plane: LumaPlane, f: number): void {
    const w = Math.floor(plane.width / f), h = Math.floor(plane.height / f);
    this.w = w;
    this.h = h;
    const n = w * h;
    if (this.work.length < n) {
      this.work = new Float32Array(n);
      this.gx = new Float32Array(n);
      this.gy = new Float32Array(n);
      this.mark = new Int32Array(n);
    }
    const out = this.work;
    const src = plane.data, stride = plane.stride;
    if (f === 1) {
      for (let y = 0; y < h; y++) {
        const r = y * stride, o = y * w;
        for (let x = 0; x < w; x++) out[o + x] = src[r + x];
      }
      return;
    }
    if (f === 2) {
      for (let y = 0; y < h; y++) {
        const r0 = 2 * y * stride, r1 = r0 + stride, o = y * w;
        for (let x = 0, s = 0; x < w; x++, s += 2) out[o + x] = (src[r0 + s] + src[r0 + s + 1] + src[r1 + s] + src[r1 + s + 1]) * 0.25;
      }
      return;
    }
    if (f === 3) {
      const inv = 1 / 9;
      for (let y = 0; y < h; y++) {
        const r0 = 3 * y * stride, r1 = r0 + stride, r2 = r1 + stride, o = y * w;
        for (let x = 0, s = 0; x < w; x++, s += 3) {
          out[o + x] = (src[r0 + s] + src[r0 + s + 1] + src[r0 + s + 2] + src[r1 + s] + src[r1 + s + 1] + src[r1 + s + 2] + src[r2 + s] + src[r2 + s + 1] + src[r2 + s + 2]) * inv;
        }
      }
      return;
    }
    const inv = 1 / (f * f);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) out[o + x] = 0;
      for (let k = 0; k < f; k++) {
        const r = (y * f + k) * stride;
        for (let x = 0, s = r; x < w; x++) {
          let acc = 0;
          for (let q = 0; q < f; q++, s++) acc += src[s];
          out[o + x] += acc;
        }
      }
      for (let x = 0; x < w; x++) out[o + x] *= inv;
    }
  }

  /** The landmarks' convex hull, padded by `pad`, as a mask on the working grid. */
  private rasterHull(pts: number[], pad: number): void {
    const n = this.w * this.h;
    if (this.hull.length < n) this.hull = new Uint8Array(n);
    this.hull.fill(0, 0, n);
    const hull = convexHull(pts);
    if (hull.length < 3) return;
    // Outward edge normals and offsets: inside-or-near means every n·p - c <= pad.
    const edges: number[] = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < hull.length; i += 2) {
      const x0 = hull[i], y0 = hull[i + 1];
      const x1 = hull[(i + 2) % hull.length], y1 = hull[(i + 3) % hull.length];
      const ex = x1 - x0, ey = y1 - y0, len = Math.hypot(ex, ey);
      if (len < 1e-9) continue;
      // Counter-clockwise hull (convexHull), y down: the outward normal is (ey, -ex) / len.
      const nx = ey / len, ny = -ex / len;
      edges.push(nx, ny, nx * x0 + ny * y0);
      minX = Math.min(minX, x0);
      maxX = Math.max(maxX, x0);
      minY = Math.min(minY, y0);
      maxY = Math.max(maxY, y0);
    }
    const x0 = Math.max(0, Math.floor(minX - pad - 1)), x1 = Math.min(this.w - 1, Math.ceil(maxX + pad + 1));
    const y0 = Math.max(0, Math.floor(minY - pad - 1)), y1 = Math.min(this.h - 1, Math.ceil(maxY + pad + 1));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let inside = true;
        for (let e = 0; e < edges.length; e += 3) {
          if (edges[e] * x + edges[e + 1] * y - edges[e + 2] > pad) {
            inside = false;
            break;
          }
        }
        if (inside) this.hull[y * this.w + x] = 1;
      }
    }
  }

  private inHull(x: number, y: number): boolean {
    const i = Math.round(x), j = Math.round(y);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return false;
    return this.hull[j * this.w + i] === 1;
  }

  /** Pixel noise of the working image, from the median step between neighbours outside the hand (a
   *  histogram in quarter levels: a sort of the ten thousand steps cost more than the rest of a find). */
  private noise(): number {
    const { w, h, work } = this;
    const hist = this.noiseHist;
    hist.fill(0);
    let n = 0;
    for (let y = 1; y < h - 1; y += 3) {
      const row = y * w;
      for (let x = 1; x < w - 2; x += 3) {
        if (this.hull[row + x]) continue;
        const d = Math.abs(work[row + x + 1] - work[row + x]) * 4;
        hist[d >= 1023 ? 1023 : d | 0]++;
        n++;
      }
    }
    if (!n) return 2;
    let k = 0;
    for (let c = 0; k < 1023; k++) {
      c += hist[k];
      if (2 * c >= n) break;
    }
    // Median absolute difference of two pixels: 0.6745 * sqrt(2) * sigma for Gaussian noise.
    return (k + 0.5) / 4 / 0.954;
  }

  /** Steps 3 and 4: vote for lines through the grip, check the strongest, return the best. */
  private search(ax: number, ay: number, P: number, fore: number, prior: number | null, sigma: number, tauR: number): Judged | null {
    const { w, h, work } = this;
    const R = Math.max(2, Math.round(WAND.rhoMax * P));
    const nRho = 2 * R + 1;
    const cells = THETA_BINS * nRho;
    if (this.acc.length < cells) {
      this.acc = new Float32Array(cells);
      this.tmp = new Float32Array(cells);
    }
    const acc = this.acc;
    acc.fill(0, 0, cells);
    // Sobel noise: a 3 x 3 Sobel of white noise has 3.46 sigma; an edge of the shaft is far above it.
    const tauG = Math.max(WAND.gradFloor, 8.5 * sigma);
    const cap = 4 * tauG;
    const reach2 = (WAND.reach * P) ** 2;
    const minAlong = WAND.minAlong * P;
    const minR2 = minAlong * minAlong;
    const x0 = Math.max(1, Math.floor(ax - WAND.reach * P)), x1 = Math.min(w - 2, Math.ceil(ax + WAND.reach * P));
    const y0 = Math.max(1, Math.floor(ay - WAND.reach * P)), y1 = Math.min(h - 2, Math.ceil(ay + WAND.reach * P));
    const cosFore = Math.cos(WAND.forearmCone);
    const fx = Math.cos(fore), fy = Math.sin(fore);
    const cosPrior = Math.cos(WAND.priorCone);
    const px = prior === null ? 0 : Math.cos(prior), py = prior === null ? 0 : Math.sin(prior);
    // A pixel a palm or more from the anchor lies within 30 degrees (asin(rhoMax)) of the direction of any
    // line through it that passes the anchor within rhoMax: outside the cones by more than that, it can
    // vote for nothing, and its gradient is never computed.
    const far2 = P * P;
    const cosPriorFar = Math.cos(WAND.priorCone + Math.PI / 6);
    const cosForeFar = Math.cos(Math.max(0, WAND.forearmCone - Math.PI / 6));
    const gxs = this.gx, gys = this.gy, mark = this.mark, hull = this.hull;
    const stamp = ++this.stamp;
    let cand = this.cand, count = 0;
    const tau2 = tauG * tauG;
    // A Sobel response is about 4 times the central difference on a smooth edge; a pixel whose central
    // differences are under half of that is flat, and is passed over before the full kernel is read.
    const pre2 = tau2 / 64;
    // Pass 1: gradients (Sobel) of the pixels that may vote, row by row across the disk of reach.
    for (let y = y0; y <= y1; y++) {
      const row = y * w;
      const dy = y - ay;
      const left = reach2 - dy * dy;
      if (left < 0) continue;
      const half = Math.sqrt(left);
      const xs = Math.max(x0, Math.ceil(ax - half)), xe = Math.min(x1, Math.floor(ax + half));
      for (let x = xs; x <= xe; x++) {
        const i = row + x;
        if (hull[i]) continue;
        const ch = work[i + 1] - work[i - 1], cv = work[i + w] - work[i - w];
        if (ch * ch + cv * cv < pre2) continue;
        const dx = x - ax;
        const d2 = dx * dx + dy * dy;
        if (d2 < minR2) continue;
        if (d2 >= far2) {
          const d = Math.sqrt(d2);
          if ((dx * fx + dy * fy) / d > cosForeFar) continue;
          if (prior !== null && (dx * px + dy * py) / d < cosPriorFar) continue;
        }
        const a = work[i - w - 1], b = work[i - w], c = work[i - w + 1];
        const d = work[i - 1], e = work[i + 1];
        const fq = work[i + w - 1], gq = work[i + w], hq = work[i + w + 1];
        const gx = c + 2 * e + hq - a - 2 * d - fq;
        const gy = fq + 2 * gq + hq - a - 2 * b - c;
        if (gx * gx + gy * gy < tau2) continue;
        gxs[i] = gx;
        gys[i] = gy;
        mark[i] = stamp;
        if (count === cand.length) {
          const grown = new Int32Array(cand.length * 2);
          grown.set(cand);
          cand = this.cand = grown;
        }
        cand[count++] = i;
      }
    }
    // Pass 2: an edge pixel votes only where its gradient peaks across the edge (non-maximum suppression,
    // as in Canny): each edge of the shaft is then one line of voters, not a band.
    for (let k = 0; k < count; k++) {
      const i = cand[k];
      const y = (i / w) | 0, x = i - y * w;
      const dx = x - ax, dy = y - ay;
      const gx = gxs[i], gy = gys[i];
      const m2 = gx * gx + gy * gy;
      // Neighbours along the gradient, its direction rounded to 45 degrees.
      const agx = Math.abs(gx), agy = Math.abs(gy);
      let o: number;
      if (agx > 2.414 * agy) o = 1;
      else if (agy > 2.414 * agx) o = w;
      else o = gx * gy > 0 ? w + 1 : w - 1;
      if (magAt(gxs, gys, mark, stamp, i + o) > m2 || magAt(gxs, gys, mark, stamp, i - o) > m2) continue;
      const m = Math.sqrt(m2);
      // The edge runs across the gradient; take the direction that leads away from the anchor.
      let ux = -gy / m, uy = gx / m;
      let t = dx * ux + dy * uy;
      if (t < 0) {
        ux = -ux;
        uy = -uy;
        t = -t;
      }
      if (t < minAlong) continue;
      if (ux * fx + uy * fy > cosFore) continue;
      if (prior !== null && ux * px + uy * py < cosPrior) continue;
      const wgt = m >= cap ? 1 : m / cap;
      // The lines through this pixel within 2 degrees of its edge: an orientation error would move a far
      // pixel's line a long way across, so each nearby direction gets its own vote.
      const center = Math.floor(((Math.atan2(uy, ux) + Math.PI) / TAU) * THETA_BINS) % THETA_BINS;
      for (let j = -2; j <= 2; j++) {
        const tb = (center + j + THETA_BINS) % THETA_BINS;
        // rho = (p - A) · n with n = (-sin, cos): where the line passes the anchor, across it.
        const rho = dy * COS[tb] - dx * SIN[tb];
        const rb = Math.round(rho) + R;
        if (rb < 0 || rb >= nRho) continue;
        // Only the line leaving the anchor this way: the pixel lies ahead along it.
        if (dx * COS[tb] + dy * SIN[tb] < minAlong) continue;
        acc[tb * nRho + rb] += j === 0 ? wgt : j === 1 || j === -1 ? 0.8 * wgt : 0.5 * wgt;
      }
    }
    this.smooth(nRho);
    const peaks = this.peaks(nRho);
    let best: Judged | null = null;
    const found: Judged[] = [];
    for (const p of peaks) {
      const theta = binTheta(p.tb);
      const rho = p.rb - R;
      let run = this.verify(ax, ay, { theta, rho }, P, tauR);
      if (!run) continue;
      // Refit through the bar's centre and check again (the bins are a degree and a pixel wide). The refit
      // only corrects the bins: a larger turn, or a line the vote would not have counted, is another bar
      // (a fit over a few samples once turned a weak line 59 degrees onto a wall's stripes and kept it).
      const refined = this.refine(ax, ay, run);
      const rx = Math.cos(refined.theta), ry = Math.sin(refined.theta);
      const fits =
        Math.abs(wrapPi(refined.theta - theta)) <= REFIT_TURN &&
        Math.abs(refined.rho) <= R + 1 &&
        rx * fx + ry * fy <= cosFore &&
        (prior === null || rx * px + ry * py >= cosPrior);
      const again = fits ? this.verify(ax, ay, refined, P, tauR) : null;
      if (again && again.score >= run.score * 0.98) run = again;
      const judged = this.judge(run, P, tauR, sigma);
      if (!judged) continue;
      found.push(judged);
      // The strongest evidence wins: two lines along the same wand can both look certain, and the one
      // that follows it all the way to the tip has the larger score.
      if (!best || judged.rank > best.rank) best = judged;
    }
    if (!best) return null;
    // Ambiguity: another bar, in another direction, nearly as strong.
    let quality = best.quality;
    for (const o of found) {
      if (o === best) continue;
      if (Math.abs(wrapPi(o.run.line.theta - best.run.line.theta)) < (10 * Math.PI) / 180) continue;
      const ratio = o.rank / Math.max(1e-9, best.rank);
      if (ratio > 0.75) quality *= 1 - (0.8 * (ratio - 0.75)) / 0.25;
    }
    return { ...best, quality };
  }

  /** Smooth the accumulator: across rho by a triangle 7 bins wide (the shaft's two edges, 3 to 6 px
   *  apart, become one ridge), and across theta by [1 2 1] (circular). */
  private smooth(nRho: number): void {
    const acc = this.acc, tmp = this.tmp;
    const K = [1, 2, 3, 4, 3, 2, 1];
    for (let t = 0; t < THETA_BINS; t++) {
      const row = t * nRho;
      for (let r = 0; r < nRho; r++) {
        let s = 0;
        for (let k = -3; k <= 3; k++) {
          const rr = r + k;
          if (rr < 0 || rr >= nRho) continue;
          s += K[k + 3] * acc[row + rr];
        }
        tmp[row + r] = s / 16;
      }
    }
    for (let t = 0; t < THETA_BINS; t++) {
      const a = ((t + THETA_BINS - 1) % THETA_BINS) * nRho, b = t * nRho, c = ((t + 1) % THETA_BINS) * nRho;
      for (let r = 0; r < nRho; r++) acc[b + r] = (tmp[a + r] + 2 * tmp[b + r] + tmp[c + r]) / 4;
    }
  }

  /** The strongest cells, each at least 4 degrees and 3 pixels from a stronger one. */
  private peaks(nRho: number): { tb: number; rb: number; v: number }[] {
    const acc = this.acc;
    const out: { tb: number; rb: number; v: number }[] = [];
    const cells = THETA_BINS * nRho;
    // A cell needs some support to be worth checking: two edges of a bar a palm length long give about
    // 2 * WAND.workPalm votes; a tenth of that is the floor.
    const floor = 0.1 * WAND.workPalm;
    const taken: { tb: number; rb: number }[] = [];
    for (let k = 0; k < WAND.peaks; k++) {
      let bi = -1, bv = floor;
      for (let i = 0; i < cells; i++) {
        const v = acc[i];
        if (v <= bv) continue;
        const tb = (i / nRho) | 0, rb = i - tb * nRho;
        let near = false;
        for (const q of taken) {
          const dt = Math.min(Math.abs(tb - q.tb), THETA_BINS - Math.abs(tb - q.tb));
          if (dt <= 4 && Math.abs(rb - q.rb) <= 3) {
            near = true;
            break;
          }
        }
        if (near) continue;
        bi = i;
        bv = v;
      }
      if (bi < 0) break;
      const tb = (bi / nRho) | 0;
      taken.push({ tb, rb: bi - tb * nRho });
      out.push({ tb, rb: bi - tb * nRho, v: bv });
    }
    return out;
  }

  /**
   * Step 4: walk a line outward from the anchor's foot and find the bar on it. At each pixel step the
   * profile across the line is read at -PROFILE..PROFILE px; a bar centred within a pixel of the line,
   * 3 to 15 px wide (SIDES), must be darker (or lighter) than both sides by tauR. The run starts within WAND.startSlack of
   * where the line leaves the hand, allows gaps up to WAND.gap, and ends at the last bar sample.
   */
  private verify(ax: number, ay: number, line: Line, P: number, tauR: number): Run | null {
    const { theta, rho } = line;
    const ux = Math.cos(theta), uy = Math.sin(theta), nx = -uy, ny = ux;
    const bx = ax + rho * nx, by = ay + rho * ny;
    const rMax = WAND.reach * P;
    const need = Math.ceil(rMax) + 2;
    if (this.sR.length < need) {
      this.sR = new Float32Array(need);
      this.sV = new Float32Array(need);
      this.sO = new Float32Array(need);
      this.sHidden = new Uint8Array(need);
    }
    const sR = this.sR, sV = this.sV, sO = this.sO, sHidden = this.sHidden;
    let n = 0;
    let exit = -1;
    /** Where the walk left the hand, even inside the band along the frame's edge that cannot be read: the
     *  start check counts from there, not from where the band ends (counted from the band's end, a bar
     *  starting two palms from a hand at the edge passed for the shaft). */
    let left = -1;
    let cut = false;
    const prof = this.prof;
    // Keep clear of each edge by what the profile across the line and a bilinear read need: along the line
    // the walk may come within two pixels of the edge (a margin all round stopped every shaft a third of a
    // palm short of the frame's edge).
    const mx = Math.ceil(PROFILE * Math.abs(nx)) + 2, my = Math.ceil(PROFILE * Math.abs(ny)) + 2;
    for (let r = 0; r <= rMax; r += 1) {
      const cx = bx + r * ux, cy = by + r * uy;
      if (cx < mx || cy < my || cx > this.w - 1 - mx || cy > this.h - 1 - my) {
        // Still in the hand: a hand at the frame's edge starts its walk in the band that cannot be read,
        // and the shaft may run into the frame from there. Only past the hand is the edge a cut.
        if (exit < 0) {
          if (left < 0 && !this.inHull(cx, cy)) left = r;
          continue;
        }
        cut = true;
        break;
      }
      if (this.inHull(cx, cy)) {
        if (exit < 0) continue;
        // Back over the hand (a thumb across the shaft): hidden, neither bar nor gap.
        sR[n] = r;
        sV[n] = 0;
        sO[n] = 0;
        sHidden[n] = 1;
        n++;
        continue;
      }
      if (exit < 0) exit = left >= 0 ? left : r;
      const Z = PROFILE;
      for (let k = -Z; k <= Z; k++) prof[k + Z] = this.sample(cx + k * nx, cy + k * ny);
      let bestV = 0, bestC = 0, bestS = 0;
      for (let c = -1; c <= 1; c++) {
        const pc = prof[c + Z];
        for (const s of SIDES) {
          const dl = pc - prof[c - s + Z], dr = pc - prof[c + s + Z];
          if (dl * dr <= 0) continue;
          const v = Math.min(Math.abs(dl), Math.abs(dr));
          if (v > bestV) {
            bestV = v;
            bestC = c;
            bestS = s;
          }
        }
      }
      // The bar's centre across the line: the centroid of its contrast against the two sides, which holds
      // for a sharp bar and for the flat top of a smeared one alike.
      let off = bestC;
      if (bestV > 0) {
        const base = (prof[bestC - bestS + Z] + prof[bestC + bestS + Z]) / 2;
        const sign = prof[bestC + Z] < base ? -1 : 1;
        let ws = 0, wo = 0;
        for (let k = bestC - bestS + 1; k <= bestC + bestS - 1; k++) {
          const v = sign * (prof[k + Z] - base);
          if (v <= 0) continue;
          ws += v;
          wo += v * k;
        }
        if (ws > 0) off = wo / ws;
      }
      sR[n] = r;
      sV[n] = bestV;
      sO[n] = off;
      sHidden[n] = 0;
      n++;
    }
    if (exit < 0 || n === 0) return null;
    // The run.
    const slack = WAND.startSlack * P, gapMax = Math.max(2, WAND.gap * P);
    let start = -1;
    for (let i = 0; i < n; i++) {
      if (sR[i] - exit > slack) break;
      if (!sHidden[i] && sV[i] >= tauR) {
        start = i;
        break;
      }
    }
    if (start < 0) return null;
    // A sample is part of the bar when it clears tauR and BAR_SHARE of the bar's own contrast so far (a
    // running level that follows the shaft as the background behind it changes): past the tip, the
    // texture of a wall can clear a threshold set by the noise alone, but not one set by the wand.
    let end = start, gap = 0, level = sV[start];
    const isBar = (v: number) => v >= tauR && v >= BAR_SHARE * level;
    // Pieces of bar between gaps of 2 samples or more: [first, last, gap before], so a short piece just past
    // the tip (an edge or a cable crossing the line there) can be told from the shaft going on.
    const pieces: number[] = [start, start, 0];
    for (let i = start; i < n; i++) {
      if (sHidden[i]) continue;
      const v = sV[i];
      if (isBar(v)) {
        if (gap >= 2) pieces.push(i, i, gap);
        else pieces[pieces.length - 2] = i;
        end = i;
        gap = 0;
        level += 0.15 * (Math.min(2 * level, Math.max(0.5 * level, v)) - level);
        sV[i] = v;
      } else {
        // Marked off for the sums below.
        sV[i] = -v - 1;
        gap += 1;
        if (gap > gapMax) break;
      }
    }
    // A last piece shorter than one and a half times the gap before it (and than 4 samples) is not shaft.
    while (pieces.length > 3) {
      const k = pieces.length - 3;
      const len = pieces[k + 1] - pieces[k] + 1;
      if (len >= Math.max(4, 1.5 * pieces[k + 2])) break;
      for (let i = pieces[k]; i <= pieces[k + 1]; i++) if (!sHidden[i] && sV[i] >= 0) sV[i] = -sV[i] - 1;
      pieces.length = k;
      end = pieces[k - 2];
    }
    let on = 0, sum = 0;
    let span = 0, sx = 0, so = 0, sxx = 0, sxo = 0;
    for (let i = start; i <= end; i++) {
      if (sHidden[i]) continue;
      span++;
      if (sV[i] >= 0) {
        on++;
        sum += sV[i];
        sx += sR[i];
        so += sO[i];
        sxx += sR[i] * sR[i];
        sxo += sR[i] * sO[i];
      }
    }
    // The run is cut when it reaches the edge of what was read, not when the bar ends before it.
    const reachedEdge = cut && end >= n - 1 - Math.ceil(gapMax);
    let alpha = 0, beta = 0;
    if (on >= 3) {
      // A slope from a short run is noise: the line is only shifted across unless the run is long enough to
      // turn it (REFIT_SAMPLES bar samples over a quarter of a palm).
      const den = on * sxx - sx * sx;
      const spread = Math.sqrt(Math.max(0, sxx / on - (sx / on) ** 2)) * Math.sqrt(12);
      if (on >= REFIT_SAMPLES && spread >= 0.25 * P && Math.abs(den) > 1e-9) {
        beta = (on * sxo - sx * so) / den;
        alpha = (so - beta * sx) / on;
      } else {
        alpha = so / on;
      }
    }
    const off = span - on;
    return {
      line, exit, start: sR[start], end: sR[end], on, span, sum,
      score: sum - 0.5 * tauR * off, cut: reachedEdge, alpha, beta,
    };
  }

  /** The line through the bar's centre, from a run's fit. */
  private refine(ax: number, ay: number, run: Run): Line {
    const { theta, rho } = run.line;
    const ux = Math.cos(theta), uy = Math.sin(theta), nx = -uy, ny = ux;
    // Points on the fitted centre line at r = 0 and r = 1, in working coordinates.
    const bx = ax + rho * nx, by = ay + rho * ny;
    const p0x = bx + run.alpha * nx, p0y = by + run.alpha * ny;
    const p1x = bx + ux + (run.alpha + run.beta) * nx, p1y = by + uy + (run.alpha + run.beta) * ny;
    const t = Math.atan2(p1y - p0y, p1x - p0x);
    const vx = Math.cos(t), vy = Math.sin(t);
    // Signed distance of the new line from the anchor, positive to the left (n = (-uy, ux)).
    const r = (p0x - ax) * -vy + (p0y - ay) * vx;
    return { theta: t, rho: r };
  }

  /** Quality of a run: support, contrast, a plausible length, and a start where the shaft leaves the
   *  hand; and its rank among the lines of one search (its evidence, weighed by the same start and
   *  support). */
  private judge(run: Run, P: number, tauR: number, sigma: number): Judged | null {
    const length = (run.end - run.start) / P;
    if (length < WAND.minLength || run.on < 4) return null;
    const support = run.on / Math.max(1, run.span);
    const contrast = run.sum / run.on;
    const qContrast = clamp01((contrast - tauR) / Math.max(2, 3 * tauR));
    const qSupport = clamp01((support - 0.45) / 0.4);
    const qLength = smoothstep(WAND.minLength, 1.2, length);
    const late = (run.start - run.exit) / P;
    const qStart = 1 - smoothstep(0.15, WAND.startSlack, late);
    // A noisy image (sigma high) makes every bar less certain.
    const qNoise = clamp01(1.2 - sigma / 12);
    // And a faint bar is no wand, however clean the image: a held wand stands 20 levels or more from most
    // backgrounds, while the edges of a smeared shaft, or texture lined up by chance, reach 5 to 15
    // (synthetic scenes with a shaft smeared by a third of a palm: three such bars were taken for the
    // wand at 0.5 to 0.75 before this).
    const qFaint = smoothstep(7, 22, contrast);
    // A bar cut off by the frame's edge says nothing of where it ends, and the shelves and stripes of a room
    // run off the frame too: it is never sure (WAND_SURE in tracking.ts), and a weak one is not used.
    const qCut = run.cut ? CUT_SHARE : 1;
    const quality = Math.sqrt(qContrast) * qSupport * qLength * (0.4 + 0.6 * qStart) * qNoise * qFaint * qCut;
    const rank = Math.max(0, run.score) * (0.4 + 0.6 * qStart) * (0.5 + 0.5 * qSupport);
    return { run, quality, contrast, rank };
  }

  /** Bilinear sample of the working image (pixel centres on integers). */
  private sample(x: number, y: number): number {
    const w = this.w;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const i = y0 * w + x0;
    const d = this.work;
    return (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + w] * (1 - fx) + d[i + w + 1] * fx) * fy;
  }

  /**
   * Step 5: a lit tip. Around the tip (frame px), at full resolution, a spot at least 50 levels brighter
   * than its surroundings, brighter than the shaft behind it by six times the frame's noise (15 levels or
   * more), and no wider than a fifth of a palm; its brightness-weighted centre.
   */
  private glint(tx: number, ty: number, ux: number, uy: number, palm: number, noise: number): { x: number; y: number } | null {
    const plane = this.plane!;
    const full = plane.limited ? (v: number) => Math.max(0, Math.min(255, (v - 16) * LIMITED)) : (v: number) => v;
    const r = Math.max(3, Math.round(0.3 * palm));
    const cx = Math.round(tx + 0.1 * palm * ux - plane.x0), cy = Math.round(ty + 0.1 * palm * uy - plane.y0);
    const x0 = Math.max(0, cx - r), x1 = Math.min(plane.width - 1, cx + r);
    const y0 = Math.max(0, cy - r), y1 = Math.min(plane.height - 1, cy + r);
    if (x1 - x0 < 4 || y1 - y0 < 4) return null;
    const d = plane.data, stride = plane.stride;
    let max = 0, mx = 0, my = 0;
    let sum = 0, count = 0;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const v = d[y * stride + x];
        sum += v;
        count++;
        if (v > max) {
          max = v;
          mx = x;
          my = y;
        }
      }
    }
    const peak = full(max);
    const mean = full(sum / Math.max(1, count));
    if (peak < 165 || peak - mean < 50) return null;
    // A spot, not the shaft: an unlit light wand on a darker wall is as bright a fifth to two fifths of a
    // palm back along its line as at its end, and its brightest pixel there is no lit tip (in synthetic
    // scenes every such wand was given a glint, which moved the tip 0.1 palm back and shook it). The margin
    // follows the noise: a fixed 25 levels lost a lit tip on a near-white wand in a clean picture, and 15
    // gave noisy light wands glints again.
    const back: number[] = [];
    for (let i = 0; i < 5; i++) {
      const sb = (0.2 + 0.05 * i) * palm;
      const bx = Math.round(tx - sb * ux - plane.x0), by = Math.round(ty - sb * uy - plane.y0);
      if (bx >= 0 && by >= 0 && bx < plane.width && by < plane.height) back.push(full(d[by * stride + bx]));
    }
    back.sort((a, b) => a - b);
    if (back.length && peak - back[back.length >> 1] < Math.max(15, 6 * noise)) return null;
    // Compact: the pixels near the peak's level must be few (in raw levels: the stretch keeps their order).
    const level = max - 25 / (plane.limited ? LIMITED : 1);
    let n = 0, wx = 0, wy = 0, ws = 0;
    const k = Math.max(2, Math.round(0.1 * palm));
    for (let y = Math.max(y0, my - k); y <= Math.min(y1, my + k); y++) {
      for (let x = Math.max(x0, mx - k); x <= Math.min(x1, mx + k); x++) {
        const v = d[y * stride + x];
        if (v < level) continue;
        n++;
        const wgt = v - level + 1;
        ws += wgt;
        wx += wgt * (x + 0.5);
        wy += wgt * (y + 0.5);
      }
    }
    if (n > Math.PI * k * k * 0.8 || ws <= 0) return null;
    return { x: wx / ws + plane.x0, y: wy / ws + plane.y0 };
  }
}

/** Andrew's monotone chain; returns the hull counter-clockwise (in a y-down frame: clockwise on screen)
 *  as flat x, y pairs. */
export function convexHull(pts: readonly number[]): number[] {
  const idx: number[] = [];
  for (let i = 0; i < pts.length; i += 2) if (Number.isFinite(pts[i]) && Number.isFinite(pts[i + 1])) idx.push(i);
  idx.sort((a, b) => pts[a] - pts[b] || pts[a + 1] - pts[b + 1]);
  if (idx.length < 3) return idx.flatMap((i) => [pts[i], pts[i + 1]]);
  const cross = (o: number, a: number, b: number) => (pts[a] - pts[o]) * (pts[b + 1] - pts[o + 1]) - (pts[a + 1] - pts[o + 1]) * (pts[b] - pts[o]);
  const lower: number[] = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper: number[] = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  lower.pop();
  upper.pop();
  return [...lower, ...upper].flatMap((i) => [pts[i], pts[i + 1]]);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
