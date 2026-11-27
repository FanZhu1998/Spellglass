// Pack files the player shares (Section 11.1 "Your content: a pack file"): exporting the redrawn
// gestures as a gesture pack, and reading stored and imported pack records. Pure functions.

import type { GestureOverride, GesturePack, UserPack } from '../../contracts';
import { DATA_VERSION, PACK_SIZE_LIMIT_BYTES } from '../../contracts';
import { checkPack } from './check';
import { drawingReason } from './limits';
import { failedPack, loadedFromChecked, sizeReason } from './loaded';
import type { LoadedPack } from './types';
import { isRecord } from './types';
import { checkSchema } from './validate';

/** The player's redrawn gestures as one gesture pack. Gestures are stored right-handed, so the file is
 *  the same whichever hand the player uses; the importer's own switch mirrors them. The id carries the
 *  date and a short random part, because ids are permanent and two friends' exports must not collide. */
export function gesturePackFromOverrides(overrides: readonly GestureOverride[], now: Date, random: () => number = Math.random): GesturePack {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const suffix = Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0');
  const gestures: GesturePack['gestures'] = {};
  for (const o of [...overrides].sort((a, b) => (a.spellId < b.spellId ? -1 : a.spellId > b.spellId ? 1 : 0))) gestures[o.spellId] = o.gesture;
  return {
    schema: 'gesturepack/1',
    id: `gestures-${date.replace(/-/g, '')}-${suffix}`,
    version: '1.0.0',
    title: `Redrawn gestures, ${date}`,
    gestures,
  };
}

/** Pretty JSON with a final newline, the form pack files are kept in. */
export function packText(pack: unknown): string {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

export function exportFilename(id: string): string {
  return `${id}.json`;
}

/** UTF-8 byte length without allocating for obviously oversized text (each UTF-16 unit is at least
 *  one UTF-8 byte). */
export function utf8Length(text: string): number {
  if (text.length > PACK_SIZE_LIMIT_BYTES) return text.length;
  return new TextEncoder().encode(text).byteLength;
}

export type ParsedImport = { ok: true; json: unknown } | { ok: false; reason: string };

/** Size limit, then JSON (packs.import). checkPack, which comes next, refuses a file nested too
 *  deeply before anything else walks it (limits.ts). */
export function parseImportText(text: unknown): ParsedImport {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'The file is empty.' };
  const bytes = utf8Length(text);
  if (bytes > PACK_SIZE_LIMIT_BYTES) return { ok: false, reason: `The file is too large: ${sizeReason(bytes)}` };
  try {
    return { ok: true, json: JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) };
  } catch (err) {
    return { ok: false, reason: `The file is not valid JSON (${err instanceof Error ? err.message : String(err)}).` };
  }
}

/** A record of store 'packs' as a loaded pack: checked and migrated like a bundled pack, every time it
 *  loads (the stored file is never rewritten, Section 9.1 rule 4). */
export function userPackFromRecord(key: string, value: unknown): LoadedPack {
  if (!isRecord(value) || !('json' in value)) {
    return failedPack({ id: key, kind: 'spellpack', version: '', reason: 'The saved copy of this pack is damaged.', user: true, storageKey: key });
  }
  const importedAt = typeof value.importedAt === 'number' && Number.isFinite(value.importedAt) ? value.importedAt : 0;
  const checked = checkPack(value.json);
  if (!checked.ok) {
    return failedPack({
      id: checked.id ?? key, kind: checked.kind ?? 'spellpack', version: checked.version ?? '', reason: checked.reason,
      title: checked.title, user: true, storageKey: key, importedAt,
    });
  }
  return loadedFromChecked(checked, { user: true, storageKey: key, importedAt });
}

/** The record stored for an imported pack: the JSON exactly as imported. */
export function userPackRecord(id: string, json: unknown, importedAt: number): UserPack {
  return { dataVersion: DATA_VERSION, id, json, importedAt };
}

export type ReadOverride = { ok: true; override: GestureOverride } | { ok: false; reason: string };

/** A stored override, read tolerantly: a record whose gesture fails the schema is dropped, and so is
 *  one with more templates than a drawing may have (limits.ts drawingReason), which only a data file
 *  brings in. The reason is for the log. */
export function readOverrideRecord(key: string, value: unknown): ReadOverride {
  if (!isRecord(value)) return { ok: false, reason: 'It is not a drawing.' };
  const spellId = typeof value.spellId === 'string' && value.spellId ? value.spellId : key;
  if (!spellId || !checkSchema('gesture/1', value.gesture).ok) return { ok: false, reason: 'It is not a valid gesture.' };
  const gesture = value.gesture as GestureOverride['gesture'];
  const tooComplex = drawingReason(gesture);
  if (tooComplex) return { ok: false, reason: tooComplex };
  return {
    ok: true,
    override: {
      ...value,
      dataVersion: typeof value.dataVersion === 'number' ? value.dataVersion : DATA_VERSION,
      spellId,
      gesture,
      savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0,
    },
  };
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
