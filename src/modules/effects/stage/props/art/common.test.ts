// Reducto's shards are painted once, the first time a prop is shattered, from the prop's own body. What
// matters is that they come out the same every time, lie on the shelf round the prop's home, keep to
// where the body is painted, and never make a call a browser would throw on.

import { describe, expect, it } from 'vitest';
import { recorder } from '../testing';
import { paintSprite, type Sprite } from './canvas';
import { paintShards, type ShardOptions } from './common';

const OPTS: ShardOptions = { seed: 5, pieces: 5, spread: 60, edge: 'rgba(250,248,242,0.9)' };

function body(rec: ReturnType<typeof recorder>): Sprite {
  const s = paintSprite(rec.factory, 1, { x0: -40, y0: -120, x1: 40, y1: 0 }, () => {});
  if (!s) throw new Error('no sprite');
  return s;
}

describe('shards (Reducto)', () => {
  it('lays the same pieces in the same places every time', () => {
    const a = recorder();
    const b = recorder();
    const wa = paintShards(a.factory, body(a), null, OPTS);
    const wb = paintShards(b.factory, body(b), null, OPTS);
    expect(wa).not.toBeNull();
    expect(wb?.box).toEqual(wa?.box);
    expect(b.surfaces).toBe(a.surfaces);
    expect(b.calls).toBe(a.calls);
    // A sprite for the body, one for each piece, and the wreck they are laid into.
    expect(a.surfaces).toBe(1 + OPTS.pieces + 1);
    expect(a.problems).toEqual([]);
  });

  it('leaves the pieces lying on the shelf round its home, lower than it stood', () => {
    const rec = recorder();
    const w = paintShards(rec.factory, body(rec), null, OPTS);
    if (!w) throw new Error('no wreck');
    // Nothing below the front of the shelf's board (12 mH), and lying down, lower than the body was tall.
    expect(w.box.y1).toBeLessThanOrEqual(20);
    expect(w.box.y0).toBeGreaterThan(-110);
    expect(w.box.x0).toBeGreaterThan(-OPTS.spread - 120);
    expect(w.box.x1).toBeLessThan(OPTS.spread + 120);
  });

  it('breaks only what is painted', () => {
    const rec = recorder();
    // Paint only in the lower half: the pieces lie lower still.
    const w = paintShards(rec.factory, body(rec), null, { ...OPTS, solid: [{ rect: [-40, -50, 40, 0] }] });
    if (!w) throw new Error('no wreck');
    expect(w.box.y0).toBeGreaterThan(-70);
    // Nothing painted, nothing to break.
    const none = recorder();
    expect(paintShards(none.factory, body(none), null, { ...OPTS, solid: [{ ellipse: [500, 500, 1, 1] }] })).toBeNull();
    expect(rec.problems).toEqual([]);
  });

  it('copes with a feather that tears rather than breaks, and with a single piece', () => {
    const rec = recorder();
    expect(paintShards(rec.factory, body(rec), null, { ...OPTS, edge: null, jag: 1 })).not.toBeNull();
    expect(paintShards(rec.factory, body(rec), null, { ...OPTS, pieces: 1 })).not.toBeNull();
    expect(rec.problems).toEqual([]);
  });
});
