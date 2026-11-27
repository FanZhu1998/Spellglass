// The JSON Schemas (src/contracts/schemas) through the generated validators: what they accept, what
// they refuse, and that the generated code is current.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { schemaFingerprint } from '../../../tools/gen-validators.mjs';
// @ts-ignore TS2307 before 'npm run gen' has run (see validate.ts)
import { SCHEMA_FINGERPRINT } from './generated/validators.js';
import { checkSchema, validatorsPresent } from './validate';
import { checkSession, checkUserData } from './validate-data';

const shipped = (path: string) => JSON.parse(readFileSync(new URL(`../../../public/packs/${path}`, import.meta.url), 'utf8'));

function spellPack(spell: Record<string, unknown> = {}, pack: Record<string, unknown> = {}) {
  return {
    schema: 'spellpack/1', id: 'test-pack', version: '1.0.0', engine: '>=1.0 <2.0', title: 'Test pack', needs: ['fx.light@1'],
    spells: [{ id: 'glow', incantation: 'Glow', gesture: { flick: 'up' }, effect: { steps: [{ use: 'light.orb' }] }, ...spell }],
    ...pack,
  };
}

const reason = (name: Parameters<typeof checkSchema>[0], data: unknown) => {
  const r = checkSchema(name, data);
  return r.ok ? 'ok' : r.reason;
};

describe('generated validators', () => {
  it('exist and match the current schemas', () => {
    expect(validatorsPresent()).toBe(true);
    expect(SCHEMA_FINGERPRINT, "The validators are out of date: run 'npm run gen'.").toBe(schemaFingerprint());
  });

  it('accept every shipped pack and the index', () => {
    for (const p of ['core-charms/pack.json', 'further-spells/pack.json', 'restricted-section/pack.json']) expect(reason('spellpack/1', shipped(p))).toBe('ok');
    expect(reason('themepack/1', shipped('theme-candlelit/pack.json'))).toBe('ok');
    expect(reason('packindex/1', shipped('index.json'))).toBe('ok');
  });
});

