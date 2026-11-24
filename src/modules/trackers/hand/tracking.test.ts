import { describe, expect, it } from 'vitest';
import { LANDMARK, LANDMARK_COUNT } from './geometry';
import type { HandWire } from './protocol';
import { HandTipState, HINT_AFTER_MS, LOST_AFTER_FRAMES, type ProcessedFrame, type TrackingSettings } from './tracking';

const FINGER: TrackingSettings = { mode: 'finger', reach: 0.9, flipX: true };

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

let frameNo = 0;
function frame(t: number, hand: HandWire | null, stepMs = 8): ProcessedFrame {
  return { t, frame: frameNo++, width: 1920, height: 1080, hand, stepMs };
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

  it('declares the tip lost after a few frames without a hand, at the frame that declared it', () => {
    const s = new HandTipState('tracker.hand');
    s.frame(frame(1000, wire([0.3, 0.4])), FINGER, 1000);
    for (let i = 1; i < LOST_AFTER_FRAMES; i++) expect(s.frame(frame(1000 + i * 33, null), FINGER, 1000 + i * 33).lost).toBeUndefined();
    const out = s.frame(frame(1000 + LOST_AFTER_FRAMES * 33, null), FINGER, 1100);
    expect(out.lost).toEqual({ t: 1000 + LOST_AFTER_FRAMES * 33, lastSeen: 1000 });
    expect(s.holding).toBe(false);
    // Found again: a new tip.found.
    expect(s.frame(frame(1200, wire([0.3, 0.4])), FINGER, 1200).found).toBeDefined();
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
