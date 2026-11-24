// Constructors for LoadedPack, shared by the index loader and the stored and imported packs.

import type { PackKind } from '../../contracts';
import { PACK_SIZE_LIMIT_BYTES } from '../../contracts';
import type { CheckedPack } from './check';
import type { LoadedPack } from './types';

/** A pack that passed checkPack. */
export function loadedFromChecked(
  checked: Extract<CheckedPack, { ok: true }>,
  where: { user: boolean; importedAt: number; path?: string; storageKey?: string },
): LoadedPack {
  const p = checked.pack as { id: string; version: string; title?: unknown; description?: unknown; notice?: unknown; default_enabled?: unknown };
  return {
    id: p.id,
    kind: checked.kind,
    version: p.version,
    title: typeof p.title === 'string' && p.title ? p.title : p.id,
    ...(typeof p.description === 'string' && p.description ? { description: p.description } : {}),
    ...(typeof p.notice === 'string' && p.notice ? { notice: p.notice } : {}),
    user: where.user,
    ...(where.path ? { path: where.path } : {}),
    ...(where.storageKey ? { storageKey: where.storageKey } : {}),
    importedAt: where.importedAt,
    pack: checked.pack,
    ...(checked.migratedFrom ? { migratedFrom: checked.migratedFrom } : {}),
    warnings: [],
    defaultEnabled: p.default_enabled !== false,
  };
}

/** A pack that was skipped, with the reason (Section 7.9). */
export function failedPack(p: {
  id: string; kind: PackKind; version: string; reason: string;
  path?: string; title?: string; user?: boolean; storageKey?: string; importedAt?: number;
}): LoadedPack {
  return {
    id: p.id,
    kind: p.kind,
    version: p.version,
    title: p.title ?? p.id,
    user: p.user ?? false,
    ...(p.path ? { path: p.path } : {}),
    ...(p.storageKey ? { storageKey: p.storageKey } : {}),
    importedAt: p.importedAt ?? 0,
    pack: null,
    error: p.reason,
    warnings: [],
    defaultEnabled: true,
  };
}

/** 'it is 600 KB, and packs may be at most 512 KB.' */
export function sizeReason(bytes: number): string {
  return `it is ${Math.ceil(bytes / 1024)} KB, and packs may be at most ${Math.round(PACK_SIZE_LIMIT_BYTES / 1024)} KB.`;
}
