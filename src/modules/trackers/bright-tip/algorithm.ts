// Bright-tip tracking as pure functions over pixel buffers (blueprint Section 7.2, routes A and C).
//
// Nothing here touches a browser API, so the worker (worker.ts), the tip-finder page
// (tools/tip-finder) and the Node tests all run exactly this code. The worker only reads pixels
// and hands them over; every decision is made here.
//
// Per frame, following Section 7.2:
//  1. Take brightness, or the colour channel of the light, and shrink to the search width by keeping
//     the brightest pixel of each block (max-pool), so a glint a few pixels wide survives.
//  2. Threshold = max(floor, mean + k * std).
//  3. Remove known static bright areas with a slow-moving mask (lamps, windows, glasses).
//  4. Group the remaining pixels into blobs; keep plausible areas and roughly round shapes. While the
//     tip is held and moving fast, a streak along its path counts as round enough (isStreak).
//  5. Score by brightness, roundness and distance from the predicted position; after `lostAfter`
//     misses declare the tip lost and search the whole frame again.
//  6. Refine the winner with a brightness-weighted centroid at full resolution.
//  7. Flip x into caster space (once, here: Section 6) and report a confidence.
//
// To meet the 4 ms budget (Section 13) the tracker does not read the whole frame while it holds the
// tip: plan() asks for a window around the prediction, and for a full-frame "survey" every
// TUNING.surveyMs to keep the statistics, the static mask and the background level current.
// While searching, every frame is a survey.

export type Channel = 'luma' | 'r' | 'g' | 'b';

/** The settings that shape tracking (contracts/settings.ts 'brightTip.*' and 'capture.flipX'). */
export interface TipConfig {
  /** k in the brightness threshold mean + k * std. */
  k: number;
  /** Brightness floor, 0..255: nothing darker is ever a tip. */
  floor: number;
  channel: Channel;
  /** Plausible tip area at full resolution, px². */
  minArea: number;
  maxArea: number;
  /** Search radius around the predicted position, as a fraction of frame width per frame at 30 fps. */
  searchRadius: number;
  /** Frames without the tip before it is declared lost. */
  lostAfter: number;
  /** Width of the max-pooled search image. */
  searchWidth: number;
  staticMask: boolean;
  /** Flip x into caster space (true for ordinary webcams, which do not mirror). */
  flipX: boolean;
}

/** Starting values from the Section 7.2 table and contracts/settings.ts. */
export const DEFAULT_TIP_CONFIG: TipConfig = {
  k: 4,
  floor: 200,
  channel: 'luma',
  minArea: 4,
  maxArea: 400,
  searchRadius: 0.12,
  lostAfter: 6,
  searchWidth: 640,
  staticMask: true,
  flipX: true,
};

/** Defaults for route C ('brightTip.profile' = 'infrared'). An infrared camera with LEDs around the lens
 *  delivers a grey image, so colour channels mean nothing; the retro-reflected tip is far brighter than
 *  anything else and blooms, so the floor, k and the largest area go up. These are starting guesses to
 *  be measured with the tip-finder page, as Appendix A asks for route A. */
export const INFRARED_DEFAULTS: Readonly<Partial<TipConfig>> = { channel: 'luma', floor: 230, k: 5, maxArea: 900 };

/** Constants that are not player settings. Each is explained where it is used. */
export const TUNING = {
  /** Full-frame survey interval while the tip is held. */
  surveyMs: 500,
  /** Interval between debug views (the Wand tuning screen asks for about 10 fps). */
  debugMs: 100,
  /** A blob must be at least this round (minor ÷ major axis) to be a tip. Lines (window edges, the rim of
   *  a pair of glasses, a light strip) fall below it; a short motion streak does not. */
  minRoundness: 0.25,
  /** While the tip is held and moving, a longer streak still counts (see isStreak) down to this
   *  roundness. A fast stroke smears the glint along its path (Section 15.1, "Motion blur at 30 fps"):
   *  at 1080p a circle traced in 1.2 s moves about 55 px a frame, so even a 1/120 s exposure draws a
   *  6 px dot as a 20 px streak, and a 1/30 s one as a 60 px streak. */
  minStreakRoundness: 0.08,
  /** How far a curving stroke may bend a streak away from the line back to the last sample, as a share
   *  of the distance to it (a circle of a third of the frame height, traced in 1.2 s at 1080p, bends it
   *  by about a tenth). */
  streakBend: 0.15,
  /** The static mask learns a bright area that stays put for about this long (EMA time constant). */
  maskTauMs: 2500,
  /** After a reset the mask learns fast for a moment, so lamps are masked before they can be locked on. */
  warmupMs: 1000,
  warmupTauMs: 250,
  /** Mask persistence above which a cell counts as static. */
  maskOn: 0.6,
  /** A tracked tip that has stayed within stillRadius (fraction of width) for stillMs may be learned
   *  into the mask: it is probably a lamp, and a held wand is never still that long while casting. */
  stillMs: 3000,
  stillRadius: 0.015,
  /** Keep the threshold below this, so in an over-bright room saturated pixels still get a chance. */
  maxThreshold: 250,
  /** Smallest search radius, fraction of width, whatever the frame rate. */
  minRadius: 0.02,
  /** Frame interval the search radius is stated for (30 fps). */
  framePeriodMs: 1000 / 30,
  /** Cap on blobs refined at full resolution per frame (brightest first). */
  maxRefined: 12,
  /** Full-resolution margin around a blob for centroid refinement, px. */
  patchMargin: 3,
  /** Misses after which the next frame is a full survey, before the tip is declared lost. */
  surveyAfterMisses: 2,
  /** A window larger than this share of the frame is read as a full survey instead. */
  maxWindowShare: 0.6,
} as const;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rectangle of the frame at full resolution, as the worker read it. */
export interface PixelRegion extends Rect {
  /** 'rgba' and 'bgra': 4 bytes per pixel (canvas getImageData, VideoFrame RGBA/BGRA copies).
   *  'gray': 1 byte per pixel that already is the tracking channel (the Y plane of an NV12 or I420
   *  frame, valid for the luma channel only). */
  format: 'rgba' | 'bgra' | 'gray';
  data: Uint8Array | Uint8ClampedArray;
  /** Bytes per row. */
  stride: number;
  /** 'gray' only: maps raw values to full-range brightness (limited-range video luma, 16..235). */
  lut?: Uint8Array;
}

/** Max-pooled channel values on the search grid. Cell (i, j) covers full-resolution pixels
 *  [(x0+i)·factor, (x0+i+1)·factor) × [(y0+j)·factor, (y0+j+1)·factor). */
export interface SearchImage {
  data: Uint8Array;
  width: number;
  height: number;
  x0: number;
  y0: number;
  factor: number;
}

export interface Stats {
  mean: number;
  std: number;
  max: number;
}

