// Stored records: how values are copied on the way in, how each store's records migrate forward, what
// shape an imported record must have, and which of two copies of a record is the newer one.
// Pure functions (Section 9.1 rule 4: "Everything stored carries a schema version. Loaders migrate
// forward through a chain of pure functions. Files are never rewritten silently").
//
// Records are migrated when they are read and when they are imported, never written back on read: a
// record keeps the dataVersion it was saved with until its owner saves it again.

import type { StoreName } from '../../contracts';
import { DATA_VERSION, STORE_NAMES } from '../../contracts';
import { checkSchema, checkSession } from '../../kernel';

export type Rec = Record<string, unknown>;

export function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStoreName(value: unknown): value is StoreName {
  return typeof value === 'string' && (STORE_NAMES as readonly string[]).includes(value);
}

/** Keys longer than this could not travel through "Export my data" (userdata-1.json caps them). */
export const MAX_KEY_LENGTH = 256;

// ---------------------------------------------------------------------------------------- copying

/** How deeply a stored value may nest lists and objects. Structured cloning, IndexedDB and JSON copy
 *  a value recursively, so one nested a thousand or so levels deep overflows the stack: Chrome's
 *  put() throws a RangeError at about 1,500, and a copy kept in memory can then not be read back.
 *  Packs and data files may carry unknown fields of any shape (Section 9.1 rule 3), so a crafted one
 *  can nest that deep; the bound is checked on the way in. Nothing Spellglass stores comes near it:
 *  the deepest record is an imported pack, one level over the 32 a pack may nest
 *  (src/kernel/packs/limits.ts). */
export const MAX_DEPTH = 64;

export const TOO_DEEP = `This value is nested too deeply to save: lists and objects may nest at most ${MAX_DEPTH} levels deep.`;

/**
 * How deeply `value` nests lists and objects (0 for a plain value, 1 for {} or []), counted up to
 * just past `limit`. The walk keeps its own stack, so measuring a hostile value cannot overflow the
 * call stack, and it stops once it is past the limit. An object reached again is walked again only
 * when reached deeper than before, so shared parts cost little, and a value that contains itself
 * counts as deeper than any limit (it could not be exported as JSON either). It reads every part, so
 * it throws what reading one throws (a revoked Proxy, a getter that throws): callers catch that.
 */
export function nestingDepth(value: unknown, limit: number): number {
  if (value === null || typeof value !== 'object') return 0;
  let deepest = 0;
  const reached = new Map<object, number>();
  // Two stacks rather than one of pairs: a recorded session holds a hundred thousand objects.
  const objects: object[] = [value];
  const depths: number[] = [1];
  while (objects.length) {
    const v = objects.pop()!;
    const depth = depths.pop()!;
    if (depth > deepest) {
      deepest = depth;
      if (deepest > limit) return deepest;
    }
    if ((reached.get(v) ?? 0) >= depth) continue;
    reached.set(v, depth);
    for (const child of Array.isArray(v) ? v : Object.values(v)) {
      if (child !== null && typeof child === 'object') {
        objects.push(child);
        depths.push(depth + 1);
      }
    }
  }
  return deepest;
}

export type Cloned = { ok: true; value: unknown; viaJson: boolean } | { ok: false; reason: string };

/**
 * The copy that is stored. IndexedDB stores a structured clone, and the memory fallback must behave
 * the same, or a caller that changes an object after saving it would change the "saved" copy too.
 * structuredClone refuses Proxies (Svelte $state objects) and anything holding a function; those are
 * plain data underneath, so a JSON copy is taken instead (the contract asks callers for
 * $state.snapshot(), this keeps a forgotten one from losing the player's data). Values nested deeper
 * than MAX_DEPTH are refused first, whichever copy would be taken, and so are values that are not
 * data at all (cycles, BigInt). Never throws: whatever cannot be saved is refused with a reason, which
 * the module turns into 'invalid-payload' (contracts/requests.ts: storage rejects with nothing else).
 */
