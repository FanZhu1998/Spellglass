import { describe, expect, it } from 'vitest';
import { LANDMARK, LANDMARK_COUNT } from './geometry';
import type { HandWire } from './protocol';
import {
  COLLAPSE_MAX_MS, HandTipState, HINT_AFTER_MS, LOST_AFTER_MS, SEGMENTATION, SMALL_HAND, SMALL_HAND_CLEAR,
  type ProcessedFrame, type TrackingSettings,
} from './tracking';

const FINGER: TrackingSettings = { mode: 'finger', reach: 0.9, flipX: true };
const W = 1920, H = 1080, ASPECT = W / H;

function wire(indexTip: [number, number], score = 0.95): HandWire {
  const pts: number[] = [];
  for (let i = 0; i < LANDMARK_COUNT; i++) pts.push(0.5, 0.8, 0);
  pts[LANDMARK.MIDDLE_MCP * 3] = 0.5;
  pts[LANDMARK.MIDDLE_MCP * 3 + 1] = 0.6;
  for (const k of [LANDMARK.INDEX_MCP, LANDMARK.RING_MCP, LANDMARK.PINKY_MCP]) pts[k * 3 + 1] = 0.6;
  pts[LANDMARK.INDEX_TIP * 3] = indexTip[0];
  pts[LANDMARK.INDEX_TIP * 3 + 1] = indexTip[1];
  return { points: pts, score, label: 'Left' };
}

/** An upright hand on the 16:9 test frame (frame-normalized, unmirrored): the wrist at `at`, the middle
 *  knuckle `size` frame widths above it (TipSample.size), the index knuckle just left of that, and the
 *  index fingertip `finger` frame widths above the index knuckle. A short finger is a collapsed or
 *  curled one. */
function hand(opts: { at?: [number, number]; size?: number; finger?: number } = {}): HandWire {
  const [x, y] = opts.at ?? [0.5, 0.8];
  const size = opts.size ?? 0.1;
  const finger = opts.finger ?? 0.08;
  const knuckleY = y - size * ASPECT;
  const pts: number[] = [];
  for (let i = 0; i < LANDMARK_COUNT; i++) pts.push(x, y, 0);
  const set = (i: number, px: number, py: number) => {
    pts[i * 3] = px;
    pts[i * 3 + 1] = py;
  };
  set(LANDMARK.INDEX_MCP, x - 0.02, knuckleY);
  set(LANDMARK.MIDDLE_MCP, x, knuckleY);
  set(LANDMARK.RING_MCP, x + 0.02, knuckleY);
  set(LANDMARK.PINKY_MCP, x + 0.04, knuckleY);
  set(LANDMARK.INDEX_TIP, x - 0.02, knuckleY - finger * ASPECT);
  return { points: pts, score: 0.95, label: 'Left' };
}

/** Landmark 8 of a hand, in caster space as FINGER publishes it. */
const tipOf = (h: HandWire) => ({ x: 1 - h.points[LANDMARK.INDEX_TIP * 3], y: h.points[LANDMARK.INDEX_TIP * 3 + 1] });

let frameNo = 0;
function frame(t: number, hand: HandWire | null, stepMs = 8): ProcessedFrame {
  return { t, frame: frameNo++, width: W, height: H, hand, stepMs };
}