/** A connected group of bright cells on the search grid (coordinates local to the search image). */
export interface Blob {
  cells: number;
  sum: number;
  peak: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** A blob measured at full resolution. */
export interface Refined {
  /** Brightness-weighted centroid in continuous full-resolution coordinates (pixel centres at +0.5). */
  cx: number;
  cy: number;
  /** Pixels at or above the threshold, px². */
  area: number;
  peak: number;
  /** Semi-axes of the thresholded shape, px (equal to the radius for a disc). */
  major: number;
  minor: number;
  /** minor ÷ major, 1 for a disc. */
  roundness: number;
  /** Direction of the major axis, radians (x right, y down); meaningless for a round blob. */
  angle: number;
}

export interface DebugBlob {
  /** Caster space. */
  x: number;
  y: number;
  /** Radius, major and minor semi-axes in caster-x units (fractions of frame width). */
  r: number;
  major: number;
  minor: number;
  score: number;
  chosen: boolean;
}

export interface TipObservation {
  /** Caster space (x flipped when configured). */
  x: number;
  y: number;
  conf: number;
  /** Blob radius ÷ frame width (TipSample.size). */
  size: number;
  /** Full-resolution measurements, in camera pixels (not flipped), for readouts and tests. */
  px: number;
  py: number;
  areaPx: number;
  radiusPx: number;
}

/** What the threshold view needs; buffers belong to the tracker and change on the next process(). */
export interface ThresholdView {
  image: SearchImage;
  threshold: number;
  masked: Uint8Array | null;
  maskWidth: number;
}

export interface FramePlan {
  /** Full-resolution rectangle to read, aligned for 4:2:0 frames and the search grid. */
  rect: Rect;
  survey: boolean;
  /** This frame carries a threshold view (a survey, at most every TUNING.debugMs). */
  debug: boolean;
  width: number;
  height: number;
}

export interface FrameResult {
  t: number;
  state: 'searching' | 'tracking';
  sample: TipObservation | null;
  /** The tip was found on this frame (send tip.found before the sample). */
  found: boolean;
  /** The tip was declared lost on this frame. */
  lost: boolean;
  /** Capture time of the last sample, when lost (or while tracking). */
  lastSeen: number | null;
  survey: boolean;
  threshold: number;
  mean: number;
  std: number;
  /** Peak level of the tip, 0..255. */
  tipLevel: number | null;
  /** Brightest unmasked level away from the tip (Appendix A step 5). */
  backgroundMax: number;
  /** tipLevel ÷ backgroundMax: aim for 3 or more. */
  contrast: number | null;
  /** Bright, unmasked blobs before the shape checks: many of them mean a cluttered room. */
  candidates: number;
  /** Share of the frame the static mask covers. */
  maskedFraction: number;
  blobs: DebugBlob[];
  view: ThresholdView | null;
}

// ---------------------------------------------------------------------------------------- pixels

const CHANNEL_CODE: Record<Channel, number> = { luma: 0, r: 1, g: 2, b: 3 };

/**
 * The tracking value of one pixel. Luma uses BT.601 weights in fixed point. A colour channel uses
 * that channel minus half of the weaker of the other two: Section 7.2 picks the light's colour so "a
 * colored light tints the reflection, which separates the tip from white lamps", but a bare channel
 * cannot do that (a white lamp is bright in every channel). With the subtraction a white lamp counts
 * for half while a tinted tip keeps nearly its full level, and a saturated tip still scores 128.
 */
export function channelValue(r: number, g: number, b: number, channel: Channel): number {
  switch (channel) {
    case 'luma':
      return (77 * r + 150 * g + 29 * b) >> 8;
    case 'r':
      return Math.max(0, r - (Math.min(g, b) >> 1));
    case 'g':
      return Math.max(0, g - (Math.min(r, b) >> 1));
    case 'b':
      return Math.max(0, b - (Math.min(r, g) >> 1));
  }
}

/** Byte offsets of R, G and B within a 4-byte pixel. */
function rgbOffsets(format: 'rgba' | 'bgra'): [number, number, number] {
  return format === 'rgba' ? [0, 1, 2] : [2, 1, 0];
}

/** Limited-range (16..235) to full-range (0..255) luma, for the Y plane of most webcam frames. */
export function limitedRangeLut(): Uint8Array {
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.max(0, Math.min(255, Math.round(((i - 16) * 255) / 219)));
  return lut;
}

/** Search grid factor for a frame width: 1920 → 3 (640 wide), 1280 → 2, 640 → 1. */
export function poolFactor(frameWidth: number, searchWidth: number): number {
  return Math.max(1, Math.round(frameWidth / Math.max(16, searchWidth)));
}

/**
 * Max-pool a region onto the search grid (Section 7.2 step 1). Keeping the brightest pixel of each
 * block is what lets a glint 3 to 7 pixels wide (Section 4, "Size of the dot") survive a 3× shrink;
 * an averaging resize would dim it into the background.
 *
 * This is the hot loop of the tracker (2 million pixels for a 1080p survey), so aligned regions (all
 * plans are aligned) take kernels that read one whole block per output cell and write it once, and
 * none of them branch on pixel values: in a noisy room "is this pixel brighter" is a coin toss, and
 * mispredicted branches cost more than the arithmetic (measured on the reference laptop: 3.6 ms for a
 * 1080p luma plane with branches, 1.6 ms branchless, 1.1 ms with four pixels per 32-bit word).
 * The output is exactly the same whichever kernel runs; the tests check that against a plain loop.
 */
export function maxPool(region: PixelRegion, factor: number, channel: Channel, out?: Uint8Array): SearchImage {
  const f = Math.max(1, Math.floor(factor));
  const x0 = Math.floor(region.x / f), y0 = Math.floor(region.y / f);
  const sw = Math.ceil((region.x + region.width) / f) - x0;
  const sh = Math.ceil((region.y + region.height) / f) - y0;
  const n = sw * sh;
  const data = out && out.length >= n ? out.subarray(0, n) : new Uint8Array(n);
  data.fill(0);
  const src = asBytes(region.data);
  const aligned = region.x % f === 0 && region.y % f === 0;
  if (region.format === 'gray') {
    // The range mapping is monotonic, so mapping each block's maximum equals the maximum of the mapped
    // pixels; the aligned kernels map as they write instead of making a second pass.
    if (aligned) poolGrayAligned(src, region.width, region.height, region.stride, f, data, sw, region.lut ?? IDENTITY_LUT);
    else {
      poolGeneric(region, src, f, channel, data, sw, region.x - x0 * f, region.y - y0 * f);
      const lut = region.lut;
      if (lut) for (let i = 0; i < n; i++) data[i] = lut[data[i]];
    }
  } else if (aligned) {
    poolRgbaAligned(region, src, f, channel, data, sw);
  } else {
    poolGeneric(region, src, f, channel, data, sw, region.x - x0 * f, region.y - y0 * f);
  }
  return { data, width: sw, height: sh, x0, y0, factor: f };
}

/** A Uint8Array view of the pixel bytes, so the kernels see one array type (V8 keeps them monomorphic). */
function asBytes(d: Uint8Array | Uint8ClampedArray): Uint8Array {
  return d instanceof Uint8Array ? d : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
}

const IDENTITY_LUT = (() => {
  const l = new Uint8Array(256);
  for (let i = 0; i < 256; i++) l[i] = i;
  return l;
})();

/** The 32-bit kernels read pixel i of a word from byte i, which holds on little-endian machines (every
 *  platform a browser runs on). Elsewhere they step aside for the byte kernels. Plain JS, no browser API. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x04030201]).buffer)[0] === 0x01;

/** max(a, b) for small integers without a branch: the sign of a - b selects. */
function max2(a: number, b: number): number {
  const d = a - b;
  return a - (d & (d >> 31));
}

const HI = 0x80808080 | 0;
const LO = 0x7f7f7f7f;

/**
 * The per-byte unsigned maximum of two 32-bit words, each holding four pixels (SWAR: "SIMD within a
 * register"). Exact for every byte value; the tests check all 65,536 pairs.
 */
export function byteMax4(a: number, b: number): number {
  // High bit of each byte of t: the low 7 bits of b are at least those of a. Every byte of (b | HI) is
  // at least 0x80 and every byte of (a & LO) at most 0x7F, so no borrow crosses into the next byte.
  const t = ((b | HI) - (a & LO)) | 0;
  // b >= a per byte: b's high bit decides where the high bits differ, t's where they agree.
  const ge = ((b & ~a) | (~(a ^ b) & t)) & HI;
  // 0x80 per byte to 0xFF per byte: pick b's bytes there, a's elsewhere.
  const mask = ((ge >>> 7) * 255) | 0;
  return (a ^ ((a ^ b) & mask)) | 0;
}

/** Whether the 32-bit kernels can read this plane: aligned start and rows. */
function wordsFit(src: Uint8Array, stride: number): boolean {
  return LITTLE_ENDIAN && (src.byteOffset & 3) === 0 && (stride & 3) === 0;
}

function poolGrayAligned(src: Uint8Array, w: number, h: number, stride: number, f: number, out: Uint8Array, sw: number, lut: Uint8Array): void {
  const cols = (w / f) | 0, rows = (h / f) | 0;
  if (f === 3) poolGray3(src, stride, cols, rows, out, sw, lut);
  else if (f === 2) poolGray2(src, stride, cols, rows, out, sw, lut);
  else if (f === 1) {
    for (let y = 0; y < rows; y++) {
      const r = y * stride, o = y * sw;
      for (let x = 0; x < cols; x++) out[o + x] = lut[src[r + x]];
    }
  } else {
    for (let cy = 0; cy < rows; cy++) {
      const o = cy * sw;
      for (let cx = 0; cx < cols; cx++) {
        let m = 0;
        for (let ky = 0; ky < f; ky++) {
          const r = (cy * f + ky) * stride + cx * f;
          for (let kx = 0; kx < f; kx++) m = max2(m, src[r + kx]);
        }
        out[o + cx] = lut[m];
      }
    }
  }
  // Partial cells along the right and bottom edges, when the size is not a multiple of f.
  for (let y = 0; y < h; y++) {
    const fromX = y < rows * f ? cols * f : 0;
    const cellRow = ((y / f) | 0) * sw;
    for (let x = fromX; x < w; x++) {
      const v = lut[src[y * stride + x]], ci = cellRow + ((x / f) | 0);
      if (v > out[ci]) out[ci] = v;
    }
  }
}

/** 3×3 blocks (1080p): twelve pixels (three words per row) make four cells. */
function poolGray3(src: Uint8Array, stride: number, cols: number, rows: number, out: Uint8Array, sw: number, lut: Uint8Array): void {
  const u32 = wordsFit(src, stride) ? new Uint32Array(src.buffer, src.byteOffset, src.byteLength >> 2) : null;
  const groups = u32 ? cols >> 2 : 0;
  for (let cy = 0; cy < rows; cy++) {
    const r0 = cy * 3 * stride, r1 = r0 + stride, r2 = r1 + stride;
    const o = cy * sw;
    let cx = 0;
    if (u32) {
      const q0 = r0 >> 2, q1 = r1 >> 2, q2 = r2 >> 2;
      for (let g = 0, k = 0; g < groups; g++, k += 3, cx += 4) {
        // The brightest of the three rows, per pixel, for pixels 0-3, 4-7 and 8-11 of the group.
        const a = byteMax4(byteMax4(u32[q0 + k], u32[q1 + k]), u32[q2 + k]);
        const b = byteMax4(byteMax4(u32[q0 + k + 1], u32[q1 + k + 1]), u32[q2 + k + 1]);
        const c = byteMax4(byteMax4(u32[q0 + k + 2], u32[q1 + k + 2]), u32[q2 + k + 2]);
        out[o + cx] = lut[max2(max2(a & 255, (a >>> 8) & 255), (a >>> 16) & 255)];
        out[o + cx + 1] = lut[max2(max2(a >>> 24, b & 255), (b >>> 8) & 255)];
        out[o + cx + 2] = lut[max2(max2((b >>> 16) & 255, b >>> 24), c & 255)];
        out[o + cx + 3] = lut[max2(max2((c >>> 8) & 255, (c >>> 16) & 255), c >>> 24)];
      }
    }
    for (let x = cx * 3; cx < cols; cx++, x += 3) {
      let m = max2(src[r0 + x], src[r0 + x + 1]);
      m = max2(m, src[r0 + x + 2]);
      m = max2(m, src[r1 + x]);
      m = max2(m, src[r1 + x + 1]);
      m = max2(m, src[r1 + x + 2]);
      m = max2(m, src[r2 + x]);
      m = max2(m, src[r2 + x + 1]);
      m = max2(m, src[r2 + x + 2]);
      out[o + cx] = lut[m];
    }
  }
}

/** 2×2 blocks (720p): one word per row makes two cells. */
function poolGray2(src: Uint8Array, stride: number, cols: number, rows: number, out: Uint8Array, sw: number, lut: Uint8Array): void {
  const u32 = wordsFit(src, stride) ? new Uint32Array(src.buffer, src.byteOffset, src.byteLength >> 2) : null;
  const groups = u32 ? cols >> 1 : 0;
  for (let cy = 0; cy < rows; cy++) {
    const r0 = cy * 2 * stride, r1 = r0 + stride;
    const o = cy * sw;
    let cx = 0;
    if (u32) {
      const q0 = r0 >> 2, q1 = r1 >> 2;
      for (let g = 0; g < groups; g++, cx += 2) {
        const a = byteMax4(u32[q0 + g], u32[q1 + g]);
        out[o + cx] = lut[max2(a & 255, (a >>> 8) & 255)];
        out[o + cx + 1] = lut[max2((a >>> 16) & 255, a >>> 24)];
      }
    }
    for (let x = cx * 2; cx < cols; cx++, x += 2) {
      const m = max2(max2(src[r0 + x], src[r0 + x + 1]), max2(src[r1 + x], src[r1 + x + 1]));
      out[o + cx] = lut[m];
    }
  }
}

/** 4-byte pixels: one whole block per output cell, with the channel computed per pixel. */
function poolRgbaAligned(region: PixelRegion, src: Uint8Array, f: number, channel: Channel, out: Uint8Array, sw: number): void {
  const w = region.width, h = region.height, stride = region.stride;
  const cols = (w / f) | 0, rows = (h / f) | 0;
  const [ro, go, bo] = rgbOffsets(region.format as 'rgba' | 'bgra');
  const code = CHANNEL_CODE[channel];
  const [co, o1, o2] = code === 1 ? [ro, go, bo] : code === 2 ? [go, ro, bo] : [bo, ro, go];
  const step = f * 4;
  if (code === 0 && f === 3) {
    // The default case (1080p, luma), unrolled.
    for (let cy = 0; cy < rows; cy++) {
      const o = cy * sw;
      const base = cy * 3 * stride;
      for (let cx = 0; cx < cols; cx++) {
        let m = 0;
        let p = base + cx * 12;
        for (let ky = 0; ky < 3; ky++, p += stride) {
          m = max2(m, (77 * src[p + ro] + 150 * src[p + go] + 29 * src[p + bo]) >> 8);
          m = max2(m, (77 * src[p + 4 + ro] + 150 * src[p + 4 + go] + 29 * src[p + 4 + bo]) >> 8);
          m = max2(m, (77 * src[p + 8 + ro] + 150 * src[p + 8 + go] + 29 * src[p + 8 + bo]) >> 8);
        }
        out[o + cx] = m;
      }
    }
  } else {
    for (let cy = 0; cy < rows; cy++) {
      const o = cy * sw;
      const base = cy * f * stride;
      for (let cx = 0; cx < cols; cx++) {
        let m = 0;
        let p = base + cx * step;
        for (let ky = 0; ky < f; ky++, p += stride) {
          for (let q = p, e = p + step; q < e; q += 4) {
            if (code === 0) m = max2(m, (77 * src[q + ro] + 150 * src[q + go] + 29 * src[q + bo]) >> 8);
            else {
              const a = src[q + o1], b = src[q + o2];
              // channelValue: the channel minus half the weaker of the other two, never below 0 (m starts at 0).
              m = max2(m, src[q + co] - ((a < b ? a : b) >> 1));
            }
          }
        }
        out[o + cx] = m;
      }
    }
  }
  // Partial cells along the right and bottom edges.
  for (let y = 0; y < h; y++) {
    const fromX = y < rows * f ? cols * f : 0;
    const cellRow = ((y / f) | 0) * sw;
    for (let x = fromX; x < w; x++) {
      const p = y * stride + x * 4;
      const v = channelValue(src[p + ro], src[p + go], src[p + bo], channel), ci = cellRow + ((x / f) | 0);
      if (v > out[ci]) out[ci] = v;
    }
  }
}

/** Any region, aligned or not: a column-to-cell lookup and a read-modify-write per pixel (slower). */
function poolGeneric(region: PixelRegion, src: Uint8Array, f: number, channel: Channel, out: Uint8Array, sw: number, ox: number, oy: number): void {
  const w = region.width, h = region.height, stride = region.stride;
  const cellX = new Int32Array(w);
  for (let x = 0; x < w; x++) cellX[x] = ((x + ox) / f) | 0;
  const gray = region.format === 'gray';
  const [ro, go, bo] = gray ? [0, 0, 0] : rgbOffsets(region.format as 'rgba' | 'bgra');
  for (let y = 0; y < h; y++) {
    const row = y * stride;
    const cellRow = (((y + oy) / f) | 0) * sw;
    for (let x = 0; x < w; x++) {
      const v = gray ? src[row + x] : channelValue(src[row + x * 4 + ro], src[row + x * 4 + go], src[row + x * 4 + bo], channel);
      const ci = cellRow + cellX[x];
      if (v > out[ci]) out[ci] = v;
    }
  }
}

/** Mean, standard deviation and maximum of a search image, from a histogram (one pass, no floats per cell). */
export function imageStats(img: SearchImage, hist: Uint32Array = new Uint32Array(256)): Stats {
  hist.fill(0);
  const d = img.data, n = img.width * img.height;
  for (let i = 0; i < n; i++) hist[d[i]]++;
  let sum = 0, sum2 = 0, max = 0;
  for (let v = 0; v < 256; v++) {
    const c = hist[v];
    if (!c) continue;
    sum += c * v;
    sum2 += c * v * v;
    max = v;
  }
  const mean = n ? sum / n : 0;
  const variance = n ? Math.max(0, sum2 / n - mean * mean) : 0;
  return { mean, std: Math.sqrt(variance), max };
}

/** Section 7.2 step 2: brighter than both the floor and mean + k·std (capped so saturated pixels count). */
export function thresholdFor(stats: Stats, cfg: Pick<TipConfig, 'k' | 'floor'>): number {
  const t = Math.max(cfg.floor, stats.mean + cfg.k * stats.std);
  return Math.max(1, Math.min(TUNING.maxThreshold, Math.ceil(t)));
}

export interface BlobScratch {
  labels: Int32Array;
  stack: Int32Array;
}

export function blobScratch(): BlobScratch {
  return { labels: new Int32Array(0), stack: new Int32Array(0) };
}

/**
 * Section 7.2 steps 3 and 4: cells at or above the threshold that the static mask does not cover,
 * grouped 8-connected. `mask` is on the full-frame search grid (maskWidth cells per row).
 * When `bright` is given, every cell at or above the threshold that was visited, masked or not, is
 * appended to it (indices into `img`), so the static mask can be updated from those cells alone.
 * `capped` says the search stopped at maxBlobs, so the list is incomplete.
 */
export function findBlobs(
  img: SearchImage,
  thr: number,
  mask: Uint8Array | null,
  maskWidth: number,
  scratch: BlobScratch,
  maxBlobs = 256,
  bright?: number[],
): { blobs: Blob[]; maskedBright: number; capped: boolean } {
  const { data, width: w, height: h, x0, y0 } = img;
  const n = w * h;
  if (scratch.labels.length < n) scratch.labels = new Int32Array(n);
  if (scratch.stack.length < n) scratch.stack = new Int32Array(n);
  const labels = scratch.labels;
  labels.fill(0, 0, n);
  const stack = scratch.stack;
  const blobs: Blob[] = [];
  let maskedBright = 0;
  let capped = false;
  const isMasked = (cx: number, cy: number) => mask !== null && mask[(y0 + cy) * maskWidth + (x0 + cx)] === 1;

  for (let i = 0; i < n; i++) {
    // Pixel first: nearly every cell is dark, so this costs one load per cell.
    if (data[i] < thr || labels[i] !== 0) continue;
    const ix = i % w, iy = (i / w) | 0;
    if (isMasked(ix, iy)) {
      labels[i] = -1;
      maskedBright++;
      bright?.push(i);
      continue;
    }
    if (blobs.length >= maxBlobs) {
      capped = true;
      break;
    }
    const id = blobs.length + 1;
    const blob: Blob = { cells: 0, sum: 0, peak: 0, minX: ix, minY: iy, maxX: ix, maxY: iy };
    let top = 0;
    stack[top++] = i;
    labels[i] = id;
    while (top > 0) {
      const j = stack[--top];
      const jx = j % w, jy = (j / w) | 0;
      const v = data[j];
      bright?.push(j);
      blob.cells++;
      blob.sum += v;
      if (v > blob.peak) blob.peak = v;
      if (jx < blob.minX) blob.minX = jx;
      if (jx > blob.maxX) blob.maxX = jx;
      if (jy < blob.minY) blob.minY = jy;
      if (jy > blob.maxY) blob.maxY = jy;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = jy + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = jx + dx;
          if (nx < 0 || nx >= w) continue;
          const k = ny * w + nx;
          if (data[k] < thr || labels[k] !== 0) continue;
          if (isMasked(nx, ny)) {
            labels[k] = -1;
            maskedBright++;
            bright?.push(k);
            continue;
          }
          labels[k] = id;
          stack[top++] = k;
        }
      }
    }
    blobs.push(blob);
  }
  return { blobs, maskedBright, capped };
}

