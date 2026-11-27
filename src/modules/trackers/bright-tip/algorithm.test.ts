import { describe, expect, it } from 'vitest';
import {
  TUNING, TipTracker, byteMax4, channelValue, findBlobs, blobScratch, imageStats, limitedRangeLut, maxPool, poolFactor,
  refineBlob, renderThresholdView, thresholdFor, type Channel, type FrameResult, type PixelRegion, type TipConfig,
} from './algorithm';
import { crop, renderFrame, rng, toGray, type SyntheticFrame } from './synthetic';

/** The plain definition of the max-pool (Section 7.2 step 1), one pixel at a time, for comparison. */
function referencePool(region: PixelRegion, f: number, channel: Channel): Uint8Array {
  const x0 = Math.floor(region.x / f), y0 = Math.floor(region.y / f);
  const sw = Math.ceil((region.x + region.width) / f) - x0;
  const sh = Math.ceil((region.y + region.height) / f) - y0;
  const out = new Uint8Array(sw * sh);
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      let v: number;
      if (region.format === 'gray') {
        v = region.data[y * region.stride + x];
        if (region.lut) v = region.lut[v];
      } else {
        const p = y * region.stride + x * 4;
        const [r, g, b] = region.format === 'rgba' ? [region.data[p], region.data[p + 1], region.data[p + 2]] : [region.data[p + 2], region.data[p + 1], region.data[p]];
        v = channelValue(r, g, b, channel);
      }
      const ci = (Math.floor((region.y + y) / f) - y0) * sw + (Math.floor((region.x + x) / f) - x0);
      if (v > out[ci]) out[ci] = v;
    }
  }
  return out;
}

/** A region of random bytes; `offset` shifts the data start (a plane that does not start on a word). */
function randomRegion(o: { x?: number; y?: number; width: number; height: number; stride?: number; format: PixelRegion['format']; seed: number; offset?: number; dark?: boolean; lut?: Uint8Array }): PixelRegion {
  const bpp = o.format === 'gray' ? 1 : 4;
  const stride = o.stride ?? o.width * bpp;
  const rand = rng(o.seed);
  const backing = new Uint8Array(stride * o.height + (o.offset ?? 0));
  // Uniform bytes exercise every high-bit case; a dark room is what the tracker sees most.
  for (let i = 0; i < backing.length; i++) backing[i] = o.dark ? (rand() < 0.002 ? 200 + rand() * 55 : 10 + rand() * 20) : rand() * 256;
  const data = backing.subarray(o.offset ?? 0);
  return { x: o.x ?? 0, y: o.y ?? 0, width: o.width, height: o.height, format: o.format, data, stride, lut: o.lut };
}

const FPS = 30;
const DT = 1000 / FPS;

/** Run the tracker over frames, reading only what each plan asks for, like the worker does. */
function run(tracker: TipTracker, frames: number, spec: (i: number) => SyntheticFrame, start = 0): FrameResult[] {
  const out: FrameResult[] = [];
  for (let i = 0; i < frames; i++) {
    const s = spec(i);
    const t = (start + i) * DT;
    const plan = tracker.plan(s.width, s.height, t);
    const frame = renderFrame({ seed: start + i + 1, ...s });
    out.push(tracker.process(crop(frame, plan.rect), plan, t));
  }
  return out;
}

/** Let the static mask finish its warm-up on an empty room (the tracker never locks during it). */
function warm(tracker: TipTracker, base: Omit<SyntheticFrame, 'dots'>, frames = 36): number {
  run(tracker, frames, () => base);
  return frames;
}

const room = { width: 640, height: 360, background: 18, noise: 4 };

