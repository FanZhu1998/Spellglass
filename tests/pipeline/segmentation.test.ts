// A recorded session carries its tracker's segmentation needs (contracts 1.2 RecordedSession.segmentation),
// and play() publishes them with the tracker's status, as the replay tracker does: a hand session is then
// segmented as it was live, its dropouts bridged. Sessions without needs (all the fixtures) play as
// before, with the settings alone.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordedSession, Stroke } from '../../src/contracts';
import { on } from '../../src/kernel';
import { createPipeline, HAND_NEEDS, handCastEvents, longestGap, play } from './harness';

function handSession(extra: Partial<RecordedSession> = {}): RecordedSession {
  return {
    schema: 'session/1', id: 'hand-cast', recordedAt: '2026-11-24T00:00:00Z', tracker: 'tracker.hand', aspect: 16 / 9, pen: false,
    events: handCastEvents(), expected: [], ...extra,
  };
}

/** The strokes a session gives, with their times in session time. */
async function strokesOf(session: RecordedSession): Promise<Stroke[]> {
  const p = await createPipeline();
  const strokes: Stroke[] = [];
  const off = on(p.kernel, 'stroke.end', (s) => strokes.push({ ...s, t0: s.t0 - p.t0, t1: s.t1 - p.t0 }));
  try {
    await play(p, session);
  } finally {
    off();
    await p.dispose();
  }
  return strokes;
}

describe("a session's segmentation needs", () => {
  const gap = longestGap(handCastEvents());
  const across = (s: Stroke) => s.t0 < gap.from && s.t1 > gap.to;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('are published with the tracker status, so a hand session keeps the stroke it had live', async () => {
    expect(gap.to - gap.from).toBeGreaterThan(350);
    const strokes = await strokesOf(handSession({ segmentation: HAND_NEEDS }));
    // One stroke through the dropout, ended by the pause at the end of the cast.
    expect(strokes).toHaveLength(1);
    expect(across(strokes[0])).toBe(true);
    expect(strokes[0]).toMatchObject({ src: 'tracker.hand', endReason: 'pause' });
    expect(strokes[0].points.at(-1)!.x).toBeCloseTo(0.65, 2);
    expect(strokes[0].points.at(-1)!.y).toBeCloseTo(0.3, 1);
  });

  it('are left to the settings when the session has none', async () => {
    // What a hand session recorded without its needs gave: the stroke ends at the dropout.
    const strokes = await strokesOf(handSession());
    expect(strokes[0]).toMatchObject({ endReason: 'lost' });
    expect(strokes[0].points.at(-1)!.x).toBeCloseTo(0.5, 1);
    expect(strokes.some(across)).toBe(false);
  });
});