/** Read the tracking channel of a full-resolution rectangle (inside the region) into a dense buffer. */
export function readPatch(region: PixelRegion, channel: Channel, rect: Rect, out?: Uint8Array): Uint8Array {
  const n = rect.width * rect.height;
  const buf = out && out.length >= n ? out.subarray(0, n) : new Uint8Array(n);
  const lx = rect.x - region.x, ly = rect.y - region.y;
  const { data, stride } = region;
  if (region.format === 'gray') {
    const lut = region.lut;
    for (let y = 0; y < rect.height; y++) {
      const row = (ly + y) * stride + lx;
      for (let x = 0; x < rect.width; x++) {
        const v = data[row + x];
        buf[y * rect.width + x] = lut ? lut[v] : v;
      }
    }
    return buf;
  }
  const [ro, go, bo] = rgbOffsets(region.format);
  for (let y = 0; y < rect.height; y++) {
    let p = (ly + y) * stride + lx * 4;
    for (let x = 0; x < rect.width; x++, p += 4) buf[y * rect.width + x] = channelValue(data[p + ro], data[p + go], data[p + bo], channel);
  }
  return buf;
}

/**
 * Section 7.2 step 6: measure a blob at full resolution. Area, axes and roundness come from the pixels
 * at or above the threshold. The centroid weights every pixel by its height above the local background
 * (estimated from the patch border), not above the threshold: a glint is only a few pixels wide, and
 * using its whole profile, not just the clipped top, is what makes the centroid sub-pixel accurate.
 */
