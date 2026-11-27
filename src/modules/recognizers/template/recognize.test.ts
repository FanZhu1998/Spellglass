import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GestureSample, Point, SpellPack } from '../../../contracts';
import { bbox, dist, pointAt, resample, rotate } from '../../../kernel/geometry';
import { strokeToUnitPath } from '../../../kernel/gestures';
import { DEFAULT_PARAMS, recognize } from './recognize';
import { prepareGesture, prepareSample, storedTemplates, type PreparedSpell } from './templates';

const ASPECT = 16 / 9;
const PACKS = ['core-charms', 'further-spells', 'restricted-section'].map(
  (id) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../../public/packs/${id}/pack.json`, import.meta.url)), 'utf8')) as SpellPack,
);
const SPELLS = PACKS.flatMap((p) => p.spells);
const ALL: PreparedSpell[] = SPELLS.map((s) => ({ spellId: s.id, gesture: prepareGesture(s.gesture, storedTemplates(s.gesture)), user: [] }));
const only = (...ids: string[]) => ALL.filter((s) => ids.includes(s.spellId));
const pathOf = (id: string): Point[] => {
  const g = SPELLS.find((s) => s.id === id)!.gesture;
  return 'path' in g ? g.path : 'paths' in g ? g.paths[0] : [];
};

/** An isotropic unit-square drawing placed in caster space: 40% of the frame height, centred. */
function caster(iso: readonly Point[], height = 0.4, cx = 0.5, cy = 0.5): Point[] {
  const b = bbox(iso);
  const s = height / (Math.max(b.w, b.h) || 1);
  const mx = (b.minX + b.maxX) / 2, my = (b.minY + b.maxY) / 2;
  return iso.map(([x, y]) => [cx + ((x - mx) * s) / ASPECT, cy + (y - my) * s] as Point);
}
const line = (angleDeg: number, n = 20): Point[] => {
  const a = (angleDeg * Math.PI) / 180;
  return Array.from({ length: n }, (_, i) => [0.5 + Math.cos(a) * (i / (n - 1) - 0.5), 0.5 + Math.sin(a) * (i / (n - 1) - 0.5)] as Point);
};
const tilt = (pts: readonly Point[], deg: number) => rotate(pts, (deg * Math.PI) / 180, [0.5, 0.5]);
const subPath = (pts: readonly Point[], from: number, to: number) => Array.from({ length: 64 }, (_, i) => pointAt(pts, from + ((to - from) * i) / 63));

describe('candidates', () => {
  it('has exactly one entry per spell given, best first', () => {
    const r = recognize(caster(pathOf('accio')), ASPECT, ALL);
    expect(r.candidates).toHaveLength(ALL.length);
    expect(new Set(r.candidates.map((c) => c.spellId)).size).toBe(ALL.length);
    for (let i = 1; i < r.candidates.length; i++) expect(r.candidates[i - 1].score).toBeGreaterThanOrEqual(r.candidates[i].score);
    expect(r.candidates[0].spellId).toBe('accio');
  });

  it('recognizes every seed gesture drawn exactly as itself', () => {
    for (const spell of SPELLS) {
      const g = spell.gesture;
      const drawn = 'flick' in g ? caster(line({ right: 0, down: 90, left: 180, up: -90 }[g.flick])) : caster(pathOf(spell.id));
      const r = recognize(drawn, ASPECT, ALL);
      expect(r.candidates[0].spellId, spell.id).toBe(spell.id);
      expect(r.candidates[0].score, spell.id).toBeGreaterThan(0.97);
    }
  });

  it('gives no candidates when nothing is enabled, and zero for a stroke with no extent', () => {
    expect(recognize(caster(pathOf('accio')), ASPECT, []).candidates).toEqual([]);
    const dot = recognize([[0.5, 0.5], [0.5, 0.5], [0.5, 0.5]], ASPECT, only('lumos', 'accio'));
    expect(dot.candidates.map((c) => c.score)).toEqual([0, 0]);
    expect(dot.details).toEqual([]);
    expect(recognize([[Number.NaN, 0.5], [0.4, 0.4]], ASPECT, only('accio')).candidates[0].score).toBe(0);
  });
});

describe('stage 1: flicks', () => {
  const flicks = only('lumos', 'nox', 'stupefy', 'finite-incantatem', 'accio', 'protego');

  it.each([['up', -90, 'lumos'], ['down', 90, 'nox'], ['right', 0, 'stupefy'], ['left', 180, 'finite-incantatem']] as const)(
    'reads a straight stroke %s as its flick spell', (_dir, angle, spellId) => {
      const r = recognize(caster(line(angle)), ASPECT, flicks);
      expect(r.stage).toBe('flick');
      expect(r.candidates[0]).toEqual({ spellId, score: 1 });
      expect(r.linearity).toBeLessThan(1e-6);
    },
  );

  it('scores 1 − 0.14·(linearity ÷ 0.20) − 0.14·(angle error ÷ 35°)', () => {
    const r = recognize(caster(line(-90 + 20)), ASPECT, flicks);
    expect(r.stage).toBe('flick');
    expect(r.candidates[0].spellId).toBe('lumos');
    expect(r.candidates[0].score).toBeCloseTo(1 - 0.14 * (20 / 35), 6);
    // A gently bowed flick: linearity counts too.
    const bowed = Array.from({ length: 30 }, (_, i) => [0.5 + 0.05 * Math.sin((Math.PI * i) / 29), 0.9 - (0.8 * i) / 29] as Point);
    const b = recognize(caster(bowed), ASPECT, flicks);
    expect(b.stage).toBe('flick');
    expect(b.linearity).toBeGreaterThan(0.02);
    expect(b.candidates[0].score).toBeCloseTo(1 - 0.14 * (b.linearity / 0.2) - 0.14 * (Math.abs(b.details[0]?.rotation ?? 0) / 35), 1);
  });

  it('leaves a straight stroke outside every 35° cone to stage 2, where the two nearest lines tie', () => {
    const r = recognize(caster(line(-45)), ASPECT, flicks);
    expect(r.stage).toBe('template');
    const [a, b] = r.candidates;
    expect([a.spellId, b.spellId].sort()).toEqual(['lumos', 'stupefy']);
    expect(Math.abs(a.score - b.score)).toBeLessThan(1e-9);
  });

  it('goes to stage 2 when no enabled spell has that direction', () => {
    const r = recognize(caster(line(0)), ASPECT, only('lumos', 'accio'));
    expect(r.stage).toBe('template');
  });

  it('measures direction in isotropic space: a 16:9 frame does not bend the cone', () => {
    // 30° above horizontal on screen is 30° in isotropic units, whatever the caster-space numbers say.
    const r = recognize(caster(line(-30)), ASPECT, flicks);
    expect(r.candidates[0].spellId).toBe('stupefy');
    expect(r.candidates[0].score).toBeCloseTo(1 - 0.14 * (30 / 35), 6);
  });

  it('calls two flick spells drawn the same way a template decision, so the lead rule applies', () => {
    const twin: PreparedSpell = { spellId: 'twin', gesture: prepareGesture({ flick: 'up' }), user: [] };
    const r = recognize(caster(line(-90)), ASPECT, [...only('lumos'), twin]);
    expect(r.candidates.map((c) => c.score)).toEqual([1, 1]);
    expect(r.stage).toBe('template');
  });
});

describe('stage 2: templates', () => {
  it('compares line templates only with nearly straight strokes', () => {
    // A curved stroke: flick spells score nothing.
    const r = recognize(caster(pathOf('accio')), ASPECT, only('lumos', 'nox', 'stupefy', 'accio'));
    expect(r.linearity).toBeGreaterThan(0.3);
    expect(r.candidates.filter((c) => c.spellId !== 'accio').every((c) => c.score === 0)).toBe(true);
    // A slightly bent line (linearity between 0.20 and 0.30): no stage 1, but the line templates compete.
    const bent = Array.from({ length: 40 }, (_, i) => [0.1 + (0.8 * i) / 39, 0.5 - 0.18 * Math.sin((Math.PI * i) / 39)] as Point);
    const b = recognize(caster(bent), ASPECT, only('lumos', 'stupefy', 'accio'));
    expect(b.linearity).toBeGreaterThan(0.2);
    expect(b.linearity).toBeLessThan(0.3);
    expect(b.stage).toBe('template');
    expect(b.candidates[0].spellId).toBe('stupefy');
    expect(b.candidates[0].score).toBeGreaterThan(0.72);
  });

  it('multiplies x by the aspect before comparing shapes', () => {
    const protego = caster(pathOf('protego'));
    const right = recognize(protego, ASPECT, only('protego')).candidates[0].score;
    const wrong = recognize(protego, 1, only('protego')).candidates[0].score;
    expect(right).toBeGreaterThan(0.97);
    expect(wrong).toBeLessThan(right - 0.1);
  });

  it('tolerates ±15° of tilt and reports it, clockwise positive', () => {
    const spells = only('accio', 'locomotor', 'aguamenti', 'impedimenta');
    const r12 = recognize(caster(tilt(pathOf('accio'), 12)), ASPECT, spells, DEFAULT_PARAMS, { details: true });
    expect(r12.candidates[0].spellId).toBe('accio');
    expect(r12.candidates[0].score).toBeGreaterThan(0.97);
    expect(r12.details.find((d) => d.spellId === 'accio')!.rotation).toBe(12);
    const rMinus = recognize(caster(tilt(pathOf('accio'), -6)), ASPECT, spells, DEFAULT_PARAMS, { details: true });
    expect(rMinus.details.find((d) => d.spellId === 'accio')!.rotation).toBe(-6);
    const r40 = recognize(caster(tilt(pathOf('accio'), 40)), ASPECT, only('accio'));
    expect(r40.candidates[0].score).toBeLessThan(0.85);
  });

  it('cares about direction: a path drawn backwards does not match', () => {
    const forward = recognize(caster(pathOf('accio')), ASPECT, only('accio')).candidates[0].score;
    const backward = recognize(caster([...pathOf('accio')].reverse()), ASPECT, only('accio')).candidates[0].score;
    expect(forward).toBeGreaterThan(0.97);
    expect(backward).toBeLessThan(0.6);
  });

  it('matches a closed shape started at each quarter of the loop', () => {
    const loop = resample(pathOf('protego'), 200);
    // The pack expands Protego into start_points start points; a quarter turn is start_points / 4 of them.
    const protegoGesture = PACKS.flatMap((p) => p.spells).find((sp) => sp.id === 'protego')!.gesture as { start_points?: number };
    const perQuarter = (protegoGesture.start_points ?? 4) / 4;
    for (let s = 0; s < 4; s++) {
      const drawn = Array.from({ length: 64 }, (_, i) => pointAt(loop, (s / 4 + i / 63) % 1 || (i === 63 ? s / 4 || 1 : 0)));
      const r = recognize(caster(drawn), ASPECT, ALL, DEFAULT_PARAMS, { details: true });
      expect(r.candidates[0].spellId).toBe('protego');
      expect(r.candidates[0].score).toBeGreaterThan(0.95);
      const d = r.details.find((x) => x.spellId === 'protego')!;
      expect(d.template).toBe(s === 0 ? 'seed:0' : `seed:0@start${s * perQuarter}`);
      // Fractions refer to the stored path with the start shift undone.
      expect(d.started).toBeCloseTo(s / 4, 1);
      expect(d.reached).toBeCloseTo(s === 0 ? 1 : s / 4, 1);
    }
  });
});

describe('details', () => {
  it('explains the top three, everything above the detail score, and the practice focus', () => {
    const r = recognize(caster(pathOf('accio')), ASPECT, ALL, DEFAULT_PARAMS, { details: true, detailScore: 0.6, focus: 'lumos' });
    const ids = r.details.map((d) => d.spellId);
    expect(ids.slice(0, 3)).toEqual(r.candidates.slice(0, 3).map((c) => c.spellId));
    for (const c of r.candidates) if (c.score >= 0.6) expect(ids).toContain(c.spellId);
    expect(ids).toContain('lumos');
    for (const d of r.details) {
      expect(d.deviation).toHaveLength(64);
      expect(d.aligned).toHaveLength(64);
      expect(d.score).toBe(r.candidates.find((c) => c.spellId === d.spellId)!.score);
    }
    expect(recognize(caster(pathOf('accio')), ASPECT, ALL).details).toEqual([]);
  });

  /** Mean distance between a detail's aligned path and the stroke resampled the way the recognizer
   *  resamples it (evenly in isotropic units, not in caster units), isotropic units. */
  const gap = (aligned: [number, number][], drawn: Point[]) => {
    const stroke = resample(drawn.map(([x, y]) => [x * ASPECT, y] as Point), 64);
    return aligned.reduce((s, p, i) => s + dist([p[0] * ASPECT, p[1]], stroke[i]), 0) / 64;
  };

  it('fits the stored path onto the stroke in caster space, through the same centroid and scale', () => {
    const drawn = caster(pathOf('alohomora'), 0.35, 0.4, 0.45);
    const d = recognize(drawn, ASPECT, ALL, DEFAULT_PARAMS, { details: true }).details.find((x) => x.spellId === 'alohomora')!;
    expect(d.pathIndex).toBe(0);
    expect(d.rotation).toBe(0);
    expect(gap(d.aligned, drawn)).toBeLessThan(0.001);
    expect(Math.max(...d.deviation)).toBeLessThan(0.005);
    expect(d.reached).toBeGreaterThan(0.97);
    expect(d.started).toBeLessThan(0.03);
  });

  it('tilts the settled shape with the stroke', () => {
    // Uniform scaling by the bounding box is not rotation-invariant, so a tilted stroke and its template
    // differ a little in size: the settled shape lies within a few percent of the ink, not on it.
    const drawn = caster(tilt(pathOf('alohomora'), 9), 0.35, 0.4, 0.45);
    const d = recognize(drawn, ASPECT, ALL, DEFAULT_PARAMS, { details: true }).details.find((x) => x.spellId === 'alohomora')!;
    expect(d.rotation).toBe(9);
    expect(gap(d.aligned, drawn)).toBeLessThan(0.035 * 0.35 * 2);
    const flat = recognize(drawn, ASPECT, ALL, { ...DEFAULT_PARAMS, rotationDeg: 0 }, { details: true }).details.find((x) => x.spellId === 'alohomora')!;
    expect(gap(flat.aligned, drawn)).toBeGreaterThan(gap(d.aligned, drawn));
  });

  it('says how far a stroke that stopped short got', () => {
    const r = recognize(caster(subPath(pathOf('alohomora'), 0, 0.8)), ASPECT, ALL, DEFAULT_PARAMS, { details: true, focus: 'alohomora' });
    const d = r.details.find((x) => x.spellId === 'alohomora')!;
    expect(d.reached).toBeGreaterThan(0.75);
    expect(d.reached).toBeLessThan(0.85);
    expect(d.started).toBeLessThan(0.05);
  });

  it('says where a stroke that began late began', () => {
    const r = recognize(caster(subPath(pathOf('incendio'), 0.25, 1)), ASPECT, ALL, DEFAULT_PARAMS, { details: true, focus: 'incendio' });
    const d = r.details.find((x) => x.spellId === 'incendio')!;
    expect(d.started).toBeGreaterThan(0.2);
    expect(d.started).toBeLessThan(0.3);
    expect(d.reached).toBeGreaterThan(0.95);
  });

  it('finds the part that strayed most', () => {
    const accio = resample(pathOf('accio'), 64);
    // Push the middle of the curve (around half way) out to the left.
    const bumped = accio.map(([x, y], i) => [x - 0.12 * Math.exp(-((i - 32) ** 2) / 18), y] as Point);
    const r = recognize(caster(bumped), ASPECT, only('accio', 'locomotor'), DEFAULT_PARAMS, { details: true });
    const d = r.details.find((x) => x.spellId === 'accio')!;
    expect(d.strayPath!.from).toBeLessThan(0.5);
    expect(d.strayPath!.to).toBeGreaterThan(0.5);
    expect(d.strayPath!.to - d.strayPath!.from).toBeLessThan(0.2);
  });

  it('draws a flick as a straight line from the stroke start to its end, reached 1', () => {
    const drawn = caster(line(-80), 0.4, 0.3, 0.5);
    const r = recognize(drawn, ASPECT, only('lumos', 'nox'), DEFAULT_PARAMS, { details: true });
    const d = r.details.find((x) => x.spellId === 'lumos')!;
    expect(d.template).toBe('flick:up');
    expect(d.reached).toBe(1);
    expect(d.rotation).toBeCloseTo(10, 0);
    expect(d.aligned[0][0]).toBeCloseTo(drawn[0][0], 4);
    expect(d.aligned[0][1]).toBeCloseTo(drawn[0][1], 4);
    expect(d.aligned[63][0]).toBeCloseTo(drawn[drawn.length - 1][0], 4);
    expect(d.aligned[63][1]).toBeCloseTo(drawn[drawn.length - 1][1], 4);
  });
});

describe('learned samples', () => {
  /** A drawing of Accio that is wider and flatter than the pack's. */
  const habit = caster(pathOf('accio').map(([x, y]) => [x * 1.5, 0.3 + y * 0.45] as Point));
  const sample: GestureSample = { dataVersion: 1, id: 's', spellId: 'accio', points: strokeToUnitPath(habit, ASPECT), score: 0.8, gestureKey: 'k', savedAt: 0 };

  it('adds a sample as a user template, while details still refer to the stored path', () => {
    const seedOnly = recognize(habit, ASPECT, only('accio'));
    const withUser: PreparedSpell = { ...only('accio')[0], user: [prepareSample(sample, 0)] };
    const r = recognize(habit, ASPECT, [withUser], DEFAULT_PARAMS, { details: true });
    expect(r.candidates[0].score).toBeGreaterThan(seedOnly.candidates[0].score + 0.05);
    expect(r.candidates[0].score).toBeGreaterThan(0.97);
    const d = r.details[0];
    expect(d.template).toBe('user:0');
    expect(d.pathIndex).toBe(0);
    expect(r.matches[0].seedScore).toBeCloseTo(seedOnly.candidates[0].score, 12);
    expect(recognize(habit, ASPECT, [withUser], DEFAULT_PARAMS, { seedsOnly: true }).candidates[0].score).toBeCloseTo(seedOnly.candidates[0].score, 12);
  });

  it('never lets a learned sample replace the stage-1 score of a flick', () => {
    const up = caster(line(-90));
    const lumos: PreparedSpell = { ...only('lumos')[0], user: [prepareSample({ ...sample, spellId: 'lumos', points: strokeToUnitPath(up, ASPECT) }, 0)] };
    const r = recognize(up, ASPECT, [lumos]);
    expect(r.stage).toBe('flick');
    expect(r.matches[0].template).toBe('flick:up');
  });
});

// The strict 50 ms budget lives in recognize.perf.test.ts (npm run test:perf, a quiet machine). Here,
// with every test file running at once, only a gross slowdown (an accidental blow-up in the template
// count or the matching) is caught: five times the budget, whatever else the machine is doing.
describe('performance guard', () => {
  it('stays far inside five times the 50 ms budget even on a busy machine', () => {
    const user = (id: string) => [0, 1, 2, 3, 4].map((k) => prepareSample({ dataVersion: 1, id: `${id}${k}`, spellId: id, points: storedTemplates({ path: tilt(pathOf('accio'), k * 3) })[0], score: 0.9, gestureKey: 'k', savedAt: 0 }, k));
    const loaded = ALL.map((s) => ({ ...s, user: user(s.spellId) }));
    const strokes = SPELLS.filter((s) => !('flick' in s.gesture)).map((s) => caster(tilt(pathOf(s.id), 5)));
    recognize(strokes[0], ASPECT, loaded, DEFAULT_PARAMS, { details: true, detailScore: 0.6 });
    // Best of three per stroke: the recognizer's own cost, not a busy machine's scheduling or GC pauses.
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
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(250);
  });
});
