import { describe, expect, it } from 'vitest';
import { BOLT_TRAVEL_MS, Bolt, drawBolt, drawShield, Shield } from './shapes';
import type { Arcana } from './arcane';
import type { BoltParams, ShieldParams } from './limits';
import type { Sprites } from './sprites';
import { View } from './view';

/** A canvas that records the alpha of everything drawn: strokes, fills and images. */
function recordingContext() {
  const drawn: number[] = [];
  let alpha = 1;
  const ctx = {
    get globalAlpha() { return alpha; },
    set globalAlpha(v: number) { alpha = v; },
    globalCompositeOperation: 'source-over',
    lineCap: 'butt',
    lineJoin: 'miter',
    strokeStyle: '#000',
    lineWidth: 1,
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() { drawn.push(alpha); },
    fill() { drawn.push(alpha); },
    drawImage() { drawn.push(alpha); },
    // Transforms draw nothing.
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, drawn };
}

const sprites = { glow: () => ({}), star: () => ({}) } as unknown as Sprites;
/** Constructs that always have a layer to draw (in Node the real ones paint nothing). */
const arcana = { ring: () => ({}), sigil: () => ({}), tracery: () => ({}) } as unknown as Arcana;

function view(): View {
  const v = new View();
  v.update(1280, 720, 1, 16 / 9);
  return v;
}

const params = (over: Partial<BoltParams> = {}): BoltParams => ({ from: 'tip', to: 'target', color: '#FF4040', width: 2.5, jagged: true, red: false, ...over });

describe('bolts over the flash budget (Section 10.6)', () => {
  it('are drawn as a faint trace: everything a refused bolt draws adds up to under a tenth of full light', () => {
    for (const red of [false, true]) {
      const bolt = new Bolt('c1', params({ red }), { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.4 }, 0, false, 7);
      // Every moment of its life: travelling, arrived (where a bright bolt flares), fading.
      for (let t = 0; t < bolt.duration; t += 16) {
        const { ctx, drawn } = recordingContext();
        drawBolt(ctx, bolt, view(), sprites, t, false, arcana);
        // All of it may land on one spot: the sum is what that spot could gain in one frame.
        const total = drawn.reduce((a, b) => a + b, 0);
        expect(total).toBeLessThan(0.1);
      }
    }
  });

  it('keeps a bolt inside the budget bright: it is one of the counted flashes', () => {
    const bolt = new Bolt('c1', params(), { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.4 }, 0, true, 7);
    const { ctx, drawn } = recordingContext();
    drawBolt(ctx, bolt, view(), sprites, BOLT_TRAVEL_MS + 10, false, arcana);
    expect(Math.max(...drawn)).toBeGreaterThan(0.5);
  });

  it('gives a bolt inside the budget its rings: one at the wand and one where it lands', () => {
    const bolt = new Bolt('c1', params({ red: true }), { x: 0.2, y: 0.5 }, { x: 0.8, y: 0.4 }, 0, true, 7);
    const plain = recordingContext();
    drawBolt(plain.ctx, bolt, view(), sprites, BOLT_TRAVEL_MS + 10, false);
    const ringed = recordingContext();
    drawBolt(ringed.ctx, bolt, view(), sprites, BOLT_TRAVEL_MS + 10, false, arcana);
    expect(ringed.drawn.length).toBe(plain.drawn.length + 2);
    // A red bolt's rings are kept dimmer, like the rest of it.
    expect(Math.max(...ringed.drawn.slice(-3))).toBeLessThan(0.9);
  });
});

/** A canvas that records each image drawn: which one, how wide (in the transform drawLayer sets up)
 *  and how bright. */
function imageContext() {
  const images: { img: unknown; w: number; alpha: number }[] = [];
  let alpha = 1;
  const ctx = {
    get globalAlpha() { return alpha; },
    set globalAlpha(v: number) { alpha = v; },
    globalCompositeOperation: 'source-over', strokeStyle: '#000', lineWidth: 1,
    beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, closePath() {}, clip() {}, stroke() {}, fill() {},
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    drawImage(img: unknown, _x: number, _y: number, w: number) { images.push({ img, w, alpha }); },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, images };
}

