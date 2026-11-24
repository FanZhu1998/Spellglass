// The kernel: event bus, module registry and lifecycle, feature detection, settings, named
// requests, and the pack loader (Section 5). It knows modules only through their manifests.

import type {
  Envelope, EventMap, EventType, Kernel, Module, ModuleKind, ModuleManifest, ModuleState, Spellbook,
} from '../contracts';
import { CONTRACT, eventVersion } from '../contracts';
import { Bus } from './bus';
import { CapabilitySet } from './capabilities';
import { KernelError } from './errors';
import { detectFeatures } from './features';
import { logger } from './log';
import { satisfies } from './semver';
import { SettingsStore, localStoragePersistence, type SettingsPersistence } from './settings';
import { createPackService, type PackService } from './packs/service';

const log = logger('kernel');

/** Kinds where only one module runs at a time, and the setting that names it. */
const EXCLUSIVE: Partial<Record<ModuleKind, { setting: string; fallback: string }>> = {
  tracker: { setting: 'tracker.active', fallback: 'tracker.pointer' },
};

/** A start() or stop() that has not settled by then is abandoned (contracts/module.ts). */
const LIFECYCLE_TIMEOUT_MS = 6000;

export interface KernelOptions {
  persistence?: SettingsPersistence;
  /** Clock for capture times; performance.now() by default. Tests use fake timers instead. */
  clock?: () => number;
  /** Override feature detection (tests, or a host that knows better). */
  features?: string[];
  /** fetch used by the pack loader. */
  fetch?: typeof fetch;
  /** Milliseconds before an unsettled start() or stop() is abandoned. */
  lifecycleTimeoutMs?: number;
}

interface ModuleRecord {
  module: Module;
  state: ModuleState;
  reason?: string;
  phase?: 'init' | 'start' | 'stop';
}

