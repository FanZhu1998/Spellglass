// Dev harness only: a minimal spellbook built straight from the bundled pack files, so the stage
// can be looked at without the pack service. Not used by the app.

import type { Spell, SpellPack, Spellbook, SpellbookEntry, ThemePack } from '../../../../../contracts';
import { geometry, gestureKey, gesturePaths } from '../../../../../kernel';

function lastsOf(spell: Spell): SpellbookEntry['lasts'] {
  if (typeof spell.duration_ms === 'number') return spell.duration_ms;
  if (spell.effect.steps.some((s) => s.hold === true)) return 'until-ended';
  return null;
}

export async function buildSpellbook(base: string): Promise<Spellbook> {
  const load = async <T,>(path: string): Promise<T> => (await fetch(`${base}${path}`)).json() as Promise<T>;
  const packs = await Promise.all(['core-charms', 'further-spells', 'restricted-section'].map((id) => load<SpellPack>(`packs/${id}/pack.json`)));
  const theme = await load<ThemePack>('packs/theme-candlelit/pack.json');
  const spells: SpellbookEntry[] = [];
  for (const pack of packs) {
    for (const spell of pack.spells) {
      spells.push({
        spell, packId: pack.id, packTitle: pack.title, available: true, status: 'open', enabled: true, overridden: false,
        gestureSource: 'pack', gestureKey: gestureKey(spell.gesture), mirrored: false,
        templates: gesturePaths(spell.gesture).map((p) => geometry.resample(p, 64)),
        lasts: lastsOf(spell), skippedSteps: [], accepted: 0,
      });
    }
  }
  return {
    revision: 1, unlockedTier: 9, learnAfter: 3, theme, spells,
    packs: packs.map((p) => ({ id: p.id, kind: 'spellpack', title: p.title, version: p.version, enabled: true, user: false, unmet: [] })),
  };
}
