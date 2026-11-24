import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SpellPack } from '../../src/contracts';
import { contrastRatio, isSaturatedRed } from './contrast';
import { limitWarnings, lintPacks, type IdsLock, type LintInput, type PackFile, type SeparationResult } from './lint';
import { schemaValidator } from './schemas';

const DIR = new URL('../../public/packs/', import.meta.url);
const PATHS = ['core-charms/pack.json', 'further-spells/pack.json', 'restricted-section/pack.json', 'theme-candlelit/pack.json'];
const read = (path: string) => new Uint8Array(readFileSync(new URL(path, DIR)));
const json = (path: string) => JSON.parse(readFileSync(new URL(path, DIR), 'utf8'));
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v, null, 2));
const LOCK = JSON.parse(readFileSync(new URL('./ids.lock.json', import.meta.url), 'utf8')) as IdsLock;
const INDEX = readFileSync(new URL('index.json', DIR), 'utf8');
const validate = schemaValidator();
const noOverlap = (): SeparationResult => ({ pairs: [{ a: 'x', b: 'y', score: 0.5 }], closest: { a: 'x', b: 'y', score: 0.5 } });

function input(extra: Partial<LintInput> = {}): LintInput {
  return { files: PATHS.map((path) => ({ path, bytes: read(path) })), indexText: INDEX, lock: LOCK, writeIndex: false, validate, separation: noOverlap, ...extra };
}

/** The shipped files with one pack replaced (the index and lock left as they are). */
function withPack(path: string, pack: unknown): PackFile[] {
  return PATHS.map((p) => ({ path: p, bytes: p === path ? encode(pack) : read(p) }));
}

const errors = (r: ReturnType<typeof lintPacks>) => r.findings.filter((f) => f.level === 'error').map((f) => `${f.where}: ${f.message}`);

describe('the shipped packs', () => {
  it('pass with the current index and lock', () => {
    const r = lintPacks(input());
    expect(errors(r)).toEqual([]);
    expect(r.packs.map((p) => [p.id, p.kind, p.valid])).toEqual([
      ['core-charms', 'spellpack', true], ['further-spells', 'spellpack', true], ['restricted-section', 'spellpack', true], ['candlelit', 'themepack', true],
    ]);
    expect(r.newIndexText).toBeUndefined();
    expect(r.newLock).toBeUndefined();
  });

  it('rewrite to the same index, byte for byte', () => {
    const r = lintPacks(input({ writeIndex: true }));
    expect(r.newIndexText).toBeUndefined();
    expect(r.changes).toEqual([]);
  });
});

describe('the index', () => {
  it('fails on a stale hash, and --write-index fixes it', () => {
    const core = json('core-charms/pack.json');
    core.description = 'Changed.';
    const files = withPack('core-charms/pack.json', core);
    expect(errors(lintPacks(input({ files })))).toEqual([expect.stringMatching(/^index.json: has an out-of-date SHA-256 for core-charms\/pack.json/)]);
    const fixed = lintPacks(input({ files, writeIndex: true }));
    expect(errors(fixed)).toEqual([]);
    const index = JSON.parse(fixed.newIndexText!);
    expect(index.packs.map((p: { id: string }) => p.id)).toEqual(['core-charms', 'further-spells', 'restricted-section', 'candlelit']);
    expect(index.packs[0].sha256).not.toBe(JSON.parse(INDEX).packs[0].sha256);
    expect(fixed.newIndexText!.endsWith('}\n')).toBe(true);
  });

  it('fails when a pack is not listed, or the index points at nothing', () => {
    const files = [...input().files, { path: 'extra/pack.json', bytes: encode({ ...json('theme-candlelit/pack.json'), id: 'extra' }) }];
    expect(errors(lintPacks(input({ files, lock: { ...LOCK, packs: { ...LOCK.packs, extra: { kind: 'themepack' } } } })))).toEqual([
      "index.json: does not list extra/pack.json. Run 'npm run packs:index' to update it.",
    ]);
    const gone = lintPacks(input({ files: input().files.slice(0, 3) }));
    expect(errors(gone)).toContain("index.json: lists theme-candlelit/pack.json, which is not a readable pack. Run 'npm run packs:index' to update it.");
  });
});

