import { describe, expect, it } from 'vitest';
import { convexHull, fromGrip, gripFrame, toGrip, WAND, WandFinder, wandRegion, type LumaPlane } from './wand';
import { renderScene, type SceneOptions, type SceneWand } from './wand-scene';

/** The region the worker would read for this scene's hand, as a plane. */
function planeFor(scene: ReturnType<typeof renderScene>): LumaPlane {
  const g = gripFrame(scene.landmarks, 2, 1, 1);
  const r = wandRegion(g, scene.width, scene.height);
  const data = new Uint8Array(r.width * r.height);
  for (let y = 0; y < r.height; y++) data.set(scene.data.subarray((r.y + y) * scene.width + r.x, (r.y + y) * scene.width + r.x + r.width), y * r.width);
  return { data, width: r.width, height: r.height, stride: r.width, x0: r.x, y0: r.y };
}

const PALM = 75;

function scene(wand: Partial<SceneWand> | null, o: Partial<SceneOptions> = {}): ReturnType<typeof renderScene> {
  return renderScene({
    width: 1280, height: 720,
    hand: { x: 640, y: 520, palm: PALM, angle: -Math.PI / 2 - 0.2 },
    wand: wand === null ? null : { angle: -Math.PI / 2 - 0.5, length: 2.6, ...wand },
    background: 'room',
    ...o,
  });
}

const finder = new WandFinder();
const find = (s: ReturnType<typeof renderScene>, prior: { a: number; b: number } | null = null) => finder.find(planeFor(s), s.landmarks, prior);
const tipError = (s: ReturnType<typeof renderScene>, f: { tip: { x: number; y: number } }) => Math.hypot(f.tip.x - s.tip!.x, f.tip.y - s.tip!.y) / PALM;
const deg = (d: number) => (d * Math.PI) / 180;

describe('grip frame', () => {
  it('puts the anchor between the thumb and the index finger and measures the palm', () => {
    const s = scene(null);
    const g = gripFrame(s.landmarks, 2, 1, 1);
    expect(g.palm).toBeGreaterThan(0.9 * PALM);
    expect(g.palm).toBeLessThan(1.3 * PALM);
    expect(Math.abs(Math.atan2(g.uy, g.ux) - (-Math.PI / 2 - 0.2))).toBeLessThan(0.15);
    // The anchor sits between landmarks 2-3 (thumb) and 5-6 (index).
    const lm = s.landmarks;
    expect(g.ax).toBeCloseTo((lm[4] + lm[6] + lm[10] + lm[12]) / 4, 9);
  });

  it('round-trips grip coordinates', () => {
    const g = gripFrame(scene(null).landmarks, 2, 1, 1);
    const p = fromGrip(g, 1.7, -0.4);
    const q = toGrip(g, p.x, p.y);
    expect(q.a).toBeCloseTo(1.7, 9);
    expect(q.b).toBeCloseTo(-0.4, 9);
  });

  it('reads normalized landmarks the same as pixels, so grip coordinates do not depend on the frame size', () => {
    const s = scene(null);
    const px = gripFrame(s.landmarks, 2, 1, 1);
    const norm = gripFrame(s.normalized, 3, 1280, 720);
    expect(norm.ax).toBeCloseTo(px.ax, 6);
    expect(norm.palm).toBeCloseTo(px.palm, 6);
    // Isotropic frame widths (geometry.ts): a uniform scale of the pixels.
    const iso = gripFrame(s.normalized, 3, 1, 720 / 1280);
    const p = fromGrip(iso, 2, 0.3);
    const q = fromGrip(px, 2, 0.3);
    expect(p.x * 1280).toBeCloseTo(q.x, 6);
    expect(p.y * 1280).toBeCloseTo(q.y, 6);
  });

  it('falls back to the knuckles, then straight up, for a degenerate palm', () => {
    const flat = new Array(42).fill(100);
    const g = gripFrame(flat, 2, 1, 1);
    expect(g.ux).toBe(0);
    expect(g.uy).toBe(-1);
    expect(Number.isFinite(g.palm)).toBe(true);
  });

  it('keeps the region inside the frame, on even pixels', () => {
    const g = gripFrame(scene(null).landmarks, 2, 1, 1);
    for (const [ax, ay] of [[10, 10], [1270, 715], [640, 360]]) {
      const r = wandRegion({ ...g, ax, ay }, 1280, 720);
      expect(r.x % 2 + r.y % 2 + r.width % 2 + r.height % 2).toBe(0);
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.width).toBeLessThanOrEqual(1280);
      expect(r.y + r.height).toBeLessThanOrEqual(720);
    }
  });

  it('builds a convex hull of the points', () => {
    expect(convexHull([0, 0, 2, 0, 1, 1, 2, 2, 0, 2]).length).toBe(8);
  });
});