describe('HandTipState', () => {
  it('finds the tip with the first hand, then samples, in caster space', () => {
    const s = new HandTipState('tracker.hand');
    const a = s.frame(frame(1000, wire([0.3, 0.4])), FINGER, 1010);
    expect(a.found).toBeDefined();
    expect(a.found).toEqual(a.sample);
    expect(a.sample).toMatchObject({ t: 1000, x: 0.7, y: 0.4, conf: 0.95, src: 'tracker.hand' });
    // Wrist to middle knuckle: 0.2 of the height on a 16:9 frame.
    expect(a.sample!.size).toBeCloseTo(0.2 / (16 / 9), 4);
    expect(a.landmarks).toHaveLength(21);
    const b = s.frame(frame(1033, wire([0.31, 0.4])), FINGER, 1043);
    expect(b.found).toBeUndefined();
    expect(b.sample).toMatchObject({ t: 1033, x: 0.69 });
    expect(s.holding).toBe(true);
  });

  it('declares the tip lost at the first frame without a hand LOST_AFTER_MS after the last sample, at 15, 30 and 60 fps', () => {
    // A time, not a count of frames: 6 missed frames at 15 fps, 12 at 30 and 24 at 60.
    for (const [fps, missed] of [[15, 6], [30, 12], [60, 24]] as const) {
      const s = new HandTipState('tracker.hand');
      const dt = 1000 / fps;
      s.frame(frame(1000, wire([0.3, 0.4])), FINGER, 1000);
      let lostAt: number | null = null;
      let i = 1;
      for (; lostAt === null && i < 100; i++) {
        const t = 1000 + i * dt;
        const out = s.frame(frame(t, null), FINGER, t);
        if (t - 1000 < LOST_AFTER_MS) {
          expect(out.lost, `${fps} fps, ${(t - 1000).toFixed(0)} ms`).toBeUndefined();
          expect(s.holding).toBe(true);
        } else {
          expect(out.lost, `${fps} fps`).toEqual({ t, lastSeen: 1000 });
          lostAt = t;
        }
      }
      expect(i - 1, `${fps} fps`).toBe(missed);
      expect(lostAt! - 1000).toBeLessThan(LOST_AFTER_MS + dt);
      expect(s.holding).toBe(false);
      // Found again: a new tip.found.
      expect(s.frame(frame(lostAt! + 100, wire([0.3, 0.4])), FINGER, lostAt! + 100).found).toBeDefined();
    }
  });

  it('keeps the tip when the hand comes back inside the window, and times the next gap from there', () => {
    const s = new HandTipState('tracker.hand');
    s.frame(frame(1000, wire([0.3, 0.4])), FINGER, 1000);
    // Ten frames without a hand at 30 fps, then the hand again, 383 ms after it was last seen.
    for (let t = 1033; t <= 1350; t += 33) expect(s.frame(frame(t, null), FINGER, t).lost).toBeUndefined();
    const back = s.frame(frame(1383, wire([0.32, 0.4])), FINGER, 1383);
    expect(back.found).toBeUndefined();
    expect(back.sample).toMatchObject({ t: 1383 });
    // The next gap counts from 1383, not from 1000.
    expect(s.frame(frame(1700, null), FINGER, 1700).lost).toBeUndefined();
    expect(s.frame(frame(1783, null), FINGER, 1783).lost).toEqual({ t: 1783, lastSeen: 1383 });
  });

  it('forgives a single missed frame', () => {
    const s = new HandTipState('tracker.hand');
    s.frame(frame(1000, wire([0.3, 0.4])), FINGER, 1000);
    s.frame(frame(1033, null), FINGER, 1033);
    const out = s.frame(frame(1066, wire([0.3, 0.4])), FINGER, 1066);
    expect(out.found).toBeUndefined();
    expect(out.sample).toBeDefined();
    expect(s.frame(frame(1099, null), FINGER, 1099).lost).toBeUndefined();
  });

  it('asks the segmenter to bridge the gaps it bridges itself', () => {
    expect(SEGMENTATION).toEqual({ lostMs: 500, minSamples: 5, pauseMs: 300 });
    // The tracker's own tip.lost, at the frame that declares it, comes before the segmenter's gap rule
    // at 10 fps and faster.
    expect(SEGMENTATION.lostMs!).toBeGreaterThanOrEqual(LOST_AFTER_MS + 100);
    expect(Object.isFrozen(SEGMENTATION)).toBe(true);
  });

  it('uses the grip projection and the flip setting', () => {
    const s = new HandTipState('tracker.hand');
    const out = s.frame(frame(1000, wire([0.3, 0.4])), { mode: 'grip', reach: 0.9, flipX: false }, 1000);
    // Upright hand centred at x 0.5: the projected tip is above the knuckles, unflipped.
    expect(out.sample!.x).toBeCloseTo(0.5, 5);
    expect(out.sample!.y).toBeLessThan(0.6);
  });

  it('reports lock, fps and the median step over the last second', () => {
    const s = new HandTipState('tracker.hand');
    for (let i = 0; i < 20; i++) s.frame(frame(1000 + i * 33, i % 2 ? null : wire([0.3, 0.4], i < 10 ? 0.9 : 0.4), 5 + (i % 3)), FINGER, 1000 + i * 33);
    const k = 1000 + 19 * 33;
    expect(s.fps(k)).toBe(20);
    // Hands in 10 of 20 frames, 5 of them confident.
    expect(s.lock(k)).toBe(0.25);
    expect(s.stepMs(k)).toBe(6);
    expect(s.fps(k + 2000)).toBe(0);
    expect(s.stepMs(k + 2000)).toBeUndefined();
  });

  it('gives the hand-not-found hint after 3 s of frames without a confident hand', () => {
    const s = new HandTipState('tracker.hand');
    expect(s.hint(0)).toBeNull();
    let t = 1000;
    for (; t < 1000 + HINT_AFTER_MS - 100; t += 100) s.frame(frame(t, null), FINGER, t);
    expect(s.hint(t)).toBeNull();
    for (; t <= 1000 + HINT_AFTER_MS; t += 100) s.frame(frame(t, null), FINGER, t);
    expect(s.hint(t - 100)).toBe('hand-not-found');
    // Cleared when the tip is found.
    s.frame(frame(t, wire([0.3, 0.4])), FINGER, t);
    expect(s.hint(t)).toBeNull();
    // A hand held at low confidence keeps the tip found: no hint while holding.
    for (let i = 1; i < 40; i++) s.frame(frame(t + i * 100, wire([0.3, 0.4], 0.3)), FINGER, t + i * 100);
    expect(s.hint(t + 3900)).toBeNull();
    // No hint once frames stop arriving (camera off): the camera status says why.
    const quiet = new HandTipState('tracker.hand');
    quiet.frame(frame(1000, null), FINGER, 1000);
    expect(quiet.hint(1000 + HINT_AFTER_MS + 10)).toBeNull();
  });

  it('lets go now, never before the last sample', () => {
    const s = new HandTipState('tracker.hand');
    expect(s.loseNow(5)).toBeNull();
    s.frame(frame(1000, wire([0.3, 0.4])), FINGER, 1000);
    expect(s.loseNow(990)).toEqual({ t: 1000, lastSeen: 1000 });
    expect(s.holding).toBe(false);
  });

  it('ignores a malformed hand', () => {
    const s = new HandTipState('tracker.hand');
    const out = s.frame(frame(1000, { points: [0.1, 0.2], score: 0.9, label: 'Left' }), FINGER, 1000);
    expect(out.sample).toBeUndefined();
  });
});