describe('spellpack/1', () => {
  it('allows unknown fields everywhere (readers are tolerant)', () => {
    const pack = spellPack({ sparkle_color: 'blue', effect: { steps: [{ use: 'light.orb', shimmer: 3 }], extra: true } }, { homepage: 'x' });
    expect(reason('spellpack/1', pack)).toBe('ok');
    expect(reason('spellpack/1', spellPack({ gesture: { flick: 'up', wobble: 1 } }))).toBe('ok');
  });

  it('requires the fields of Section 9.2', () => {
    const { engine: _e, ...noEngine } = spellPack();
    expect(reason('spellpack/1', noEngine)).toBe('The file is missing "engine".');
    expect(reason('spellpack/1', spellPack({ effect: undefined }))).toBe('spells[0] (glow) is missing "effect".');
  });

  it('enforces kebab-case ids, versions and capability names', () => {
    expect(reason('spellpack/1', spellPack({ id: 'Glow_Spell' }))).toBe('spells[0] (Glow_Spell).id must be lower-case letters and digits in words joined by hyphens, like core-charms.');
    expect(reason('spellpack/1', spellPack({}, { id: 'test--pack' }))).toMatch(/^id must be lower-case/);
    expect(reason('spellpack/1', spellPack({}, { version: '1.0' }))).toBe('version must be a version like 1.0.0.');
    expect(reason('spellpack/1', spellPack({}, { needs: ['FX Light'] }))).toBe('needs[0] must be a capability like fx.light@1.');
    expect(reason('spellpack/1', spellPack({ ends: ['*', 'lumos'] }))).toBe('ok');
  });

  it('needs exactly one gesture form, and points of two numbers in a sane range', () => {
    expect(reason('spellpack/1', spellPack({ gesture: {} }))).toBe('spells[0] (glow).gesture must have exactly one of "flick", "path" or "paths".');
    expect(reason('spellpack/1', spellPack({ gesture: { flick: 'up', path: [[0, 0], [1, 1]] } }))).toMatch(/exactly one of/);
    expect(reason('spellpack/1', spellPack({ gesture: { flick: 'sideways' } }))).toBe('spells[0] (glow).gesture.flick must be one of "up", "down", "left", "right".');
    expect(reason('spellpack/1', spellPack({ gesture: { path: [[0, 0, 0], [1, 1]] } }))).toBe('spells[0] (glow).gesture.path[0] must be a point of exactly two numbers [x, y].');
    expect(reason('spellpack/1', spellPack({ gesture: { path: [[0, 0], [1]] } }))).toBe('spells[0] (glow).gesture.path[1] must have at least 2 items.');
    expect(reason('spellpack/1', spellPack({ gesture: { path: [[0, 0], [3, 1]] } }))).toBe('spells[0] (glow).gesture.path[1][0] must be at most 1.5.');
    expect(reason('spellpack/1', spellPack({ gesture: { path: [[0.5, 0.5]] } }))).toBe('spells[0] (glow).gesture.path must have at least 2 items.');
    expect(reason('spellpack/1', spellPack({ gesture: { paths: [[[0, 0], [1, 1]], [[1, 0], [0, 1]]], any_start: true, start_points: 4 } }))).toBe('ok');
    const long = Array.from({ length: 257 }, (_, i) => [i / 257, 0.5]);
    expect(reason('spellpack/1', spellPack({ gesture: { path: long } }))).toBe('spells[0] (glow).gesture.path must have at most 256 items.');
  });

  it('limits sizes and types of known fields, and checks colors in steps', () => {
    expect(reason('spellpack/1', spellPack({ incantation: 'x'.repeat(61) }))).toBe('spells[0] (glow).incantation must have at most 60 characters.');
    expect(reason('spellpack/1', spellPack({ tier: 0 }))).toBe('spells[0] (glow).tier must be at least 1.');
    expect(reason('spellpack/1', spellPack({ tier: 1.5 }))).toBe('spells[0] (glow).tier must be a whole number.');
    expect(reason('spellpack/1', spellPack({ effect: { steps: [{ use: 'light.flash', color: 'red' }] } }))).toBe('spells[0] (glow).effect.steps[0].color must be a color like #F2B84B.');
    expect(reason('spellpack/1', spellPack({ effect: { steps: [{ use: 'light.flash', color: '#FFAA0080' }] } }))).toBe('ok');
    expect(reason('spellpack/1', spellPack({ effect: { steps: [{ use: 'audio.cue', cue: 'Chime Rise' }] } }))).toBe('spells[0] (glow).effect.steps[0].cue must be a short lower-case name, like chime-rise.');
    expect(reason('spellpack/1', spellPack({ effect: { steps: [{ use: 'orb' }] } }))).toBe('spells[0] (glow).effect.steps[0].use must be an effect name like light.orb.');
    expect(reason('spellpack/1', spellPack({ effect: { steps: [{ use: 'scene.dim', amount: 2 }] } }))).toBe('spells[0] (glow).effect.steps[0].amount must be at most 1.');
    // Effect step names the app does not know are allowed: the loader skips them (Section 9.1 rule 3).
    expect(reason('spellpack/1', spellPack({ effect: { steps: [{ use: 'prop.dance', tempo: 'fast' }] } }))).toBe('ok');
  });

  it('names several problems, then counts the rest', () => {
    const r = reason('spellpack/1', { schema: 'spellpack/1' });
    expect(r).toBe('The file is missing "id"; The file is missing "version"; The file is missing "engine"; and 3 more problems.');
  });
});

describe('themepack/1', () => {
  const theme = shipped('theme-candlelit/pack.json');
  it('checks colors, token keys and font names', () => {
    expect(reason('themepack/1', { ...theme, tokens: { ...theme.tokens, night: 'navy' } })).toBe('tokens.night must be a color like #F2B84B.');
    expect(reason('themepack/1', { ...theme, tokens: { ...theme.tokens, Night: '#000' } })).toBe('tokens has the key "Night", which must be a short lower-case name, like chime-rise.');
    expect(reason('themepack/1', { ...theme, fonts: { display: 'Fell<script>', text: 'Spectral' } })).toBe('fonts.display must be a font name of letters, digits, spaces and hyphens.');
    expect(reason('themepack/1', { ...theme, accents: { gold: { label: 'Gold', candle: '#FC0' } } })).toBe('accents.gold is missing "oxblood".');
    expect(reason('themepack/1', { ...theme, grades: { cast: [], fizzle: theme.grades.fizzle } })).toBe('grades.cast must have at least 1 item.');
    expect(reason('themepack/1', { ...theme, palette_notes: 'kept' })).toBe('ok');
  });
});

