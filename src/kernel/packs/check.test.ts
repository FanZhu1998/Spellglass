// The checks every pack goes through before the spellbook may use it (check.ts), here the limits that
// keep a pack from a friend safe to open (limits.ts): how deeply it nests, and how many gesture
// templates it asks the recognizer to build. Also the template limit on the player's drawings.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkPack } from './check';
import { drawingReason, nestingDepth, PACK_DEPTH_LIMIT, templateCount, TEMPLATES_PER_DRAWING, TEMPLATES_PER_PACK, TEMPLATES_PER_SPELL } from './limits';

const shipped = (path: string) => JSON.parse(readFileSync(new URL(`../../../public/packs/${path}`, import.meta.url), 'utf8'));

/** A closed loop of n points, rounded so a big pack stays under the size limit. */
const loop = (n = 9): [number, number][] =>
  Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / (n - 1);
    return [Math.round((0.5 + 0.4 * Math.cos(a)) * 100) / 100, Math.round((0.5 + 0.4 * Math.sin(a)) * 100) / 100];
  });

const spell = (id: string, gesture: unknown, extra: Record<string, unknown> = {}) => ({
  id, incantation: 'Glacius', gesture, effect: { steps: [{ use: 'light.flash' }], fallback: 'sparkle' }, ...extra,
});

function spellPack(spells: unknown[], extra: Record<string, unknown> = {}) {
  return { schema: 'spellpack/1', id: 'friend-charms', version: '1.0.0', engine: '>=1.0 <2.0', title: 'Friend charms', needs: [], spells, ...extra };
}

/** `depth` lists, one inside the other. */
function nested(depth: number): unknown {
  let v: unknown = 0;
  for (let i = 0; i < depth; i++) v = [v];
  return v;
}

const reason = (json: unknown) => {
  const r = checkPack(json);
  return r.ok ? 'ok' : r.reason;
};

const TOO_DEEP = `The file is nested too deeply: a pack may nest lists and objects at most ${PACK_DEPTH_LIMIT} levels deep.`;

describe('nesting depth', () => {
  it('counts lists and objects, and stops once past the limit', () => {
    expect(nestingDepth(3)).toBe(0);
    expect(nestingDepth({})).toBe(1);
    expect(nestingDepth({ a: [1, { b: [] }], c: 'x' })).toBe(4);
    expect(nestingDepth(nested(10), 4)).toBe(5);
    // A hostile depth is measured without overflowing the stack.
    expect(nestingDepth(JSON.parse(`${'['.repeat(100_000)}${']'.repeat(100_000)}`), PACK_DEPTH_LIMIT)).toBe(PACK_DEPTH_LIMIT + 1);
  });

  it('refuses a pack nested deeper than the limit, wherever the depth is', () => {
    // The pack object is the first level.
    expect(reason(spellPack([spell('glacius', { flick: 'up' })], { notes: nested(PACK_DEPTH_LIMIT - 1) }))).toBe('ok');
    expect(reason(spellPack([spell('glacius', { flick: 'up' })], { notes: nested(PACK_DEPTH_LIMIT) }))).toBe(TOO_DEEP);
    expect(reason(spellPack([spell('glacius', { flick: 'up', wobble: nested(3000) })]))).toBe(TOO_DEEP);
    const theme = shipped('theme-candlelit/pack.json');
    expect(reason({ ...theme, id: 'dusk', moon: nested(3000) })).toBe(TOO_DEEP);
    expect(reason({ schema: 'gesturepack/1', id: 'mine', version: '1.0.0', title: 'Mine', gestures: { lumos: { flick: 'up', x: nested(40) } } })).toBe(TOO_DEEP);
  });

  it('names the pack it refuses, so it can be listed', () => {
    const r = checkPack(spellPack([], { notes: nested(100) }));
    expect(r).toMatchObject({ ok: false, id: 'friend-charms', version: '1.0.0', title: 'Friend charms' });
  });
});