describe('HandTipState: the collapsed finger (finger mode)', () => {
  /** A hand moving right at 0.3 frame widths a second, 30 fps, from t = 1000. */
  const at = (i: number): [number, number] => [0.3 + i * 0.01, 0.8];
  const t = (i: number) => 1000 + i * (1000 / 30);

  it('carries the finger on the palm through a brief collapse, then follows landmark 8 again', () => {
    const s = new HandTipState('tracker.hand');
    for (let i = 0; i < 10; i++) {
      const h = hand({ at: at(i) });
      expect(s.frame(frame(t(i), h), FINGER, t(i)).sample).toMatchObject(round5(tipOf(h)));
    }
    // Two blurred frames: landmark 8 drops onto the fist (the finger a tenth of its length).
    for (const i of [10, 11]) {
      const blurred = hand({ at: at(i), finger: 0.008 });
      const out = s.frame(frame(t(i), blurred), FINGER, t(i));
      // Where the finger would be: knuckle 5 now, plus the finger as it last was.
      expect(out.sample!.x).toBeCloseTo(tipOf(hand({ at: at(i) })).x, 4);
      expect(out.sample!.y).toBeCloseTo(tipOf(hand({ at: at(i) })).y, 4);
      expect(out.sample!.y).toBeLessThan(tipOf(blurred).y - 0.1);
      // The debug view still shows the landmarks as the model gave them.
      expect(out.landmarks![LANDMARK.INDEX_TIP][1]).toBeCloseTo(tipOf(blurred).y, 3);
    }
    const sharp = hand({ at: at(12) });
    expect(s.frame(frame(t(12), sharp), FINGER, t(12)).sample).toMatchObject(round5(tipOf(sharp)));
  });

  it('never replaces the tip of a finger that is not collapsed: one that bends, turns or curls slowly', () => {
    const s = new HandTipState('tracker.hand');
    // The finger's length goes up and down by a quarter (pointing toward the camera and back), then the
    // finger curls slowly to a third of its length over 1.5 s, while the hand moves.
    for (let i = 0; i < 120; i++) {
      const finger = i < 60 ? 0.08 * (1 + 0.25 * Math.sin(i / 4)) : 0.08 * Math.max(1 / 3, 1 - ((i - 60) / 45) * (2 / 3));
      const h = hand({ at: [0.3 + 0.004 * i, 0.8 - 0.002 * i], finger });
      expect(s.frame(frame(t(i), h), FINGER, t(i)).sample, `frame ${i}`).toMatchObject(round5(tipOf(h)));
    }
  });

  it('takes a finger that stays short for longer than COLLAPSE_MAX_MS as curled, and follows it', () => {
    const s = new HandTipState('tracker.hand');
    for (let i = 0; i < 15; i++) s.frame(frame(t(i), hand({ at: [0.5, 0.8] })), FINGER, t(i));
    const long = tipOf(hand({ at: [0.5, 0.8] }));
    const fist = hand({ at: [0.5, 0.8], finger: 0.015 });
    const shortFrom = t(15);
    for (let i = 15; i < 60; i++) {
      const out = s.frame(frame(t(i), fist), FINGER, t(i));
      if (t(i) - shortFrom <= COLLAPSE_MAX_MS) expect(out.sample!.y, `frame ${i}`).toBeCloseTo(long.y, 4);
      else expect(out.sample, `frame ${i}`).toMatchObject(round5(tipOf(fist)));
    }
    // The curled finger is now the finger: opening it again is followed at once.
    const open = hand({ at: [0.5, 0.8] });
    expect(s.frame(frame(t(60), open), FINGER, t(60)).sample).toMatchObject(round5(tipOf(open)));
  });

  it('measures by the curled finger once it is curled: a frame that reads longer during the curl carries nothing', () => {
    const s = new HandTipState('tracker.hand');
    const carried: number[] = [];
    for (let i = 0; i < 70; i++) {
      // The finger long for 15 frames, then curled for good, but one frame (30) reads longer again
      // (landmark noise, a twitch): not long enough for the old finger, longer than the curl.
      const h = hand({ at: [0.5, 0.8], finger: i < 15 ? 0.08 : i === 30 ? 0.06 : 0.015 });
      const out = s.frame(frame(t(i), h), FINGER, t(i));
      if (Math.abs(out.sample!.y - tipOf(h).y) > 1e-4) carried.push(i);
    }
    // Carried through the first COLLAPSE_MAX_MS of the curl as a possible blur (frames 15 to 27), then
    // followed: frame 30 and the curl after it are judged against the curled finger.
    const blur = Array.from({ length: 70 }, (_, i) => i).filter((i) => i >= 15 && t(i) - t(15) <= COLLAPSE_MAX_MS);
    expect(blur).toEqual(Array.from({ length: 13 }, (_, i) => 15 + i));
    expect(carried).toEqual(blur);
    // A collapse after the curl is still caught: the finger opens, then blurs onto the fist for two frames.
    for (let i = 70; i < 85; i++) s.frame(frame(t(i), hand({ at: [0.5, 0.8] })), FINGER, t(i));
    const blurred = hand({ at: [0.5, 0.8], finger: 0.008 });
    expect(s.frame(frame(t(85), blurred), FINGER, t(85)).sample!.y).toBeCloseTo(tipOf(hand({ at: [0.5, 0.8] })).y, 4);
  });

  it('judges each hold of the tip afresh', () => {
    const s = new HandTipState('tracker.hand');
    for (let i = 0; i < 10; i++) s.frame(frame(t(i), hand()), FINGER, t(i));
    s.loseNow(t(10));
    // A new hold that starts with a short finger is not judged by the last hold's long one.
    const fist = hand({ finger: 0.015 });
    for (let i = 20; i < 30; i++) expect(s.frame(frame(t(i), fist), FINGER, t(i)).sample).toMatchObject(round5(tipOf(fist)));
  });

  it('leaves grip mode alone', () => {
    const s = new HandTipState('tracker.hand');
    const grip: TrackingSettings = { mode: 'grip', reach: 0.9, flipX: true };
    const first = s.frame(frame(t(0), hand()), grip, t(0)).sample!;
    for (let i = 1; i < 10; i++) s.frame(frame(t(i), hand()), grip, t(i));
    // The fingertip plays no part in the projection, collapsed or not.
    expect(s.frame(frame(t(10), hand({ finger: 0.008 })), grip, t(10)).sample).toMatchObject({ x: first.x, y: first.y });
  });
});