describe('gesturepack/1', () => {
  it('keys gestures by spell id', () => {
    const pack = { schema: 'gesturepack/1', id: 'mine', version: '1.0.0', title: 'Mine', gestures: { lumos: { flick: 'up' } } };
    expect(reason('gesturepack/1', pack)).toBe('ok');
    expect(reason('gesturepack/1', { ...pack, gestures: { 'Lumos!': { flick: 'up' } } })).toMatch(/^gestures has the key "Lumos!"/);
    expect(reason('gesturepack/1', { ...pack, gestures: { lumos: { flick: 'up', paths: [] } } })).toMatch(/gestures.lumos/);
  });
});

describe('packindex/1 entries', () => {
  const entry = { id: 'core-charms', kind: 'spellpack', version: '1.0.0', path: 'core-charms/pack.json', sha256: 'a'.repeat(64) };
  it('keeps paths inside the pack folder', () => {
    expect(reason('packindex/1#entry', entry)).toBe('ok');
    for (const path of ['../x.json', 'a/../../x.json', '/abs.json', 'https://x.test/p.json', 'a/./b.json', 'core/pack.txt', 'a\\b.json']) {
      expect(reason('packindex/1#entry', { ...entry, path })).toMatch(/path must be a relative path/);
    }
    expect(reason('packindex/1#entry', { ...entry, kind: 'soundpack' })).toBe('kind must be one of "spellpack", "themepack", "gesturepack".');
    expect(reason('packindex/1#entry', { ...entry, sha256: 'abc' })).toBe('sha256 must be a SHA-256 digest of 64 hexadecimal digits.');
  });
});

describe('session/1 and spellglass-data/1', () => {
  const session = {
    schema: 'session/1', id: 'session-1', recordedAt: '2026-11-20T10:00:00Z', tracker: 'tracker.pointer', aspect: 16 / 9,
    events: [
      { type: 'tip.found', t: 0, x: 0.5, y: 0.5, conf: 1 },
      { type: 'tip.sample', t: 16, x: 0.51, y: 0.5, conf: 0.9, size: 0.01, frame: 3 },
      { type: 'tip.lost', t: 400, lastSeen: 380 },
      { type: 'voice.incantation', t: 420, text: 'lumos', spellId: 'lumos', conf: 0.8, final: true },
      { type: 'tracker.note', t: 500, anything: true },
    ],
    expected: [{ spellId: 'lumos', t: 450 }, { spellId: null, t: 900, decided: null }],
  };
  it('accept recordings, including event types they do not know', () => {
    expect(checkSession(session)).toEqual({ ok: true });
  });
  it('check the fields of known event types', () => {
    const bad = { ...session, events: [{ type: 'tip.sample', t: 0, x: 0.5, conf: 1 }] };
    const r = checkSession(bad);
    expect(r.ok ? '' : r.reason).toBe('events[0] is missing "y".');
  });
  it("accept a tracker's segmentation needs (contract 1.2), within what the segmenter applies", () => {
    expect(checkSession({ ...session, tracker: 'tracker.hand', segmentation: { lostMs: 500, minSamples: 5, pauseMs: 300 } })).toEqual({ ok: true });
    expect(checkSession({ ...session, segmentation: {} })).toEqual({ ok: true });
    for (const segmentation of [{ lostMs: -1 }, { pauseMs: 2001 }, { minSamples: 'five' }, 500]) {
      expect(checkSession({ ...session, segmentation }).ok, JSON.stringify(segmentation)).toBe(false);
    }
  });
  it('accept a data export envelope and leave its records to storage', () => {
    const data = { schema: 'spellglass-data/1', dataVersion: 1, settingsVersion: 1, exportedAt: '2026-11-20T10:00:00Z', settings: {}, stores: { progress: [{ key: 'lumos', value: { anything: 1 } }], futurestore: [] } };
    expect(checkUserData(data)).toEqual({ ok: true });
    const r = checkUserData({ ...data, stores: { progress: [{ value: 1 }] } });
    expect(r.ok ? '' : r.reason).toBe('stores.progress[0] is missing "key".');
  });
});