export function cloneForStorage(value: unknown): Cloned {
  // Measuring reads every part, as either copy would, so a part that cannot be read (a revoked Proxy,
  // a getter that throws) makes the value one that cannot be saved, as the copies below would find.
  let depth: number;
  try {
    depth = nestingDepth(value, MAX_DEPTH);
  } catch (err) {
    return { ok: false, reason: cannotSave(err) };
  }
  if (depth > MAX_DEPTH) return { ok: false, reason: TOO_DEEP };
  try {
    return { ok: true, value: structuredClone(value), viaJson: false };
  } catch {
    try {
      const text = JSON.stringify(value);
      if (text === undefined) return { ok: false, reason: 'This value cannot be saved.' };
      return { ok: true, value: JSON.parse(text), viaJson: true };
    } catch (err) {
      return { ok: false, reason: cannotSave(err) };
    }
  }
}

/** The refusal for a value that could not be read or copied, naming the error where it can: what was
 *  thrown may itself be something that cannot be read. */
function cannotSave(err: unknown): string {
  try {
    return `This value cannot be saved (${err instanceof Error ? err.message : String(err)}).`;
  } catch {
    return 'This value cannot be saved.';
  }
}

/** A copy for a reader, so nobody can change what the memory store holds. */
export function copyOut<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  return structuredClone(value);
}

// ------------------------------------------------------------------------------------- migrations

/** One step: a record of dataVersion v in, the same record as dataVersion v + 1 out. */
export type RecordStep = (record: Rec) => Rec;

/**
 * RECORD_MIGRATIONS[store][v] migrates that store's records from dataVersion v to v + 1. Only
 * version 1 exists. When DATA_VERSION becomes 2, add the step for each store whose shape changed,
 * e.g. `progress: { 1: (r) => ({ ...r, streak: 0 }) }`; stores without a step are carried over as
 * they are (their dataVersion is still raised, since their shape is the same in version 2).
 */
export const RECORD_MIGRATIONS: Partial<Record<StoreName, Record<number, RecordStep>>> = {};

/**
 * A record as the current version reads it. Records without a numeric dataVersion (a recorded
 * session carries its own `schema` instead) and records from a newer version are returned as they
 * are: readers are tolerant (Section 9.1 rule 3).
 */
export function migrateRecord(
  store: StoreName,
  value: unknown,
  chain: Partial<Record<StoreName, Record<number, RecordStep>>> = RECORD_MIGRATIONS,
  target: number = DATA_VERSION,
): unknown {
  if (!isRecord(value) || typeof value.dataVersion !== 'number' || !Number.isInteger(value.dataVersion)) return value;
  let out: Rec = value;
  for (let v = value.dataVersion; v < target; v++) {
    const step = chain[store]?.[v];
    out = { ...(step ? step(out) : out), dataVersion: v + 1 };
  }
  return out;
}

// --------------------------------------------------------------------------------- record shapes

const SPELL_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const int = (v: unknown, min = 0): v is number => num(v) && Number.isInteger(v) && v >= min;
const str = (v: unknown, max = 1024): v is string => typeof v === 'string' && v.length <= max;
const fraction = (v: unknown): v is number => num(v) && v >= 0 && v <= 1;
const spellId = (v: unknown): v is string => typeof v === 'string' && v.length <= 64 && SPELL_ID.test(v);
const point = (p: unknown): boolean => Array.isArray(p) && p.length >= 2 && num(p[0]) && num(p[1]);
const path = (v: unknown, min: number, max = 256): boolean => Array.isArray(v) && v.length >= min && v.length <= max && v.every(point);

/** Each store's required fields, as contracts/storage.ts defines them for dataVersion 1 (the
 *  definitions in userdata-1.json describe the same shapes). Unknown fields are allowed and kept.
 *  Returns null when the record is acceptable, else what is wrong with it. */