describe('the template budget', () => {
  it('counts one template per path, times its start points when any_start is set', () => {
    expect(templateCount({ flick: 'up' })).toBe(1);
    expect(templateCount({ path: loop() })).toBe(1);
    expect(templateCount({ paths: [loop(), loop(), loop()] })).toBe(3);
    expect(templateCount({ path: loop(), any_start: true })).toBe(4); // DEFAULT_START_POINTS
    expect(templateCount({ path: loop(), any_start: false, start_points: 12 })).toBe(1);
    // The recognizer builds at most 16 start points per path, whatever the pack asks for.
    expect(templateCount({ paths: [loop(), loop()], any_start: true, start_points: 32 })).toBe(32);
  });

  it('accepts the shipped packs', () => {
    for (const p of ['core-charms/pack.json', 'further-spells/pack.json', 'restricted-section/pack.json', 'theme-candlelit/pack.json']) {
      expect(reason(shipped(p))).toBe('ok');
    }
  });

  it('refuses a spell that asks for more than its share', () => {
    const many = { paths: Array.from({ length: 16 }, () => loop()), any_start: true, start_points: 32 };
    expect(reason(spellPack([spell('lumos', { flick: 'up' }), spell('glacius', many)]))).toBe(
      `This spell pack is too complex to match quickly: spell "glacius" has 256 gesture templates, and a spell may have at most ${TEMPLATES_PER_SPELL}.`,
    );
  });

  it('refuses a pack whose spells together ask for too many, far under the size limit', () => {
    // 32 templates each: within a spell's share, but 63 of them pass the pack's.
    const spells = (n: number) => Array.from({ length: n }, (_, i) => spell(`spell-${i + 1}`, { paths: [loop(), loop()], any_start: true, start_points: 16 }));
    expect(reason(spellPack(spells(62)))).toBe('ok');
    const big = spellPack(spells(63));
    expect(JSON.stringify(big).length).toBeLessThan(100_000);
    expect(reason(big)).toBe(`This spell pack is too complex to match quickly: it has 2016 gesture templates, and a pack may have at most ${TEMPLATES_PER_PACK}.`);
  });

  it('counts a gesture pack\'s gestures at the most they can take from the spell they replace', () => {
    // What a gesture sets itself is counted as it is.
    expect(templateCount({ path: loop(), any_start: true, start_points: 12 }, true)).toBe(12);
    expect(templateCount({ paths: [loop(), loop()], any_start: false }, true)).toBe(2);
    expect(templateCount({ flick: 'up' }, true)).toBe(1);
    // What it leaves unset comes from the spell's gesture (drawing.ts inheritFromPack): any_start, and
    // up to 16 start points.
    expect(templateCount({ paths: [loop(), loop()] }, true)).toBe(32);
    expect(templateCount({ path: loop(), any_start: true }, true)).toBe(16);
    expect(templateCount({ paths: [loop(), loop()], start_points: 3 }, true)).toBe(6);

    const layer = (gestures: Record<string, unknown>) => ({ schema: 'gesturepack/1', id: 'mine', version: '1.0.0', title: 'Mine', gestures });
    const loops = (n: number) => Array.from({ length: n }, () => loop());
    expect(reason(layer({ protego: { path: loop(), any_start: true, start_points: 12 } }))).toBe('ok');
    expect(reason(layer({ protego: { paths: loops(8), any_start: true, start_points: 16 } }))).toBe(
      `This gesture pack is too complex to match quickly: the gesture for "protego" can have up to 128 gesture templates, and a spell may have at most ${TEMPLATES_PER_SPELL}.`,
    );
    // Sixteen paths that set nothing: over a spell with any_start (Protego has 12 start points), they
    // would become 192 templates, so they are refused like the spell pack that asks for as many.
    expect(reason(layer({ protego: { paths: loops(16) } }))).toBe(
      `This gesture pack is too complex to match quickly: the gesture for "protego" can have up to 256 gesture templates, and a spell may have at most ${TEMPLATES_PER_SPELL}.`,
    );
    expect(reason(layer({ protego: { paths: loops(16), any_start: false } }))).toBe('ok');
    // The pack's total is counted the same way.
    const many = Object.fromEntries(Array.from({ length: 126 }, (_, i) => [`spell-${i + 1}`, { path: loop() }]));
    expect(reason(layer(many))).toBe(
      `This gesture pack is too complex to match quickly: it can have up to 2016 gesture templates, and a pack may have at most ${TEMPLATES_PER_PACK}.`,
    );
  });

  it('checks a legacy pack after migrating it', () => {
    const v0 = {
      schema: 'spellpack/0', id: 'old-charms', version: '0.9.0', name: 'Old charms',
      spells: [{ id: 'glacius', words: 'Glacius', shape: { paths: Array.from({ length: 16 }, () => loop()), any_start: true, start_points: 5 }, effect: [{ use: 'light.flash' }] }],
    };
    expect(reason(v0)).toMatch(/^This spell pack is too complex to match quickly: spell "glacius" has 80 gesture templates/);
    // At the share exactly is fine: 16 paths and the default four start points.
    expect(reason({ ...v0, spells: [{ ...v0.spells[0], shape: { paths: v0.spells[0].shape.paths, any_start: true } }] })).toBe('ok');
  });
});

describe('the limit on drawings', () => {
  const tooComplex = (n: number) =>
    `This drawing is too complex to match quickly: it can have up to ${n} gesture templates, and a drawing, which is one stroke, may have at most ${TEMPLATES_PER_DRAWING}.`;

  it('lets through everything one drawn stroke can become', () => {
    expect(drawingReason({ flick: 'up' })).toBeNull();
    // A path that sets nothing may take up to 16 start points from the spell it is for.
    expect(drawingReason({ path: loop() })).toBeNull();
    expect(drawingReason({ path: loop(), any_start: true, start_points: 32 })).toBeNull();
    expect(drawingReason({ path: loop(), any_start: true, start_points: 12, parts: [{ until: 1, name: 'the circle' }] })).toBeNull();
    expect(drawingReason({ paths: Array.from({ length: 16 }, () => loop()), any_start: false })).toBeNull();
  });

  it('refuses more, counted at the most it can take from its spell', () => {
    expect(drawingReason({ paths: [loop(), loop()] })).toBe(tooComplex(32));
    expect(drawingReason({ paths: [loop(), loop()], any_start: true, start_points: 12 })).toBe(tooComplex(24));
    expect(drawingReason({ paths: Array.from({ length: 16 }, () => loop()), any_start: true, start_points: 16 })).toBe(tooComplex(256));
  });
});
