// Everything a parsed pack file goes through before the spellbook may use it (Section 9.3): bound how
// deeply it nests, detect its schema, check it against that schema, migrate it forward, check the
// result against the current schema, check its engine range, and check its template budget. Used for
// bundled packs, the player's stored packs, and imports, right after parsing. Pure and synchronous.

import type { GesturePack, PackKind, SpellPack, ThemePack } from '../../contracts';
import { ENGINE_VERSION } from '../../contracts';
import { satisfies } from '../semver';
import { depthReason, templateReason } from './limits';
import { CURRENT_SCHEMAS, migrateForward, parseSchemaId, READABLE_SCHEMAS } from './migrate';
import { KIND_NAMES, isRecord } from './types';
import { checkSchema, type SchemaName } from './validate';

export interface CheckOptions {
  /** The index says the file is this kind of pack. */
  expectKind?: PackKind;
  /** The index says the file has this id. */
  expectId?: string;
}

export type CheckedPack =
  | { ok: true; kind: 'spellpack'; pack: SpellPack; migratedFrom?: string }
  | { ok: true; kind: 'themepack'; pack: ThemePack; migratedFrom?: string }
  | { ok: true; kind: 'gesturepack'; pack: GesturePack; migratedFrom?: string }
  | { ok: false; reason: string; kind?: PackKind; id?: string; version?: string; title?: string };

/** Check a parsed pack file. On failure the reason is one plain sentence (Section 10.5). */
export function checkPack(json: unknown, options: CheckOptions = {}): CheckedPack {
  if (!isRecord(json)) return { ok: false, reason: 'The file does not hold a pack: a pack is a JSON object.' };
  const meta = bestEffortMeta(json);
  const fail = (reason: string, kind?: PackKind): CheckedPack => ({ ok: false, reason, kind, ...meta });

  // First, before anything walks the file: deeper data would overflow the stack later, where it is
  // hashed or saved, and stop the pack service and storage instead of failing this one pack.
  const tooDeep = depthReason(json);
  if (tooDeep) return fail(tooDeep, parseSchemaId(json.schema)?.kind);

  if (typeof json.schema !== 'string') return fail('The file has no "schema" field, so it is not a Spellglass pack.');
  const schema = parseSchemaId(json.schema);
  if (!schema) return fail(`"${json.schema}" is not a pack format Spellglass knows.`);
  const kindName = KIND_NAMES[schema.kind];
  if (!READABLE_SCHEMAS[schema.kind].includes(schema.id)) {
    const current = parseSchemaId(CURRENT_SCHEMAS[schema.kind]);
    return current && schema.version > current.version
      ? fail(`This ${kindName} uses a newer format (${schema.id}) than this version of Spellglass reads.`, schema.kind)
      : fail(`This ${kindName} uses an old format (${schema.id}) that Spellglass no longer reads.`, schema.kind);
  }
  if (options.expectKind && options.expectKind !== schema.kind) {
    return fail(`The index lists it as a ${KIND_NAMES[options.expectKind]}, but the file is a ${kindName}.`, schema.kind);
  }

  const source = checkSchema(schema.id as SchemaName, json, `The ${kindName}`);
  if (!source.ok) return fail(`The ${kindName} does not match the ${schema.id} format: ${source.reason}`, schema.kind);

  const current = CURRENT_SCHEMAS[schema.kind];
  let pack: unknown = json;
  let migratedFrom: string | undefined;
  if (schema.id !== current) {
    const result = migrateForward(json, schema.id);
    if (result.schema !== current) return fail(`Spellglass cannot convert this ${kindName} from ${schema.id}.`, schema.kind);
    const after = checkSchema(current as SchemaName, result.pack, `The ${kindName}`);
    if (!after.ok) return fail(`After converting it from ${schema.id}, the ${kindName} does not match ${current}: ${after.reason}`, schema.kind);
    pack = result.pack;
    migratedFrom = schema.id;
  }

  const checked = pack as { id: string; engine?: unknown };
  if (options.expectId !== undefined && checked.id !== options.expectId) {
    return fail(`The index lists it as "${options.expectId}", but the file's id is "${checked.id}".`, schema.kind);
  }
  // Spell packs must state an engine range (the schema requires it); other kinds may.
  if (typeof checked.engine === 'string' && !satisfies(ENGINE_VERSION, checked.engine)) {
    return fail(`This ${kindName} needs Spellglass engine ${checked.engine}; this is ${ENGINE_VERSION}.`, schema.kind);
  }
  const tooComplex = templateReason(schema.kind, pack as SpellPack | ThemePack | GesturePack);
  if (tooComplex) return fail(tooComplex, schema.kind);

  const extra = migratedFrom ? { migratedFrom } : {};
  switch (schema.kind) {
    case 'spellpack': return { ok: true, kind: 'spellpack', pack: pack as SpellPack, ...extra };
    case 'themepack': return { ok: true, kind: 'themepack', pack: pack as ThemePack, ...extra };
    case 'gesturepack': return { ok: true, kind: 'gesturepack', pack: pack as GesturePack, ...extra };
  }
}

/** Id, version and title as far as they can be read, so a failed pack can still be listed by name. */
function bestEffortMeta(json: Record<string, unknown>): { id?: string; version?: string; title?: string } {
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 80 ? v : undefined);
  return { id: str(json.id), version: str(json.version), title: str(json.title) ?? str(json.name) };
}
