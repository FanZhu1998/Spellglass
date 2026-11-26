// Synthetic scenes for the wand finder's tests (wand.test.ts, tracking.test.ts): a fist with MediaPipe's
// 21 landmarks, a tapered wand held in it, and a room behind, drawn into a luma plane. Not part of the app.

import { gripFrame } from './wand';

export interface SceneHand {
  /** Wrist position, frame px. */
  x: number;
  y: number;
  /** Palm length (wrist to middle knuckle), px. */
  palm: number;
  /** Direction of the palm, wrist to middle knuckle, radians (y down: -PI/2 is straight up). */
  angle: number;
  /** Mirror the hand across its palm axis (the other hand). */
  mirror?: boolean;
}

export interface SceneWand {
  /** Direction from the grip to the tip, radians (y down). */
  angle: number;
  /** Visible length past the anchor, palm lengths. */
  length: number;
  /** The line's offset from the anchor, across it, palm lengths. */
  offset?: number;
  /** Diameter at the handle and at the tip, palm lengths. */
  thick?: number;
  thin?: number;
  /** Luma of the wand. */
  level?: number;
  /** A lit tip: a small spot this bright at the end. */
  glint?: number;
  /** Motion blur across the shaft, palm lengths (the bar is smeared over this width). */
  blur?: number;
}

export interface SceneOptions {
  width: number;
  height: number;
  hand: SceneHand;
  wand?: SceneWand | null;
  /** Background: a plain light wall, a dark one, or a room with a shelf, a door frame and a cable. */
  background?: 'light' | 'dark' | 'room';
  noise?: number;
  seed?: number;
}

export interface Scene {
  data: Uint8Array;
  width: number;
  height: number;
  /** The 21 landmarks, frame px, x, y pairs. */
  landmarks: number[];
  /** The same, normalized like MediaPipe's (x, y, z triples over the frame size). */
  normalized: number[];
  /** Where the wand's tip is, frame px (null without a wand). */
  tip: { x: number; y: number } | null;
}

/** A fist holding a wand, the thumb resting along the handle, in palm units with the wrist at the origin and
 *  the palm along -y (the knuckles above the wrist). Index order is MediaPipe's. */