const SHAPES: Record<StoreName, (key: string, r: Rec) => string | null> = {
  profiles: (_key, r) =>
    str(r.deviceId) && str(r.label) && num(r.width) && num(r.height) && num(r.fps)
    && (r.exposureMode === 'continuous' || r.exposureMode === 'manual')
    && (r.exposureTime === null || num(r.exposureTime)) && num(r.savedAt)
      ? null : 'not a camera profile',
  samples: (key, r) => {
    if (!str(r.id, 128) || !spellId(r.spellId) || !path(r.points, 2) || !fraction(r.score) || !num(r.savedAt)) return 'not a gesture sample';
    if (r.gestureKey !== undefined && !str(r.gestureKey, 64)) return 'not a gesture sample';
    return r.id === key ? null : 'stored under another key than its id';
  },
  overrides: (key, r) => {
    if (!spellId(r.spellId) || !num(r.savedAt) || !checkSchema('gesture/1', r.gesture).ok) return 'not a redrawn gesture';
    if (r.drawnLeftHanded !== undefined && typeof r.drawnLeftHanded !== 'boolean') return 'not a redrawn gesture';
    return r.spellId === key ? null : 'stored under another key than its spell';
  },
  progress: (key, r) => {
    if (!spellId(r.spellId) || !int(r.casts) || !int(r.practiceAttempts) || !fraction(r.best) || !(r.learnedAt === null || num(r.learnedAt))) return 'not spell progress';
    return r.spellId === key ? null : 'stored under another key than its spell';
  },
  keepsakes: (key, r) => {
    const cast = r.cast;
    const castOk = isRecord(cast) && str(cast.id, 128) && spellId(cast.spellId)
      && (cast.via === 'gesture' || cast.via === 'voice' || cast.via === 'both')
      && fraction(cast.quality) && fraction(cast.power) && num(cast.t)
      && isRecord(cast.aim) && num(cast.aim.x) && num(cast.aim.y);
    if (!str(r.id, 128) || !castOk || !str(r.spellName, 200) || !path(r.points, 0) || !num(r.durationMs) || r.durationMs < 0 || !num(r.aspect) || r.aspect <= 0 || !num(r.savedAt)) return 'not a keepsake';
    return r.id === key && (cast as Rec).id === key ? null : 'stored under another key than its cast';
  },
  packs: (_key, r) => (str(r.id, 64) && isRecord(r.json) && num(r.importedAt) ? null : 'not an imported pack'),
  // Recorded sessions carry their own schema ('session/1') and are checked against it.
  sessions: (key, r) => {
    const check = checkSession(r);
    if (!check.ok) return check.reason;
    return r.id === key ? null : 'stored under another key than its id';
  },
  kv: (key, r) => {
    if (!('value' in r)) return 'not a stored value';
    if (key === 'progress.unlockedTier' && !(int(r.value, 1) && r.value <= 99)) return 'not a tier';
    return null;
  },
};

/**
 * Whether a record (already migrated) may be imported into a store. Every stored record carries a
 * dataVersion except recorded sessions, which carry a schema. Returns null when it may, otherwise a
 * short reason for the log.
 */
export function recordProblem(store: StoreName, key: string, value: unknown): string | null {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) return 'has no usable key';
  if (!isRecord(value)) return 'is not a record';
  if (store !== 'sessions' && !int(value.dataVersion, 1)) return 'carries no dataVersion';
  return SHAPES[store](key, value);
}

// --------------------------------------------------------------------------------------- merging

/**
 * Merge import: "the newer savedAt wins" (contracts/requests.ts). Records that carry no savedAt are
 * compared by what stands for their age: an imported pack by importedAt, a recorded session by
 * recordedAt, progress by how far it has got (counts only grow, so more casts is the later state),
 * the unlocked tier by its value (it never goes down). When nothing tells them apart, the copy on
 * this device stays: an import never replaces data it cannot show to be older.
 */
export function incomingIsNewer(store: StoreName, existing: unknown, incoming: unknown): boolean {
  if (!isRecord(incoming)) return false;
  if (!isRecord(existing)) return true;
  const a = ageOf(store, existing);
  const b = ageOf(store, incoming);
  if (!a || !b) return false;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (b[i] !== a[i]) return b[i] > a[i];
  }
  return false;
}

function ageOf(store: StoreName, r: Rec): number[] | null {
  if (num(r.savedAt)) return [r.savedAt];
  switch (store) {
    case 'packs':
      return num(r.importedAt) ? [r.importedAt] : null;
    case 'sessions': {
      const t = typeof r.recordedAt === 'string' ? Date.parse(r.recordedAt) : NaN;
      return Number.isFinite(t) ? [t] : null;
    }
    case 'progress':
      return int(r.casts) && int(r.practiceAttempts) ? [r.casts, r.practiceAttempts, num(r.best) ? r.best : 0] : null;
    case 'kv':
      return num(r.value) ? [r.value] : null;
    default:
      return null;
  }
}
