// Internal shapes of the pack service. Nothing here crosses the bus: the contracts in
// src/contracts/packs.ts (Spellbook, SpellbookEntry, SpellbookPack) are what other modules see.

import type { GesturePack, PackKind, SpellPack, ThemePack } from '../../contracts';

/** A pack after loading: either checked and migrated to its current schema, or failed with a reason. */
export interface LoadedPack {
  id: string;
  kind: PackKind;
  version: string;
  title: string;
  description?: string;
  notice?: string;
  /** Imported by the player (store 'packs'), not shipped with the app. */
  user: boolean;
  /** Bundled packs: the path from the index. */
  path?: string;
  /** User packs: the key of the record in store 'packs' (normally the pack id). */
  storageKey?: string;
  /** User packs: when they were imported. Orders gesture-pack layers, newest first. Bundled: 0. */
  importedAt: number;
  /** The pack in its current schema, validated. null when it failed its checks. */
  pack: SpellPack | ThemePack | GesturePack | null;
  /** The schema the file was written in, when it was migrated forward (e.g. 'spellpack/0'). */
  migratedFrom?: string;
  /** Why the pack was skipped (Section 7.9). Set exactly when pack is null. */
  error?: string;
  /** Problems found while loading that did not stop the pack. */
  warnings: string[];
  /** On unless the pack says default_enabled: false (the restricted section ships off). */
  defaultEnabled: boolean;
}

export const KIND_NAMES: Record<PackKind, string> = {
  spellpack: 'spell pack',
  themepack: 'theme pack',
  gesturepack: 'gesture pack',
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
