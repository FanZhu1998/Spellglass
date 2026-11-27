// kernel: bus, registry and lifecycle, features, settings, requests, pack loader, and the small
// shared helpers modules must agree on (among them the camera trackers' frame feed). Modules may
// import from here and from contracts, never from each other.
export { createKernel } from './kernel';
export type { KernelHost, KernelOptions } from './kernel';
export { Bus } from './bus';
export { CapabilitySet, parseCapability } from './capabilities';
export { detectFeatures, PLATFORM } from './features';
export { SettingsStore, localStoragePersistence, memoryPersistence, migrateSettings, SETTINGS_MIGRATIONS } from './settings';
export type { SettingsPersistence } from './settings';
export { KernelError, describeError } from './errors';
export { logger, setLogLevel } from './log';
export type { Logger } from './log';
export { satisfies, parseVersion, compare } from './semver';
export { newId } from './ids';
export { emit, on, lastPayload, ask, serve, setting, setSetting, watchSettings } from './typed';
export { gradeFor } from './grades';
export { isReducedMotion, watchReducedMotion } from './access';
export { gesturePaths, gesturePaceMs, gestureKey, stableHash, strokeToUnitPath, asFlick } from './gestures';
export * as geometry from './geometry';
// The camera trackers' fast path: frames straight from the camera track, where Chromium allows it.
export { browserProcessor, ClockMap, startFeed } from './frame-feed';
export type { Feed, FeedFrame, ProcessorFactory } from './frame-feed';
// Validation against the JSON Schemas (the source of truth): packs and gestures, recorded sessions,
// data exports. The session and export validators are only bundled when something imports them.
export { checkSchema } from './packs/validate';
export { checkSession, checkUserData } from './packs/validate-data';