describe('finding the wand', () => {
  for (const a of [-150, -120, -95, -70, -40, -10, 15]) {
    it(`finds a dark wand at ${a} degrees, its tip within a tenth of a palm`, () => {
      const s = scene({ angle: deg(a) });
      const f = find(s)!;
      expect(f).not.toBeNull();
      expect(tipError(s, f)).toBeLessThan(0.1);
      expect(f.quality).toBeGreaterThan(0.5);
      expect(Math.abs((Math.atan2(f.tip.y - f.base.y, f.tip.x - f.base.x) * 180) / Math.PI - a)).toBeLessThan(3);
      expect(f.search).toBe('wide');
    });
  }

  it('finds it in the other hand, on a plain wall, and lighter than a dark wall behind it', () => {
    for (const s of [
      scene({ angle: deg(-60) }, { hand: { x: 640, y: 520, palm: PALM, angle: -Math.PI / 2 + 0.2, mirror: true } }),
      scene({ angle: deg(-100) }, { background: 'light' }),
      scene({ angle: deg(-100), level: 200 }, { background: 'dark' }),
    ]) {
      const f = find(s)!;
      expect(tipError(s, f)).toBeLessThan(0.1);
      expect(f.quality).toBeGreaterThan(0.5);
    }
  });

  it('works at any distance: the palm sets the scale', () => {
    for (const palm of [36, 150]) {
      const s = renderScene({
        width: 1920, height: 1080, hand: { x: 960, y: 800, palm, angle: -Math.PI / 2 - 0.2 },
        wand: { angle: deg(-110), length: 2.6 }, background: 'room',
      });
      const f = finder.find(planeFor(s), s.landmarks, null)!;
      expect(Math.hypot(f.tip.x - s.tip!.x, f.tip.y - s.tip!.y) / palm).toBeLessThan(0.1);
    }
  });

  it('follows a shaft that does not pass through the anchor', () => {
    for (const offset of [-0.35, 0.35]) {
      const s = scene({ angle: deg(-80), offset });
      expect(tipError(s, find(s)!)).toBeLessThan(0.1);
    }
  });

  it('searches around the prior when it has one, and everywhere when the prior is wrong', () => {
    const s = scene({ angle: deg(-75) });
    const g = gripFrame(s.landmarks, 2, 1, 1);
    const right = find(s, toGrip(g, s.tip!.x, s.tip!.y))!;
    expect(right.search).toBe('prior');
    expect(tipError(s, right)).toBeLessThan(0.1);
    // A prior pointing the other way (down and to the side): the wide search still finds the wand.
    const wrong = find(s, toGrip(g, g.ax + 2 * PALM, g.ay + 1.5 * PALM))!;
    expect(wrong.search).toBe('wide');
    expect(tipError(s, wrong)).toBeLessThan(0.1);
  });

  it('sees through a moderate smear, and is never sure of a heavy one', () => {
    const moderate = scene({ angle: deg(-90), blur: 0.15 });
    const f = find(moderate)!;
    expect(tipError(moderate, f)).toBeLessThan(0.15);
    for (const a of [-140, -110, -80, -50]) {
      const heavy = scene({ angle: deg(a), blur: 0.35 });
      const h = find(heavy);
      expect(h === null || h.quality < 0.3).toBe(true);
    }
  });

  it('finds nothing to be sure of without a wand', () => {
    for (const background of ['light', 'dark', 'room'] as const) {
      for (const angle of [-1.9, -1.4]) {
        const s = scene(null, { background, hand: { x: 600, y: 500, palm: PALM, angle } });
        const f = find(s);
        expect(f === null || f.quality < 0.3).toBe(true);
      }
    }
  });

  it('is unsure of a stub (a wand pointed at the camera) but places it right', () => {
    const s = scene({ angle: deg(-100), length: 1.2 });
    const f = find(s);
    if (f) {
      expect(f.quality).toBeLessThan(0.5);
      expect(tipError(s, f)).toBeLessThan(0.1);
    }
  });

  it('reports a lit tip', () => {
    const s = scene({ angle: deg(-100), glint: 250 });
    const f = find(s)!;
    expect(f.glint).not.toBeNull();
    expect(Math.hypot(f.glint!.x - s.tip!.x, f.glint!.y - s.tip!.y) / PALM).toBeLessThan(0.05);
    // No glint on an unlit tip.
    expect(find(scene({ angle: deg(-100) }))!.glint).toBeNull();
  });

  it('gives an unlit light wand on a darker wall no glint, and a lit tip on a light wand one', () => {
    for (const a of [-140, -100, -60]) {
      const unlit = scene({ angle: deg(a), level: 200 }, { background: 'dark' });
      const f = find(unlit)!;
      expect(f.glint).toBeNull();
      expect(tipError(unlit, f)).toBeLessThan(0.1);
    }
    const lit = scene({ angle: deg(-100), level: 200, glint: 252 }, { background: 'dark' });
    const g = find(lit)!;
    expect(g.glint).not.toBeNull();
    expect(Math.hypot(g.glint!.x - lit.tip!.x, g.glint!.y - lit.tip!.y) / PALM).toBeLessThan(0.05);
    // A lit tip on a near-white wand, in a clean picture: the margin over the shaft follows the noise.
    let white = 0;
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const w = scene({ angle: deg(-100), level: 230, glint: 255 }, { background: 'dark', noise: 2.5, seed });
      if (find(w)?.glint) white++;
    }
    expect(white).toBeGreaterThanOrEqual(5);
    // And no glint on an unlit light wand in a noisy one.
    for (const seed of [1, 2, 3]) {
      expect(find(scene({ angle: deg(-100), level: 210 }, { background: 'dark', noise: 5, seed }))?.glint ?? null).toBeNull();
    }
  });

  it('follows a shaft to within a few pixels of the frame edge', () => {
    // The hand rises until the tip is 10 px under the top edge: the shaft is found nearly to its end.
    const s = scene({ angle: deg(-90), length: 2.6 }, { hand: { x: 640, y: 272, palm: PALM, angle: -Math.PI / 2 } });
    expect(s.tip!.y).toBeGreaterThan(4);
    expect(s.tip!.y).toBeLessThan(16);
    const f = find(s)!;
    expect(tipError(s, f)).toBeLessThan(0.08);
  });

  it('finds the wand while the hand is at the frame edge, the shaft running into the frame', () => {
    for (const fromEdge of [16, 8]) {
      // The anchor this many pixels above the bottom edge, the wand pointing up into the frame.
      const probe = scene({ angle: deg(-100) }, { hand: { x: 640, y: 720, palm: PALM, angle: -Math.PI / 2 - 0.2 } });
      const anchorY = gripFrame(probe.landmarks, 2, 1, 1).ay;
      const s = scene({ angle: deg(-100) }, { hand: { x: 640, y: 720 + (720 - fromEdge - anchorY), palm: PALM, angle: -Math.PI / 2 - 0.2 } });
      const f = find(s)!;
      expect(f).not.toBeNull();
      expect(tipError(s, f)).toBeLessThan(0.1);
      expect(f.cut).toBe(false);
    }
  });

  it('does not take a bar near a hand at the frame edge for the wand any more often than mid-frame', () => {
    // No wand; a dark bar 4 px wide at a shallow angle to the bottom edge, starting a palm or more from the
    // anchor along a line through it. A bar that close to the hand, at a direction a wand could take, can
    // pass for a wand whose base is hidden anywhere in the frame; at the edge it passed twice as often,
    // the start check being counted from where the unreadable band along the edge ends.
    const paint = (s: ReturnType<typeof renderScene>, x0: number, y0: number, a: number, len: number) => {
      const ux = Math.cos(a), uy = Math.sin(a);
      for (let r = 0; r <= len; r += 0.25) {
        for (let o = -2; o <= 2; o += 0.5) {
          const x = Math.round(x0 + r * ux - o * uy), y = Math.round(y0 + r * uy + o * ux);
          if (x >= 0 && y >= 0 && x < s.width && y < s.height) s.data[y * s.width + x] = 40;
        }
      }
    };
    const pose = { x: 640, y: 760, palm: PALM, angle: -Math.PI / 2 - 0.2 };
    const lift = gripFrame(renderScene({ width: 64, height: 64, hand: pose, wand: null }).landmarks, 2, 1, 1).ay - pose.y;
    const taken = (anchorY: number) => {
      let n = 0;
      for (const start of [1.0, 1.4]) {
        for (const side of [1, -1]) {
          for (const tilt of [6, 18, 30]) {
            const s = renderScene({ width: 1280, height: 720, hand: { ...pose, y: anchorY - lift }, wand: null, background: 'light' });
            const g = gripFrame(s.landmarks, 2, 1, 1);
            const a = side > 0 ? -deg(tilt) : Math.PI + deg(tilt);
            paint(s, g.ax + Math.cos(a) * start * PALM, g.ay + Math.sin(a) * start * PALM, a, 2 * PALM);
            const f = find(s);
            if (f && f.quality >= 0.35) n++;
          }
        }
      }
      return n;
    };
    expect(taken(720 - 6)).toBeLessThanOrEqual(taken(400));
  });

  it('judges video-range levels as it judges full range', () => {
    // The same faint wand as a webcam's Y plane (16 to 235) and as full range (what a canvas reads): the
    // same find, sure enough to teach the tip's place either way. Unstretched, the video range was judged
    // a fifth stricter, under the line that teaches.
    for (const [a, level] of [[-50, 150], [-80, 145]] as const) {
      const s = renderScene({
        width: 1920, height: 1080, hand: { x: 960, y: 800, palm: 110, angle: -Math.PI / 2 - 0.2 },
        wand: { angle: deg(a), length: 2.6, level }, background: 'light',
      });
      const full = planeFor(s);
      const video = { ...full, data: full.data.map((v) => Math.round(16 + (v * 219) / 255)), limited: true };
      const fa = finder.find(full, s.landmarks, null)!, fb = finder.find(video, s.landmarks, null)!;
      const raw = finder.find({ ...video, limited: false }, s.landmarks, null)!;
      expect(Math.abs(fa.quality - fb.quality)).toBeLessThan(0.02);
      expect(Math.hypot(fa.tip.x - fb.tip.x, fa.tip.y - fb.tip.y) / 110).toBeLessThan(0.01);
      expect(fb.quality).toBeGreaterThan(0.6);
      expect(raw.quality).toBeLessThan(fb.quality - 0.15);
    }
  });

  it('keeps the line it refits within a few degrees of the line the vote found', () => {
    // A hand close to a 1080p camera (the scene drawn at 4K and averaged 2 x 2): a fit over three samples of
    // a weak line turned it 59 degrees onto the wall's stripes, and the stripes were kept as the wand.
    const s4 = renderScene({
      width: 3840, height: 2160, hand: { x: 2120, y: 1540, palm: 600, angle: -Math.PI / 2 - 0.2 },
      wand: { angle: -1.9, length: 2.6 }, background: 'room',
    });
    const W1 = 1920, H1 = 1080;
    const data = new Uint8Array(W1 * H1);
    for (let y = 0; y < H1; y++) {
      for (let x = 0; x < W1; x++) {
        const i = 2 * y * 3840 + 2 * x;
        data[y * W1 + x] = Math.round((s4.data[i] + s4.data[i + 1] + s4.data[i + 3840] + s4.data[i + 3841]) / 4);
      }
    }
    const lm = s4.landmarks.map((v) => v / 2);
    const g = gripFrame(lm, 2, 1, 1);
    const r = wandRegion(g, W1, H1);
    const pd = new Uint8Array(r.width * r.height);
    for (let y = 0; y < r.height; y++) pd.set(data.subarray((r.y + y) * W1 + r.x, (r.y + y) * W1 + r.x + r.width), y * r.width);
    const f = finder.find({ data: pd, width: r.width, height: r.height, stride: r.width, x0: r.x, y0: r.y }, lm, null);
    // Whatever is found and sure lies along the wand.
    if (f && f.quality >= 0.8) expect(Math.abs(Math.atan2(f.tip.y - f.base.y, f.tip.x - f.base.x) - -1.9)).toBeLessThan(deg(5));
  });

  it('says when the shaft runs out of the frame', () => {
    const s = scene({ angle: deg(-90), length: 4.4 }, { hand: { x: 640, y: 300, palm: PALM, angle: -Math.PI / 2 - 0.2 } });
    const f = find(s)!;
    expect(f).not.toBeNull();
    expect(f.cut).toBe(true);
  });

  it('keeps to the reach and length limits in its constants', () => {
    expect(WAND.reach).toBeLessThan(WAND.roiReach);
    expect(WAND.minLength).toBeLessThan(1);
  });
});
