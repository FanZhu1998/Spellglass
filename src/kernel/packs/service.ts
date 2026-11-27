// Pack loader and spellbook service (Section 9.3). It belongs to the kernel: it reads the pack index
// and the player's stored packs, drawings and progress, builds the Spellbook every module reads
// ('spellbook.changed'), counts progress from 'spell.cast', and serves the pack, spellbook and progress
// requests of contracts/requests.ts.
//
// How the work is split (each file explains its rules):
//   loader.ts     index and pack files: size limit, SHA-256, decoding
//   check.ts      schema detection, validation, migration (migrate.ts), engine range
//   limits.ts     nesting depth and the template budget, which checkPack applies; drawings' limit
//   spellbook.ts  the pure build: precedence, availability, tiers, mirroring, templates, lasts
//   progress.ts   counting rules and staged unlocking
//   drawing.ts    gesture mirroring and Workshop drawings
//   transfer.ts   stored records, import and export
//
// Concurrency. Asynchronous operations (load, reload, import, remove, redraw, reset) run one at a time
// through `serialized`, and each changes state in one synchronous step after its awaits, so another
// operation never sees half of it. Rebuilds are synchronous and so always see consistent state;
// rebuilds caused by events (settings, casts) are deferred with queueMicrotask and coalesced, so a burst
// of changes publishes one spellbook, after the event that caused it has reached every subscriber. A
// request that adds something (an import, a drawing, a pack switch) builds its spellbook before it
// changes any state, so one that cannot be built is refused and leaves everything as it was.
//
// Storage is another module. Every storage request may fail (no storage module, blocked storage): the
// service then carries on in memory (Section 7.9 "Runs without saving").
//
// Two windows of the app may count at once (an installed window and a tab, a replay link opened in a
// new tab), each with its own copy in memory. So progress is never written from memory alone: each
// change is applied again to what storage holds when it is written (read, apply, merge, write), one
// write at a time. A cast adds one to the stored count, and the result is merged with this window's
// own record (progress.ts mergeProgress): counts and best take the higher value, learnedAt the earlier
// time, and the tier never goes below the stored one. So a window that is behind never lowers what
// another one saved ("Once set, the spell stays learned", contracts/storage.ts), and storage that
// starts again empty (it switched to memory mid-session) never lowers what this window counted.
// Memory then takes what was written; the other window's writes also arrive as 'storage.changed',
// which reloads them, with the steps still waiting to be written applied again on top.

import type {
  GestureOverride, Kernel, PracticeAttempt, ProgressChanged, Spell, SpellCast, SpellPack, SpellProgress, Spellbook,
  StorageChanged, StoreName,
} from '../../contracts';
import { DATA_VERSION, DEFAULT_SETTINGS } from '../../contracts';
import type { CapabilitySet } from '../capabilities';
import { KernelError } from '../errors';
import { logger } from '../log';
import type { SettingsStore } from '../settings';
import { ask, emit, lastPayload, on, serve, setting } from '../typed';
import { checkPack } from './check';
import { drawingToGesture, inheritFromPack, type DrawingOptions } from './drawing';
import { drawingReason } from './limits';
import { loadedFromChecked } from './loaded';
import { loadBundledPacks, type BundledPacks } from './loader';
import {
  applyCast, applyPracticeAttempt, countsTowardProgress, isLearned, mergeProgress, readProgressRecord, readUnlockedTier,
  UNLOCKED_TIER_KEY, unlockedTierRecord,
} from './progress';
import { buildSpellbook, isHigherVersion, needsSentence, type BuildResult } from './spellbook';
import { exportFilename, gesturePackFromOverrides, packText, parseImportText, readOverrideRecord, userPackFromRecord, userPackRecord } from './transfer';
import type { LoadedPack } from './types';
import { KIND_NAMES, isRecord } from './types';
import { checkSchema } from './validate';

const log = logger('packs');

/** Source of the events this service publishes (and the owner of its requests). */
const SOURCE = 'kernel.packs';

/** Settings the spellbook depends on. */
const REBUILD_ON = new Set<string>(['spells.unlockAll', 'spells.learnAfter', 'packs.enabled', 'access.leftHanded', 'theme.id']);

/** Stores this service keeps in memory and reloads on 'storage.changed'. */
const CACHED_STORES: readonly StoreName[] = ['packs', 'overrides', 'progress', 'kv'];

/** A 'storage.changed' this soon after our own write of the same keys is that write's echo. */
const ECHO_WINDOW_MS = 10_000;

export interface PackServiceDeps {
  /** Kernel facade whose requests are attributed to 'kernel.packs'. */
  kernel: Kernel;
  capabilities: CapabilitySet;
  /** Effect step `use` names some registered effect module implements. */
  knownEffects: () => Set<string>;
  settings: SettingsStore;
  fetch: typeof fetch;
}

export interface PackService {
  /** Load everything and publish the spellbook. indexUrl null loads only the user's own packs. */
  load(indexUrl: string | null): Promise<Spellbook>;
  /** The current spellbook (empty until load() resolves). */
  spellbook(): Spellbook;
}