describe('HandTipState: the hand-too-small hint', () => {
  const t = (i: number) => 1000 + i * (1000 / 30);

  it('says so while a small hand is held, with hysteresis, and only once it has a few samples', () => {
    const s = new HandTipState('tracker.hand');
    s.frame(frame(t(0), hand({ size: 0.04 })), FINGER, t(0));
    s.frame(frame(t(1), hand({ size: 0.04 })), FINGER, t(1));
    // Two samples are too few to judge the hand by.
    expect(s.hint(t(1))).toBeNull();
    let i = 2;
    for (; i < 30; i++) s.frame(frame(t(i), hand({ size: 0.04 })), FINGER, t(i));
    expect(s.hint(t(i - 1))).toBe('hand-too-small');
    // Between the two lines it stays as it was...
    const between = (SMALL_HAND + SMALL_HAND_CLEAR) / 2;
    for (const end = i + 60; i < end; i++) s.frame(frame(t(i), hand({ size: between })), FINGER, t(i));
    expect(s.hint(t(i - 1))).toBe('hand-too-small');
    // ... and the hand near enough clears it once it is most of the last second.
    for (const end = i + 20; i < end; i++) s.frame(frame(t(i), hand({ size: SMALL_HAND_CLEAR })), FINGER, t(i));
    expect(s.hint(t(i - 1))).toBeNull();
    // A hand that comes in from the line, never under it, is not small.
    const fresh = new HandTipState('tracker.hand');
    for (let j = 0; j < 30; j++) fresh.frame(frame(t(j), hand({ size: between })), FINGER, t(j));
    expect(fresh.hint(t(29))).toBeNull();
  });

  it('keeps the hint through a short loss, drops it after a second without samples, then hand-not-found takes over', () => {
    const s = new HandTipState('tracker.hand');
    let i = 0;
    for (; i < 30; i++) s.frame(frame(t(i), hand({ size: 0.04 })), FINGER, t(i));
    const lastSeen = t(i - 1);
    // Frames without a hand: the tip is lost after 400 ms, the hint stays while the last second holds samples.
    for (; t(i) < lastSeen + 900; i++) s.frame(frame(t(i), null), FINGER, t(i));
    expect(s.holding).toBe(false);
    expect(s.hint(t(i - 1))).toBe('hand-too-small');
    for (; t(i) < lastSeen + 1100; i++) s.frame(frame(t(i), null), FINGER, t(i));
    expect(s.hint(t(i - 1))).toBeNull();
    for (; t(i) < lastSeen + HINT_AFTER_MS + 100; i++) s.frame(frame(t(i), null), FINGER, t(i));
    expect(s.hint(t(i - 1))).toBe('hand-not-found');
  });

  it('starts again with a new camera', () => {
    const s = new HandTipState('tracker.hand');
    for (let i = 0; i < 30; i++) s.frame(frame(t(i), hand({ size: 0.03 })), FINGER, t(i));
    expect(s.hint(t(29))).toBe('hand-too-small');
    s.loseNow(t(29));
    s.rebase();
    s.frame(frame(t(30), hand()), FINGER, t(30));
    expect(s.hint(t(30))).toBeNull();
  });
});

function round5(p: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(p.x * 1e5) / 1e5, y: Math.round(p.y * 1e5) / 1e5 };
}
