import { describe, expect, it } from 'vitest';
import type { RecognitionDetail } from '../../contracts';
import { gesturePaceMs } from '../../kernel';
import type { HintContext } from './hints';
import { adviseFizzle, adviseImprovement, findStray, needsActiveHint, partAt, shortHint, strayHint, TEXT } from './hints';
import { strokeFacts } from './measure';
import { detailOf, flickStroke, pathStroke, seedSpell, strokeAlong } from './test-support';

const FULL = { x: 0, y: 0, w: 1, h: 1 };

function ctxFor(spellId: string, detail: RecognitionDetail | undefined, durationMs?: number, quality = 0.95): HintContext {
  const gesture = seedSpell(spellId).gesture;
  const pace = gesturePaceMs(gesture);
  const stroke = 'flick' in gesture
    ? flickStroke('s', gesture.flick, { t0: 0, durationMs: durationMs ?? 300, quality })
    : pathStroke('s', spellId, { t0: 0, durationMs: durationMs ?? pace, quality });
  return { gesture, detail, facts: strokeFacts(stroke, FULL), paceMs: pace, flickLinearity: 0.2 };
}

/** 64 deviations, low everywhere except a bump over [from, to] (indices). */
function bump(from: number, to: number, high = 0.3, low = 0.03): number[] {
  return Array.from({ length: 64 }, (_, i) => (i >= from && i <= to ? high : low));
}

describe('stopped short', () => {
  it("uses the pack's short_hint for Alohomora's short downstroke, word for word", () => {
    const advice = adviseFizzle(ctxFor('alohomora', detailOf('alohomora', 0.66, { reached: 0.8 })), 'low-score');
    expect(advice.hint).toBe('The downstroke stopped short: carry it through the circle.');
    expect(advice.kind).toBe('stopped-short');
  });

  it('names the circle when the stroke ended inside it', () => {
    const advice = adviseFizzle(ctxFor('alohomora', detailOf('alohomora', 0.5, { reached: 0.5 })), 'low-score');
    expect(advice.hint).toBe('The circle stopped short: close it at the top before the downstroke.');
  });

  it('falls back to the contract default without a short_hint, and without parts', () => {
    expect(shortHint({ until: 0.3, name: 'the first turn' })).toBe('The first turn stopped short: carry it through.');
    expect(shortHint(null)).toBe('The stroke stopped short: carry it through.');
  });

  it('on a loop drawn from any point, counts how much of the loop was covered, across the seam', () => {
    // A full Protego can come back as started 0.01, reached 0.01: the window wrapped the seam.
    expect(adviseImprovement(ctxFor('protego', detailOf('protego', 0.97, { started: 0.01, reached: 0.01 })), 0.97)).toEqual({});
    // Begun a third of the way round and closed again: not a late start.
    expect(adviseImprovement(ctxFor('protego', detailOf('protego', 0.96, { started: 0.35, reached: 0.33 })), 0.96)).toEqual({});
    // Covered half the loop.
    const short = adviseFizzle(ctxFor('protego', detailOf('protego', 0.6, { started: 0.1, reached: 0.6 })), 'low-score');
    expect(short.hint).toBe('The circle stopped short: close it where you began.');
  });

  it('names a late start on an open path', () => {
    expect(adviseFizzle(ctxFor('alohomora', detailOf('alohomora', 0.62, { started: 0.3 })), 'low-score').hint).toBe(
      'The circle started late: begin where the guide begins.',
    );
  });

  it('a stroke that ends exactly at a part boundary is short in the next part', () => {
    const parts = seedSpell('alohomora').gesture.parts!;
    expect(partAt(parts, 0.656)?.name).toBe('the downstroke');
    expect(partAt(parts, 0.2)?.name).toBe('the circle');
    expect(partAt(parts, 1)?.name).toBe('the downstroke');
  });
});

describe('strayed', () => {
  it('finds the worst window in the deviations, maps it to its part, and reports it in stroke fractions', () => {
    // The worst 8-point window starts at index 4: the stroke from 4/63 to 11/63, inside the circle.
    const advice = adviseFizzle(ctxFor('alohomora', detailOf('alohomora', 0.6, { deviation: bump(4, 15) })), 'low-score');
    expect(advice.hint).toBe('The circle wandered: keep it closer to the guide.');
    expect(advice.stray!.from).toBeCloseTo(4 / 63, 6);
    expect(advice.stray!.to).toBeCloseTo(11 / 63, 6);
  });

  it("names the part from the recognizer's strayPath, which undoes a loop's start shift", () => {
    // Stroke points 40..47 strayed; on the stored path (start shift undone) that is 0.135..0.246.
    const shifted = detailOf('alohomora', 0.6, { deviation: bump(40, 47), strayPath: { from: 0.135, to: 0.246 } });
    const advice = adviseFizzle(ctxFor('alohomora', shifted), 'low-score');
    expect(advice.hint).toBe('The circle wandered: keep it closer to the guide.');
    expect(advice.stray!.from).toBeCloseTo(40 / 63, 6);
    expect(advice.stray!.to).toBeCloseTo(47 / 63, 6);
    // Without strayPath the stroke window stands for the path (exact for open paths): the downstroke.
    const open = adviseFizzle(ctxFor('alohomora', detailOf('alohomora', 0.6, { deviation: bump(40, 47) })), 'low-score');
    expect(open.hint).toBe('The downstroke wandered: keep it closer to the guide.');
  });

  it('uses strayPath for the stroke too when a detail has no deviations', () => {
    const w = findStray({ ...detailOf('incendio', 0.62, { strayPath: { from: 0.75, to: 0.95 } }), deviation: [] })!;
    expect(w).toMatchObject({ from: 0.75, to: 0.95, mean: null });
    expect(w.pathCentre).toBeCloseTo(0.85, 6);
    const advice = adviseFizzle(ctxFor('incendio', { ...detailOf('incendio', 0.62, { strayPath: { from: 0.75, to: 0.95 } }), deviation: [] }), 'low-score');
    expect(advice.hint).toBe('The base wandered: keep it closer to the guide.');
  });

  it('names no part for a scribble, but still shows where it strayed most', () => {
    const advice = adviseFizzle(ctxFor('riddikulus', detailOf('riddikulus', 0.47, { deviation: bump(0, 7) })), 'low-score');
    expect(advice).toMatchObject({ kind: 'general', hint: 'Trace the shape more closely to the guide.' });
    expect(advice.stray).toEqual({ from: 0, to: 7 / 63 });
  });

  it("uses a part's stray_hint when the pack has one", () => {
    expect(strayHint({ until: 1, name: 'the loop', stray_hint: 'Keep the loop round.' })).toBe('Keep the loop round.');
  });
});