export function refineBlob(region: PixelRegion, channel: Channel, patch: Rect, thr: number, scratch?: { buf: Uint8Array }): Refined | null {
  if (patch.width <= 0 || patch.height <= 0) return null;
  const pw = patch.width, ph = patch.height;
  const buf = readPatch(region, channel, patch, scratch?.buf);
  if (scratch && scratch.buf.length < buf.length) scratch.buf = buf;

  // Local background from the patch border.
  let bs = 0, bs2 = 0, bn = 0;
  const addBorder = (v: number) => {
    bs += v;
    bs2 += v * v;
    bn++;
  };
  for (let x = 0; x < pw; x++) {
    addBorder(buf[x]);
    if (ph > 1) addBorder(buf[(ph - 1) * pw + x]);
  }
  for (let y = 1; y < ph - 1; y++) {
    addBorder(buf[y * pw]);
    if (pw > 1) addBorder(buf[y * pw + pw - 1]);
  }
  const bMean = bn ? bs / bn : 0;
  const bStd = bn ? Math.sqrt(Math.max(0, bs2 / bn - bMean * bMean)) : 0;
  // Never above the threshold, so the thresholded core always counts in full.
  const bg = Math.min(thr - 1, bMean + 3 * bStd + 1);

  let area = 0, peak = 0;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  let wSum = 0, wx = 0, wy = 0;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const v = buf[y * pw + x];
      if (v > peak) peak = v;
      if (v > bg) {
        const wgt = v - bg;
        wSum += wgt;
        wx += wgt * (x + 0.5);
        wy += wgt * (y + 0.5);
      }
      if (v >= thr) {
        area++;
        sx += x;
        sy += y;
        sxx += x * x;
        syy += y * y;
        sxy += x * y;
      }
    }
  }
  if (area === 0 || wSum <= 0) return null;
  // Covariance of the thresholded shape, plus 1/12 for the extent of a pixel itself, so a single
  // pixel or a 1×3 streak still has a sensible shape.
  const mx = sx / area, my = sy / area;
  const cxx = sxx / area - mx * mx + 1 / 12;
  const cyy = syy / area - my * my + 1 / 12;
  const cxy = sxy / area - mx * my;
  const tr = cxx + cyy;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - (cxx * cyy - cxy * cxy)));
  const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
  // For a uniform disc of radius R the variance along any axis is R²/4, so 2·sqrt(λ) is the semi-axis.
  const major = 2 * Math.sqrt(l1), minor = 2 * Math.sqrt(l2);
  return {
    cx: patch.x + wx / wSum,
    cy: patch.y + wy / wSum,
    area,
    peak,
    major,
    minor,
    roundness: major > 0 ? minor / major : 1,
    angle: 0.5 * Math.atan2(2 * cxy, cxx - cyy),
  };
}