const FIST: [number, number][] = [
  [0, 0], // 0 wrist
  [-0.32, -0.28], // 1 thumb CMC
  [-0.55, -0.55], // 2 thumb MCP
  [-0.68, -0.86], // 3 thumb IP
  [-0.74, -1.12], // 4 thumb tip
  [-0.38, -0.96], // 5 index MCP
  [-0.52, -1.22], // 6 index PIP (curled forward)
  [-0.46, -1.02], // 7 index DIP
  [-0.38, -0.86], // 8 index tip (curled into the palm)
  [-0.06, -1.0], // 9 middle MCP
  [-0.16, -1.3], // 10
  [-0.12, -1.06], // 11
  [-0.06, -0.88], // 12
  [0.2, -0.94], // 13 ring MCP
  [0.14, -1.2], // 14
  [0.12, -0.98], // 15
  [0.14, -0.82], // 16
  [0.4, -0.84], // 17 pinky MCP
  [0.36, -1.06], // 18
  [0.34, -0.9], // 19
  [0.36, -0.76], // 20
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The 21 landmarks of a scene's hand, frame px. */
export function sceneLandmarks(h: SceneHand): number[] {
  // Canonical palm direction is -y; rotate so it points along h.angle.
  const rot = h.angle + Math.PI / 2;
  const c = Math.cos(rot), s = Math.sin(rot);
  const out: number[] = [];
  for (const [u0, v] of FIST) {
    const u = h.mirror ? -u0 : u0;
    out.push(h.x + h.palm * (u * c - v * s), h.y + h.palm * (u * s + v * c));
  }
  return out;
}

export function renderScene(o: SceneOptions): Scene {
  const { width: W, height: H } = o;
  const rand = mulberry32(o.seed ?? 7);
  const img = new Float32Array(W * H);
  const bg = o.background ?? 'light';
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v: number;
      if (bg === 'dark') v = 52 + 10 * Math.sin(x / 41) * Math.sin(y / 37);
      else v = 172 + 14 * Math.sin(x / 53 + y / 97) + 4 * Math.sin(x / 7.3) * Math.sin(y / 9.1);
      img[y * W + x] = v;
    }
  }
  if (bg === 'room') {
    // A bookshelf on the left, a door frame on the right, a cable hanging down the middle.
    const shelf = Math.round(W * 0.18);
    for (let y = 0; y < H; y++) for (let x = 0; x < shelf; x++) img[y * W + x] = 60 + ((x * 7) % 23) + (((y / 40) | 0) % 2) * 25;
    const door = Math.round(W * 0.86);
    for (let y = 0; y < H; y++) for (let x = door; x < Math.min(W, door + Math.round(W * 0.03)); x++) img[y * W + x] = 90;
    const cx = Math.round(W * 0.7);
    for (let y = 0; y < H; y++) for (let x = cx - 1; x <= cx + 1; x++) img[y * W + x] = 40;
  }

  const lm = sceneLandmarks(o.hand);
  let tip: { x: number; y: number } | null = null;
  if (o.wand) {
    const g = gripFrame(lm, 2, 1, 1);
    const P = g.palm;
    const w = o.wand;
    const ux = Math.cos(w.angle), uy = Math.sin(w.angle), nx = -uy, ny = ux;
    const off = (w.offset ?? 0) * P;
    const bx = g.ax + off * nx, by = g.ay + off * ny;
    // From inside the fist (0.6 palm behind the anchor) to the tip.
    const r0 = -0.6 * P, r1 = w.length * P;
    const thick = (w.thick ?? 0.16) * P, thin = (w.thin ?? 0.085) * P;
    const level = w.level ?? (bg === 'dark' ? 200 : 46);
    const blur = (w.blur ?? 0) * P;
    tip = { x: bx + r1 * ux, y: by + r1 * uy };
    const reach = Math.max(thick, blur) + 3;
    const x0 = Math.max(0, Math.floor(Math.min(bx + r0 * ux, tip.x) - reach)), x1 = Math.min(W - 1, Math.ceil(Math.max(bx + r0 * ux, tip.x) + reach));
    const y0 = Math.max(0, Math.floor(Math.min(by + r0 * uy, tip.y) - reach)), y1 = Math.min(H - 1, Math.ceil(Math.max(by + r0 * uy, tip.y) + reach));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        // 4 x 4 supersampling for coverage.
        let cov = 0;
        for (let sy = 0; sy < 4; sy++) {
          for (let sx = 0; sx < 4; sx++) {
            const px = x + (sx + 0.5) / 4, py = y + (sy + 0.5) / 4;
            const r = (px - bx) * ux + (py - by) * uy;
            if (r < r0 || r > r1) continue;
            const across = Math.abs((px - bx) * nx + (py - by) * ny);
            const half = (thick + (thin - thick) * ((r - r0) / (r1 - r0))) / 2;
            if (blur > 0) {
              // Smeared across: the bar's coverage spread evenly over half + blur.
              const spread = half + blur / 2;
              if (across <= spread) cov += (2 * half) / (2 * spread);
            } else if (across <= half) {
              cov += 1;
            }
          }
        }
        if (cov > 0) {
          const a = cov / 16;
          const i = y * W + x;
          img[i] = img[i] * (1 - a) + level * a;
        }
      }
    }
    if (w.glint) {
      const gr = Math.max(1.5, 0.035 * P);
      for (let y = Math.floor(tip.y - 3 * gr); y <= Math.ceil(tip.y + 3 * gr); y++) {
        for (let x = Math.floor(tip.x - 3 * gr); x <= Math.ceil(tip.x + 3 * gr); x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const d = Math.hypot(x + 0.5 - tip.x, y + 0.5 - tip.y);
          const a = Math.max(0, Math.min(1, gr + 0.5 - d));
          img[y * W + x] = img[y * W + x] * (1 - a) + w.glint * a;
        }
      }
    }
  }

  // The hand over the wand: the landmarks' hull, padded by a finger's half-width, in skin tone.
  {
    const P = gripFrame(lm, 2, 1, 1).palm;
    const pad = 0.11 * P;
    const hull = hullOf(lm);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < hull.length; i += 2) {
      minX = Math.min(minX, hull[i]);
      maxX = Math.max(maxX, hull[i]);
      minY = Math.min(minY, hull[i + 1]);
      maxY = Math.max(maxY, hull[i + 1]);
    }
    for (let y = Math.max(0, Math.floor(minY - pad)); y <= Math.min(H - 1, Math.ceil(maxY + pad)); y++) {
      for (let x = Math.max(0, Math.floor(minX - pad)); x <= Math.min(W - 1, Math.ceil(maxX + pad)); x++) {
        const d = distToPolygon(hull, x + 0.5, y + 0.5);
        if (d > pad) continue;
        const shade = 150 + 18 * Math.sin((x - minX) / (0.2 * P)) * Math.cos((y - minY) / (0.25 * P));
        img[y * W + x] = shade;
      }
    }
    // The forearm, from the wrist away from the knuckles.
    const g = gripFrame(lm, 2, 1, 1);
    const wx = lm[0], wy = lm[1];
    const fx = -g.ux, fy = -g.uy;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const r = (x + 0.5 - wx) * fx + (y + 0.5 - wy) * fy;
        if (r < 0 || r > 4 * P) continue;
        const across = Math.abs((x + 0.5 - wx) * -fy + (y + 0.5 - wy) * fx);
        if (across < 0.33 * P) img[y * W + x] = 140;
      }
    }
  }

  const noise = o.noise ?? 2.5;
  const data = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    // Box-Muller from two uniforms.
    const u = Math.max(1e-12, rand()), v = rand();
    const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * noise;
    data[i] = Math.max(0, Math.min(255, Math.round(img[i] + n)));
  }
  const normalized: number[] = [];
  for (let i = 0; i < 21; i++) normalized.push(lm[i * 2] / W, lm[i * 2 + 1] / H, 0);
  return { data, width: W, height: H, landmarks: lm, normalized, tip };
}

