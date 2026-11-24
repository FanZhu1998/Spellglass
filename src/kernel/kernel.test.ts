import { describe, expect, it, vi } from 'vitest';
import type { Kernel, Module, ModuleManifest } from '../contracts';
import { Bus } from './bus';
import { CapabilitySet } from './capabilities';
import { createKernel } from './kernel';
import { memoryPersistence, SettingsStore } from './settings';
import { satisfies } from './semver';
import { emit, on, ask } from './typed';

function fakeModule(manifest: Partial<ModuleManifest> & { id: string; kind: ModuleManifest['kind'] }, hooks: Partial<Module> = {}) {
  const calls: string[] = [];
  let kernel: Kernel | null = null;
  const m: Module & { calls: string[]; kernel: () => Kernel | null } = {
    manifest: { version: '1.0.0', contract: '^1.1', provides: [], ...manifest } as ModuleManifest,
    calls,
    kernel: () => kernel,
    async init(k) {
      kernel = k;
      calls.push('init');
      await hooks.init?.(k);
    },
    async start() {
      calls.push('start');
      await hooks.start?.();
    },
    async stop() {
      calls.push('stop');
      await hooks.stop?.();
    },
  };
  return m;
}

describe('Bus: run to completion', () => {
  it('delivers an event to every subscriber before events published from its handlers', () => {
    const bus = new Bus();
    const order: string[] = [];
    const env = (type: string) => ({ type, v: 1, t: 0, source: 'test', payload: null });
    bus.subscribe('stroke.end', () => {
      order.push('recognizer saw stroke.end');
      bus.publish(env('recognition.result'));
    });
    bus.subscribe('stroke.end', () => order.push('engine saw stroke.end'));
    bus.subscribe('recognition.result', () => order.push('engine saw recognition.result'));
    bus.publish(env('stroke.end'));
    expect(order).toEqual(['recognizer saw stroke.end', 'engine saw stroke.end', 'engine saw recognition.result']);
  });

  it('updates last() at publish time and keeps no frames', () => {
    const bus = new Bus();
    bus.publish({ type: 'camera.frame', v: 1, t: 1, source: 's', payload: {} });
    bus.publish({ type: 'tracker.status', v: 1, t: 2, source: 's', payload: { a: 1 } });
    expect(bus.last('camera.frame')).toBeUndefined();
    expect(bus.last<{ a: number }>('tracker.status')?.payload.a).toBe(1);
  });

  it('survives a throwing handler and stops a runaway cascade', () => {
    const bus = new Bus();
    let seen = 0;
    bus.subscribe('x', () => {
      throw new Error('boom');
    });
    bus.subscribe('x', () => seen++);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    bus.publish({ type: 'x', v: 1, t: 0, source: 's', payload: null });
    expect(seen).toBe(1);
    bus.subscribe('loop', () => bus.publish({ type: 'loop', v: 1, t: 0, source: 's', payload: null }));
    bus.publish({ type: 'loop', v: 1, t: 0, source: 's', payload: null });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
});

describe('semver and capabilities', () => {
  it('handles the ranges the contracts use', () => {
    expect(satisfies('1.1', '^1.0')).toBe(true);
    expect(satisfies('1.1.0', '>=1.0 <2.0')).toBe(true);
    expect(satisfies('2.0.0', '>=1.0 <2.0')).toBe(false);
    expect(satisfies('1.1', '^1.2')).toBe(false);
    expect(satisfies('1.4.2', '1.x')).toBe(true);
    expect(satisfies('0.9.0', '^1.0 || ^0.9')).toBe(true);
  });

  it('meets lower versions with higher providers', () => {
    const caps = new CapabilitySet();
    caps.add('fx.light@2');
    caps.add('audio');
    expect(caps.has('fx.light@1')).toBe(true);
    expect(caps.has('fx.light@3')).toBe(false);
    expect(caps.has('audio@1')).toBe(true);
    expect(caps.unmet(['fx.light@1', 'fx.props@1'])).toEqual(['fx.props@1']);
  });
});

describe('SettingsStore', () => {
  it('never persists session-only settings', () => {
    const persistence = memoryPersistence();
    const store = new SettingsStore(persistence);
    store.set('tracker.debug', true);
    store.set('brightTip.k', 5);
    const saved = persistence.load()!;
    expect(saved.values['tracker.debug']).toBeUndefined();
    expect(saved.values['brightTip.k']).toBe(5);
    expect(store.get('tracker.debug', false)).toBe(true);
    expect(new SettingsStore(persistence).get('tracker.debug', false)).toBe(false);
  });

  it('rejects values of the wrong type', () => {
    const store = new SettingsStore(memoryPersistence());
    expect(() => store.set('brightTip.k', 'four')).toThrow(TypeError);
  });
});

describe('Kernel lifecycle', () => {
  it('resolves requirements on other modules to a fixpoint', async () => {
    const kernel = createKernel({ persistence: memoryPersistence(), features: ['platform.camera'] });
    const capture = fakeModule({ id: 'capture.camera', kind: 'capture', provides: ['camera.frames@1'], requires: ['platform.camera'] });
    const tip = fakeModule({ id: 'tracker.bright-tip', kind: 'tracker', provides: ['tip.source'], requires: ['camera.frames@1'] });
    const needsMissing = fakeModule({ id: 'x.lonely', kind: 'share', requires: ['platform.nothing'] });
    const needsLonely = fakeModule({ id: 'x.dependent', kind: 'share', requires: ['x.cap'] });
    needsMissing.manifest.provides = ['x.cap'];
    kernel.register(capture, tip, needsMissing, needsLonely);
    await kernel.init();
    const states = Object.fromEntries(kernel.modules().map((m) => [m.manifest.id, m.state]));
    expect(states).toEqual({ 'capture.camera': 'initialized', 'tracker.bright-tip': 'initialized', 'x.lonely': 'unavailable', 'x.dependent': 'unavailable' });
    expect(kernel.has('x.cap')).toBe(false);
  });

  it('drops the capabilities and effects of a module whose init fails, and falls back to the pointer', async () => {
    const kernel = createKernel({ persistence: memoryPersistence({ 'tracker.active': 'tracker.broken' }), features: [] });
    const broken = fakeModule({ id: 'tracker.broken', kind: 'tracker', provides: ['tip.source@2'] }, { init: async () => { throw new Error('no'); } });
    const pointer = fakeModule({ id: 'tracker.pointer', kind: 'tracker', provides: ['tip.source'] });
    const fx = fakeModule({ id: 'effect.x', kind: 'effect', provides: ['fx.light@1'], effects: ['light.orb'] }, { init: async () => { throw new Error('no'); } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    kernel.register(broken, pointer, fx);
    await kernel.init();
    expect(kernel.has('tip.source@2')).toBe(false);
    expect(kernel.has('fx.light@1')).toBe(false);
    expect(kernel.knownEffects().size).toBe(0);
    await kernel.start();
    expect(pointer.calls).toContain('start');
    expect(broken.calls).not.toContain('start');
  });

  it('runs one tracker at a time and settings.set resolves after the switch', async () => {
    const kernel = createKernel({ persistence: memoryPersistence(), features: [] });
    const a = fakeModule({ id: 'tracker.pointer', kind: 'tracker' });
    const b = fakeModule({ id: 'tracker.bright-tip', kind: 'tracker' });
    const other = fakeModule({ id: 'effect.stage', kind: 'effect' });
    kernel.register(a, b, other);
    await kernel.init();
    await kernel.start();
    expect(a.calls).toEqual(['init', 'start']);
    expect(b.calls).toEqual(['init']);
    await ask(kernel, 'settings.set', { key: 'tracker.active', value: 'tracker.bright-tip' });
    expect(a.calls).toEqual(['init', 'start', 'stop']);
    expect(b.calls).toEqual(['init', 'start']);
    expect(other.calls).toEqual(['init', 'start']);
  });

  it('activates a module transiently without touching the setting, and releases it', async () => {
    const kernel = createKernel({ persistence: memoryPersistence(), features: [] });
    const pointer = fakeModule({ id: 'tracker.pointer', kind: 'tracker' });
    const replay = fakeModule({ id: 'tracker.replay', kind: 'tracker' });
    kernel.register(pointer, replay);
    await kernel.init();
    await kernel.start();
    const r = await ask(kernel, 'modules.activate', { kind: 'tracker', id: 'tracker.replay', transient: true });
    expect(r.active).toBe('tracker.replay');
    expect(kernel.settings.get('tracker.active', '')).toBe('tracker.pointer');
    expect(replay.calls).toContain('start');
    const back = await ask(kernel, 'modules.release', { kind: 'tracker', id: 'tracker.replay' });
    expect(back.active).toBe('tracker.pointer');
    expect(replay.calls.at(-1)).toBe('stop');
  });

  it('abandons a start() that never settles and keeps going', async () => {
    const kernel = createKernel({ persistence: memoryPersistence(), features: [], lifecycleTimeoutMs: 30 });
    const stuck = fakeModule({ id: 'effect.stuck', kind: 'effect' }, { start: () => new Promise(() => {}) });
    const after = fakeModule({ id: 'share.after', kind: 'share' });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    kernel.register(stuck, after);
    await kernel.init();
    await kernel.start();
    expect(after.calls).toContain('start');
    expect(kernel.modules().find((m) => m.manifest.id === 'effect.stuck')?.state).toBe('error');
  });

  it('restarts a module that failed to start', async () => {
    let fail = true;
    const kernel = createKernel({ persistence: memoryPersistence(), features: [] });
    const flaky = fakeModule({ id: 'effect.flaky', kind: 'effect' }, { start: async () => { if (fail) throw new Error('camera busy'); } });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    kernel.register(flaky);
    await kernel.init();
    await kernel.start();
    expect(kernel.modules()[0].state).toBe('error');
    fail = false;
    const r = await ask(kernel, 'modules.restart', { id: 'effect.flaky' });
    expect(r.state).toBe('running');
  });

  it('refuses modules that speak another contract', async () => {
    const kernel = createKernel({ persistence: memoryPersistence(), features: [] });
    const old = fakeModule({ id: 'x.old', kind: 'share', contract: '^2.0' });
    kernel.register(old);
    await kernel.init();
    expect(kernel.modules()[0]).toMatchObject({ state: 'unavailable' });
  });

  it('routes requests, attributes them, and rejects when nobody handles a name', async () => {
    const kernel = createKernel({ persistence: memoryPersistence(), features: [] });
    const m = fakeModule({ id: 'share.links', kind: 'share' }, {
      init: async (k) => {
        k.handle('share.url', (_p: unknown, from?: string) => ({ outcome: from }));
      },
    });
    const asker = fakeModule({ id: 'storage.indexeddb', kind: 'storage' });
    kernel.register(m, asker);
    await kernel.init();
    const res = await asker.kernel()!.request<{ outcome: string }>('share.url', { url: 'x' });
    expect(res.outcome).toBe('storage.indexeddb');
    await expect(kernel.request('nobody.home')).rejects.toMatchObject({ code: 'no-handler' });
  });

  it('publishes settings changes and typed events', async () => {
    const kernel = createKernel({ persistence: memoryPersistence(), features: [] });
    const seen: unknown[] = [];
    on(kernel, 'settings.changed', (p) => seen.push(p));
    emit(kernel, 'test', 'practice.focus', { spellId: 'lumos' });
    await ask(kernel, 'settings.set', { key: 'audio.volume', value: 0.5 });
    expect(seen).toEqual([{ key: 'audio.volume', value: 0.5 }]);
    expect(kernel.last<{ spellId: string }>('practice.focus')?.payload.spellId).toBe('lumos');
    expect(await ask(kernel, 'settings.user')).toEqual({ 'audio.volume': 0.5 });
  });
});
