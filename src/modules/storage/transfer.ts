// "Export my data" and "Import" (Section 9.4): one JSON file with camera profiles, gesture samples,
// progress and settings, read back from any older version. Pure functions: the module reads the
// stores and the settings, these build the file and plan what an import writes.
//
// Three version numbers travel in the file, each with its own chain of pure migrations:
//   dataVersion      the file as a whole (EXPORT_MIGRATIONS, below)
//   record dataVersion   each record (RECORD_MIGRATIONS in records.ts)
//   settingsVersion  the settings object (SETTINGS_MIGRATIONS, below)
// Only version 1 of each exists. Adding version 2 is one function in the matching table.

import type { StoreName, UserDataExport } from '../../contracts';
import { DATA_VERSION, DEFAULT_SETTINGS, EPHEMERAL_SETTINGS, SETTINGS_VERSION, STORE_NAMES } from '../../contracts';
import { checkUserData, SETTINGS_MIGRATIONS as KERNEL_SETTINGS_MIGRATIONS } from '../../kernel';
import type { Rec } from './records';
import { MAX_DEPTH, incomingIsNewer, isRecord, isStoreName, migrateRecord, nestingDepth, recordProblem } from './records';

export const EXPORT_SCHEMA = 'spellglass-data/1';

/** "Export my data" leaves out recorded sessions unless asked: they are diagnostics, and large. */
export const DEFAULT_EXPORT_STORES: readonly StoreName[] = STORE_NAMES.filter((s) => s !== 'sessions');

/** A file holds each record four levels down (the file, its stores, a store's list, the row), so it
 *  nests at most this deep when every record keeps within MAX_DEPTH. */
export const MAX_FILE_DEPTH = MAX_DEPTH + 4;

/** Settings that name something only this browser profile knows. 'capture.deviceId' is a camera id as
 *  the browser gives it to this site: another browser, or this one after its site data was cleared,
 *  has other ids, so on import it names no camera and capture would report the chosen camera missing.
 *  The export leaves these out, so that no file made from now on carries them, also not to an older
 *  edition that would apply them; an import skips them in files that do. */
export const DEVICE_BOUND_SETTINGS: readonly string[] = ['capture.deviceId'];

export interface Row {
  key: string;
  value: unknown;
}

export const IMPORT_MESSAGES = {
  notJson: 'The file is not valid JSON.',
  notData: 'This is not a Spellglass data file. Choose a file made with "Export my data".',
  newer: 'This file was saved by a newer edition of Spellglass. Reload the page to update, then import it again.',
  tooDeep: 'This file is nested too deeply to be a Spellglass data file.',
  /** The store would not take one of the file's records, so the import wrote nothing. */
  refused: 'A record in this file cannot be saved, so nothing was imported.',
} as const;

// ------------------------------------------------------------------------------------------ export

export function buildExport(input: {
  settings: Record<string, unknown>;
  stores: ReadonlyMap<StoreName, readonly Row[]>;
  now: Date;
}): UserDataExport {
  const stores: UserDataExport['stores'] = {};
  for (const [name, rows] of input.stores) stores[name] = rows.map((r) => ({ key: r.key, value: r.value }));
  const settings = Object.fromEntries(Object.entries(input.settings).filter(([key]) => !DEVICE_BOUND_SETTINGS.includes(key)));
  return {
    schema: EXPORT_SCHEMA,
    dataVersion: DATA_VERSION,
    settingsVersion: SETTINGS_VERSION,
    exportedAt: input.now.toISOString(),
    settings,
    stores,
  };
}

// ------------------------------------------------------------------------------- file migrations

/** One step: an export file of dataVersion v in, the same file as dataVersion v + 1 out. For example
 *  a store renamed in version 2: `1: (doc) => ({ ...doc, stores: renameStore(doc.stores, 'old', 'new') })`. */
export type ExportStep = (doc: Rec) => Rec;

/** EXPORT_MIGRATIONS[v] migrates a whole file from dataVersion v to v + 1. Empty: only version 1 exists. */
export const EXPORT_MIGRATIONS: Record<number, ExportStep> = {};