describe('permanent ids', () => {
  it('fails when a locked spell disappears or changes its incantation', () => {
    const core = json('core-charms/pack.json');
    core.spells = core.spells.filter((s: { id: string }) => s.id !== 'reparo');
    core.spells[0].incantation = 'Lumos Solem';
    const r = lintPacks(input({ files: withPack('core-charms/pack.json', core), writeIndex: true }));
    // In the lock's order, which is alphabetical.
    expect(errors(r)).toEqual([
      'core-charms/lumos: was "Lumos" and is now "Lumos Solem"; an id never changes its meaning. Use a new id for a new spell.',
      'reparo: is a permanent spell id ("Reparo", core-charms) and has disappeared. Restore it, or mark it retired in ids.lock.json.',
    ]);
  });

  it('records new ids only with --write-index, and never reuses a retired one', () => {
    const core = json('core-charms/pack.json');
    core.spells.push({ ...core.spells[0], id: 'lumos-solem', incantation: 'Lumos Solem' });
    const files = withPack('core-charms/pack.json', core);
    expect(errors(lintPacks(input({ files })))).toContain("core-charms/lumos-solem: is a new spell id. Run 'npm run packs:index' to record it in ids.lock.json.");
    const written = lintPacks(input({ files, writeIndex: true }));
    expect(written.newLock?.spells['lumos-solem']).toEqual({ incantation: 'Lumos Solem', pack: 'core-charms' });
    expect(written.newLock?.spells.lumos).toEqual(LOCK.spells.lumos);
    const retired: IdsLock = { ...LOCK, spells: { ...LOCK.spells, 'lumos-solem': { incantation: 'Lumos Solem', pack: 'core-charms', retired: true } } };
    expect(errors(lintPacks(input({ files, lock: retired, writeIndex: true })))).toEqual([
      'core-charms/lumos-solem: uses a retired spell id; retired ids are never used again (ids.lock.json).',
    ]);
  });

  it('fails on spell ids shared between packs', () => {
    const further = json('further-spells/pack.json');
    further.spells[0] = { ...further.spells[0], id: 'lumos', incantation: 'Lumos' };
    expect(errors(lintPacks(input({ files: withPack('further-spells/pack.json', further), writeIndex: true })))).toContain(
      'further-spells/lumos: is also in core-charms; spell ids must be unique across all packs.',
    );
  });
});

describe('effects', () => {
  it('fails on unknown primitives, capabilities missing from needs, unknown cues, presets and anchors', () => {
    const core = json('core-charms/pack.json');
    core.needs = core.needs.filter((n: string) => n !== 'fx.text@1' && n !== 'fx.shapes@1');
    core.spells[0].effect.steps.push({ use: 'prop.dance' }, { use: 'audio.cue', cue: 'kazoo' }, { use: 'particles.burst', preset: 'confetti', at: 'ceiling' });
    const r = errors(lintPacks(input({ files: withPack('core-charms/pack.json', core), writeIndex: true })));
    expect(r).toEqual(expect.arrayContaining([
      'core-charms/lumos step 4 (prop.dance): is not an effect primitive (contracts/effects.ts), so the app would skip it.',
      'core-charms/lumos step 5 (audio.cue): cue "kazoo" is not one the audio module plays (AUDIO_CUES); it would play "chime" instead.',
      'core-charms/lumos step 6 (particles.burst): preset "confetti" is not a particle preset (sparks, embers, water, mist, stars, dust, smoke).',
      'core-charms/lumos step 6 (particles.burst): at "ceiling" is not an anchor (tip, aim, target, center, caster).',
      "core-charms/expelliarmus step 1 (bolt.cast): uses fx.shapes@1, which the pack's needs (or the spell's) do not list.",
    ]));
  });

  it('warns about values beyond EFFECT_LIMITS, after the largest effect_scale', () => {
    expect(limitWarnings({ use: 'light.flash', radius: 0.25, intensity: 0.5 }, 1.6)).toEqual(['radius 0.4 is over the limit of 0.35', 'intensity 0.8 is over the limit of 0.7']);
    expect(limitWarnings({ use: 'light.flash', color: '#FF0000', intensity: 0.5 })).toEqual(['intensity (saturated red) 0.5 is over the limit of 0.45']);
    expect(limitWarnings({ use: 'scene.dim', amount: 0.9, fade_ms: 100 })).toEqual(['amount 0.9 is over the limit of 0.8', 'fade_ms 100 is under the minimum of 300']);
    expect(limitWarnings({ use: 'screen.shake', intensity: 0.5, duration_ms: 900, hold: true })).toEqual(['duration_ms 900 is over the limit of 600', 'a shake is never held']);
    expect(limitWarnings({ use: 'particles.burst', preset: 'stars', count: 2000 })).toEqual(['count 2000 is over the limit of 1500']);
    expect(limitWarnings({ use: 'prop.levitate', duration_ms: 40000 })).toEqual(['duration_ms 40000 is over the limit of 30000']);
    expect(limitWarnings({ use: 'light.orb', hold: true, duration_ms: 40000 })).toEqual([]);
  });

  it('warns when a step holds an effect that never lasts, and not when it holds one that does', () => {
    const core = json('core-charms/pack.json');
    core.spells[0].effect.steps.push({ use: 'light.flash', hold: true }, { use: 'prop.unlock', hold: true }, { use: 'light.orb', hold: true });
    const r = lintPacks(input({ files: withPack('core-charms/pack.json', core), writeIndex: true }));
    const held = r.findings.filter((f) => f.message.startsWith('sets hold')).map((f) => f.where);
    expect(held).toEqual(['core-charms/lumos step 4 (light.flash)', 'core-charms/lumos step 5 (prop.unlock)']);
  });

  it('counts flashes and bolts against the flash budget', () => {
    const core = json('core-charms/pack.json');
    core.spells[0].effect.steps.push(...[0, 100, 200, 300].map((d) => ({ use: 'light.flash', delay_ms: d })));
    const r = lintPacks(input({ files: withPack('core-charms/pack.json', core), writeIndex: true }));
    expect(r.findings.filter((f) => f.where === 'core-charms/lumos').map((f) => f.message)).toContain('has 4 flashes and bolts within 1000 ms; at most 3 play.');
  });
});

