import { describe, expect, it } from 'vitest';
import type { Spell, SpellbookEntry } from '../../contracts';
import type { ActiveCast } from './rules';
import { activationFor, ActiveSpells, Cooldowns } from './rules';
import { seedSpell, seedSpellbook } from './test-support';

const entries = new Map<string, SpellbookEntry>(seedSpellbook().spells.map((e) => [e.spell.id, e]));

function active(spellId: string, castId = `c-${spellId}`): ActiveCast {
  return { castId, spellId, since: 0, endsAt: null, endBy: null, fromRequest: false };
}

describe('ActiveSpells', () => {
  it('knows what needs_active is missing (Nox needs Lumos)', () => {
    const a = new ActiveSpells();
    expect(a.missingNeeds(seedSpell('nox'))).toEqual(['lumos']);
    a.add(active('lumos'));
    expect(a.missingNeeds(seedSpell('nox'))).toEqual([]);
  });

  it('ends what a spell lists in `ends`', () => {
    const a = new ActiveSpells();
    a.add(active('incendio'));
    a.add(active('lumos'));
    expect(a.endedBy(seedSpell('aguamenti'), entries).map((x) => x.spellId)).toEqual(['incendio']);
  });

  it("ends every active spell for '*', oldest first", () => {
    const a = new ActiveSpells();
    a.add(active('lumos'));
    a.add(active('protego'));
    a.add(active('muffliato'));
    expect(a.endedBy(seedSpell('finite-incantatem'), entries).map((x) => x.spellId)).toEqual(['lumos', 'protego', 'muffliato']);
  });

  it('ends an active spell whose ended_by lists the cast spell, even when the cast spell lists nothing', () => {
    const a = new ActiveSpells();
    a.add(active('lumos'));
    const quietNox: Spell = { ...seedSpell('nox'), ends: undefined };
    expect(a.endedBy(quietNox, entries).map((x) => x.spellId)).toEqual(['lumos']);
    expect(a.endedBy(seedSpell('stupefy'), entries)).toEqual([]);
  });

  it('ends its own earlier activation when a spell is cast again', () => {
    const a = new ActiveSpells();
    a.add(active('protego', 'first'));
    expect(a.endedBy(seedSpell('protego'), entries).map((x) => x.castId)).toEqual(['first']);
  });

  it('lists due activations earliest first', () => {
    const a = new ActiveSpells();
    a.add({ ...active('protego'), endsAt: 5250, endBy: 'timeout' });
    a.add({ ...active('locomotor'), endsAt: 3000, endBy: 'timeout' });
    a.add(active('lumos'));
    expect(a.nextDue()).toBe(3000);
    expect(a.due(4000).map((x) => x.spellId)).toEqual(['locomotor']);
    expect(a.due(6000).map((x) => x.spellId)).toEqual(['locomotor', 'protego']);
  });
});

describe('activationFor', () => {
  it('counts timed spells from the bloom', () => {
    expect(activationFor(5000, 1000, 250)).toEqual({ endsAt: 6250, endBy: 'timeout' });
    expect(activationFor('until-ended', 1000, 250)).toEqual({ endsAt: null, endBy: null });
    expect(activationFor(null, 1000, 250)).toBeNull();
  });

  it("gives a replay's until-ended spell its hold", () => {
    expect(activationFor('until-ended', 1000, 250, 4000)).toEqual({ endsAt: 5250, endBy: 'replay' });
    expect(activationFor(5000, 1000, 250, 4000)).toEqual({ endsAt: 6250, endBy: 'timeout' });
  });
});

describe('Cooldowns', () => {
  it('blocks a spell cast again within cooldown_ms of capture time', () => {
    const c = new Cooldowns();
    const lumos = seedSpell('lumos');
    expect(c.blocked(lumos, 1000)).toBe(false);
    c.note('lumos', 1000);
    expect(c.blocked(lumos, 1399)).toBe(true);
    expect(c.blocked(lumos, 1400)).toBe(false);
    expect(c.blocked(seedSpell('nox'), 1001)).toBe(false); // Nox has no cooldown
    c.clear();
    expect(c.blocked(lumos, 1001)).toBe(false);
  });
});