function hullOf(pts: number[]): number[] {
  // Gift wrapping is enough for 21 points.
  const n = pts.length / 2;
  let start = 0;
  for (let i = 1; i < n; i++) if (pts[i * 2] < pts[start * 2]) start = i;
  const out: number[] = [];
  let p = start;
  do {
    out.push(pts[p * 2], pts[p * 2 + 1]);
    let q = (p + 1) % n;
    for (let i = 0; i < n; i++) {
      const cr = (pts[q * 2] - pts[p * 2]) * (pts[i * 2 + 1] - pts[p * 2 + 1]) - (pts[q * 2 + 1] - pts[p * 2 + 1]) * (pts[i * 2] - pts[p * 2]);
      if (cr < 0) q = i;
    }
    p = q;
  } while (p !== start && out.length < 2 * n + 2);
  return out;
}

/** Distance from a point to a convex polygon (0 inside). */
function distToPolygon(poly: number[], x: number, y: number): number {
  let inside = true, best = Infinity;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const x0 = poly[i * 2], y0 = poly[i * 2 + 1];
    const x1 = poly[((i + 1) % n) * 2], y1 = poly[((i + 1) % n) * 2 + 1];
    const ex = x1 - x0, ey = y1 - y0;
    const len2 = ex * ex + ey * ey || 1;
    const t = Math.max(0, Math.min(1, ((x - x0) * ex + (y - y0) * ey) / len2));
    best = Math.min(best, Math.hypot(x - (x0 + t * ex), y - (y0 + t * ey)));
    if (ex * (y - y0) - ey * (x - x0) > 0) inside = false;
  }
  // The winding of the gift-wrapped hull decides which side is inside; accept either.
  if (inside) return 0;
  let other = true;
  for (let i = 0; i < n; i++) {
    const x0 = poly[i * 2], y0 = poly[i * 2 + 1];
    const x1 = poly[((i + 1) % n) * 2], y1 = poly[((i + 1) % n) * 2 + 1];
    if ((x1 - x0) * (y - y0) - (y1 - y0) * (x - x0) < 0) other = false;
  }
  return other ? 0 : best;
}
