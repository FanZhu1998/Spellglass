// Schema ids and forward migrations (Section 9.1 rule 4): "Loaders migrate forward through a chain of
// pure functions, 1 to 2 to 3. Files are never rewritten silently." Each migration takes a pack that
// is valid in one schema and returns a new object in the next; the input is never changed, so a stored
// user pack keeps its original form and is migrated again every time it loads.

import type { EffectStep, PackKind, Spell, SpellPack, SpellPackV0 } from '../../contracts';
import {
  CURRENT_SPELLPACK_SCHEMA, CURRENT_THEMEPACK_SCHEMA, EFFECT_CAPABILITY, GESTUREPACK_SCHEMAS, SPELLPACK_SCHEMAS,
  THEMEPACK_SCHEMAS,
} from '../../contracts';

export interface SchemaId {
  /** 'spellpack/1' */
  id: string;
  kind: PackKind;
  version: number;
}

/** Schemas this build can read, oldest first, by pack kind. */
export const READABLE_SCHEMAS: Record<PackKind, readonly string[]> = {
  spellpack: SPELLPACK_SCHEMAS,
  themepack: THEMEPACK_SCHEMAS,
  gesturepack: GESTUREPACK_SCHEMAS,
};

/** The schema each kind is migrated to. */
export const CURRENT_SCHEMAS: Record<PackKind, string> = {
  spellpack: CURRENT_SPELLPACK_SCHEMA,
  themepack: CURRENT_THEMEPACK_SCHEMA,
  gesturepack: GESTUREPACK_SCHEMAS[GESTUREPACK_SCHEMAS.length - 1],
};

/** Engine range given to packs from before 'engine' existed. */
export const LEGACY_ENGINE_RANGE = '>=1.0 <2.0';

/** 'spellpack/1' → { kind: 'spellpack', version: 1 }. null for anything that is not a pack schema id. */
export function parseSchemaId(value: unknown): SchemaId | null {
  if (typeof value !== 'string') return null;
  const m = /^(spellpack|themepack|gesturepack)\/(\d{1,4})$/.exec(value);
  if (!m) return null;
  return { id: value, kind: m[1] as PackKind, version: Number(m[2]) };
}

type Migration = { to: string; migrate: (pack: never) => unknown };

/** One step per old schema. Add 'spellpack/1': { to: 'spellpack/2', ... } when spellpack/2 arrives. */
export const MIGRATIONS: Readonly<Record<string, Migration>> = {
  'spellpack/0': { to: 'spellpack/1', migrate: (pack: SpellPackV0) => migrateSpellPack0To1(pack) },
};

/** Apply migrations until the pack is in its kind's current schema. The pack must already be valid in
 *  `from`. Returns the schemas passed through, so callers can say a pack was converted. */
export function migrateForward(pack: unknown, from: string): { pack: unknown; schema: string; path: string[] } {
  let current = pack;
  let schema = from;
  const path = [from];
  // A chain longer than the number of known migrations would be a loop in MIGRATIONS.
  for (let i = 0; i <= Object.keys(MIGRATIONS).length; i++) {
    const step = MIGRATIONS[schema];
    if (!step) break;
    current = step.migrate(current as never);
    schema = step.to;
    path.push(schema);
  }
  return { pack: current, schema, path };
}

/** spellpack/0 → spellpack/1, exactly as contracts/packs.ts SpellPackV0 describes: name → title,
 *  words → incantation, shape → gesture, effect (a bare step list) → { steps, fallback: 'sparkle' },
 *  engine (absent) → '>=1.0 <2.0', needs (absent) → the capabilities of the steps used. Unknown fields
 *  are kept (Section 9.1 rule 3); the renamed fields are not, so nothing is left with two names. */
export function migrateSpellPack0To1(v0: SpellPackV0): SpellPack {
  const { schema: _schema, id, version, name, spells, engine, needs, ...rest } = v0;
  const migrated: Spell[] = spells.map((s) => {
    const { id: spellId, words, shape, effect, ...other } = s;
    // The migrated fields come after the unknown ones, so they win if an old file happened to carry
    // a field of the same name.
    return { id: spellId, ...other, incantation: words, gesture: shape, effect: { steps: effect, fallback: 'sparkle' } };
  });
  return {
    schema: 'spellpack/1',
    id,
    version,
    ...rest,
    engine: typeof engine === 'string' ? engine : LEGACY_ENGINE_RANGE,
    title: name,
    needs: Array.isArray(needs) ? (needs as string[]) : capabilitiesOfSteps(spells.flatMap((s) => s.effect)),
    spells: migrated,
  };
}

/** The capabilities a list of effect steps uses (EFFECT_CAPABILITY), sorted. Unknown uses add nothing:
 *  they are skipped when the pack loads anyway. */
export function capabilitiesOfSteps(steps: readonly EffectStep[]): string[] {
  const caps = new Set<string>();
  for (const step of steps) {
    if (Object.prototype.hasOwnProperty.call(EFFECT_CAPABILITY, step.use)) caps.add(EFFECT_CAPABILITY[step.use as keyof typeof EFFECT_CAPABILITY]);
  }
  return [...caps].sort();
}
