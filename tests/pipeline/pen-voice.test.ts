// An incantation said right after a pen press still pairs with the stroke when the pointer then
// rests before moving.
// The segmenter starts a rested pen stroke where the pointer starts to move (stroke Stroke.t0), and
// stroke.begin keeps the press; the voice window must reach back to the press (Section 7.7: "between
// 2.5 s before and 1 s after the stroke").

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordedSession, SessionEvent } from '../../src/contracts';
import { createPipeline, play } from './harness';

/** Press at t0, rest (no events) for restMs, then a straight flick up over 200 ms at 60 Hz. */
function pressRestFlick(t0: number, restMs: number): SessionEvent[] {
  const ev: SessionEvent[] = [
    { type: 'tip.found', t: t0, x: 0.5, y: 0.65, conf: 1 },
    { type: 'tip.sample', t: t0, x: 0.5, y: 0.65, conf: 1 },
  ];
  const n = 12;
  for (let k = 1; k <= n; k++) ev.push({ type: 'tip.sample', t: Math.round(t0 + restMs + (k / n) * 200), x: 0.5, y: 0.65 - 0.3 * (k / n), conf: 1 });
  const last = Math.round(t0 + restMs + 200);
  ev.push({ type: 'tip.lost', t: last + 1, lastSeen: last });
  return ev;
}

function session(events: SessionEvent[]): RecordedSession {
  events.sort((a, b) => a.t - b.t);
  return { schema: 'session/1', id: 'pen-voice', recordedAt: '2026-11-22', tracker: 'tracker.pointer', aspect: 16 / 9, pen: true, events, expected: [] };
}

describe('a pen press, the incantation, a rest, then the stroke', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  for (const restMs of [800, 3000]) {
    it(`strict: "Lumos" said at the press pairs with the flick after a ${restMs} ms rest`, async () => {
      const p = await createPipeline({ 'engine.mode': 'strict' });
      try {
        p.kernel.emit('voice.status', { state: 'listening', local: true }, 'voice.test');
        await play(p, session([
          ...pressRestFlick(1000, restMs),
          // Speech 1050 to 1450: an interim at 1300, the final at 1700.
          { type: 'voice.incantation', t: 1300, text: 'lu', conf: 0.3, final: false, id: 'u1', t0: 1050 },
          { type: 'voice.incantation', t: 1700, text: 'lumos', spellId: 'lumos', conf: 0.9, final: true, id: 'u1', t0: 1050, t1: 1450 },
        ]));
        expect(p.decisions.map((d) => `${d.kind} ${d.spellId} ${d.cast?.via ?? d.fizzle?.reason}`)).toEqual(['cast lumos both']);
        // The rest is no part of the stroke: the flick's own duration and quality.
        expect(p.decisions[0].cast!.quality).toBe(1);
      } finally {
        await p.dispose();
      }
    });
  }
});