/** The threshold view for the Wand tuning screen and the tip-finder page, in caster orientation. */
export function renderThresholdView(view: ThresholdView, flipX: boolean, out?: Uint8ClampedArray): Uint8ClampedArray {
  const { image, threshold, masked, maskWidth } = view;
  const w = image.width, h = image.height;
  const rgba = out && out.length >= w * h * 4 ? out.subarray(0, w * h * 4) : new Uint8ClampedArray(w * h * 4);
  // A square-root curve keeps a nearly black room readable without hiding the tip.
  const gray = GRAY_CURVE;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = image.data[y * w + x];
      const m = masked !== null && masked[(image.y0 + y) * maskWidth + image.x0 + x] === 1;
      const ox = flipX ? w - 1 - x : x;
      const p = (y * w + ox) * 4;
      if (v >= threshold) {
        // Candle for candidates; a muted violet for bright areas the static mask removes.
        if (m) {
          rgba[p] = 128; rgba[p + 1] = 112; rgba[p + 2] = 196;
        } else {
          rgba[p] = 242; rgba[p + 1] = 184; rgba[p + 2] = 75;
        }
      } else {
        const g = gray[v];
        rgba[p] = m ? g >> 1 : g;
        rgba[p + 1] = m ? g >> 1 : g;
        rgba[p + 2] = m ? (g >> 1) + 48 : g;
      }
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}

const GRAY_CURVE = (() => {
  const c = new Uint8Array(256);
  for (let v = 0; v < 256; v++) c[v] = Math.round(Math.sqrt(v / 255) * 170);
  return c;
})();

// ---------------------------------------------------------------------------------------- tracker

interface HistoryPoint {
  t: number;
  x: number;
  y: number;
}

interface Candidate {
  blob: Blob;
  ref: Refined;
  score: number;
  /** Accepted as a motion streak rather than a round dot. */
  streak: boolean;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** The dot's radius in px: the area of a round blob, the narrow axis of a streak (which its length
 *  would otherwise inflate). */
function dotRadius(c: Candidate): number {
  return c.streak ? c.ref.minor : Math.sqrt(c.ref.area / Math.PI);
}