export interface KernelHost extends Kernel {
  register(...modules: Module[]): void;
  /** Detect features, resolve availability, then init() every available module in order. */
  init(): Promise<void>;
  /** Load the pack index and every pack, then publish the spellbook. Never rejects. */
  loadPacks(indexUrl: string | null): Promise<Spellbook>;
  /** start() every initialized module, except non-active members of exclusive kinds. */
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly started: boolean;
  readonly settings: SettingsStore;
  readonly capabilities: CapabilitySet;
  readonly packs: PackService;
  modules(): { manifest: ModuleManifest; state: ModuleState; reason?: string }[];
  /** Effect step `use` names that some usable effect module implements. */
  knownEffects(): Set<string>;
  /** Typed publish, with source 'kernel' unless given. */
  emit<K extends EventType>(type: K, payload: EventMap[K], source?: string, t?: number): void;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new KernelError('timeout', `${what} did not finish within ${ms} ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export function createKernel(options: KernelOptions = {}): KernelHost {
  const bus = new Bus();
  const clock = options.clock ?? (() => (globalThis.performance ? performance.now() : Date.now()));
  const settings = new SettingsStore(options.persistence ?? localStoragePersistence());
  const capabilities = new CapabilitySet();
  const records: ModuleRecord[] = [];
  const handlers = new Map<string, { fn: (payload: any, from?: string) => unknown; owner: string }>();
  const transient = new Map<ModuleKind, string>();
  const timeoutMs = options.lifecycleTimeoutMs ?? LIFECYCLE_TIMEOUT_MS;
  let features: string[] = [];
  let started = false;
  let initialized = false;
  let switchChain: Promise<void> = Promise.resolve();

  const setState = (rec: ModuleRecord, state: ModuleState, reason?: string, phase?: ModuleRecord['phase']) => {
    rec.state = state;
    rec.reason = reason;
    rec.phase = phase;
    host.emit('module.status', { id: rec.module.manifest.id, kind: rec.module.manifest.kind, state, reason, phase });
  };

  /** Usable: initialized, running, stopped, or failed only at start (it may start again). */
  const usable = (rec: ModuleRecord) =>
    rec.state === 'initialized' || rec.state === 'running' || rec.state === 'stopped' || (rec.state === 'error' && rec.phase !== 'init');

  /** A per-module view of the kernel, so requests know who asked and handlers know their owner. */
  const facade = (owner: string): Kernel => ({
    publish: (e) => bus.publish(e),
    subscribe: (type, fn) => bus.subscribe(type, fn),
    has: (cap) => capabilities.has(cap),
    setting: (key, fallback) => settings.get(key, fallback),
    last: (type) => bus.last(type),
    now: clock,
    request: (name, payload) => request(name, payload, owner),
    handle: (name, fn) => handle(name, fn, owner),
  });

  function handle(name: string, fn: (payload: any, from?: string) => unknown, owner: string): () => void {
    const existing = handlers.get(name);
    if (existing && existing.owner !== owner) log.warn(`request '${name}' was handled by ${existing.owner}; ${owner} replaces it`);
    const entry = { fn, owner };
    handlers.set(name, entry);
    return () => {
      if (handlers.get(name) === entry) handlers.delete(name);
    };
  }

  async function request<R>(name: string, payload: unknown, from?: string): Promise<R> {
    const h = handlers.get(name);
    if (!h) throw new KernelError('no-handler', `Nothing handles '${name}'`);
    return (await h.fn(payload, from)) as R;
  }

  /** Rebuild the capability set from platform features and the provides of usable modules. */
  function recomputeCapabilities(): void {
    capabilities.clear();
    for (const f of features) capabilities.add(f);
    for (const rec of records) if (usable(rec) || rec.state === 'registered') for (const p of rec.module.manifest.provides) capabilities.add(p);
  }

  const activeOf = (kind: ModuleKind): string | undefined => {
    const ex = EXCLUSIVE[kind];
    if (!ex) return undefined;
    const ok = (id: string | undefined) =>
      !!id && records.some((r) => r.module.manifest.id === id && r.module.manifest.kind === kind && usable(r));
    const want = transient.get(kind) ?? settings.get<string>(ex.setting, ex.fallback);
    if (ok(want)) return want;
    if (ok(ex.fallback)) return ex.fallback;
    return records.find((r) => r.module.manifest.kind === kind && usable(r))?.module.manifest.id;
  };

  async function startRecord(rec: ModuleRecord): Promise<void> {
    if (!(rec.state === 'initialized' || rec.state === 'stopped' || (rec.state === 'error' && rec.phase === 'start'))) return;
    try {
      await withTimeout(rec.module.start(), timeoutMs, `${rec.module.manifest.id} start()`);
      setState(rec, 'running');
    } catch (err) {
      log.warn(`${rec.module.manifest.id} failed to start`, err);
      setState(rec, 'error', err instanceof Error ? err.message : String(err), 'start');
    }
  }

  async function stopRecord(rec: ModuleRecord): Promise<void> {
    if (rec.state !== 'running') return;
    try {
      await withTimeout(rec.module.stop(), timeoutMs, `${rec.module.manifest.id} stop()`);
    } catch (err) {
      log.warn(`${rec.module.manifest.id} failed to stop cleanly`, err);
    }
    setState(rec, 'stopped');
  }

  /** Stop the running member of an exclusive kind and start the chosen one. Serialized. */
  function switchExclusive(kind: ModuleKind): Promise<void> {
    switchChain = switchChain.then(async () => {
      if (!started) return;
      const want = activeOf(kind);
      for (const rec of records) {
        if (rec.module.manifest.kind !== kind) continue;
        if (rec.module.manifest.id !== want) await stopRecord(rec);
      }
      const target = records.find((r) => r.module.manifest.id === want);
      if (target && target.state !== 'running') await startRecord(target);
    });
    return switchChain;
  }

  const packs = createPackService({
    kernel: facade('kernel.packs'),
    capabilities,
    // Called lazily (in load() and later), never while the kernel is being created.
    knownEffects: () => host.knownEffects(),
    settings,
    fetch: options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)),
  });

  const host: KernelHost = {
    ...facade('kernel'),
    get started() {
      return started;
    },
    settings,
    capabilities,
    packs,

    emit(type, payload, source = 'kernel', t) {
      bus.publish({ type, v: eventVersion(type), t: t ?? clock(), source, payload } as Envelope<unknown>);
    },

    register(...modules) {
      for (const module of modules) {
        const id = module.manifest.id;
        if (records.some((r) => r.module.manifest.id === id)) throw new Error(`Module ${id} is already registered`);
        records.push({ module, state: 'registered' });
      }
    },

    async init() {
      if (initialized) return;
      initialized = true;
      features = options.features ?? detectFeatures();

      // Contract range first: a module that speaks another contract is never usable.
      for (const rec of records) {
        const m = rec.module.manifest;
        if (!satisfies(CONTRACT, m.contract)) {
          rec.state = 'unavailable';
          rec.reason = `speaks contract ${m.contract}; this kernel is ${CONTRACT}`;
        }
      }
      // Requirements to a fixpoint: a requirement may be another module's capability, which only
      // counts while that module is itself available.
      let changed = true;
      while (changed) {
        changed = false;
        recomputeCapabilities();
        for (const rec of records) {
          if (rec.state !== 'registered') continue;
          const unmet = capabilities.unmet(rec.module.manifest.requires);
          if (unmet.length) {
            rec.state = 'unavailable';
            rec.reason = `needs ${unmet.join(', ')}`;
            changed = true;
          }
        }
      }

      for (const rec of records) {
        if (rec.state === 'unavailable') {
          setState(rec, 'unavailable', rec.reason);
          continue;
        }
        try {
          await rec.module.init(facade(rec.module.manifest.id));
          setState(rec, 'initialized');
        } catch (err) {
          log.error(`${rec.module.manifest.id} failed to init`, err);
          setState(rec, 'error', err instanceof Error ? err.message : String(err), 'init');
        }
      }
      // A module whose init() failed provides nothing.
      recomputeCapabilities();
    },

    async loadPacks(indexUrl) {
      return packs.load(indexUrl);
    },

    async start() {
      if (started) return;
      started = true;
      for (const rec of records) {
        if (EXCLUSIVE[rec.module.manifest.kind]) continue;
        await startRecord(rec);
      }
      for (const kind of Object.keys(EXCLUSIVE) as ModuleKind[]) await switchExclusive(kind);
    },

    async stop() {
      if (!started) return;
      await switchChain;
      for (const rec of [...records].reverse()) await stopRecord(rec);
      started = false;
    },

    modules() {
      return records.map((r) => ({ manifest: r.module.manifest, state: r.state, reason: r.reason }));
    },

    knownEffects() {
      const set = new Set<string>();
      for (const r of records) if (usable(r) && r.module.manifest.kind === 'effect') for (const u of r.module.manifest.effects ?? []) set.add(u);
      return set;
    },
  };

  // Settings changes go out on the bus; exclusive kinds follow their setting.
  settings.onChange((key, value) => {
    host.emit('settings.changed', { key, value });
    for (const [kind, ex] of Object.entries(EXCLUSIVE)) {
      if (ex && ex.setting === key && !transient.has(kind as ModuleKind)) void switchExclusive(kind as ModuleKind);
    }
  });

  // Built-in requests.
  const k = facade('kernel');
  k.handle('settings.set', async (p: { key: string; value: unknown }) => {
    if (!p || typeof p.key !== 'string') throw new KernelError('invalid-payload', 'settings.set needs { key, value }');
    try {
      settings.set(p.key, p.value);
    } catch (err) {
      throw new KernelError('invalid-payload', err instanceof Error ? err.message : String(err));
    }
    // Resolve after a tracker switch has completed, so callers can rely on it.
    if (Object.values(EXCLUSIVE).some((ex) => ex?.setting === p.key)) await switchChain;
  });
  k.handle('settings.reset', async (p: { key?: string } | undefined) => {
    settings.reset(p?.key);
    await switchChain;
  });
  k.handle('settings.all', () => settings.all());
  k.handle('settings.user', () => settings.changed());
  k.handle('modules.list', () => host.modules());

  k.handle('modules.activate', async (p: { kind: ModuleKind; id: string; transient?: boolean }) => {
    const ex = p && EXCLUSIVE[p.kind];
    if (!ex) throw new KernelError('invalid-payload', `${p?.kind} is not an exclusive kind`);
    if (!records.some((r) => r.module.manifest.id === p.id && r.module.manifest.kind === p.kind)) {
      throw new KernelError('invalid-payload', `No ${p.kind} module ${p.id}`);
    }
    if (p.transient) {
      transient.set(p.kind, p.id);
      await switchExclusive(p.kind);
    } else {
      transient.delete(p.kind);
      settings.set(ex.setting, p.id);
      await switchExclusive(p.kind);
    }
    return { active: activeOf(p.kind) ?? '' };
  });
  k.handle('modules.release', async (p: { kind: ModuleKind; id: string }) => {
    if (p && transient.get(p.kind) === p.id) {
      transient.delete(p.kind);
      await switchExclusive(p.kind);
    }
    return { active: activeOf(p.kind) ?? '' };
  });
  k.handle('modules.restart', async (p: { id: string }) => {
    const rec = records.find((r) => r.module.manifest.id === p?.id);
    if (!rec) throw new KernelError('invalid-payload', `No module ${p?.id}`);
    if (!usable(rec)) return { state: rec.state };
    const ex = EXCLUSIVE[rec.module.manifest.kind];
    if (ex) {
      // Restart only if it is the chosen member of its kind.
      await switchChain;
      if (rec.state === 'running') await stopRecord(rec);
      if (rec.state === 'error') rec.state = 'stopped';
      await switchExclusive(rec.module.manifest.kind);
    } else if (started) {
      await stopRecord(rec);
      if (rec.state === 'error') rec.state = 'stopped';
      await startRecord(rec);
    }
    return { state: rec.state };
  });

  return host;
}