export function migrateExport(doc: Rec, chain: Record<number, ExportStep> = EXPORT_MIGRATIONS, target: number = DATA_VERSION): Rec {
  const from = typeof doc.dataVersion === 'number' && Number.isInteger(doc.dataVersion) ? doc.dataVersion : target;
  let out = doc;
  for (let v = from; v < target; v++) {
    const step = chain[v];
    out = { ...(step ? step(out) : out), dataVersion: v + 1 };
  }
  return out;
}

/** One step: settings of settingsVersion v in, settingsVersion v + 1 out. */
export type SettingsStep = (values: Record<string, unknown>) => Record<string, unknown>;

/** SETTINGS_MIGRATIONS[v] migrates exported settings from settingsVersion v to v + 1. It is the
 *  kernel's chain, the one stored settings go through, so a new settings version is one step in one
 *  place (src/kernel/settings.ts). */
export const SETTINGS_MIGRATIONS: Readonly<Record<number, SettingsStep>> = KERNEL_SETTINGS_MIGRATIONS;

// ---------------------------------------------------------------------------------- reading files

export type ReadResult = { ok: true; doc: UserDataExport } | { ok: false; reason: string };

/**
 * An import file (the parsed object, or its text) as a current-version export, or the reason it
 * cannot be read. The envelope is checked against userdata-1.json after migration; the records
 * inside are checked one by one when the import is planned.
 */
export function readExport(input: unknown): ReadResult {
  let data = input;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data.charCodeAt(0) === 0xfeff ? data.slice(1) : data);
    } catch {
      return { ok: false, reason: IMPORT_MESSAGES.notJson };
    }
  }
  // Before anything else walks the file: JSON allows any depth, and a record nested thousands deep
  // would overflow whatever copies or saves it (records.ts MAX_DEPTH). The whole file is refused,
  // as one that is not a data file is: nothing of it is imported. The walk reads every part, so an
  // object handed over in the page with a part that cannot be read (a revoked Proxy, a getter that
  // throws) is refused here too, as not a data file, rather than thrown out of the request.
  let depth: number;
  try {
    depth = nestingDepth(data, MAX_FILE_DEPTH);
  } catch {
    return { ok: false, reason: IMPORT_MESSAGES.notData };
  }
  if (depth > MAX_FILE_DEPTH) return { ok: false, reason: IMPORT_MESSAGES.tooDeep };
  if (!isRecord(data)) return { ok: false, reason: IMPORT_MESSAGES.notData };
  const schema = typeof data.schema === 'string' ? /^spellglass-data\/(\d+)$/.exec(data.schema) : null;
  if (!schema) return { ok: false, reason: IMPORT_MESSAGES.notData };
  // A newer file may hold records this edition would misread; it is refused rather than half-read.
  if (Number(schema[1]) > 1) return { ok: false, reason: IMPORT_MESSAGES.newer };
  if (typeof data.dataVersion === 'number' && data.dataVersion > DATA_VERSION) return { ok: false, reason: IMPORT_MESSAGES.newer };
  const migrated = migrateExport(data);
  const check = checkUserData(migrated);
  if (!check.ok) return { ok: false, reason: check.reason };
  return { ok: true, doc: migrated as unknown as UserDataExport };
}

// ----------------------------------------------------------------------------------------- settings

export interface SettingsPlan {
  /** Settings to apply through 'settings.set', in file order. */
  apply: { key: string; value: unknown }[];
  /** Keys left out, with why. */
  skipped: { key: string; why: 'unknown' | 'session-only' | 'device-bound' | 'newer-format' }[];
}

/** Which of a file's settings to apply: known keys only, never the session-only or device-bound ones
 *  (DEVICE_BOUND_SETTINGS: this device keeps its own choice of camera), and nothing from a newer
 *  settings format (its keys may mean something else). The kernel then refuses values of the wrong
 *  type, and the module skips those too. */
