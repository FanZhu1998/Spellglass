// contracts/storage.ts
//
// What is saved on the device (IndexedDB), and the export file. Everything stored carries a
// schema version (Section 9.1 rule 4); loaders migrate forward and never rewrite files silently.
//
// The storage module never requires platform.indexeddb. It serves every 'storage.*' request from
// the end of its init() (src/main.ts registers it first), opening the database lazily. When
// IndexedDB is blocked, full, or closed by another tab, it switches to an in-memory store for the
// rest of the session, keeps resolving every request, and publishes storage.status {persistent:
// false, reason} (Section 7.9: runs without saving and says so). It owns the record migrations for
// each store and runs them on read and on import. After committed writes it publishes
// 'storage.changed'.

import type { Gesture, Point, SpellPack } from './packs';
import type { SpellCast } from './v1';
import type { PlayArea } from './settings';

export const DATA_VERSION = 1;

/** Named collections. Each is a key → value store. */
export type StoreName =
  | 'profiles'   // CameraProfile by deviceId (or label when ids are hidden)
  | 'samples'    // GestureSample by id: your accepted strokes, used as extra templates
  | 'overrides'  // GestureOverride by spellId: gestures you redrew in the Workshop
  | 'progress'   // SpellProgress by spellId
  | 'keepsakes'  // Keepsake by cast id: recent casts for replays, cards and clips
  | 'packs'      // UserPack by pack id: packs you imported (spell, theme and gesture packs)
  | 'sessions'   // RecordedSession by id: diagnostics recordings in the fixture format
  | 'kv';        // small values that belong to no other store, each { dataVersion, value }:
  //               'progress.unlockedTier' → { dataVersion: 1, value: number }

export const STORE_NAMES: readonly StoreName[] = ['profiles', 'samples', 'overrides', 'progress', 'keepsakes', 'packs', 'sessions', 'kv'];

export interface CameraProfile {
  dataVersion: number;
  deviceId: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  exposureMode: 'continuous' | 'manual';
  /** In the Image Capture unit of 100 µs. */
  exposureTime: number | null;
  exposureCompensation?: number | null;
  /** Visible-light glint (route A) or infrared (route C); defaults from CameraReady.infrared. */
  profile?: 'visible' | 'infrared';
  /** Whether this camera needs the x flip (false for cameras that already mirror). */
  flipX?: boolean;
  /** Bright-tip settings that worked for this camera, applied when it opens. */
  k?: number;
  floor?: number;
  channel?: 'luma' | 'r' | 'g' | 'b';
  minArea?: number;
  maxArea?: number;
  playArea?: PlayArea;
  savedAt: number;
}

export interface GestureSample {
  dataVersion: number;
  id: string;
  spellId: string;
  /** 64 points, isotropic unit square, as the recognizer normalizes them. */
  points: Point[];
  score: number;
  /** SpellbookEntry.gestureKey when it was learned; samples with another key are stale. */
  gestureKey?: string;
  savedAt: number;
}

export interface GestureOverride {
  dataVersion: number;
  spellId: string;
  /** Stored right-handed (canonical): the left-handed mirror is applied when the spellbook is built. */
  gesture: Gesture;
  /** The player drew it with the left-handed switch on (it was mirrored back before storing). */
  drawnLeftHanded?: boolean;
  savedAt: number;
}

export interface SpellProgress {
  dataVersion: number;
  spellId: string;
  /** Accepted casts that count: not replays; via 'voice' only when engine.mode is 'voice';
   *  practice casts count. */
  casts: number;
  practiceAttempts: number;
  best: number;           // best quality
  /** Once set, the spell stays learned. */
  learnedAt: number | null;
}

export interface Keepsake {
  dataVersion: number;
  id: string;             // the cast id
  cast: SpellCast;
  spellName: string;
  /** The stroke resampled to 64 points in caster space (empty for voice-only casts). */
  points: Point[];
  durationMs: number;
  aspect: number;
  savedAt: number;
}

export interface UserPack {
  dataVersion: number;
  id: string;
  json: SpellPack | unknown;
  importedAt: number;
}

/** "Export my data": one JSON file with profiles, samples, progress and settings (Section 9.4). */
export interface UserDataExport {
  schema: 'spellglass-data/1';
  dataVersion: number;
  /** SETTINGS_VERSION of `settings`, so imports go through the settings migrations. */
  settingsVersion: number;
  exportedAt: string;
  /** Only the values the player changed (request 'settings.user'), so defaults are never pinned. */
  settings: Record<string, unknown>;
  stores: Partial<Record<StoreName, { key: string; value: unknown }[]>>;
}

export interface StorageStatus {
  /** Writes reach IndexedDB. false when it is blocked, full or closed: the app runs without saving and says so. */
  persistent: boolean;
  reason?: 'blocked' | 'full' | 'closed' | 'unsupported';
  /** A plain sentence for the status area, e.g. "Storage is blocked, so Spellglass runs without saving." */
  message?: string;
  /** The browser has agreed to keep the data (navigator.storage.persisted()). */
  durable?: boolean;
  usage?: number;
  quota?: number;
}
