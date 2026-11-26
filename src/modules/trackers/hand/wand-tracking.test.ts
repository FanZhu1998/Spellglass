import { describe, expect, it } from 'vitest';
import type { HandWire, WandWire } from './protocol';
import { HandTipState, WAND_HINT_MS, WAND_USE, type ProcessedFrame, type TrackingSettings } from './tracking';
import { gripFrame } from './wand';
import { sceneLandmarks } from './wand-scene';

// Wand mode's tip from frame to frame (tracking.ts WandTip), with the worker's finds made up directly, so
// these tests do not depend on the finder (wand.test.ts covers that).

const W = 1920, H = 1080, ASPECT = W / H;
const WAND: TrackingSettings = { mode: 'wand', reach: 0.9, flipX: true };
const FINGER: TrackingSettings = { mode: 'finger', reach: 0.9, flipX: true };
const PALM = 110;
const t = (i: number) => 1000 + i * (1000 / 30);

/** A fist on the 1080p test frame, from the wand scene (frame-normalized landmarks). */
function fist(o: { x?: number; y?: number; angle?: number } = {}): HandWire {
  const lm = sceneLandmarks({ x: o.x ?? 960, y: o.y ?? 800, palm: PALM, angle: o.angle ?? -Math.PI / 2 - 0.2 });
  const points: number[] = [];
  for (let i = 0; i < 21; i++) points.push(lm[i * 2] / W, lm[i * 2 + 1] / H, 0);
  return { points, score: 0.95, label: 'Left' };
}

/** A find with its tip `along` palm lengths from the hand's anchor in direction `dir` (radians, frame px). */
function find(h: HandWire, dir: number, along = 2.6, quality = 0.9, glint?: [number, number]): WandWire {
  const g = gripFrame(h.points, 3, W, H);
  const tip = { x: g.ax + Math.cos(dir) * along * g.palm, y: g.ay + Math.sin(dir) * along * g.palm };
  const base = { x: g.ax + Math.cos(dir) * 0.6 * g.palm, y: g.ay + Math.sin(dir) * 0.6 * g.palm };
  return {
    tip: [tip.x / W, tip.y / H], base: [base.x / W, base.y / H], quality, contrast: 80, length: along - 0.6, cut: false, search: 'wide',
    ...(glint ? { glint } : {}),
  };
}

let frameNo = 0;
function wframe(i: number, hand: HandWire | null, wand: WandWire | null = null): ProcessedFrame {
  return { t: t(i), frame: frameNo++, width: W, height: H, hand, stepMs: 8, wand };
}
const caster = (w: WandWire) => ({ x: 1 - w.tip[0], y: w.tip[1] });
/** Distance in frame widths. */
const apart = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, (a.y - b.y) / ASPECT);