describe('the ward (Protego)', () => {
  const DOME = { dome: true }, TRACERY = { tracery: true }, RING = { ring: true };
  const wardSprites = { dome: () => DOME, star: () => ({}) } as unknown as Sprites;
  const layers = { ring: () => RING, tracery: () => TRACERY } as unknown as Arcana;
  const ward = (over: Partial<ShieldParams> = {}): ShieldParams => ({ hold: false, duration_ms: 5000, color: '#BFE3FF', radius: 0.42, ...over });
  const center = { x: 0.5, y: 0.4 };

  it('keeps its tracery inside the rim\'s band of runes, so the arches never cut through them', () => {
    const { ctx, images } = imageContext();
    drawShield(ctx, new Shield('c1', ward(), center, 0), view(), wardSprites, 2000, false, layers);
    const tracery = images.find((i) => i.img === TRACERY)!, ring = images.find((i) => i.img === RING)!;
    // The tracery is painted with its rim at 0.985 of its half; the band's inner edge is at 0.835
    // of the ring layer's half (WARD_RING).
    expect((tracery.w / 2) * 0.985).toBeLessThan((ring.w / 2) * 0.835);
  });

  it('only fades as it goes under reduced motion: neither the dome nor its tracery and runes grow', () => {
    const s = new Shield('c1', ward(), center, 0);
    const widths = (t: number) => {
      const { ctx, images } = imageContext();
      drawShield(ctx, s, view(), wardSprites, t, true, layers);
      return images.map((i) => i.w);
    };
    const held = widths(4000);
    expect(held.length).toBeGreaterThanOrEqual(3);
    for (const t of [5100, 5260, 5400]) expect(widths(t).slice(0, held.length)).toEqual(held);
  });

  it('keeps a saturated red ward dimmer, as a red cast circle or bolt is: its dome and every layer', () => {
    const brightest = (color: string, which: unknown[]) => {
      const { ctx, images } = imageContext();
      drawShield(ctx, new Shield('c1', ward({ color }), center, 0), view(), wardSprites, 2000, false, layers);
      return Math.max(...images.filter((i) => which.includes(i.img)).map((i) => i.alpha));
    };
    expect(brightest('#FF2020', [TRACERY, RING])).toBeLessThan(0.75 * brightest('#BFE3FF', [TRACERY, RING]));
    expect(brightest('#FF2020', [DOME])).toBeLessThan(0.75 * brightest('#BFE3FF', [DOME]));
  });

  it('cast again, is renewed rather than raised again: the new ward carries on the old one\'s look', () => {
    const first = new Shield('c1', ward(), center, 0);
    expect(first.renews(ward(), center, 2000)).toBe(true);
    expect(first.renews(ward({ color: '#FFD27E' }), center, 2000)).toBe(false);
    // Only the same spell renews (another spell's ward of the same look stacks, as before).
    expect(first.renews(ward(), center, 2000, 'other-ward')).toBe(false);
    // Only a ward that lasts at least as long takes over: a timed one never takes over a held one
    // (it would leave nothing when it ends, while the held one's spell still lasts).
    const held = new Shield('h', ward({ hold: true, duration_ms: undefined }), center, 0);
    expect(held.renews(ward(), center, 2000)).toBe(false);
    expect(held.renews(ward({ hold: true, duration_ms: undefined }), center, 2000)).toBe(true);
    const second = new Shield('c2', ward(), center, 2000, first.look);
    first.replaced = true;
    expect(first.gone(2000)).toBe(true);
    // The first is drawn no more; the second is fully up at once (no second rise, no dip), and its
    // time runs from its own cast.
    const old = imageContext();
    drawShield(old.ctx, first, view(), wardSprites, 2000, false, layers);
    expect(old.images).toEqual([]);
    const { ctx, images } = imageContext();
    drawShield(ctx, second, view(), wardSprites, 2000, false, layers);
    expect(images.find((i) => i.img === DOME)?.alpha).toBeCloseTo(0.8, 6);
    expect(second.until).toBe(7000);
    // A fresh ward, by contrast, starts from nothing.
    const fresh = imageContext();
    drawShield(fresh.ctx, new Shield('c3', ward(), center, 2000), view(), wardSprites, 2000, false, layers);
    expect(fresh.images.find((i) => i.img === DOME)?.alpha ?? 0).toBeLessThan(0.05);
  });
});
