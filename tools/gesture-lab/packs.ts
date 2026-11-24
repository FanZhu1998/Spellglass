// Spell packs as the recognizer sees them, for the gesture lab (no kernel, no pack loader).
// Mirrors what the pack loader puts in SpellbookEntry.templates: each stored path resampled to 64
// points in its isotropic unit square. No left-handed mirror and no overrides: the lab checks the
// packs as shipped.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SpellPack } from '../../src/contracts';
import { prepareGesture, storedTemplates, type PreparedSpell } from '../../src/modules/recognizers/template/templates';

const PACKS_DIR = fileURLToPath(new URL('../../public/packs/', import.meta.url));

/** The seed spell packs, in the order the pack index lists them. */
export const SEED_PACK_IDS = ['core-charms', 'further-spells', 'restricted-section'] as const;

export function loadSeedPacks(): SpellPack[] {
  return SEED_PACK_IDS.map((id) => JSON.parse(readFileSync(`${PACKS_DIR}${id}/pack.json`, 'utf8')) as SpellPack);
}

/** Every spell of the packs that has a usable gesture, first occurrence of an id winning (as the
 *  pack loader does). Malformed entries are skipped here; reporting them is the schema check's job. */
export function spellsOf(packs: readonly SpellPack[]): SpellPack['spells'] {
  const seen = new Set<string>();
  const out: SpellPack['spells'] = [];
  for (const pack of packs) {
    for (const spell of pack?.spells ?? []) {
      if (!spell || typeof spell.id !== 'string' || seen.has(spell.id) || !usableGesture(spell.gesture)) continue;
      seen.add(spell.id);
      out.push(spell);
    }
  }
  return out;
}

function usableGesture(g: unknown): boolean {
  if (!g || typeof g !== 'object') return false;
  const o = g as Record<string, unknown>;
  if (typeof o.flick === 'string') return ['up', 'down', 'left', 'right'].includes(o.flick);
  const paths = Array.isArray(o.paths) ? o.paths : Array.isArray(o.path) ? [o.path] : null;
  return !!paths && paths.length > 0 && paths.every((p) => Array.isArray(p) && p.length >= 2 && p.every((q) => Array.isArray(q) && q.length >= 2 && Number.isFinite(q[0]) && Number.isFinite(q[1])));
}

export function prepareSpells(packs: readonly SpellPack[]): PreparedSpell[] {
  return spellsOf(packs).map((spell) => ({
    spellId: spell.id,
    gesture: prepareGesture(spell.gesture, 'flick' in spell.gesture ? [] : storedTemplates(spell.gesture)),
    user: [],
  }));
}