export function emptySpellbook(): Spellbook {
  return { revision: 0, packs: [], spells: [], theme: null, unlockedTier: 1, learnAfter: DEFAULT_SETTINGS['spells.learnAfter'] };
}

type EarlyEvent = { type: 'cast'; cast: SpellCast } | { type: 'attempt'; attempt: PracticeAttempt };
type Row = { key: string; value: unknown };
/** A spellbook built and not yet published, with the effect names it was built with. */
type Built = BuildResult & { known: Set<string> };
/** What a request would change, to build its spellbook before changing anything. */
type Change = { user?: readonly LoadedPack[]; overrides?: Map<string, GestureOverride>; packsEnabled?: Record<string, boolean> };
/** One change to a spell's progress: applied to memory at once, and again to whatever storage holds
 *  when it is written. */
type ProgressStep = (rec: SpellProgress | undefined) => SpellProgress | undefined;

export function createPackService(deps: PackServiceDeps): PackService {
  // Nothing here may call deps.knownEffects(): the kernel is still being built. It is called from
  // load() on.
  const kernel = deps.kernel;

  // ---------------------------------------------------------------- state
  let indexUrl: string | null = null;
  let bundled: LoadedPack[] = [];
  let indexError: string | undefined;
  let user: LoadedPack[] = [];
  /** The stored record of each user pack as JSON text, by storage key, to tell what a reload changed. */
  let userRecordText = new Map<string, string>();
  let overrides = new Map<string, GestureOverride>();
  let progress = new Map<string, SpellProgress>();
  let unlockedTier = 1;
  let book: Spellbook = emptySpellbook();
  /** Each spell as its pack has it, by id (for redraws, which inherit the pack gesture's parts). */
  let sources = new Map<string, Spell>();
  /** The first load has finished, so the spellbook is real and may be rebuilt. */
  let loaded = false;
  /** The first reads of 'progress' and 'kv' have settled, so progress may be counted and written:
   *  memory starts from what they read, and casts that arrive earlier wait in `early`. */
  let progressReady = false;
  /** Casts and practice attempts that arrived before progress was read. */
  const early: EarlyEvent[] = [];
  /** Spells whose progress changed since the last spellbook was published. */
  const notices: string[] = [];
  let dirty = false;
  let rebuildQueued = false;
  /** When this service last wrote each store key ('store\0key' → kernel.now()). */
  const localWrites = new Map<string, number>();
  let storageWarned = false;
  let chain: Promise<unknown> = Promise.resolve();
  /** Progress steps not yet written, by spell id. */
  const unsaved = new Map<string, ProgressStep[]>();
  /** Progress and tier writes, one after another, so each reads what the one before it wrote. */
  let saving: Promise<unknown> = Promise.resolve();
  let tierQueued = false;

  const invalid = (message: string) => new KernelError('invalid-payload', message);

  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = chain.then(task);
    chain = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------- settings
  function learnAfter(): number {
    const v = setting(kernel, 'spells.learnAfter');
    return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEFAULT_SETTINGS['spells.learnAfter'];
  }
  function packsEnabled(): Record<string, boolean> {
    const v: unknown = setting(kernel, 'packs.enabled');
    return isRecord(v) ? (v as Record<string, boolean>) : {};
  }
  function numberSetting(key: 'recognizer.flickLinearity' | 'recognizer.flickAngleDeg'): number {
    const v = setting(kernel, key);
    return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_SETTINGS[key];
  }
  function drawingOptions(): DrawingOptions {
    const aspect = lastPayload(kernel, 'tracker.status')?.aspect;
    return {
      leftHanded: setting(kernel, 'access.leftHanded') === true,
      flickLinearity: numberSetting('recognizer.flickLinearity'),
      flickAngleDeg: numberSetting('recognizer.flickAngleDeg'),
      fallbackAspect: typeof aspect === 'number' && Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9,
    };
  }

  // ---------------------------------------------------------------- storage (tolerant)
  function storageProblem(err: unknown): void {
    if (storageWarned) return;
    storageWarned = true;
    // No storage module happens in tests and headless harnesses (the app always registers one), so
    // it is only a debug note; a storage module that fails is worth a warning.
    if ((err as { code?: unknown } | null)?.code === 'no-handler') log.debug('no storage module: imported packs, drawings and progress last only this session');
    else log.warn('a storage request failed; carrying on without saving', err);
  }
  function noteWrite(store: StoreName, key: string): void {
    const now = kernel.now();
    for (const [k, t] of localWrites) if (now - t > ECHO_WINDOW_MS) localWrites.delete(k);
    localWrites.set(`${store}\u0000${key}`, now);
  }
  function wroteSince(store: StoreName, key: string, since: number): boolean {
    const t = localWrites.get(`${store}\u0000${key}`);
    return t !== undefined && t >= since;
  }
  async function list(store: StoreName): Promise<Row[] | null> {
    try {
      const rows: unknown = await ask(kernel, 'storage.list', { store });
      return Array.isArray(rows) ? rows.filter((r): r is Row => isRecord(r) && typeof r.key === 'string') : [];
    } catch (err) {
      storageProblem(err);
      return null;
    }
  }
  async function get(store: StoreName, key: string): Promise<{ ok: true; value: unknown } | { ok: false }> {
    try {
      return { ok: true, value: await ask(kernel, 'storage.get', { store, key }) };
    } catch (err) {
      storageProblem(err);
      return { ok: false };
    }
  }
  async function put(store: StoreName, key: string, value: unknown): Promise<boolean> {
    return (await putOutcome(store, key, value)).saved;
  }
  /** A write, and why it failed: storage refuses a value it cannot keep (invalid-payload, such as one
   *  nested too deeply) and carries on saving everything else, which is not the same as storage that
   *  is not saving at all. */
  async function putOutcome(store: StoreName, key: string, value: unknown): Promise<{ saved: boolean; refused?: string }> {
    noteWrite(store, key);
    try {
      await ask(kernel, 'storage.put', { store, key, value });
      return { saved: true };
    } catch (err) {
      if (err instanceof KernelError && err.code === 'invalid-payload') {
        log.warn(`storage refused ${store}/${key}`, err);
        return { saved: false, refused: err.message };
      }
      storageProblem(err);
      return { saved: false };
    }
  }
  async function del(store: StoreName, key: string): Promise<boolean> {
    noteWrite(store, key);
    try {
      await ask(kernel, 'storage.delete', { store, key });
      return true;
    } catch (err) {
      storageProblem(err);
      return false;
    }
  }
  async function clearStore(store: StoreName): Promise<boolean> {
    try {
      await ask(kernel, 'storage.clear', { store });
      return true;
    } catch (err) {
      storageProblem(err);
      return false;
    }
  }
  /** Storage resolves but keeps data only in memory (blocked or full IndexedDB). */
  function storageIsTemporary(): boolean {
    return lastPayload(kernel, 'storage.status')?.persistent === false;
  }

  // ---------------------------------------------------------------- building
  /** The spellbook the current state gives, with what `change` replaces. Nothing is assigned or
   *  published, so a request builds first and changes state only once its spellbook has built. */
  function build(change: Change = {}): Built {
    const known = deps.knownEffects();
    const result = buildSpellbook({
      bundled,
      user: change.user ?? user,
      overrides: change.overrides ?? overrides,
      progress,
      packsEnabled: change.packsEnabled ?? packsEnabled(),
      unlockAll: setting(kernel, 'spells.unlockAll') === true,
      learnAfter: learnAfter(),
      leftHanded: setting(kernel, 'access.leftHanded') === true,
      themeId: String(setting(kernel, 'theme.id') ?? ''),
      unmet: (needs) => deps.capabilities.unmet(needs),
      knownEffects: known,
      unlockedTier,
      revision: book.revision + 1,
      indexError,
    });
    return { ...result, known };
  }

  /** Make a built spellbook the current one: keep it, save the tier the player completed, publish it.
   *  Only completed tiers are saved; the pass-through over tiers with nothing available belongs to
   *  this spellbook alone (progress.ts), so turning a pack on again brings its stages back. */
  function commit(built: Built, packEvents: readonly LoadedPack[] = []): Spellbook {
    dirty = false;
    const before = book;
    book = built.book;
    sources = built.sources;
    if (built.storedTier > unlockedTier) {
      unlockedTier = built.storedTier;
      if (progressReady) saveTier();
    }
    stampLearned();
    for (const p of packEvents) publishPackEvent(p, built.known);
    emit(kernel, SOURCE, 'spellbook.changed', book);
    flushNotices(before, book);
    return book;
  }

  function rebuildNow(packEvents: readonly LoadedPack[] = []): Spellbook {
    return commit(build(), packEvents);
  }

  /** build(change) for a request, which is refused with a plain sentence if the build throws: an error
   *  nobody foresaw, whose message would mean nothing to the player. The log keeps it. */
  function buildOrRefuse(change: Change, what: string, refusal: string): Built {
    try {
      return build(change);
    } catch (err) {
      log.warn(`could not build the spellbook with ${what}`, err);
      throw invalid(refusal);
    }
  }

  function scheduleRebuild(): void {
    dirty = true;
    if (rebuildQueued) return;
    rebuildQueued = true;
    queueMicrotask(() => {
      rebuildQueued = false;
      if (dirty && loaded) rebuildNow();
    });
  }

  /** "A spell stays learned once SpellProgress.learnedAt is set": record the moment a spell first
   *  meets the threshold, also when the threshold itself was lowered. */
  function stampLearned(): void {
    if (!progressReady) return;
    const n = learnAfter();
    for (const [id, rec] of progress) {
      if (rec.learnedAt !== null || rec.casts < n) continue;
      const now = Date.now();
      changeProgress(id, (r) => (r && r.learnedAt === null && r.casts >= n ? { ...r, learnedAt: now } : r));
    }
  }

  /** One 'progress.changed' per spell whose progress changed, after the spellbook that shows it. The
   *  tier opened by these casts rides on the last one, with the spells it opened. */
  function flushNotices(before: Spellbook, after: Spellbook): void {
    if (!notices.length) return;
    const ids = [...new Set(notices.splice(0).reverse())].reverse();
    const opened = after.unlockedTier > before.unlockedTier ? newlyOpened(before, after) : [];
    const n = learnAfter();
    ids.forEach((spellId, i) => {
      const rec = progress.get(spellId);
      const payload: ProgressChanged = { spellId, accepted: rec?.casts ?? 0, learned: isLearned(rec, n) };
      if (i === ids.length - 1 && opened.length) {
        payload.unlockedTier = after.unlockedTier;
        payload.unlockedSpells = opened;
      }
      emit(kernel, SOURCE, 'progress.changed', payload);
    });
  }

  function publishPackEvent(p: LoadedPack, known: ReadonlySet<string>): void {
    if (!p.pack) {
      emit(kernel, SOURCE, 'pack.failed', { id: p.id, ...(p.path ? { path: p.path } : {}), reason: p.error ?? 'The pack could not be read.' });
      return;
    }
    const needs = (p.pack as { needs?: unknown }).needs;
    const skipped = p.kind === 'spellpack'
      ? (p.pack as SpellPack).spells.reduce((n, s) => n + s.effect.steps.filter((st) => !known.has(st.use)).length, 0)
      : 0;
    emit(kernel, SOURCE, 'pack.loaded', {
      id: p.id, kind: p.kind, version: p.version,
      unmet: Array.isArray(needs) ? deps.capabilities.unmet(needs as string[]) : [],
      skippedSteps: skipped, user: p.user,
    });
  }

  // ---------------------------------------------------------------- loading
  function readOverrides(rows: Row[]): Map<string, GestureOverride> {
    const out = new Map<string, GestureOverride>();
    for (const r of rows) {
      const read = readOverrideRecord(r.key, r.value);
      if (read.ok) out.set(read.override.spellId, read.override);
      else log.warn(`ignoring a stored drawing (${r.key}): ${read.reason}`);
    }
    return out;
  }
  function readProgress(rows: Row[]): Map<string, SpellProgress> {
    const out = new Map<string, SpellProgress>();
    for (const r of rows) {
      const p = readProgressRecord(r.key, r.value);
      if (p) out.set(p.spellId, p);
    }
    return out;
  }
  /** What storage holds, except keys this service wrote after `since`: those writes may not have
   *  reached the read, so memory is newer for them. */
  function mergeRows<T>(store: StoreName, current: Map<string, T>, stored: Map<string, T>, since: number): Map<string, T> {
    const out = new Map(stored);
    for (const key of new Set([...current.keys(), ...stored.keys()])) {
      if (!wroteSince(store, key, since)) continue;
      if (current.has(key)) out.set(key, current.get(key)!);
      else out.delete(key);
    }
    return out;
  }
  /** Progress as storage holds it (mergeRows), with the steps still waiting to be written applied to
   *  it again. What another writer changed (a data import, a reset in another window) then replaces
   *  what memory had, and what this window counted since is still added; keeping memory instead would
   *  let the merge in saveProgress undo that change. */
  function mergeProgressRows(stored: Map<string, SpellProgress>, since: number): Map<string, SpellProgress> {
    const out = mergeRows('progress', progress, stored, since);
    for (const [spellId, steps] of unsaved) {
      if (wroteSince('progress', spellId, since)) continue;
      const next = applySteps(stored.get(spellId), steps);
      if (next) out.set(spellId, next);
      else out.delete(spellId);
    }
    return out;
  }

  async function loadAll(url: string | null): Promise<Spellbook> {
    const startedAt = kernel.now();
    indexUrl = url;
    try {
      const noIndex: BundledPacks = { packs: [], failures: [] };
      const [index, packRows, overrideRows, progressRows, tierRead] = await Promise.all([
        url ? loadBundledPacks(url, deps.fetch) : Promise.resolve(noIndex),
        list('packs'),
        list('overrides'),
        list('progress'),
        get('kv', UNLOCKED_TIER_KEY),
      ]);
      // From here on the state changes in one synchronous step.
      bundled = index.packs;
      indexError = index.indexError;
      if (packRows) {
        user = packRows.map((r) => userPackFromRecord(r.key, r.value));
        userRecordText = new Map(packRows.map((r) => [r.key, JSON.stringify(r.value)]));
      }
      if (overrideRows) overrides = mergeRows('overrides', overrides, readOverrides(overrideRows), startedAt);
      if (progressRows) progress = mergeProgressRows(readProgress(progressRows), startedAt);
      if (tierRead.ok && !wroteSince('kv', UNLOCKED_TIER_KEY, startedAt)) unlockedTier = readUnlockedTier(tierRead.value) ?? 1;
      for (const f of index.failures) emit(kernel, SOURCE, 'pack.failed', f);
      progressReady = true;
      for (const e of early.splice(0)) {
        if (e.type === 'cast') recordCast(e.cast);
        else recordAttempt(e.attempt);
      }
      loaded = true;
      return rebuildNow([...bundled, ...user]);
    } catch (err) {
      // Every step above already turns its own failures into reasons; this is a last resort, so that
      // load() never rejects (kernel.loadPacks promises as much).
      log.error('loading packs failed', err);
      progressReady = true;
      loaded = true;
      return rebuildNow();
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (!loaded) await loadAll(indexUrl);
  }

  /** Reload stores another writer changed (a data import, a clear). Rebuild only if something differs. */
  async function reloadStores(stores: readonly StoreName[]): Promise<void> {
    const since = kernel.now();
    let changed = false;
    const fresh: LoadedPack[] = [];
    if (stores.includes('packs')) {
      const rows = await list('packs');
      if (rows) {
        const text = new Map(rows.map((r) => [r.key, JSON.stringify(r.value)]));
        const same = text.size === userRecordText.size && [...text].every(([key, t]) => userRecordText.get(key) === t);
        if (!same) {
          // Keep the packs whose records did not change; check and migrate the rest again.
          const byKey = new Map(user.map((u) => [u.storageKey ?? u.id, u]));
          user = rows.map((r) => {
            const old = byKey.get(r.key);
            if (old && userRecordText.get(r.key) === text.get(r.key)) return old;
            const next = userPackFromRecord(r.key, r.value);
            fresh.push(next);
            return next;
          });
          userRecordText = text;
          changed = true;
        }
      }
    }
    if (stores.includes('overrides')) {
      const rows = await list('overrides');
      if (rows) {
        const next = mergeRows('overrides', overrides, readOverrides(rows), since);
        if (!sameMap(next, overrides)) {
          overrides = next;
          changed = true;
        }
      }
    }
    if (stores.includes('progress')) {
      const rows = await list('progress');
      if (rows) {
        const next = mergeProgressRows(readProgress(rows), since);
        if (!sameMap(next, progress)) {
          progress = next;
          changed = true;
        }
      }
    }
    if (stores.includes('kv')) {
      const read = await get('kv', UNLOCKED_TIER_KEY);
      if (read.ok && !wroteSince('kv', UNLOCKED_TIER_KEY, since)) {
        const tier = readUnlockedTier(read.value) ?? 1;
        if (tier !== unlockedTier) {
          unlockedTier = tier;
          changed = true;
        }
      }
    }
    if (changed) rebuildNow(fresh);
  }

  // ---------------------------------------------------------------- progress
  function recordCast(cast: SpellCast): void {
    const n = learnAfter();
    const now = Date.now();
    changeProgress(cast.spellId, (rec) => applyCast(rec, cast, n, now));
    notices.push(cast.spellId);
  }
  function recordAttempt(attempt: PracticeAttempt): void {
    changeProgress(attempt.spellId, (rec) => applyPracticeAttempt(rec, attempt));
  }

  /** Apply a step to memory now, and queue it to be applied to the stored record (see the top). */
  function changeProgress(spellId: string, step: ProgressStep): void {
    setProgress(spellId, step(progress.get(spellId)));
    const queued = unsaved.get(spellId);
    if (queued) {
      queued.push(step);
      return;
    }
    unsaved.set(spellId, [step]);
    void queueSave(() => saveProgress(spellId));
  }

  /** Read the spell's record, apply the steps waiting for it, merge in this window's record, write the
   *  result. */
  async function saveProgress(spellId: string): Promise<void> {
    const read = await get('progress', spellId);
    // Steps that arrived during the read are applied with the others.
    const steps = unsaved.get(spellId) ?? [];
    unsaved.delete(spellId);
    // No storage: memory already has these steps, and is all there is (Section 7.9).
    if (!read.ok) return;
    const stored = readProgressRecord(spellId, read.value) ?? undefined;
    // Memory has the same steps, and is ahead of storage only when storage lost what this window wrote:
    // storage that switches to memory mid-session starts empty (contracts/storage.ts). Memory goes down
    // only through a reset here (progress.reset) or a change by another writer, which replaces it when
    // its 'storage.changed' arrives (mergeProgressRows).
    const next = mergeProgress(applySteps(stored, steps), progress.get(spellId));
    if (next && !sameProgress(next, stored) && !(await put('progress', spellId, next))) return;
    adoptProgress(spellId, next);
  }

  /** Memory takes the record storage now holds, with the steps that arrived since applied again. It
   *  differs from what memory had when another window counted too, and then the spellbook shows it. */
  function adoptProgress(spellId: string, rec: SpellProgress | undefined): void {
    const next = applySteps(rec, unsaved.get(spellId) ?? []);
    if (sameProgress(progress.get(spellId), next)) return;
    setProgress(spellId, next);
    notices.push(spellId);
    scheduleRebuild();
  }

  function setProgress(spellId: string, rec: SpellProgress | undefined): void {
    if (rec) progress.set(spellId, rec);
    else progress.delete(spellId);
  }

  /** Save the tier the player has opened (memory's, when the write's turn comes, so a reset queued
   *  before it is not undone). The stored one may be higher: another window got further since this
   *  one read it. Then nothing is written, and this window takes that tier. */
  function saveTier(): void {
    if (tierQueued) return;
    tierQueued = true;
    void queueSave(async () => {
      tierQueued = false;
      const read = await get('kv', UNLOCKED_TIER_KEY);
      if (!read.ok) return;
      const stored = readUnlockedTier(read.value) ?? 1;
      if (stored < unlockedTier) {
        await put('kv', UNLOCKED_TIER_KEY, unlockedTierRecord(unlockedTier));
      } else if (stored > unlockedTier) {
        unlockedTier = stored;
        scheduleRebuild();
      }
    });
  }

  function queueSave<T>(task: () => Promise<T>): Promise<T> {
    const run = saving.then(() => withProgressLock(task));
    saving = run.catch((err) => log.warn('saving progress failed', err));
    return run;
  }

  // ---------------------------------------------------------------- events
  on(kernel, 'spell.cast', (cast) => {
    if (!isRecord(cast) || !countsTowardProgress(cast, String(setting(kernel, 'engine.mode')))) return;
    if (!progressReady) {
      early.push({ type: 'cast', cast });
      return;
    }
    recordCast(cast);
    scheduleRebuild();
  });

  on(kernel, 'practice.attempt', (attempt) => {
    if (!isRecord(attempt) || typeof attempt.spellId !== 'string' || !attempt.spellId) return;
    if (!progressReady) {
      early.push({ type: 'attempt', attempt });
      return;
    }
    recordAttempt(attempt);
  });

  on(kernel, 'settings.changed', ({ key }) => {
    if (loaded && REBUILD_ON.has(key)) scheduleRebuild();
  });

  const pendingReload = new Set<StoreName>();
  let reloadQueued = false;
  on(kernel, 'storage.changed', (p) => {
    if (!loaded || !isRecord(p) || !Array.isArray(p.stores)) return;
    const stores = p.stores.filter((s) => CACHED_STORES.includes(s));
    if (!stores.length || isEcho(p)) return;
    for (const s of stores) pendingReload.add(s);
    if (reloadQueued) return;
    reloadQueued = true;
    queueMicrotask(() => {
      reloadQueued = false;
      const set = [...pendingReload];
      pendingReload.clear();
      void serialized(() => reloadStores(set));
    });
  });

  /** Our own writes come back as 'storage.changed'; reloading for them would only repeat what memory has.
   *  Only a put or a delete can be one: a change another window made ('other-tab') never is, also for
   *  keys this window wrote a moment ago. */
  function isEcho(p: StorageChanged): boolean {
    if ((p.reason !== 'put' && p.reason !== 'delete') || !Array.isArray(p.keys) || p.keys.length === 0) return false;
    const now = kernel.now();
    return p.keys.every((k) =>
      p.stores.some((s) => {
        const t = localWrites.get(`${s}\u0000${k}`);
        return t !== undefined && now - t <= ECHO_WINDOW_MS;
      }),
    );
  }

  // ---------------------------------------------------------------- requests
  serve(kernel, 'spellbook.get', () => book);

  serve(kernel, 'packs.reload', () => serialized(() => loadAll(indexUrl)));

  serve(kernel, 'spellbook.override.set', (p) =>
    serialized(async () => {
      await ensureLoaded();
      if (!isRecord(p) || typeof p.spellId !== 'string' || !p.spellId) throw invalid('Say which spell the drawing is for.');
      const source = sources.get(p.spellId);
      if (!source) throw invalid(`No loaded spell has the id "${p.spellId}".`);
      if (p.gesture !== undefined) {
        const given = checkSchema('gesture/1', p.gesture, 'The gesture');
        if (!given.ok) throw invalid(given.reason);
      }
      const drawn = drawingToGesture({ gesture: p.gesture, stroke: p.stroke }, drawingOptions());
      if (!drawn.ok) throw invalid(drawn.reason);
      const gesture = inheritFromPack(drawn.gesture, source.gesture);
      const check = checkSchema('gesture/1', gesture, 'The drawing');
      if (!check.ok) throw invalid(check.reason);
      // The limit it meets when it loads again (transfer.ts readOverrideRecord), so a drawing that is
      // saved is also used next time. A drawn stroke always fits; a gesture passed in may not.
      const tooComplex = drawingReason(gesture);
      if (tooComplex) throw invalid(tooComplex);
      const record: GestureOverride = {
        dataVersion: DATA_VERSION,
        spellId: p.spellId,
        gesture,
        ...(drawn.drawnLeftHanded ? { drawnLeftHanded: true } : {}),
        savedAt: Date.now(),
      };
      const next = new Map(overrides).set(p.spellId, record);
      const built = buildOrRefuse({ overrides: next }, `a drawing for ${p.spellId}`, 'Spellglass could not use this drawing, so it was not saved.');
      overrides = next;
      commit(built);
      await put('overrides', p.spellId, record);
    }),
  );

  serve(kernel, 'spellbook.override.clear', (p) =>
    serialized(async () => {
      await ensureLoaded();
      if (!isRecord(p) || typeof p.spellId !== 'string' || !p.spellId) throw invalid('Say which spell to give its pack gesture back.');
      if (overrides.delete(p.spellId)) rebuildNow();
      // Also when memory had none: storage may hold one that failed to load.
      await del('overrides', p.spellId);
    }),
  );

  serve(kernel, 'packs.enable', (p) =>
    serialized(async () => {
      await ensureLoaded();
      if (!isRecord(p) || typeof p.id !== 'string' || typeof p.enabled !== 'boolean') throw invalid('Say which pack to turn on or off.');
      const target = book.packs.find((pk) => pk.id === p.id);
      if (!target) throw invalid(`No pack has the id "${p.id}".`);
      // The setting is the source of truth; its change event would rebuild later, this rebuilds now,
      // with the new value first, so a spellbook that cannot be built leaves the switch as it was.
      const enabled = { ...packsEnabled(), [p.id]: p.enabled };
      const onOff = p.enabled ? 'on' : 'off';
      const built = buildOrRefuse({ packsEnabled: enabled }, `${p.id} turned ${onOff}`, `${target.title} could not be turned ${onOff}.`);
      deps.settings.set('packs.enabled', enabled);
      commit(built);
    }),
  );

  serve(kernel, 'packs.import', (p) =>
    serialized(async () => {
      await ensureLoaded();
      const parsed = parseImportText(isRecord(p) ? p.text : undefined);
      if (!parsed.ok) throw invalid(parsed.reason);
      const checked = checkPack(parsed.json);
      if (!checked.ok) throw invalid(checked.reason);
      const { kind } = checked;
      const { id, version } = checked.pack;
      const kindName = KIND_NAMES[kind];
      const warnings: string[] = [];

      // Bundled packs come first: a pack that reuses a bundled id is refused unless it is the same kind
      // with a higher version, which replaces ("shadows") the bundled one.
      const shipped = bundled.find((b) => b.id === id);
      if (shipped && shipped.kind !== kind) {
        throw invalid(`A ${KIND_NAMES[shipped.kind]} with the id "${id}" ships with Spellglass. Give this ${kindName} an id of its own.`);
      }
      if (shipped && !isHigherVersion(version, shipped.version)) {
        throw invalid(`A pack with the id "${id}" ships with Spellglass (version ${shipped.version}). Give this pack an id of its own, or a higher version to replace it.`);
      }
      const earlier = user.find((u) => u.id === id);
      if (earlier?.pack && earlier.kind !== kind) {
        throw invalid(`You already have a ${KIND_NAMES[earlier.kind]} with the id "${id}". Remove it first, or give this ${kindName} an id of its own.`);
      }
      if (earlier) warnings.push(earlier.pack ? `This replaces the copy you imported earlier (version ${earlier.version}).` : 'This replaces a damaged copy you imported earlier.');

      // The record keeps the JSON exactly as imported; it is migrated again each time it loads.
      const importedAt = Date.now();
      const record = userPackRecord(id, parsed.json, importedAt);
      const entry = loadedFromChecked(checked, { user: true, storageKey: id, importedAt });
      const nextUser = [...user.filter((u) => u.id !== id && u.storageKey !== id), entry];
      // Everything that can fail comes before anything changes, so an error nobody foresaw refuses
      // this pack and keeps the others (Section 7.9) instead of leaving it half imported.
      const refusal = `This ${kindName} could not be loaded.`;
      let recordText: string;
      try {
        recordText = JSON.stringify(record);
      } catch (err) {
        log.warn(`could not keep ${kindName} ${id}`, err);
        throw invalid(refusal);
      }
      const built = buildOrRefuse({ user: nextUser }, `${kindName} ${id}`, refusal);
      user = nextUser;
      if (earlier?.storageKey && earlier.storageKey !== id) userRecordText.delete(earlier.storageKey);
      userRecordText.set(id, recordText);
      const next = commit(built, [entry]);

      const summary = next.packs.find((s) => s.id === id);
      if (summary?.warnings) warnings.push(...summary.warnings);
      if (summary && summary.unmet.length) warnings.push(needsSentence(summary.unmet));
      for (const e of next.spells) {
        if (e.packId === id && summary?.enabled && e.unavailableReason && !summary.unmet.length) warnings.push(`${e.spell.incantation}: ${e.unavailableReason}`);
      }
      if (summary && !summary.enabled) warnings.push(`This ${kindName} is turned off. Turn it on in the Workshop to use it.`);

      if (earlier?.storageKey && earlier.storageKey !== id) await del('packs', earlier.storageKey);
      const write = await putOutcome('packs', id, record);
      if (write.refused !== undefined) warnings.push(`Spellglass could not save this ${kindName}, so it lasts only until Spellglass is closed. ${write.refused}`.trim());
      else if (!write.saved || storageIsTemporary()) warnings.push('Storage is not available, so this pack lasts only until Spellglass is closed.');
      return { id, kind, warnings: [...new Set(warnings)] };
    }),
  );

  serve(kernel, 'packs.remove', (p) =>
    serialized(async () => {
      await ensureLoaded();
      const id = isRecord(p) && typeof p.id === 'string' ? p.id : '';
      const target = user.find((u) => u.id === id) ?? user.find((u) => u.storageKey === id);
      if (!target) {
        if (bundled.some((b) => b.id === id)) throw invalid('Packs that ship with Spellglass cannot be removed. Turn the pack off instead.');
        throw invalid(`No pack has the id "${id}".`);
      }
      user = user.filter((u) => u !== target);
      userRecordText.delete(target.storageKey ?? target.id);
      // Forget its on/off choice, so a later import starts from the pack's own default. A bundled pack
      // of the same id (which this one shadowed) keeps the choice.
      const enabled = packsEnabled();
      if (!bundled.some((b) => b.id === target.id) && Object.prototype.hasOwnProperty.call(enabled, target.id)) {
        const { [target.id]: _gone, ...rest } = enabled;
        deps.settings.set('packs.enabled', rest);
      }
      rebuildNow();
      await del('packs', target.storageKey ?? target.id);
    }),
  );

  serve(kernel, 'packs.export', (p) => {
    if (isRecord(p) && p.gestures === true) {
      // Every drawing the player made, also for spells whose pack is not loaded now: they are theirs.
      const drawings = [...overrides.values()];
      if (!drawings.length) throw invalid('There are no redrawn gestures to export yet. Redraw a gesture in the Workshop first.');
      const pack = gesturePackFromOverrides(drawings, new Date());
      return { filename: exportFilename(pack.id), text: packText(pack) };
    }
    const id = isRecord(p) && typeof p.id === 'string' ? p.id : '';
    if (!id) throw invalid('Say which pack to export, or ask for the redrawn gestures.');
    const summary = book.packs.find((s) => s.id === id);
    const found = summary?.user ? user.find((u) => u.id === id) : bundled.find((b) => b.id === id);
    if (!found) throw invalid(`No pack has the id "${id}".`);
    if (!found.pack) throw invalid('This pack could not be read, so it cannot be exported.');
    // The pack in its current format, unknown fields included: a pack imported in an older format
    // leaves as the current one.
    return { filename: exportFilename(id), text: packText(found.pack) };
  });

  serve(kernel, 'progress.reset', (p) =>
    serialized(async () => {
      await ensureLoaded();
      const spellId = isRecord(p) && typeof p.spellId === 'string' && p.spellId ? p.spellId : undefined;
      // In turn with the progress writes, so none that was queued before the reset lands after it.
      // Steps queued after it are written after it, onto the reset record.
      await queueSave(async () => {
        if (spellId) {
          // One spell: its count starts again. Tiers already opened stay open.
          progress.delete(spellId);
          notices.push(spellId);
          await del('progress', spellId);
          return;
        }
        // Everything: counts, learned spells and the unlocked tier (the only way it goes down).
        notices.push(...progress.keys());
        progress = new Map();
        unlockedTier = 1;
        await clearStore('progress');
        await del('kv', UNLOCKED_TIER_KEY);
      });
      rebuildNow();
    }),
  );

  return {
    load: (url) => serialized(() => loadAll(url)),
    spellbook: () => book,
  };
}

function applySteps(rec: SpellProgress | undefined, steps: readonly ProgressStep[]): SpellProgress | undefined {
  return steps.reduce<SpellProgress | undefined>((r, step) => step(r), rec);
}

/** Held across each progress save (a read, a merge and a write), named for the whole site. */
const PROGRESS_LOCK = 'spellglass:progress';

/**
 * Run a progress save while holding a lock every window of the app shares (the Web Locks API), so two
 * windows saving at the same moment take turns: each reads what the other wrote, and no cast is lost.
 * The queue keeps a window's own saves in order; the merge keeps whatever other windows saved before
 * the read. Where the browser has no Web Locks, the save runs as it is, and only two windows writing
 * within a few milliseconds of each other can still lose a cast.
 */
function withProgressLock<T>(task: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: Pick<LockManager, 'request'> }).locks : undefined;
  return locks && typeof locks.request === 'function' ? locks.request(PROGRESS_LOCK, task) : task();
}

/** The same counts, as far as the spellbook and 'progress.changed' can tell. */
function sameProgress(a: SpellProgress | undefined, b: SpellProgress | undefined): boolean {
  if (!a || !b) return a === b;
  return a.casts === b.casts && a.practiceAttempts === b.practiceAttempts && a.best === b.best && a.learnedAt === b.learnedAt;
}

function sameMap<T>(a: ReadonlyMap<string, T>, b: ReadonlyMap<string, T>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (!b.has(k) || JSON.stringify(b.get(k)) !== JSON.stringify(v)) return false;
  return true;
}

function newlyOpened(before: Spellbook, after: Spellbook): string[] {
  const was = new Map(before.spells.map((e) => [e.spell.id, e.status]));
  return after.spells.filter((e) => e.enabled && was.get(e.spell.id) === 'locked').map((e) => e.spell.id);
}
