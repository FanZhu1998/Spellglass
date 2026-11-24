// Settings store: defaults from contracts, the user's values on top, persisted with a version.
// Synchronous reads (kernel.setting) so modules can read settings in hot paths.

import { DEFAULT_SETTINGS, EPHEMERAL_SETTINGS, SETTINGS_VERSION } from '../contracts';
import { logger } from './log';

const log = logger('settings');

export interface SettingsPersistence {
  load(): { v: number; values: Record<string, unknown> } | null;
  save(data: { v: number; values: Record<string, unknown> }): void;
}

export function memoryPersistence(initial?: Record<string, unknown>): SettingsPersistence {
  let data: { v: number; values: Record<string, unknown> } | null = initial ? { v: SETTINGS_VERSION, values: { ...initial } } : null;
  return { load: () => data, save: (d) => { data = d; } };
}

export function localStoragePersistence(key = 'spellglass.settings'): SettingsPersistence {
  return {
    load() {
      try {
        const raw = globalThis.localStorage?.getItem(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && typeof parsed.v === 'number' && parsed.values && typeof parsed.values === 'object') return parsed;
        return null;
      } catch (err) {
        log.warn('could not read saved settings', err);
        return null;
      }
    },
    save(data) {
      try {
        globalThis.localStorage?.setItem(key, JSON.stringify(data));
      } catch (err) {
        log.warn('could not save settings', err);
      }
    },
  };
}

/** Forward migrations of the settings shape, shared by stored settings and imported data exports
 *  (Section 9.4): SETTINGS_MIGRATIONS[v] turns settings of version v into version v + 1. Empty while
 *  SETTINGS_VERSION is 1; a version 2 adds one step here. */
export const SETTINGS_MIGRATIONS: Readonly<Record<number, (values: Record<string, unknown>) => Record<string, unknown>>> = {};

/** Settings of an older version, migrated to SETTINGS_VERSION. */
export function migrateSettings(values: Record<string, unknown>, fromVersion: number): Record<string, unknown> {
  let out = { ...values };
  for (let v = fromVersion; v < SETTINGS_VERSION; v++) {
    const step = SETTINGS_MIGRATIONS[v];
    if (step) out = step(out);
  }
  return out;
}

export class SettingsStore {
  private values: Record<string, unknown> = {};
  private listeners = new Set<(key: string, value: unknown) => void>();

  constructor(private persistence: SettingsPersistence) {
    const loaded = persistence.load();
    if (loaded) {
      const values = migrateSettings(loaded.values, loaded.v);
      // Session-only settings never survive a reload, even if an older build saved them.
      for (const k of EPHEMERAL_SETTINGS) delete values[k];
      this.values = values;
    }
  }

  get<T>(key: string, fallback: T): T {
    if (Object.prototype.hasOwnProperty.call(this.values, key)) return this.values[key] as T;
    if (Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key)) return (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key] as T;
    return fallback;
  }

  /** Throws TypeError when the value's type does not match the default's. */
  set(key: string, value: unknown): void {
    const def = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[key];
    if (def !== undefined && def !== null && value !== null && value !== undefined) {
      const want = Array.isArray(def) ? 'array' : typeof def;
      const got = Array.isArray(value) ? 'array' : typeof value;
      if (want !== got) throw new TypeError(`Setting ${key} expects ${want}, got ${got}`);
    }
    const before = this.values[key];
    if (value === undefined) delete this.values[key];
    else this.values[key] = value;
    if (JSON.stringify(before) === JSON.stringify(value)) return;
    this.persist();
    for (const fn of this.listeners) fn(key, this.get(key, value));
  }

  reset(key?: string): void {
    const keys = key ? [key] : Object.keys(this.values);
    for (const k of keys) {
      if (!(k in this.values)) continue;
      delete this.values[k];
      for (const fn of this.listeners) fn(k, this.get(k, undefined));
    }
    this.persist();
  }

  /** Defaults merged with the user's values. */
  all(): Record<string, unknown> {
    return { ...DEFAULT_SETTINGS, ...this.values };
  }

  /** Only the values the user changed (for exports and session recordings), without session-only ones. */
  changed(): Record<string, unknown> {
    const out = { ...this.values };
    for (const k of EPHEMERAL_SETTINGS) delete out[k];
    return out;
  }

  onChange(fn: (key: string, value: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private persist(): void {
    this.persistence.save({ v: SETTINGS_VERSION, values: this.changed() });
  }
}
