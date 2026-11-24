import { describe, expect, it } from 'vitest';
import type { SpellPackV0 } from '../../contracts';
import { capabilitiesOfSteps, migrateForward, migrateSpellPack0To1, parseSchemaId } from './migrate';

const v0 = (extra: Partial<SpellPackV0> = {}): SpellPackV0 => ({
  schema: 'spellpack/0', id: 'old', version: '0.1.0', name: 'Old charms',
  spells: [{ id: 'glow', words: 'Glow', shape: { flick: 'up' }, effect: [{ use: 'light.orb' }, { use: 'audio.cue', cue: 'chime' }, { use: 'mystery.step' }] }],
  ...extra,
});

describe('schema ids', () => {
  it('parses pack schema ids only', () => {
    expect(parseSchemaId('spellpack/0')).toEqual({ id: 'spellpack/0', kind: 'spellpack', version: 0 });
    expect(parseSchemaId('themepack/12')).toMatchObject({ kind: 'themepack', version: 12 });
    expect(parseSchemaId('packindex/1')).toBeNull();
    expect(parseSchemaId('spellpack/1.0')).toBeNull();
    expect(parseSchemaId(1)).toBeNull();
  });
});

describe('spellpack/0 to spellpack/1', () => {
  it('renames, wraps the steps with the sparkle fallback, and derives engine and needs', () => {
    const out = migrateSpellPack0To1(v0());
    expect(out).toEqual({
      schema: 'spellpack/1', id: 'old', version: '0.1.0', engine: '>=1.0 <2.0', title: 'Old charms', needs: ['audio@1', 'fx.light@1'],
      spells: [{ id: 'glow', incantation: 'Glow', gesture: { flick: 'up' }, effect: { steps: [{ use: 'light.orb' }, { use: 'audio.cue', cue: 'chime' }, { use: 'mystery.step' }], fallback: 'sparkle' } }],
    });
    expect('name' in out).toBe(false);
    expect('words' in out.spells[0]).toBe(false);
  });

  it('keeps unknown fields, and an engine or needs the old file already had', () => {
    const out = migrateSpellPack0To1(v0({ engine: '^1.1', needs: ['voice@1'], author: 'me', title: 'ignored' }));
    expect(out).toMatchObject({ engine: '^1.1', needs: ['voice@1'], author: 'me', title: 'Old charms' });
  });

  it('runs the chain from any readable schema to the current one', () => {
    expect(migrateForward(v0(), 'spellpack/0').schema).toBe('spellpack/1');
    const current = { schema: 'spellpack/1' };
    expect(migrateForward(current, 'spellpack/1')).toEqual({ pack: current, schema: 'spellpack/1', path: ['spellpack/1'] });
  });

  it('lists the capabilities steps use, ignoring unknown ones', () => {
    expect(capabilitiesOfSteps([{ use: 'prop.unlock' }, { use: 'light.flash' }, { use: 'prop.mend' }, { use: 'constructor' }])).toEqual(['fx.light@1', 'fx.props@1']);
  });
});