describe('wand mode: the tip from frame to frame', () => {
  it('guesses past the knuckles until the wand is seen, then follows the shaft', () => {
    const s = new HandTipState('tracker.hand');
    const h = fist();
    const a = s.frame(wframe(0, h), WAND, t(0));
    expect(a.wand?.source).toBe('grip');
    // The guess is grip mode's projection.
    const g = new HandTipState('tracker.hand').frame(wframe(0, h), { ...WAND, mode: 'grip' }, t(0));
    expect(apart(a.sample!, g.sample!)).toBeLessThan(1e-4);
    expect(s.wandPrior()).toBeNull();
    expect(s.wandStatus(t(0))).toEqual({ seen: 0, learned: false });

    const w = find(h, -2.0);
    let out = s.frame(wframe(1, h, w), WAND, t(1));
    expect(out.wand?.source).toBe('shaft');
    // The step from the guess to the shaft fades out over WAND_SETTLE_MS.
    for (let i = 2; i < 14; i++) out = s.frame(wframe(i, h, w), WAND, t(i));
    expect(apart(out.sample!, caster(w))).toBeLessThan(1e-3);
    expect(out.wand?.base).toBeDefined();
    expect(s.wandPrior()).not.toBeNull();
    expect(s.wandStatus(t(13))).toEqual({ seen: 0.929, learned: true });
    // As sure as the hand, scaled by the find's quality.
    expect(out.sample!.conf).toBeCloseTo(0.95 * (0.7 + 0.3 * 0.9), 2);
  });

  it('carries the learned tip on the hand through frames without the shaft: a turn of the wrist sweeps it', () => {
    const s = new HandTipState('tracker.hand');
    const h0 = fist();
    for (let i = 0; i < 10; i++) s.frame(wframe(i, h0, find(h0, -2.0)), WAND, t(i));
    // The hand turns 25 degrees and the shaft is lost (a smeared stroke).
    const turn = 0.44;
    const h1 = fist({ angle: -Math.PI / 2 - 0.2 + turn });
    let out = s.frame(wframe(10, h1), WAND, t(10));
    expect(out.wand?.source).toBe('carried');
    for (let i = 11; i < 25; i++) out = s.frame(wframe(i, h1), WAND, t(i));
    // Where the tip is with the wand turned as the hand did.
    expect(apart(out.sample!, caster(find(h1, -2.0 + turn)))).toBeLessThan(0.01);
    expect(out.sample!.conf).toBeCloseTo(0.95 * 0.75, 2);
    // The worker is told where to look.
    expect(s.wandPrior()).not.toBeNull();
  });

  it('starts the carried tip where the shaft was last seen, and goes straight to the shaft when it is seen again', () => {
    const s = new HandTipState('tracker.hand');
    const h = fist();
    for (let i = 0; i < 12; i++) s.frame(wframe(i, h, find(h, -2.0)), WAND, t(i));
    // The last sight of the shaft has its end further on than the learned place (an average that lags).
    const longer = find(h, -2.0, 2.85);
    const seen = s.frame(wframe(12, h, longer), WAND, t(12)).sample!;
    expect(apart(seen, caster(longer))).toBeLessThan(1e-3);
    // Lost: carried, starting where it was seen, then settling on the learned place.
    const first = s.frame(wframe(13, h), WAND, t(13)).sample!;
    expect(apart(first, seen)).toBeLessThan(0.006);
    let carried = first;
    for (let i = 14; i < 30; i++) carried = s.frame(wframe(i, h), WAND, t(i)).sample!;
    expect(apart(carried, seen)).toBeGreaterThan(0.008);
    // Seen again: straight to the shaft, whatever the carried tip said.
    const back = s.frame(wframe(30, h, longer), WAND, t(30)).sample!;
    expect(apart(back, caster(longer))).toBeLessThan(1e-3);
  });

  it('takes a sight of the wand at once, after the glint or a long step, and fades only a short step', () => {
    const s = new HandTipState('tracker.hand');
    const h = fist();
    const plain = find(h, -2.0);
    const g = gripFrame(h.points, 3, W, H);
    const lit: [number, number] = [plain.tip[0] + (0.1 * g.palm) / W, plain.tip[1]];
    for (let i = 0; i < 12; i++) s.frame(wframe(i, h, { ...plain, glint: lit }), WAND, t(i));
    // From the glint to the shaft's end: straight there.
    const shaft = s.frame(wframe(12, h, plain), WAND, t(12)).sample!;
    expect(apart(shaft, caster(plain))).toBeLessThan(1e-3);
    // The last sight a long way from the learned place (the hand's frame jumped as it came into view): the
    // carried tip does not start there.
    const far = find(h, -2.0, 4.0, 0.95);
    s.frame(wframe(13, h, far), WAND, t(13));
    const carried = s.frame(wframe(14, h), WAND, t(14)).sample!;
    const settled = new HandTipState('tracker.hand');
    for (let i = 0; i < 13; i++) settled.frame(wframe(i, h, { ...plain, glint: lit }), WAND, t(i));
    const ref = settled.frame(wframe(14, h), WAND, t(14)).sample!;
    expect(apart(carried, ref)).toBeLessThan(0.01);
    expect(apart(carried, caster(far))).toBeGreaterThan(0.02);
  });

  it('fades nothing across a gap of frames', () => {
    const s = new HandTipState('tracker.hand');
    const h = fist();
    for (let i = 0; i < 12; i++) s.frame(wframe(i, h, find(h, -2.0)), WAND, t(i));
    s.frame(wframe(12, h, find(h, -2.0, 3.0)), WAND, t(12));
    // The hand is not seen for 200 ms, then is, without the shaft: the learned place, no step kept.
    const carried = s.frame(wframe(18, h), WAND, t(18)).sample!;
    const settled = new HandTipState('tracker.hand');
    for (let i = 0; i < 12; i++) settled.frame(wframe(i, h, find(h, -2.0)), WAND, t(i));
    let ref = settled.frame(wframe(12, h), WAND, t(12)).sample!;
    for (let i = 13; i < 40; i++) ref = settled.frame(wframe(i, h), WAND, t(i)).sample!;
    expect(apart(carried, ref)).toBeLessThan(0.01);
  });

  it('takes a glint at the end of the shaft for the tip, and ignores one elsewhere', () => {
    const s = new HandTipState('tracker.hand');
    const h = fist();
    const plain = find(h, -2.0);
    const g = gripFrame(h.points, 3, W, H);
    const lit: [number, number] = [plain.tip[0] + (0.08 * g.palm) / W, plain.tip[1]];
    let out = s.frame(wframe(0, h, { ...plain, glint: lit }), WAND, t(0));
    for (let i = 1; i < 12; i++) out = s.frame(wframe(i, h, { ...plain, glint: lit }), WAND, t(i));
    expect(out.wand?.source).toBe('glint');
    expect(apart(out.sample!, { x: 1 - lit[0], y: lit[1] })).toBeLessThan(2e-3);
    const far: [number, number] = [plain.tip[0] + (0.6 * g.palm) / W, plain.tip[1]];
    expect(s.frame(wframe(12, h, { ...plain, glint: far }), WAND, t(12)).wand?.source).toBe('shaft');
  });

  it('doubts a fair find far from the learned place, until a few in a row agree (a new grip)', () => {
    const s = new HandTipState('tracker.hand');
    const h = fist();
    for (let i = 0; i < 12; i++) s.frame(wframe(i, h, find(h, -2.0)), WAND, t(i));
    // A stick lined up with the grip, another way, seen fairly: carried over.
    const stray = find(h, -0.9, 2.6, 0.6);
    expect(s.frame(wframe(12, h, stray), WAND, t(12)).wand?.source).toBe('carried');
    expect(s.frame(wframe(13, h, find(h, -2.0)), WAND, t(13)).wand?.source).toBe('shaft');
    // The same far place three times running: the player holds the wand differently now.
    const sources = [14, 15, 16, 17].map((i) => s.frame(wframe(i, h, stray), WAND, t(i)).wand?.source);
    expect(sources).toEqual(['carried', 'carried', 'shaft', 'shaft']);
  });

  it('takes a sure find far from the learned place (a blurred hand placed badly), but learns nothing from it', () => {
    const s = new HandTipState('tracker.hand');
    const h = fist();
    for (let i = 0; i < 12; i++) s.frame(wframe(i, h, find(h, -2.0)), WAND, t(i));
    const prior = s.wandPrior()!;
    const sure = find(h, -1.2, 2.6, 0.95);
    const out = s.frame(wframe(12, h, sure), WAND, t(12));
    expect(out.wand?.source).toBe('shaft');
    expect(apart(out.sample!, caster(sure))).toBeLessThan(1e-3);
    // Neither does a find on a hand the model is unsure of teach the place.
    s.frame(wframe(13, { ...h, score: 0.8 }, find(h, -1.9)), WAND, t(13));
    expect(s.wandPrior()).toEqual(prior);
  });

  it('takes a find cut off by the frame as reaching the learned length, and learns nothing from it', () => {
    const s = new HandTipState('tracker.hand');
    const h = fist();
    for (let i = 0; i < 12; i++) s.frame(wframe(i, h, find(h, -2.0)), WAND, t(i));
    const prior = s.wandPrior()!;
    // The shaft runs out of the frame: the find ends 0.6 palm short of the tip.
    const short = { ...find(h, -2.0, 2.0), cut: true };
    let out = s.frame(wframe(12, h, short), WAND, t(12));
    for (let i = 13; i < 18; i++) out = s.frame(wframe(i, h, short), WAND, t(i));
    expect(apart(out.sample!, caster(find(h, -2.0)))).toBeLessThan(0.004);
    expect(s.wandPrior()).toEqual(prior);
    // A cut find past the learned length is taken as it is (the wand is at least that long).
    const long = { ...find(h, -2.0, 3.0), cut: true };
    expect(apart(s.frame(wframe(18, h, long), WAND, t(18)).sample!, caster(long))).toBeLessThan(1e-3);
    expect(s.wandPrior()).toEqual(prior);
  });

  it('carries where the wand was last seen while its place is not learned yet, not the guess past the knuckles', () => {
    // Fair finds (used, not taught), every fifth frame lost to a smear.
    const s = new HandTipState('tracker.hand');
    const h = fist();
    const fair = find(h, -2.0, 2.6, 0.45);
    let prev = s.frame(wframe(0, h, fair), WAND, t(0)).sample!;
    for (let i = 1; i < 30; i++) {
      const out = s.frame(wframe(i, h, i % 5 === 0 ? null : fair), WAND, t(i));
      expect(out.wand?.source).toBe(i % 5 === 0 ? 'carried' : 'shaft');
      expect(apart(out.sample!, prev)).toBeLessThan(0.002);
      prev = out.sample!;
    }
    expect(s.wandPrior()).toBeNull();
    expect(s.wandStatus(t(29))!.learned).toBe(false);
    expect(s.wandStatus(t(29))!.seen).toBeCloseTo(0.8, 1);
    // A new hold starts from the guess again.
    for (let i = 30; i < 45; i++) s.frame(wframe(i, null), WAND, t(i));
    expect(s.frame(wframe(45, h), WAND, t(45)).wand?.source).toBe('grip');
  });

  it('follows a new grip on a hand the model is unsure of, teaching nothing, and does not say the wand is not seen', () => {
    const s = new HandTipState('tracker.hand');
    const h = fist();
    for (let i = 0; i < 12; i++) s.frame(wframe(i, h, find(h, -2.0)), WAND, t(i));
    const prior = s.wandPrior();
    // The wand is held 0.7 rad round now, found fairly every frame, on a hand scored 0.85.
    const unsure = { ...h, score: 0.85 };
    const turned = find(h, -1.3, 2.6, 0.7);
    const sources: (string | undefined)[] = [];
    let i = 12;
    for (; t(i) < t(12) + WAND_HINT_MS + 500; i++) sources.push(s.frame(wframe(i, unsure, turned), WAND, t(i)).wand?.source);
    expect(sources.slice(0, 2)).toEqual(['carried', 'carried']);
    expect(sources.slice(2).every((x) => x === 'shaft')).toBe(true);
    expect(s.hint(t(i - 1))).toBeNull();
    expect(s.wandPrior()).toEqual(prior);
    // A steady hand then teaches the new grip.
    s.frame(wframe(i, h, turned), WAND, t(i));
    expect(s.wandPrior()).not.toEqual(prior);
  });

  it('carries over a cut-off find far from the learned place, and counts it towards no new grip', () => {
    // A room's shelf runs off the frame beside the hand: a long cut bar in another direction.
    const s = new HandTipState('tracker.hand');
    const h = fist();
    for (let i = 0; i < 12; i++) s.frame(wframe(i, h, find(h, -2.0)), WAND, t(i));
    const shelf = { ...find(h, -0.7, 2.6, 0.7), cut: true };
    for (let i = 12; i < 20; i++) expect(s.frame(wframe(i, h, shelf), WAND, t(i)).wand?.source).toBe('carried');
    // The same bar uncut would have become a new grip by now.
    expect(s.frame(wframe(20, h, find(h, -2.0)), WAND, t(20)).wand?.source).toBe('shaft');
  });

  it('carries the last sighting through a missed frame after following a new grip on an unsure hand', () => {
    const s = new HandTipState('tracker.hand');
    const h = fist();
    for (let i = 0; i < 12; i++) s.frame(wframe(i, h, find(h, -2.0)), WAND, t(i));
    const unsure = { ...h, score: 0.85 };
    const turned = find(h, -1.3, 2.6, 0.7);
    let i = 12;
    for (; i < 18; i++) s.frame(wframe(i, unsure, turned), WAND, t(i));
    const seen = s.frame(wframe(i++, unsure, turned), WAND, t(i - 1)).sample!;
    expect(apart(seen, caster(turned))).toBeLessThan(1e-3);
    // A smeared frame: the tip stays with the new grip, not the old place.
    const missed = s.frame(wframe(i++, unsure, null), WAND, t(i - 1)).sample!;
    expect(apart(missed, seen)).toBeLessThan(0.003);
    // One noisy find a little off does not undo the new grip.
    const noisy = find(h, -1.3 + 0.12, 2.6, 0.7);
    expect(s.frame(wframe(i++, unsure, noisy), WAND, t(i - 1)).wand?.source).toBe('shaft');
    expect(s.frame(wframe(i++, unsure, turned), WAND, t(i - 1)).wand?.source).toBe('shaft');
  });

  it('starts out of wand mode after a restart', () => {
    const s = new HandTipState('tracker.hand');
    const h = fist();
    for (let i = 0; i < 6; i++) s.frame(wframe(i, h, find(h, -2.0)), WAND, t(i));
    expect(s.wandStatus(t(5))).not.toBeNull();
    s.reset();
    expect(s.wandStatus(t(6))).toBeNull();
  });

  it('ignores weak finds', () => {
    const s = new HandTipState('tracker.hand');
    const h = fist();
    for (let i = 0; i < 10; i++) s.frame(wframe(i, h, find(h, -2.0)), WAND, t(i));
    expect(s.frame(wframe(10, h, find(h, -2.0, 2.6, WAND_USE - 0.05)), WAND, t(10)).wand?.source).toBe('carried');
  });

  it("says 'wand-not-seen' while the hand is held without a wand for WAND_HINT_MS, and clears when it is seen", () => {
    const s = new HandTipState('tracker.hand');
    const h = fist();
    let i = 0;
    for (; t(i) < t(0) + WAND_HINT_MS - 100; i++) s.frame(wframe(i, h), WAND, t(i));
    expect(s.hint(t(i - 1))).toBeNull();
    for (; t(i) < t(0) + WAND_HINT_MS + 100; i++) s.frame(wframe(i, h), WAND, t(i));
    expect(s.hint(t(i - 1))).toBe('wand-not-seen');
    expect(s.wandStatus(t(i - 1))!.seen).toBe(0);
    s.frame(wframe(i, h, find(h, -2.0)), WAND, t(i));
    expect(s.hint(t(i))).toBeNull();
    // Never in the other modes.
    const f = new HandTipState('tracker.hand');
    for (let j = 0; j < 120; j++) f.frame(wframe(j, h), FINGER, t(j));
    expect(f.hint(t(119))).toBeNull();
    expect(f.wandStatus(t(119))).toBeNull();
  });

  it('forgets the wand with a new camera or a change of mode, and keeps it through a short loss', () => {
    const s = new HandTipState('tracker.hand');
    const h = fist();
    for (let i = 0; i < 10; i++) s.frame(wframe(i, h, find(h, -2.0)), WAND, t(i));
    // The hand leaves and comes back: the wand is still where it was in the hand.
    for (let i = 10; i < 25; i++) s.frame(wframe(i, null), WAND, t(i));
    expect(s.holding).toBe(false);
    const back = s.frame(wframe(25, h), WAND, t(25));
    expect(back.wand?.source).toBe('carried');
    s.loseNow(t(26));
    s.rebase();
    expect(s.wandPrior()).toBeNull();
    for (let i = 27; i < 35; i++) s.frame(wframe(i, h, find(h, -2.0)), WAND, t(i));
    expect(s.wandPrior()).not.toBeNull();
    s.frame(wframe(35, h), FINGER, t(35));
    expect(s.frame(wframe(36, h), WAND, t(36)).wand?.source).toBe('grip');
    expect(s.wandPrior()).toBeNull();
  });
});
