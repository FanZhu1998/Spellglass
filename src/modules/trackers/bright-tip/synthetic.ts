// Synthetic camera frames for the bright-tip tests: a dark, noisy room with round dots (the tip),
// lamps and windows. Deterministic (seeded), so a failing test fails the same way every time.
// Used only by tests; nothing in the app imports it.

import type { PixelRegion } from './algorithm';

export interface Dot {
  /** Centre in continuous full-resolution pixel coordinates (pixel centres are at +0.5). */
  x: number;
  y: number;
  /** Disc radius in px (ignored when sigma is set). */
  radius?: number;
  /** Gaussian profile instead of a disc. */
  sigma?: number;
  /** Peak level added over the background, per channel (default white 230). */
  color?: [number, number, number];
}

export interface Rectangle {
  x: number;
  y: number;
  width: number;
  height: number;
  color?: [number, number, number];
}

export interface SyntheticFrame {
  width: number;
  height: number;
  /** Background level (default 18). */
  background?: number;
  /** Uniform noise amplitude: each channel gets ± this (default 4). */
  noise?: number;
  seed?: number;
  dots?: Dot[];
  rects?: Rectangle[];
}

/** mulberry32: small, fast, good enough for test noise. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Render a frame as RGBA (the format canvas getImageData returns). */
export function renderFrame(spec: SyntheticFrame): PixelRegion {
  const { width, height } = spec;
  const bg = spec.background ?? 18;
  const noise = spec.noise ?? 4;
  const rand = rng(spec.seed ?? 1);
  const data = new Uint8ClampedArray(width * height * 4);
  // Accumulate in floats so overlapping shapes add before clamping, like light on a sensor.
  const acc = new Float32Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const n = noise ? (rand() * 2 - 1) * noise : 0;
    acc[i * 3] = bg + n;
    acc[i * 3 + 1] = bg + n;
    acc[i * 3 + 2] = bg + n;
  }
  for (const r of spec.rects ?? []) {
    const c = r.color ?? [200, 200, 200];
    for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(height, Math.ceil(r.y + r.height)); y++) {
      for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(width, Math.ceil(r.x + r.width)); x++) {
        const i = (y * width + x) * 3;
        acc[i] += c[0];
        acc[i + 1] += c[1];
        acc[i + 2] += c[2];
      }
    }
  }
  for (const d of spec.dots ?? []) {
    const c = d.color ?? [230, 230, 230];
    if (d.sigma) {
      const reach = Math.ceil(d.sigma * 4);
      for (let y = Math.max(0, Math.floor(d.y - reach)); y < Math.min(height, Math.ceil(d.y + reach)); y++) {
        for (let x = Math.max(0, Math.floor(d.x - reach)); x < Math.min(width, Math.ceil(d.x + reach)); x++) {
          const dx = x + 0.5 - d.x, dy = y + 0.5 - d.y;
          const g = Math.exp(-(dx * dx + dy * dy) / (2 * d.sigma * d.sigma));
          const i = (y * width + x) * 3;
          acc[i] += c[0] * g;
          acc[i + 1] += c[1] * g;
          acc[i + 2] += c[2] * g;
        }
      }
    } else {
      const r = d.radius ?? 3;
      // 4×4 supersampling gives an anti-aliased edge, as a lens would.
      for (let y = Math.max(0, Math.floor(d.y - r - 1)); y < Math.min(height, Math.ceil(d.y + r + 1)); y++) {
        for (let x = Math.max(0, Math.floor(d.x - r - 1)); x < Math.min(width, Math.ceil(d.x + r + 1)); x++) {
          let cover = 0;
          for (let sy = 0; sy < 4; sy++) {
            for (let sx = 0; sx < 4; sx++) {
              const px = x + (sx + 0.5) / 4, py = y + (sy + 0.5) / 4;
              if ((px - d.x) ** 2 + (py - d.y) ** 2 <= r * r) cover++;
            }
          }
          if (!cover) continue;
          const g = cover / 16;
          const i = (y * width + x) * 3;
          acc[i] += c[0] * g;
          acc[i + 1] += c[1] * g;
          acc[i + 2] += c[2] * g;
        }
      }
    }
  }
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = acc[i * 3];
    data[i * 4 + 1] = acc[i * 3 + 1];
    data[i * 4 + 2] = acc[i * 3 + 2];
    data[i * 4 + 3] = 255;
  }
  return { x: 0, y: 0, width, height, format: 'rgba', data, stride: width * 4 };
}

/** Cut a rectangle out of a full frame, as the worker reads a window. */
export function crop(frame: PixelRegion, rect: { x: number; y: number; width: number; height: number }): PixelRegion {
  if (rect.x === frame.x && rect.y === frame.y && rect.width === frame.width && rect.height === frame.height) return frame;
  const bpp = frame.format === 'gray' ? 1 : 4;
  const out = new Uint8ClampedArray(rect.width * rect.height * bpp);
  for (let y = 0; y < rect.height; y++) {
    const from = (rect.y - frame.y + y) * frame.stride + (rect.x - frame.x) * bpp;
    out.set(frame.data.subarray(from, from + rect.width * bpp), y * rect.width * bpp);
  }
  return { ...rect, format: frame.format, data: out, stride: rect.width * bpp, lut: frame.lut };
}

/** A frame's luma as a 1-byte 'gray' region (what the Y plane of an NV12 frame gives the worker). */
export function toGray(frame: PixelRegion): PixelRegion {
  const out = new Uint8Array(frame.width * frame.height);
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const p = y * frame.stride + x * 4;
      out[y * frame.width + x] = (77 * frame.data[p] + 150 * frame.data[p + 1] + 29 * frame.data[p + 2]) >> 8;
    }
  }
  return { x: frame.x, y: frame.y, width: frame.width, height: frame.height, format: 'gray', data: out, stride: frame.width };
}