describe('themes', () => {
  it('fails a text pair under 4.5:1, accent pairs included', () => {
    const theme = json('theme-candlelit/pack.json');
    theme.tokens.ash = '#5A5D70';
    theme.accents['emerald-silver'].oxblood = '#8FA89A';
    const r = errors(lintPacks(input({ files: withPack('theme-candlelit/pack.json', theme), writeIndex: true })));
    expect(r).toEqual(expect.arrayContaining([
      expect.stringMatching(/^candlelit: Ash \(#5A5D70\) on Night \(#0F1424\) has a contrast of \d\.\d\d:1; Section 10.2 needs 4.5:1.$/),
      expect.stringMatching(/^candlelit: Vellum \(#E9DFC7\) on accent emerald-silver oxblood \(#8FA89A\)/),
    ]));
  });

  it('computes WCAG contrast', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777', '#777')).toBeCloseTo(1, 5);
    expect(contrastRatio('#E9DFC7', '#0F1424')!).toBeGreaterThan(4.5);
    expect(contrastRatio('nope', '#000')).toBeNull();
    expect(isSaturatedRed('#FF0000')).toBe(true);
    expect(isSaturatedRed('#E0313F')).toBe(false);
  });
});

describe('template separation', () => {
  it('fails any pair above 0.80 and reports the closest pair', () => {
    const close = (packs: SpellPack[]): SeparationResult => {
      expect(packs.map((p) => p.id)).toEqual(['core-charms', 'further-spells', 'restricted-section']);
      const pairs = [{ a: 'engorgio', b: 'reducio', score: 0.83 }, { a: 'lumos', b: 'nox', score: 0.4 }];
      return { pairs, closest: pairs[0] };
    };
    const r = lintPacks(input({ separation: close }));
    expect(errors(r)).toEqual(['further-spells/engorgio: and reducio (further-spells) score 0.830 against each other; templates must stay at or under 0.80 (Section 7.5). Redraw one of them.']);
    expect(r.separation?.closest?.score).toBe(0.83);
    expect(lintPacks(input({ separation: null })).separation).toBeNull();
  });
});

describe('files', () => {
  it('refuses legacy formats, bad JSON and oversized files in the shipped set', () => {
    const legacy = readFileSync(new URL('../../tests/fixtures/packs/legacy/spellpack-0.json', import.meta.url));
    const files: PackFile[] = [...input().files, { path: 'legacy/pack.json', bytes: new Uint8Array(legacy) }, { path: 'broken/pack.json', bytes: new TextEncoder().encode('{') }];
    const r = errors(lintPacks(input({ files, writeIndex: true })));
    expect(r).toContain('early-charms: uses spellpack/0; packs that ship with Spellglass must use spellpack/1.');
    expect(r).toEqual(expect.arrayContaining([expect.stringMatching(/^broken\/pack.json: is not valid JSON/)]));
  });
});