/**
 * A motion streak, not a line: the tip has moved more than its own width since the last sample, the
 * streak's long axis points back at that sample (the path it was drawn along; a curving stroke bends
 * it a little, hence the allowance that grows with distance), and it is no longer than that travel can
 * explain. A smear lasts at most one frame interval, and a segment of length L measures about 0.58·L
 * on the major semi-axis by refineBlob's convention, plus the dot itself; the travel since the last
 * sample is at least half a full-exposure streak's length, so 1.2 × distance covers it. Needing no
 * velocity, this also holds on the first frame of a stroke that leaves the hold at full speed. Lines
 * across the path fail it. A bright strip lying along the path just ahead could pass for one frame
 * while the tip itself is out of sight (a round tip in reach always scores higher, and the static
 * mask learns strips that stay put). While searching there is no last sample, so an elongated blob is
 * never taken for the tip.
 */
function isStreak(ref: Refined, last: { x: number; y: number }): boolean {
  if (ref.roundness < TUNING.minStreakRoundness) return false;
  const dx = last.x - ref.cx, dy = last.y - ref.cy;
  const dist = Math.hypot(dx, dy);
  if (dist < 2 * ref.minor) return false;
  // Perpendicular distance from the last sample to the streak's axis.
  const off = Math.abs(dx * Math.sin(ref.angle) - dy * Math.cos(ref.angle));
  if (off > 1.5 * ref.minor + 2 + TUNING.streakBend * dist) return false;
  return ref.major <= 1.2 * dist + ref.minor + 1;
}

/**
 * The stateful part of Section 7.2: prediction, lost and found, the static mask, and the plan of which
 * pixels to read. One instance per camera stream; reset() when the camera generation changes.
 */
export class TipTracker {
  private cfg: TipConfig;
  private width = 0;
  private height = 0;
  private factor = 1;
  private gridW = 0;
  private gridH = 0;

  private holding = false;
  private misses = 0;
  private history: HistoryPoint[] = [];
  private lastSeen: number | null = null;
  private stillAnchor: { x: number; y: number } | null = null;
  private stillSince = 0;

  private stats: Stats & { bgMax: number } = { mean: 0, std: 0, max: 0, bgMax: 0 };
  private haveStats = false;
  private lastSurveyT = -Infinity;
  private lastDebugT = -Infinity;

  /** Mask persistence per grid cell (0..1), and the dilated mask derived from it. */
  private maskP: Float32Array | null = null;
  private masked: Uint8Array | null = null;
  private maskedCount = 0;
  private maskT: number | null = null;
  private warmupUntil: number | null = null;
  /** Cells whose persistence is above 0 (all others are 0), so a survey updates only these and the
   *  bright cells instead of the whole grid; and a scratch flag per cell. */
  private maskActive: number[] = [];
  private maskSeen: Uint8Array | null = null;
  private brightCells: number[] = [];

  private surveyBuf = new Uint8Array(0);
  private windowBuf = new Uint8Array(0);
  private hist = new Uint32Array(256);
  private scratch = blobScratch();
  private patchScratch = { buf: new Uint8Array(1024) };

  constructor(config: Partial<TipConfig> = {}) {
    this.cfg = { ...DEFAULT_TIP_CONFIG, ...config };
  }

  get config(): Readonly<TipConfig> {
    return this.cfg;
  }

  get isTracking(): boolean {
    return this.holding;
  }

  configure(config: Partial<TipConfig>): void {
    const before = this.cfg;
    this.cfg = { ...this.cfg, ...config };
    // A new search width changes the grid; a new channel or flip changes what the mask learned.
    if (before.searchWidth !== this.cfg.searchWidth || before.channel !== this.cfg.channel || before.flipX !== this.cfg.flipX) {
      this.setup(this.width, this.height, true);
    }
    if (!this.cfg.staticMask) this.clearMask();
  }

  /** Forget everything about the current stream (new camera generation). Returns whether the tip was held. */
  reset(): boolean {
    const was = this.holding;
    this.width = 0;
    this.height = 0;
    this.dropTip();
    this.haveStats = false;
    this.lastSurveyT = -Infinity;
    this.lastDebugT = -Infinity;
    this.maskP = null;
    this.masked = null;
    this.maskedCount = 0;
    this.maskT = null;
    this.warmupUntil = null;
    this.maskActive = [];
    return was;
  }

  /** 'tracker.relearn-mask': start the mask from nothing, learning fast for TUNING.warmupMs. */
  relearnMask(): void {
    this.clearMask();
    this.warmupUntil = null;
  }

  /** Whether the mask is still in its fast-learning phase. */
  maskWarmingUp(t: number): boolean {
    return this.warmupUntil === null || t < this.warmupUntil;
  }

