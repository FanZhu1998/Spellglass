// The recognizer's time budget (Section 2: a decision within 50 ms; Section 13 "Performance", checked
// before each release). Wall-clock budgets only mean something on a quiet machine, one file at a
// time, so this file runs under `npm run test:perf`, not in the parallel `npm test`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Point, SpellPack } from '../../../contracts';
import { bbox, rotate } from '../../../kernel/geometry';
import { DEFAULT_PARAMS, recognize } from './recognize';
import { prepareGesture, prepareSample, storedTemplates, type PreparedSpell } from './templates';

const ASPECT = 16 / 9;
const PACKS = ['core-charms', 'further-spells', 'restricted-section'].map(
  (id) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../public/packs/${id}/pack.json`, import.meta.url)), 'utf8')) as SpellPack,
);
const SPELLS = PACKS.flatMap((p) => p.spells);
const ALL: PreparedSpell[] = SPELLS.map((s) => ({ spellId: s.id, gesture: prepareGesture(s.gesture, storedTemplates(s.gesture)), user: [] }));
const pathOf = (id: string): Point[] => {
  const g = SPELLS.find((s) => s.id === id)!.gesture;
  return 'path' in g ? g.path : 'paths' in g ? g.paths[0] : [];
};
const tilt = (pts: readonly Point[], deg: number) => rotate(pts, (deg * Math.PI) / 180, [0.5, 0.5]);

/** An isotropic unit-square drawing placed in caster space: 40% of the frame height, centred. */
function caster(iso: readonly Point[], height = 0.4): Point[] {
  const b = bbox(iso);
  const s = height / (Math.max(b.w, b.h) || 1);
  const mx = (b.minX + b.maxX) / 2, my = (b.minY + b.maxY) / 2;
  return iso.map(([x, y]) => [0.5 + ((x - mx) * s) / ASPECT, 0.5 + (y - my) * s] as Point);
}

describe('performance (Section 2: a decision within 50 ms)', () => {
  it('recognizes against 27 spells with five learned templates each, details included, well inside 50 ms', () => {
    const user = (id: string) => [0, 1, 2, 3, 4].map((k) => prepareSample({ dataVersion: 1, id: `${id}${k}`, spellId: id, points: storedTemplates({ path: tilt(pathOf('accio'), k * 3) })[0], score: 0.9, gestureKey: 'k', savedAt: 0 }, k));
    const loaded = ALL.map((s) => ({ ...s, user: user(s.spellId) }));
    const strokes = SPELLS.filter((s) => !('flick' in s.gesture)).map((s) => caster(tilt(pathOf(s.id), 5)));
    recognize(strokes[0], ASPECT, loaded, DEFAULT_PARAMS, { details: true, detailScore: 0.6 });
    // Best of three per stroke: the recognizer's own cost, not a GC pause.
    const times: number[] = [];
    for (const stroke of strokes) {
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const t0 = performance.now();
        recognize(stroke, ASPECT, loaded, DEFAULT_PARAMS, { details: true, detailScore: 0.6, focus: 'protego' });
        best = Math.min(best, performance.now() - t0);
      }
      times.push(best);
    }
    times.sort((a, b) => a - b);
    expect(times[times.length - 1]).toBeLessThan(50);
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(20);
  });
});