describe('flicks', () => {
  it('says which way to flick when the direction is off', () => {
    const gesture = seedSpell('lumos').gesture;
    // Up and well to the right: 45 degrees off "up".
    const s = strokeAlong('s', [[0.4, 0.6], [0.4 + 0.2 / (16 / 9), 0.4]], { t0: 0, durationMs: 300 });
    const advice = adviseFizzle({ gesture, facts: strokeFacts(s, FULL), paceMs: 350, flickLinearity: 0.2, detail: detailOf('lumos', 0.6) }, 'low-score');
    expect(advice.hint).toBe('Flick straight up.');
    const finite = seedSpell('finite-incantatem').gesture;
    const down = flickStroke('d', 'down', { t0: 0, durationMs: 300 });
    expect(adviseFizzle({ gesture: finite, facts: strokeFacts(down, FULL), paceMs: 350, flickLinearity: 0.2 }, 'low-score').hint).toBe(TEXT.flick.left);
  });

  it('asks for a straight flick when it curved', () => {
    const gesture = seedSpell('lumos').gesture;
    const s = strokeAlong('s', [[0.5, 0.7], [0.56, 0.55], [0.5, 0.4]], { t0: 0, durationMs: 300 });
    const advice = adviseFizzle({ gesture, facts: strokeFacts(s, FULL), paceMs: 350, flickLinearity: 0.2 }, 'low-score');
    expect(advice.hint).toBe('Keep the flick straight.');
  });
});

describe('size and tempo', () => {
  it('says plainly when a stroke was too fast, too slow or too small', () => {
    const pace = gesturePaceMs(seedSpell('alohomora').gesture);
    const ok = detailOf('alohomora', 0.65, { deviation: Array(64).fill(0.1) });
    expect(adviseFizzle(ctxFor('alohomora', ok, pace * 0.3), 'low-score').hint).toBe('Trace it more slowly.');
    const gesture = seedSpell('alohomora').gesture;
    const small = pathStroke('s', 'alohomora', { t0: 0, durationMs: pace, size: 0.18 });
    expect(adviseFizzle({ gesture, detail: ok, facts: strokeFacts(small, FULL), paceMs: pace, flickLinearity: 0.2 }, 'low-score').hint).toBe('Make the gesture larger.');
    expect(adviseImprovement(ctxFor('alohomora', detailOf('alohomora', 0.85), pace * 2.5), 0.85).hint).toBe('Trace it a little faster.');
  });

  it('a jittery stroke is told to move steadily', () => {
    expect(adviseFizzle(ctxFor('alohomora', detailOf('alohomora', 0.6), undefined, 0.3), 'low-score').hint).toBe(TEXT.unsteady);
  });
});

describe('improvement hints for accepted casts', () => {
  it('stays quiet for a clean cast', () => {
    expect(adviseImprovement(ctxFor('alohomora', detailOf('alohomora', 0.93)), 0.95)).toEqual({});
  });

  it('names a clearly wandering part even on a good cast', () => {
    const advice = adviseImprovement(ctxFor('alohomora', detailOf('alohomora', 0.84, { deviation: bump(50, 61, 0.2) })), 0.86);
    expect(advice.hint).toBe('The downstroke wandered: keep it closer to the guide.');
    expect(advice.stray).toBeDefined();
  });

  it('always gives a hint below Exceeds Expectations', () => {
    const advice = adviseImprovement(ctxFor('alohomora', detailOf('alohomora', 0.74, { deviation: bump(20, 31, 0.08, 0.06) })), 0.72);
    expect(advice.kind).toBe('stray');
    expect(advice.hint).toMatch(/wandered: keep it closer to the guide\.$/);
  });
});

describe('rule hints', () => {
  it('names the missing spell plainly', () => {
    expect(needsActiveHint(['Lumos'])).toBe('Cast Lumos first.');
    expect(needsActiveHint(['Lumos', 'Protego'])).toBe('Cast Lumos and Protego first.');
  });

  it('never repeats the spell name in shape hints, and every hint is one sentence in sentence case', () => {
    const all = [
      adviseFizzle(ctxFor('alohomora', detailOf('alohomora', 0.66, { reached: 0.8 })), 'low-score').hint!,
      adviseFizzle(ctxFor('accio', detailOf('accio', 0.6, { deviation: bump(30, 41) })), 'ambiguous').hint!,
      ...(Object.values(TEXT) as unknown[]).filter((v): v is string => typeof v === 'string' && v.endsWith('.')),
      ...Object.values(TEXT.flick),
    ];
    for (const h of all) {
      expect(h).toMatch(/^[A-Z][^.]*\.$/);
      expect(h).not.toMatch(/Alohomora|Accio/);
    }
  });
});