  /** Which pixels to read for the frame captured at t. forceSurvey reads the whole frame (autotune). */
  plan(width: number, height: number, t: number, wantDebug = false, forceSurvey = false): FramePlan {
    if (width !== this.width || height !== this.height) this.setup(width, height, false);
    const full: Rect = { x: 0, y: 0, width, height };
    const debug = wantDebug && t - this.lastDebugT >= TUNING.debugMs;
    const survey =
      forceSurvey ||
      !this.holding ||
      debug ||
      !this.haveStats ||
      t - this.lastSurveyT >= TUNING.surveyMs ||
      this.misses >= TUNING.surveyAfterMisses;
    if (survey) return { rect: full, survey: true, debug, width, height };

    const pred = this.predict(t)!;
    const r = this.radius(t) + TUNING.patchMargin + 2 * this.factor;
    // Align to the search grid and to 2 pixels, so 4:2:0 frames can be copied by rectangle.
    const align = this.factor % 2 === 0 ? this.factor : this.factor * 2;
    const x0 = Math.max(0, Math.floor((pred.x - r) / align) * align);
    const y0 = Math.max(0, Math.floor((pred.y - r) / align) * align);
    const x1 = Math.min(width, Math.ceil((pred.x + r) / align) * align);
    const y1 = Math.min(height, Math.ceil((pred.y + r) / align) * align);
    const rect: Rect = { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
    if (rect.width * rect.height > TUNING.maxWindowShare * width * height || rect.width === 0 || rect.height === 0) {
      return { rect: full, survey: true, debug, width, height };
    }
    return { rect, survey: false, debug: false, width, height };
  }

  /** Run Section 7.2 on the pixels read for `plan`. */
  process(region: PixelRegion, plan: FramePlan, t: number): FrameResult {
    if (plan.width !== this.width || plan.height !== this.height) this.setup(plan.width, plan.height, false);
    const cfg = this.cfg;
    const f = this.factor;
    const survey = plan.survey;
    const img = maxPool(region, f, cfg.channel, survey ? this.ensureSurveyBuf() : this.ensureWindowBuf(region));

    if (survey || !this.haveStats) {
      const s = imageStats(img, this.hist);
      this.stats.mean = s.mean;
      this.stats.std = s.std;
      this.stats.max = s.max;
      this.haveStats = true;
    }
    const thr = thresholdFor(this.stats, cfg);
    const useMask = cfg.staticMask && this.masked !== null;
    // On a survey the search image is the whole grid, and its bright cells feed the static mask.
    const bright = survey && cfg.staticMask ? this.brightCells : undefined;
    if (bright) bright.length = 0;
    const { blobs, capped } = findBlobs(img, thr, useMask ? this.masked : null, this.gridW, this.scratch, 256, bright);

    // Too-large blobs are rejected on the grid; the rest are refined brightest first.
    const maxCells = (4 * cfg.maxArea) / (f * f) + 16;
    const order = blobs.filter((b) => b.cells <= maxCells).sort((a, b) => b.peak - a.peak || b.cells - a.cells).slice(0, TUNING.maxRefined);

    const pred = this.holding ? this.predict(t) : null;
    const radius = this.holding ? this.radius(t) : Infinity;
    const last = this.holding ? (this.history[this.history.length - 1] ?? null) : null;
    const candidates: Candidate[] = [];
    const rejected: Candidate[] = [];
    for (const blob of order) {
      const patch = this.patchFor(blob, img, region);
      const ref = refineBlob(region, cfg.channel, patch, thr, this.patchScratch);
      if (!ref) continue;
      const brightness = clamp01((ref.peak - thr) / Math.max(8, 255 - thr));
      const round = ref.roundness >= TUNING.minRoundness;
      const streak = !round && last !== null && isStreak(ref, last);
      // A streak's area grows with its length; what must be plausible is the dot that drew it.
      const dotArea = streak ? Math.PI * ref.minor * ref.minor : ref.area;
      let score: number;
      let ok = ref.area >= cfg.minArea && dotArea <= cfg.maxArea && (round || streak);
      if (pred) {
        const d = Math.hypot(ref.cx - pred.x, ref.cy - pred.y);
        if (d > radius) ok = false;
        score = 0.3 * brightness + 0.25 * ref.roundness + 0.45 * clamp01(1 - d / radius);
      } else {
        score = 0.55 * brightness + 0.45 * ref.roundness;
      }
      (ok ? candidates : rejected).push({ blob, ref, score, streak });
    }
    candidates.sort((a, b) => b.score - a.score);
    // No lock while the mask is warming up (the first second after a reset or a relearn): a lamp that
    // is in view from the start would otherwise be locked on first, and a locked tip is kept out of the
    // mask. A wand held in view during that second is masked where it stands and found once it moves.
    const warming = cfg.staticMask && this.maskWarmingUp(t);
    const best = warming ? null : (candidates[0] ?? null);

    // Brightest level away from the tip and outside the mask (Appendix A step 5's "brightest background").
    const bgHere = this.backgroundMax(img, best ? best : null, useMask);
    let bgMax: number;
    if (survey) {
      this.stats.bgMax = bgHere;
      bgMax = bgHere;
    } else {
      bgMax = Math.max(this.stats.bgMax, bgHere);
    }

    // State.
    let found = false, lost = false;
    let sample: TipObservation | null = null;
    let contrast: number | null = null;
    if (best) {
      found = !this.holding;
      this.holding = true;
      this.misses = 0;
      const ref = best.ref;
      contrast = ref.peak / Math.max(1, bgMax);
      const radiusPx = dotRadius(best);
      const contrastFactor = clamp01((contrast - 1) / 2);
      const conf = clamp01((0.35 + 0.65 * best.score) * contrastFactor);
      const nx = ref.cx / this.width;
      sample = {
        x: cfg.flipX ? 1 - nx : nx,
        y: ref.cy / this.height,
        conf,
        size: radiusPx / this.width,
        px: ref.cx,
        py: ref.cy,
        areaPx: ref.area,
        radiusPx,
      };
      this.history.push({ t, x: ref.cx, y: ref.cy });
      if (this.history.length > 4) this.history.shift();
      this.lastSeen = t;
      const moved = !this.stillAnchor || Math.hypot(ref.cx - this.stillAnchor.x, ref.cy - this.stillAnchor.y) > TUNING.stillRadius * this.width;
      if (moved) {
        this.stillAnchor = { x: ref.cx, y: ref.cy };
        this.stillSince = t;
      }
    } else if (this.holding) {
      this.misses++;
      if (this.misses >= cfg.lostAfter) {
        lost = true;
        this.holding = false;
        this.history = [];
        this.misses = 0;
        this.stillAnchor = null;
      }
    }

    if (survey) {
      this.lastSurveyT = t;
      if (cfg.staticMask) this.updateMask(img, thr, t, best, capped || !bright ? null : bright);
    }
    if (plan.debug) this.lastDebugT = t;

    const toDebug = (c: Candidate, chosen: boolean): DebugBlob => {
      const nx = c.ref.cx / this.width;
      return {
        x: cfg.flipX ? 1 - nx : nx,
        y: c.ref.cy / this.height,
        r: dotRadius(c) / this.width,
        major: c.ref.major / this.width,
        minor: c.ref.minor / this.width,
        score: Math.round(c.score * 1000) / 1000,
        chosen,
      };
    };
    const debugBlobs = [...candidates.map((c) => toDebug(c, c === best)), ...rejected.map((c) => toDebug(c, false))];

    return {
      t,
      state: this.holding ? 'tracking' : 'searching',
      sample,
      found,
      lost,
      lastSeen: this.lastSeen,
      survey,
      threshold: thr,
      mean: this.stats.mean,
      std: this.stats.std,
      tipLevel: best ? best.ref.peak : null,
      backgroundMax: bgMax,
      contrast,
      candidates: blobs.length,
      maskedFraction: this.gridW && this.gridH ? this.maskedCount / (this.gridW * this.gridH) : 0,
      blobs: debugBlobs,
      view: plan.debug ? { image: img, threshold: thr, masked: useMask ? this.masked : null, maskWidth: this.gridW } : null,
    };
  }

  // ------------------------------------------------------------------------------------ internals

  private setup(width: number, height: number, keepTip: boolean): void {
    this.width = width;
    this.height = height;
    this.factor = poolFactor(width || 1, this.cfg.searchWidth);
    this.gridW = Math.ceil(width / this.factor);
    this.gridH = Math.ceil(height / this.factor);
    this.maskP = null;
    this.masked = null;
    this.maskedCount = 0;
    this.maskT = null;
    this.warmupUntil = null;
    this.maskActive = [];
    this.haveStats = false;
    if (!keepTip) this.dropTip();
  }

  private dropTip(): void {
    this.holding = false;
    this.misses = 0;
    this.history = [];
    this.lastSeen = null;
    this.stillAnchor = null;
  }

  private clearMask(): void {
    this.maskP?.fill(0);
    this.masked?.fill(0);
    this.maskedCount = 0;
    this.maskT = null;
    this.maskActive = [];
  }

  private ensureSurveyBuf(): Uint8Array {
    const n = this.gridW * this.gridH;
    if (this.surveyBuf.length < n) this.surveyBuf = new Uint8Array(n);
    return this.surveyBuf;
  }

  private ensureWindowBuf(region: Rect): Uint8Array {
    const f = this.factor;
    const n = (Math.ceil(region.width / f) + 2) * (Math.ceil(region.height / f) + 2);
    if (this.windowBuf.length < n) this.windowBuf = new Uint8Array(n);
    return this.windowBuf;
  }

  /** Velocity from the last few samples, full-resolution pixels per ms (0 with fewer than two). */
  private velocity(): { vx: number; vy: number } {
    const h = this.history;
    let vx = 0, vy = 0;
    if (h.length >= 2) {
      const last = h[h.length - 1], a = h[h.length - 2];
      const dt1 = Math.max(1, last.t - a.t);
      vx = (last.x - a.x) / dt1;
      vy = (last.y - a.y) / dt1;
      if (h.length >= 3) {
        const b = h[h.length - 3];
        const dt2 = Math.max(1, a.t - b.t);
        // Weight the newest velocity more: strokes curve.
        vx = 0.7 * vx + 0.3 * ((a.x - b.x) / dt2);
        vy = 0.7 * vy + 0.3 * ((a.y - b.y) / dt2);
      }
    }
    return { vx, vy };
  }

  /** Constant-velocity prediction from the last few samples, in full-resolution pixels. */
  private predict(t: number): { x: number; y: number } | null {
    const h = this.history;
    if (!h.length) return null;
    const last = h[h.length - 1];
    const { vx, vy } = this.velocity();
    const dt = Math.max(0, t - last.t);
    return {
      x: Math.min(this.width, Math.max(0, last.x + vx * dt)),
      y: Math.min(this.height, Math.max(0, last.y + vy * dt)),
    };
  }

  /** Section 7.2 table: 12% of frame width per frame at 30 fps, scaled by the time since the last sample. */
  private radius(t: number): number {
    const last = this.history[this.history.length - 1];
    const dt = last ? Math.max(1, t - last.t) : TUNING.framePeriodMs;
    return Math.max(TUNING.minRadius, this.cfg.searchRadius * (dt / TUNING.framePeriodMs)) * this.width;
  }

  /** Full-resolution rectangle around a blob, clipped to the region that was read. */
  private patchFor(blob: Blob, img: SearchImage, region: Rect): Rect {
    const f = img.factor, m = TUNING.patchMargin;
    const x0 = Math.max(region.x, (img.x0 + blob.minX) * f - m);
    const y0 = Math.max(region.y, (img.y0 + blob.minY) * f - m);
    const x1 = Math.min(region.x + region.width, (img.x0 + blob.maxX + 1) * f + m);
    const y1 = Math.min(region.y + region.height, (img.y0 + blob.maxY + 1) * f + m);
    return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
  }

  /** Brightest cell outside the mask and away from the chosen blob. */
  private backgroundMax(img: SearchImage, best: Candidate | null, useMask: boolean): number {
    const { data, width: w, height: h, x0, y0 } = img;
    const mask = useMask ? this.masked : null;
    let ex0 = -1, ey0 = -1, ex1 = -2, ey1 = -2;
    if (best) {
      // Exclude the blob and a ring around it, so its halo does not count as background.
      const pad = 2 + Math.ceil(Math.max(best.blob.maxX - best.blob.minX, best.blob.maxY - best.blob.minY) / 2);
      ex0 = best.blob.minX - pad;
      ey0 = best.blob.minY - pad;
      ex1 = best.blob.maxX + pad;
      ey1 = best.blob.maxY + pad;
    }
    let max = 0;
    for (let y = 0; y < h; y++) {
      const inY = y >= ey0 && y <= ey1;
      const row = y * w;
      const mrow = (y0 + y) * this.gridW + x0;
      for (let x = 0; x < w; x++) {
        const v = data[row + x];
        if (v <= max) continue;
        if (inY && x >= ex0 && x <= ex1) continue;
        if (mask !== null && mask[mrow + x] === 1) continue;
        max = v;
      }
    }
    return max;
  }

  /**
   * Section 7.2 step 3: a slow-moving mask of static bright areas. Each grid cell keeps an exponential
   * average of "at or above the threshold"; above TUNING.maskOn the cell (and its 8 neighbours, to cover
   * flickering halos) is masked. The tracked tip is left out while it moves, so a wand held for the
   * hold-still beat is never learned; a "tip" that has not moved for TUNING.stillMs is probably a lamp.
   *
   * Only bright cells and cells still fading can change (every other cell stays at 0), so with the list
   * of bright cells from findBlobs this touches a few hundred cells instead of the whole grid (it was
   * 0.9 ms of a 3.4 ms 1080p survey). Without the list (findBlobs stopped at its cap) it scans them all.
   */
  private updateMask(img: SearchImage, thr: number, t: number, best: Candidate | null, bright: readonly number[] | null): void {
    const n = this.gridW * this.gridH;
    if (!this.maskP || this.maskP.length !== n) {
      this.maskP = new Float32Array(n);
      this.masked = new Uint8Array(n);
      this.maskedCount = 0;
      this.maskT = null;
      this.maskActive = [];
    }
    if (this.warmupUntil === null) this.warmupUntil = t + TUNING.warmupMs;
    const dt = this.maskT === null ? TUNING.framePeriodMs : Math.max(0, t - this.maskT);
    this.maskT = t;
    if (dt <= 0) return;
    const tau = t < this.warmupUntil ? TUNING.warmupTauMs : TUNING.maskTauMs;
    const alpha = 1 - Math.exp(-dt / tau);
    const p = this.maskP;

    let ex0 = -1, ey0 = -1, ex1 = -2, ey1 = -2;
    const learnTip = this.holding && t - this.stillSince >= TUNING.stillMs;
    if (best && !learnTip) {
      const pad = 2 + Math.ceil(Math.max(best.blob.maxX - best.blob.minX, best.blob.maxY - best.blob.minY) / 2);
      ex0 = best.blob.minX - pad;
      ey0 = best.blob.minY - pad;
      ex1 = best.blob.maxX + pad;
      ey1 = best.blob.maxY + pad;
    }

    const on: number[] = [];
    const active: number[] = [];
    const gw = this.gridW;
    /** One cell: towards 1 if lit, towards 0 if not, except around the tracked tip. */
    const visit = (i: number, lit: number) => {
      let v = p[i];
      const y = (i / gw) | 0, x = i - y * gw;
      if (!(y >= ey0 && y <= ey1 && x >= ex0 && x <= ex1)) {
        v += alpha * (lit - v);
        if (v < 0.01) v = 0;
        p[i] = v;
      }
      if (v > 0) active.push(i);
      if (v > TUNING.maskOn) on.push(i);
    };
    if (bright) {
      const seen = this.maskSeen && this.maskSeen.length === n ? this.maskSeen : (this.maskSeen = new Uint8Array(n));
      for (const i of bright) {
        seen[i] = 1;
        visit(i, 1);
      }
      for (const i of this.maskActive) if (!seen[i]) visit(i, 0);
      for (const i of bright) seen[i] = 0;
    } else {
      const data = img.data;
      for (let i = 0; i < n; i++) {
        const lit = data[i] >= thr ? 1 : 0;
        if (lit === 0 && p[i] === 0) continue;
        visit(i, lit);
      }
    }
    this.maskActive = active;
    const masked = this.masked!;
    masked.fill(0);
    let count = 0;
    for (const i of on) {
      const x = i % gw, y = (i / gw) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= this.gridH) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= gw) continue;
          const k = yy * gw + xx;
          if (!masked[k]) {
            masked[k] = 1;
            count++;
          }
        }
      }
    }
    this.maskedCount = count;
  }
}
