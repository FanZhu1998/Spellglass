// Reading the bundled packs (Section 9.3): fetch the index, then each pack file as bytes; refuse files
// over PACK_SIZE_LIMIT_BYTES, check the SHA-256 the index gives, decode, parse and check the pack
// (checkPack also refuses one nested too deeply or asking for too many templates, limits.ts).
// A pack that fails is reported and skipped; the others still load (Section 7.9). Nothing here throws.

import type { PackFailed, PackIndexEntry, PackKind } from '../../contracts';
import { PACK_SIZE_LIMIT_BYTES, PACKINDEX_SCHEMA } from '../../contracts';
import { checkPack } from './check';
import { failedPack, loadedFromChecked, sizeReason } from './loaded';
import type { LoadedPack } from './types';
import { isRecord } from './types';
import { checkSchema } from './validate';

export interface BundledPacks {
  /** In index order; failed packs included (with error set), so the Workshop can name them. */
  packs: LoadedPack[];
  /** Set when the index itself could not be read. */
  indexError?: string;
  /** pack.failed payloads for problems that have no pack of their own: the index, duplicate entries. */
  failures: PackFailed[];
}

/** A relative URL is resolved against the page (location is read only when this runs, never at import). */
export function absoluteUrl(url: string): URL {
  const base = typeof location !== 'undefined' && location && typeof location.href === 'string' ? location.href : 'http://localhost/';
  return new URL(url, base);
}