export function planSettings(doc: UserDataExport, chain: Readonly<Record<number, SettingsStep>> = SETTINGS_MIGRATIONS): SettingsPlan {
  const out: SettingsPlan = { apply: [], skipped: [] };
  const raw = isRecord(doc.settings) ? doc.settings : {};
  const from = typeof doc.settingsVersion === 'number' && Number.isInteger(doc.settingsVersion) ? doc.settingsVersion : SETTINGS_VERSION;
  if (from > SETTINGS_VERSION) {
    for (const key of Object.keys(raw)) out.skipped.push({ key, why: 'newer-format' });
    return out;
  }
  let values: Record<string, unknown> = { ...raw };
  for (let v = from; v < SETTINGS_VERSION; v++) {
    const step = chain[v];
    if (step) values = step(values);
  }
  for (const [key, value] of Object.entries(values)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) out.skipped.push({ key, why: 'unknown' });
    else if ((EPHEMERAL_SETTINGS as readonly string[]).includes(key)) out.skipped.push({ key, why: 'session-only' });
    else if (DEVICE_BOUND_SETTINGS.includes(key)) out.skipped.push({ key, why: 'device-bound' });
    else out.apply.push({ key, value });
  }
  return out;
}

// ----------------------------------------------------------------------------------------- records

export interface ImportPlan {
  /** Stores to empty first (mode 'replace'). */
  clear: StoreName[];
  /** Records to write, per store. */
  put: Map<StoreName, Row[]>;
  /** Records written, per store (what 'storage.import' reports). */
  imported: Partial<Record<StoreName, number>>;
  /** Records left out because they failed their checks, with the reason, for the log. */
  invalid: { store: StoreName; key: string; why: string }[];
  /** Records left out because this device's copy is newer (merge). */
  kept: number;
  /** Store names in the file that this edition does not know (ignored, Section 9.1 rule 3). */
  unknownStores: string[];
}

/** The stores of a file that this edition knows, in file order. */
export function storesIn(doc: UserDataExport): StoreName[] {
  return Object.keys(isRecord(doc.stores) ? doc.stores : {}).filter(isStoreName);
}

/**
 * What an import writes. Each record is migrated, then checked; records that fail are left out (and
 * counted), never patched up. merge: a record replaces this device's copy only when it is newer
 * (incomingIsNewer); replace: the file's stores are emptied first and then hold exactly the file's
 * valid records. Stores the file does not mention are never touched.
 */
export function planImport(doc: UserDataExport, existing: ReadonlyMap<StoreName, readonly Row[]>, mode: 'merge' | 'replace'): ImportPlan {
  const plan: ImportPlan = { clear: [], put: new Map(), imported: {}, invalid: [], kept: 0, unknownStores: [] };
  const fileStores = isRecord(doc.stores) ? (doc.stores as Record<string, unknown>) : {};
  for (const name of Object.keys(fileStores)) if (!isStoreName(name)) plan.unknownStores.push(name);
  for (const store of storesIn(doc)) {
    const rows = Array.isArray(fileStores[store]) ? (fileStores[store] as unknown[]) : [];
    const here = new Map((existing.get(store) ?? []).map((r) => [r.key, r.value]));
    // The last copy of a key in the file wins, as it would if the file were written in order.
    const chosen = new Map<string, unknown>();
    for (const row of rows) {
      if (!isRecord(row) || typeof row.key !== 'string') {
        plan.invalid.push({ store, key: '?', why: 'is not a { key, value } record' });
        continue;
      }
      const value = migrateRecord(store, row.value);
      const problem = recordProblem(store, row.key, value);
      if (problem) {
        plan.invalid.push({ store, key: row.key, why: problem });
        continue;
      }
      chosen.set(row.key, value);
    }
    const writes: Row[] = [];
    for (const [key, value] of chosen) {
      if (mode === 'merge' && here.has(key) && !incomingIsNewer(store, migrateRecord(store, here.get(key)), value)) {
        plan.kept++;
        continue;
      }
      writes.push({ key, value });
    }
    if (mode === 'replace') plan.clear.push(store);
    if (writes.length) plan.put.set(store, writes);
    plan.imported[store] = writes.length;
  }
  return plan;
}