describe('pixels', () => {
  it('keeps a one-pixel glint through a 3x max-pool shrink', () => {
    const frame = renderFrame({ width: 96, height: 60, noise: 0, background: 10 });
    const p = (31 * 96 + 47) * 4;
    frame.data[p] = frame.data[p + 1] = frame.data[p + 2] = 250;
    const img = maxPool(frame, 3, 'luma');
    expect(img.width).toBe(32);
    expect(img.height).toBe(20);
    expect(img.data[(31 / 3 | 0) * 32 + (47 / 3 | 0)]).toBe(250);
    expect(imageStats(img).max).toBe(250);
  });

  it('pools unaligned regions and gray planes like the full frame', () => {
    const frame = renderFrame({ ...room, seed: 7, dots: [{ x: 300.3, y: 150.7, radius: 3 }] });
    const full = maxPool(frame, 3, 'luma');
    const win = maxPool(crop(frame, { x: 271, y: 125, width: 61, height: 47 }), 3, 'luma');
    // Interior cells of the window equal the full frame's cells.
    for (let j = 1; j < win.height - 1; j++) {
      for (let i = 1; i < win.width - 1; i++) {
        expect(win.data[j * win.width + i]).toBe(full.data[(win.y0 + j) * full.width + win.x0 + i]);
      }
    }
    const gray = maxPool(toGray(frame), 3, 'luma');
    expect(Array.from(gray.data)).toEqual(Array.from(full.data));
  });

  it('takes the per-byte maximum of two words exactly, for every pair of byte values', () => {
    const wrong: string[] = [];
    for (let a = 0; a < 256; a++) {
      for (let b = 0; b < 256; b++) {
        // The pair in lanes 0 and 1 (both ways round), next to lanes holding other values, so a borrow
        // from one lane into the next would show.
        const wa = (a | (b << 8) | (a << 16) | (b << 24)) | 0;
        const wb = (b | (a << 8) | ((255 - a) << 16)) | 0;
        const m = byteMax4(wa, wb);
        const got = [m & 255, (m >>> 8) & 255, (m >>> 16) & 255, m >>> 24];
        const want = [Math.max(a, b), Math.max(a, b), Math.max(a, 255 - a), b];
        if (got.some((v, i) => v !== want[i]) && wrong.length < 5) wrong.push(`${a},${b}: ${got} instead of ${want}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('pools exactly like the plain definition, whichever kernel runs', () => {
    const lut = limitedRangeLut();
    const cases: Parameters<typeof randomRegion>[0][] = [];
    let seed = 1;
    for (const f of [1, 2, 3, 4]) {
      for (const width of [96, 98, 100, 101]) {
        for (const format of ['gray', 'rgba', 'bgra'] as const) {
          const bpp = format === 'gray' ? 1 : 4;
          // Rows that are and are not a whole number of words; data that does and does not start on one.
          for (const pad of [0, 2]) {
            for (const offset of [0, 1]) {
              cases.push({ width, height: 31, stride: width * bpp + pad, format, seed: seed++, offset, lut: format === 'gray' && seed % 2 ? lut : undefined });
            }
          }
          // An unaligned window (the generic kernel), and a dark room.
          cases.push({ x: 7, y: 5, width, height: 23, format, seed: seed++ });
          cases.push({ width, height: 30, format, seed: seed++, dark: true });
        }
      }
      for (const c of cases.splice(0)) {
        const region = randomRegion(c);
        for (const channel of region.format === 'gray' ? (['luma'] as const) : (['luma', 'r', 'g', 'b'] as const)) {
          const got = maxPool(region, f, channel);
          expect(Array.from(got.data), `f ${f}, ${JSON.stringify({ ...c, lut: !!c.lut })}, ${channel}`).toEqual(Array.from(referencePool(region, f, channel)));
        }
      }
    }
  });

  it('maps limited-range video luma to full range', () => {
    const lut = limitedRangeLut();
    expect(lut[16]).toBe(0);
    expect(lut[235]).toBe(255);
    expect(lut[0]).toBe(0);
    expect(lut[255]).toBe(255);
  });

  it('scores a tinted tip above a white lamp on its colour channel', () => {
    // A red tip against a white lamp: equal on luma, far apart on the red channel.
    expect(channelValue(255, 60, 40, 'r')).toBeGreaterThan(200);
    expect(channelValue(255, 255, 255, 'r')).toBe(128);
    expect(channelValue(40, 60, 255, 'b')).toBeGreaterThan(200);
    expect(channelValue(255, 200, 120, 'b')).toBeLessThan(30);
    expect(channelValue(255, 255, 255, 'luma')).toBe(255);
  });

  it('sets the threshold from the floor or mean + k·std, whichever is higher', () => {
    expect(thresholdFor({ mean: 20, std: 5, max: 0 }, { k: 4, floor: 200 })).toBe(200);
    expect(thresholdFor({ mean: 120, std: 30, max: 0 }, { k: 4, floor: 200 })).toBe(240);
    // Never above TUNING.maxThreshold, so saturated pixels still count in an over-bright room.
    expect(thresholdFor({ mean: 200, std: 40, max: 0 }, { k: 4, floor: 200 })).toBe(TUNING.maxThreshold);
  });

  it('picks a pool factor for the search width', () => {
    expect(poolFactor(1920, 640)).toBe(3);
    expect(poolFactor(1280, 640)).toBe(2);
    expect(poolFactor(640, 640)).toBe(1);
  });

  it('groups bright cells 8-connected and skips masked ones', () => {
    const img = { data: new Uint8Array(100), width: 10, height: 10, x0: 0, y0: 0, factor: 1 };
    img.data[11] = img.data[22] = 255; // diagonal neighbours: one blob
    img.data[77] = 255;
    const mask = new Uint8Array(100);
    mask[77] = 1;
    const { blobs, maskedBright } = findBlobs(img, 200, mask, 10, blobScratch());
    expect(blobs).toHaveLength(1);
    expect(blobs[0].cells).toBe(2);
    expect(maskedBright).toBe(1);
  });

  it('measures a disc: area, centroid and roundness', () => {
    const frame = renderFrame({ width: 64, height: 64, noise: 0, background: 10, dots: [{ x: 30.25, y: 33.6, radius: 4 }] });
    const ref = refineBlob(frame, 'luma', { x: 20, y: 22, width: 22, height: 22 }, 120)!;
    expect(ref.cx).toBeCloseTo(30.25, 1);
    expect(ref.cy).toBeCloseTo(33.6, 1);
    expect(ref.area).toBeGreaterThan(Math.PI * 16 * 0.8);
    expect(ref.area).toBeLessThan(Math.PI * 16 * 1.2);
    expect(ref.roundness).toBeGreaterThan(0.9);
  });

  it('draws the threshold view in caster orientation', () => {
    const img = { data: new Uint8Array([0, 0, 0, 255]), width: 4, height: 1, x0: 0, y0: 0, factor: 1 };
    const flipped = renderThresholdView({ image: img, threshold: 200, masked: null, maskWidth: 4 }, true);
    // The bright cell at the far right of the camera image is at the far left of the mirror.
    expect([flipped[0], flipped[1], flipped[2]]).toEqual([242, 184, 75]);
    const plain = renderThresholdView({ image: img, threshold: 200, masked: null, maskWidth: 4 }, false);
    expect([plain[12], plain[13], plain[14]]).toEqual([242, 184, 75]);
  });
});

describe('TipTracker', () => {
  it('finds a dot on noise and flips x into caster space', () => {
    const tracker = new TipTracker();
    const n = warm(tracker, room);
    const [r] = run(tracker, 1, () => ({ ...room, dots: [{ x: 160, y: 90, radius: 3 }] }), n);
    expect(r.found).toBe(true);
    expect(r.state).toBe('tracking');
    expect(r.sample).not.toBeNull();
    // Camera x = 160/640 = 0.25, so the mirror shows it at 0.75 (Section 6: flip once, at the source).
    expect(r.sample!.x).toBeCloseTo(0.75, 2);
    expect(r.sample!.y).toBeCloseTo(0.25, 2);
    expect(r.sample!.conf).toBeGreaterThan(0.8);
    // size is the blob radius in frame-width units.
    expect(r.sample!.size).toBeCloseTo(3 / 640, 3);
  });

  it('leaves x alone when the camera already mirrors (capture.flipX off)', () => {
    const tracker = new TipTracker({ flipX: false });
    const n = warm(tracker, room);
    const [r] = run(tracker, 1, () => ({ ...room, dots: [{ x: 160, y: 90, radius: 3 }] }), n);
    expect(r.sample!.x).toBeCloseTo(0.25, 2);
  });

  it('is sub-pixel accurate on a rendered gaussian (better than 0.25 px)', () => {
    const rand = rng(99);
    let worst = 0;
    for (let trial = 0; trial < 24; trial++) {
      // minArea 1: this test is about the centroid, and a sigma of 1.2 px leaves only a few pixels above
      // the 200 floor (a real glint at 1080p is 5 to 7 px wide, Section 4).
      const tracker = new TipTracker({ staticMask: false, minArea: 1 });
      const x = 100 + rand() * 440, y = 60 + rand() * 240;
      const sigma = 1.2 + rand() * 1.2;
      const spec = { ...room, noise: 3, seed: 1000 + trial, dots: [{ x, y, sigma, color: [235, 235, 235] as [number, number, number] }] };
      const plan = tracker.plan(640, 360, 0);
      const r = tracker.process(renderFrame(spec), plan, 0);
      expect(r.sample, `trial ${trial}`).not.toBeNull();
      worst = Math.max(worst, Math.hypot(r.sample!.px - x, r.sample!.py - y));
    }
    console.info(`[bright-tip] worst centroid error over 24 gaussians: ${worst.toFixed(3)} px`);
    expect(worst).toBeLessThan(0.25);
  });

  it('masks a static lamp the same size as the tip and follows the tip', () => {
    const tracker = new TipTracker();
    const lamp = { x: 120, y: 80, radius: 3 };
    // The lamp is in view from the first frame; the mask warms up before anything can lock.
    const before = run(tracker, 36, () => ({ ...room, dots: [lamp] }));
    expect(before.every((r) => r.sample === null)).toBe(true);
    const results = run(tracker, 40, (i) => ({ ...room, dots: [lamp, { x: 300 + i * 4, y: 200, radius: 3 }] }), 36);
    const samples = results.filter((r) => r.sample);
    expect(samples.length).toBe(40);
    for (const [i, r] of results.entries()) expect(r.sample!.px).toBeCloseTo(300 + i * 4, 0);
    expect(results.at(-1)!.maskedFraction).toBeGreaterThan(0);
  });

  it('updates the static mask from the bright cells alone exactly as a scan of the whole grid would', () => {
    // Two trackers see the same scene: a lamp, a light that flickers, and a moving tip. One of them is
    // made to scan the whole grid (what happens when findBlobs stops at its cap).
    const fast = new TipTracker(), full = new TipTracker();
    type Internals = { updateMask: (...args: unknown[]) => void; maskP: Float32Array; masked: Uint8Array; maskedCount: number };
    const f = full as unknown as Internals;
    const original = f.updateMask.bind(full);
    f.updateMask = (img, thr, t, best) => original(img, thr, t, best, null);
    for (let i = 0; i < 120; i++) {
      const dots = [{ x: 120, y: 80, radius: 3 }, { x: 500 + 10 * Math.sin(i / 5), y: 250, radius: 4 }];
      if (i % 7 < 4) dots.push({ x: 400, y: 60, radius: 3 });
      const spec: SyntheticFrame = { ...room, seed: i + 1, dots };
      const t = i * DT;
      const pa = fast.plan(640, 360, t, false, true), pb = full.plan(640, 360, t, false, true);
      const frame = renderFrame(spec);
      fast.process(frame, pa, t);
      full.process(frame, pb, t);
    }
    const a = fast as unknown as Internals;
    expect(a.maskedCount).toBeGreaterThan(0);
    expect(a.maskedCount).toBe(f.maskedCount);
    expect(Array.from(a.masked)).toEqual(Array.from(f.masked));
    let differ = 0;
    for (let i = 0; i < a.maskP.length; i++) if (a.maskP[i] !== f.maskP[i]) differ++;
    expect(differ).toBe(0);
  });

  it('follows a dot moving fast without losing it', () => {
    const tracker = new TipTracker();
    const n = warm(tracker, room);
    // A circle traced at 0.1 of the frame width per frame at 30 fps (three widths a second, near the
    // 12% search radius), turning 24 degrees a frame, so constant-velocity prediction is well off.
    const speed = 0.1 * 640, radius = 150;
    const w = speed / radius;
    const path = (i: number) => ({ x: 320 + radius * Math.cos(i * w), y: 180 + radius * Math.sin(i * w) });
    const results = run(tracker, 40, (i) => ({ ...room, dots: [{ ...path(i), radius: 3 }] }), n);
    for (const [i, r] of results.entries()) {
      expect(r.sample, `frame ${i}`).not.toBeNull();
      expect(Math.hypot(r.sample!.px - path(i).x, r.sample!.py - path(i).y)).toBeLessThan(1);
    }
    expect(results.some((r) => r.lost)).toBe(false);
  });

  it('follows a fast stroke whose glint smears into a streak, from the first moving frame', () => {
    const tracker = new TipTracker();
    const n = warm(tracker, room);
    // Hold still, then move right at 22 px a frame. The exposure lasts the whole frame interval, so each
    // frame shows the dot smeared from where it was to where it is: semi-axes of about 13 and 2.5 px, far
    // less round than TUNING.minRoundness allows a dot to be.
    const x = (i: number) => (i < 6 ? 100 : 100 + (i - 5) * 22);
    const streak = (i: number) => {
      const from = x(Math.max(0, i - 1)), to = x(i);
      const dots = [];
      for (let s = 0; s <= 1.0001; s += 1 / Math.max(1, Math.round(to - from))) dots.push({ x: from + (to - from) * s, y: 180, radius: 2.5 });
      return dots;
    };
    const results = run(tracker, 18, (i) => ({ ...room, dots: streak(i) }), n);
    for (const [i, r] of results.entries()) {
      expect(r.sample, `frame ${i}`).not.toBeNull();
      // The centroid of a smear is the middle of the exposure.
      const mid = (x(Math.max(0, i - 1)) + x(i)) / 2;
      expect(Math.abs(r.sample!.px - mid), `frame ${i}`).toBeLessThan(1.5);
    }
    expect(results.some((r) => r.lost)).toBe(false);
    // The test does exercise the streak rule, and a streak's size is its dot's, not its length's.
    const chosen = results[10].blobs.find((b) => b.chosen)!;
    expect(chosen.minor / chosen.major).toBeLessThan(TUNING.minRoundness);
    expect(results[10].sample!.radiusPx).toBeLessThan(3.5);
  });

  it('does not take a bright bar across the path for the tip when the tip vanishes', () => {
    const tracker = new TipTracker({ staticMask: false });
    // A slow, steady stroke, then the tip turns away and a 3 x 24 px bar lights up just ahead of it.
    const results = run(tracker, 12, (i) => (i < 8 ? { ...room, dots: [{ x: 300 + 3 * i, y: 180, radius: 3 }] } : { ...room, rects: [{ x: 336, y: 168, width: 3, height: 24, color: [230, 230, 230] as [number, number, number] }] }));
    expect(results.slice(0, 8).every((r) => r.sample)).toBe(true);
    expect(results.slice(8).every((r) => r.sample === null)).toBe(true);
  });

  it('prefers the dot the prediction expects when two are in reach', () => {
    const tracker = new TipTracker();
    const n = warm(tracker, room);
    const a = (i: number) => ({ x: 200 + i * 6, y: 180, radius: 3 });
    // B appears at frame 8, as bright as A and inside the search radius, 50 px from A's predicted spot.
    const results = run(tracker, 20, (i) => ({ ...room, dots: i >= 8 ? [a(i), { x: 200 + i * 6 + 50, y: 180, radius: 3 }] : [a(i)] }), n);
    for (const [i, r] of results.entries()) {
      expect(r.sample, `frame ${i}`).not.toBeNull();
      expect(r.sample!.px).toBeCloseTo(a(i).x, 0);
    }
    // A blob far outside the search radius is never taken while the tip is held.
    const far = run(tracker, 1, () => ({ ...room, dots: [{ x: 600, y: 40, radius: 3 }] }), n + 20);
    expect(far[0].sample).toBeNull();
  });

  it('declares the tip lost after lostAfter misses, then finds it again', () => {
    const tracker = new TipTracker({ lostAfter: 6 });
    const n = warm(tracker, room);
    const visible = (i: number) => i < 10 || i >= 20;
    const results = run(tracker, 26, (i) => ({ ...room, dots: visible(i) ? [{ x: 320, y: 180 + i, radius: 3 }] : [] }), n);
    expect(results[0].found).toBe(true);
    expect(results.slice(1, 10).every((r) => r.sample && !r.found)).toBe(true);
    const lostAt = results.findIndex((r) => r.lost);
    expect(lostAt).toBe(15); // the sixth frame without the tip
    expect(results[lostAt].lastSeen).toBeCloseTo((n + 9) * DT, 6);
    expect(results[lostAt].state).toBe('searching');
    expect(results[20].found).toBe(true);
    expect(results[20].sample!.py).toBeCloseTo(200, 0);
  });

  it('reports contrast: tip level over the brightest background', () => {
    const tracker = new TipTracker({ staticMask: false });
    // A dim window (level about 18 + 50) and a tip at about 18 + 230.
    const spec = { ...room, noise: 0, rects: [{ x: 500, y: 40, width: 60, height: 40, color: [50, 50, 50] as [number, number, number] }], dots: [{ x: 200, y: 200, radius: 4 }] };
    const plan = tracker.plan(640, 360, 0);
    const r = tracker.process(renderFrame(spec), plan, 0);
    expect(r.tipLevel).toBe(248);
    expect(r.backgroundMax).toBe(68);
    expect(r.contrast).toBeCloseTo(248 / 68, 2);
  });

  it('rejects lines, oversized blobs and specks', () => {
    const tracker = new TipTracker({ staticMask: false, minArea: 4, maxArea: 400 });
    const spec = {
      ...room,
      rects: [
        { x: 50, y: 100, width: 200, height: 3, color: [230, 230, 230] as [number, number, number] }, // a light strip
        { x: 400, y: 100, width: 40, height: 40, color: [230, 230, 230] as [number, number, number] }, // a window, 1600 px²
        { x: 300, y: 300, width: 1, height: 1, color: [230, 230, 230] as [number, number, number] }, // a speck, 1 px²
      ],
    };
    const r = tracker.process(renderFrame(spec), tracker.plan(640, 360, 0), 0);
    expect(r.sample).toBeNull();
  });

  it('separates a red tip from a white lamp with the red channel', () => {
    const cfg: Partial<TipConfig> = { channel: 'r', staticMask: false, floor: 170 };
    const tracker = new TipTracker(cfg);
    const spec = {
      ...room,
      dots: [
        { x: 100, y: 100, radius: 3, color: [237, 40, 30] as [number, number, number] }, // the tinted tip
        { x: 400, y: 200, radius: 3, color: [237, 237, 237] as [number, number, number] }, // a white bulb
      ],
    };
    const r = tracker.process(renderFrame(spec), tracker.plan(640, 360, 0), 0);
    expect(r.sample!.px).toBeCloseTo(100, 0);
    // On luma the bulb is the brighter of the two.
    const luma = new TipTracker({ staticMask: false });
    const l = luma.process(renderFrame(spec), luma.plan(640, 360, 0), 0);
    expect(l.sample!.px).toBeCloseTo(400, 0);
  });

  it('reads a window around the prediction while tracking, and surveys the frame every so often', () => {
    const tracker = new TipTracker();
    const n = warm(tracker, room);
    run(tracker, 3, (i) => ({ ...room, dots: [{ x: 300 + i * 5, y: 180, radius: 3 }] }), n);
    const t = (n + 3) * DT;
    const plan = tracker.plan(640, 360, t);
    expect(plan.survey).toBe(false);
    expect(plan.rect.width * plan.rect.height).toBeLessThan(0.3 * 640 * 360);
    // Aligned for 4:2:0 copies and the pool grid; contains the predicted spot.
    for (const v of [plan.rect.x, plan.rect.y, plan.rect.width, plan.rect.height]) expect(v % 2).toBe(0);
    expect(plan.rect.x).toBeLessThan(315);
    expect(plan.rect.x + plan.rect.width).toBeGreaterThan(315);
    const later = tracker.plan(640, 360, t + TUNING.surveyMs + 1);
    expect(later.survey).toBe(true);
  });

  it('meets the time budget on a 1920x1080 frame', () => {
    const spec = { width: 1920, height: 1080, background: 18, noise: 5, seed: 3, dots: [{ x: 905.5, y: 512.25, radius: 3.5 }] };
    const rgba = renderFrame(spec);
    const gray = toGray(rgba);
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
    const timeIt = (fn: () => void, reps = 15) => {
      const times: number[] = [];
      for (let i = 0; i < reps; i++) {
        const t0 = performance.now();
        fn();
        times.push(performance.now() - t0);
      }
      return median(times);
    };
    const surveyRgba = timeIt(() => {
      const tr = new TipTracker({ staticMask: false });
      tr.process(rgba, tr.plan(1920, 1080, 0), 0);
    });
    const surveyGray = timeIt(() => {
      const tr = new TipTracker({ staticMask: false });
      tr.process(gray, tr.plan(1920, 1080, 0), 0);
    });
    // Tracking: lock on with two frames, then time window frames.
    const tracker = new TipTracker({ staticMask: false });
    tracker.process(rgba, tracker.plan(1920, 1080, 0), 0);
    tracker.process(rgba, tracker.plan(1920, 1080, DT), DT);
    let t = 2 * DT;
    let windowShare = 0;
    const windowRgba = timeIt(() => {
      const plan = tracker.plan(1920, 1080, t);
      windowShare = (plan.rect.width * plan.rect.height) / (1920 * 1080);
      const region = crop(rgba, plan.rect);
      tracker.process(region, plan, t);
      t += DT;
    }, 10);
    console.info(
      `[bright-tip timing, Node] 1920x1080 survey: rgba ${surveyRgba.toFixed(2)} ms, gray ${surveyGray.toFixed(2)} ms; ` +
        `tracking window (${(windowShare * 100).toFixed(1)}% of the frame, rgba, crop included): ${windowRgba.toFixed(2)} ms`,
    );
    // Generous bounds so a slow CI machine does not fail; the numbers above are what to compare
    // with the 4 ms budget (Section 13), measured on the reference laptop.
    expect(surveyGray).toBeLessThan(60);
    expect(windowRgba).toBeLessThan(20);
  });
});