export async function loadBundledPacks(indexUrl: string, fetchFn: typeof fetch): Promise<BundledPacks> {
  let indexAbs: URL;
  try {
    indexAbs = absoluteUrl(indexUrl);
  } catch {
    return indexFailure(indexUrl, 'The pack index address is not valid.');
  }

  const fetched = await fetchBytes(fetchFn, indexAbs);
  if (!fetched.ok) return indexFailure(indexUrl, `The pack index could not be read: ${fetched.reason}`);
  let index: unknown;
  try {
    index = JSON.parse(decodeUtf8(fetched.bytes));
  } catch (err) {
    return indexFailure(indexUrl, `The pack index is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  if (!isRecord(index) || index.schema !== PACKINDEX_SCHEMA || !Array.isArray(index.packs)) {
    const schema = isRecord(index) && typeof index.schema === 'string' ? ` (${index.schema})` : '';
    return indexFailure(indexUrl, `The pack index is not in the ${PACKINDEX_SCHEMA} format${schema}.`);
  }

  // Each entry is checked on its own, so one bad entry fails one pack, not the whole index.
  const failures: PackFailed[] = [];
  const entries: { entry: PackIndexEntry; position: number }[] = [];
  const failedEntries: LoadedPack[] = [];
  const seen = new Set<string>();
  index.packs.forEach((raw: unknown, i: number) => {
    const check = checkSchema('packindex/1#entry', raw, 'The index entry');
    if (!check.ok) {
      const id = isRecord(raw) && typeof raw.id === 'string' && raw.id ? raw.id : `index-entry-${i + 1}`;
      const reason = `The index entry for this pack is not valid: ${check.reason}`;
      failedEntries[i] = failedPack({ id, kind: kindOf(raw), version: '', path: pathOf(raw), reason });
      return;
    }
    const entry = raw as PackIndexEntry;
    if (seen.has(entry.id)) {
      // Listed twice: keep the first and report the second, without listing a second pack of the
      // same id (ids are unique in the spellbook).
      failures.push({ id: entry.id, path: entry.path, reason: 'The index lists this pack twice; only the first entry is used.' });
      return;
    }
    seen.add(entry.id);
    entries.push({ entry, position: i });
  });

  const loaded = await Promise.all(entries.map(({ entry }) => loadEntry(entry, indexAbs, fetchFn)));
  const byPosition: LoadedPack[] = [];
  entries.forEach(({ position }, k) => (byPosition[position] = loaded[k]));
  failedEntries.forEach((p, i) => p && (byPosition[i] = p));
  return { packs: byPosition.filter(Boolean), failures };
}

async function loadEntry(entry: PackIndexEntry, indexAbs: URL, fetchFn: typeof fetch): Promise<LoadedPack> {
  const fail = (reason: string) => failedPack({ id: entry.id, kind: entry.kind, version: entry.version, path: entry.path, reason });
  const url = new URL(entry.path, indexAbs);
  // The schema already refuses '..' and absolute paths; this also covers any URL trick it missed.
  if (url.origin !== indexAbs.origin) return fail('The index points this pack outside the app, so it was not loaded.');

  const fetched = await fetchBytes(fetchFn, url);
  if (!fetched.ok) return fail(`The pack file could not be read: ${fetched.reason}`);
  const hash = await sha256Hex(fetched.bytes);
  if (!hash.ok) return fail(hash.reason);
  if (hash.hex !== entry.sha256.toLowerCase()) return fail('The pack file does not match the hash in the pack index, so it was not loaded.');

  let json: unknown;
  try {
    json = JSON.parse(decodeUtf8(fetched.bytes));
  } catch (err) {
    return fail(err instanceof TypeError ? 'The pack file is not UTF-8 text.' : `The pack file is not valid JSON (${err instanceof Error ? err.message : String(err)}).`);
  }
  const checked = checkPack(json, { expectKind: entry.kind, expectId: entry.id });
  if (!checked.ok) return fail(checked.reason);

  const loaded = loadedFromChecked(checked, { user: false, importedAt: 0, path: entry.path });
  if (loaded.version !== entry.version) loaded.warnings.push(`The pack index lists version ${entry.version}, but the file is version ${loaded.version}.`);
  return loaded;
}

type Fetched = { ok: true; bytes: ArrayBuffer } | { ok: false; reason: string };

/** Fetch a file as bytes, refusing anything over the pack size limit (Section 9.2). */
async function fetchBytes(fetchFn: typeof fetch, url: URL): Promise<Fetched> {
  let res: Response;
  try {
    res = await fetchFn(url.href);
  } catch (err) {
    return { ok: false, reason: `the request failed (${err instanceof Error ? err.message : String(err)}).` };
  }
  if (!res.ok) return { ok: false, reason: `the server answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.` };
  // A declared length over the limit is refused before downloading anything.
  const declared = Number(res.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > PACK_SIZE_LIMIT_BYTES) return { ok: false, reason: sizeReason(declared) };
  let bytes: ArrayBuffer;
  try {
    bytes = await res.arrayBuffer();
  } catch (err) {
    return { ok: false, reason: `the download stopped (${err instanceof Error ? err.message : String(err)}).` };
  }
  // Checked again on the bytes themselves: a server may send no length, or the wrong one.
  if (bytes.byteLength > PACK_SIZE_LIMIT_BYTES) return { ok: false, reason: sizeReason(bytes.byteLength) };
  return { ok: true, bytes };
}

/** Hex SHA-256 of the raw bytes. crypto.subtle exists only in secure contexts (https or localhost), so
 *  on a plain-http address the check cannot run and the pack is refused with a reason that says so. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<{ ok: true; hex: string } | { ok: false; reason: string }> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    return {
      ok: false,
      reason: 'This page is not served over https, so the pack could not be checked against its hash. Open Spellglass from an https address or from localhost.',
    };
  }
  try {
    const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
    let hex = '';
    for (const b of digest) hex += b.toString(16).padStart(2, '0');
    return { ok: true, hex };
  } catch (err) {
    return { ok: false, reason: `The pack could not be checked against its hash (${err instanceof Error ? err.message : String(err)}).` };
  }
}

/** Strict UTF-8: invalid bytes throw a TypeError instead of turning into replacement characters. A
 *  leading byte-order mark is dropped. */
export function decodeUtf8(bytes: ArrayBuffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function indexFailure(indexUrl: string, reason: string): BundledPacks {
  return { packs: [], indexError: reason, failures: [{ id: 'index', path: indexUrl, reason }] };
}

function kindOf(raw: unknown): PackKind {
  const k = isRecord(raw) ? raw.kind : undefined;
  return k === 'themepack' || k === 'gesturepack' ? k : 'spellpack';
}

function pathOf(raw: unknown): string | undefined {
  return isRecord(raw) && typeof raw.path === 'string' ? raw.path.slice(0, 200) : undefined;
}
