// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CameraProfile, CameraReady, CameraStatus, Kernel, Module } from '../../contracts';
import { createKernel, emit, memoryPersistence, type KernelHost } from '../../kernel';
import { AppState } from '../app-state.svelte';
import WandTuning from './WandTuning.svelte';

// Vitest loads 'svelte' with Node's conditions, which pick the server build, where mount() is not
// available. These tests run in jsdom, so every importer gets the browser build instead (its types are
// those of 'svelte', hence the cast).
vi.mock('svelte', () => import('../../../node_modules/svelte/src/index-client.js' as string));

beforeAll(() => {
  // jsdom has neither; the live view only sizes and paints its canvas with them.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
});

// ------------------------------------------------------------------------------ a camera

/**
 * Capture, as far as the route goes: on every open it sets brightTip.profile from the camera's stored
 * route, else from its label (an infrared camera named "USB Camera" reads as visible), and
 * 'camera.profile.save' patches the stored profile.
 */
function fakeCapture() {
  const device = { deviceId: 'usb-1', label: 'USB Camera', infrared: false };
  const state = { on: false, generation: 0, stored: null as Partial<CameraProfile> | null, saves: [] as unknown[] };
  let k: Kernel;
  const status = (s: Partial<CameraStatus>) => emit(k, 'capture.camera', 'camera.status', { state: 'off', generation: state.generation, permission: 'granted', ...s });
  async function open(): Promise<void> {
    if (state.on) return;
    state.on = true;
    state.generation++;
    await k.request('settings.set', { key: 'brightTip.profile', value: state.stored?.profile ?? 'visible' });
    status({ state: 'on', deviceId: device.deviceId, label: device.label, width: 1280, height: 720 });
    const ready = { ...device, width: 1280, height: 720, fps: 30, exposure: null, generation: state.generation } as unknown as CameraReady;
    emit(k, 'capture.camera', 'camera.ready', ready);
  }
  function close(): void {
    if (!state.on) return;
    state.on = false;
    emit(k, 'capture.camera', 'camera.stopped', { reason: 'released', generation: state.generation });
    status({ state: 'off' });
  }
  const module: Module = {
    manifest: { id: 'capture.camera', kind: 'capture', version: '1.0.0', contract: '^1.1', provides: [] },
    async init(kernel) {
      k = kernel;
      kernel.handle('camera.devices', () => [device]);
      kernel.handle('camera.start', () => open());
      kernel.handle('camera.stop', () => close());
      kernel.handle('camera.profile.save', (p: Partial<CameraProfile> | undefined) => {
        if (!state.on) throw { name: 'InvalidStateError', message: 'The camera is not on.' };
        state.saves.push(p);
        state.stored = { ...state.stored, ...p };
        return state.stored;
      });
    },
    async start() {},
    async stop() {},
  };
  return { module, state, open, close };
}

/** A tracker that does nothing; the bright tip holds the camera while it runs. */
function tracker(id: string, camera = false): Module {
  let k: Kernel;
  return {
    manifest: { id, kind: 'tracker', version: '1.0.0', contract: '^1.1', provides: [] },
    async init(kernel) {
      k = kernel;
    },
    async start() {
      if (camera) void k.request('camera.start', { requester: id, exposure: 'profile' });
    },
    async stop() {
      if (camera) await k.request('camera.stop', { requester: id });
    },
  };
}

// ------------------------------------------------------------------------------ harness

let shown: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (shown) unmount(shown);
  shown = null;
  document.body.innerHTML = '';
});

async function setup(settings: Record<string, unknown>) {
  const kernel: KernelHost = createKernel({ persistence: memoryPersistence(), features: [] });
  const camera = fakeCapture();
  kernel.register(camera.module);
  kernel.register(tracker('tracker.pointer'));
  kernel.register(tracker('tracker.bright-tip', true));
  kernel.register(tracker('tracker.hand', true));
  await kernel.init();
  for (const [key, value] of Object.entries(settings)) kernel.settings.set(key, value);
  await kernel.start();
  const app = new AppState(kernel, { mirror: document.createElement('div'), startModules: async () => {} });
  const target = document.body.appendChild(document.createElement('div'));
  shown = mount(WandTuning, { target, props: { app }, intro: false });
  flushSync();
  return { kernel, camera, app, target };
}

function pick(target: HTMLElement, route: string): void {
  const input = target.querySelector<HTMLInputElement>(`input[name="tracker-route"][value="${route}"]`);
  if (!input) throw new Error(`no ${route} route`);
  input.click();
  flushSync();
}

const route = (kernel: KernelHost) => kernel.settings.get('brightTip.profile', '');

// ------------------------------------------------------------------------------ tests

describe('Wand tuning: the route of the bright tip', () => {
  it('stores route C with the camera when it is on, so the next open keeps it', async () => {
    const { kernel, camera, app, target } = await setup({ 'capture.consent': true, 'tracker.active': 'tracker.bright-tip' });
    await vi.waitFor(() => expect(app.camera?.state).toBe('on'));
    expect(route(kernel)).toBe('visible');

    pick(target, 'infrared');
    await vi.waitFor(() => expect(camera.state.saves).toContainEqual({ profile: 'infrared' }));
    expect(route(kernel)).toBe('infrared');

    // The camera closes (a tracker switch, a reload) and opens again.
    camera.close();
    await camera.open();
    expect(route(kernel)).toBe('infrared');
  });

  it('stores it on the camera.ready that follows when the choice itself opens the camera', async () => {
    const { kernel, camera, target } = await setup({ 'capture.consent': true });
    expect(camera.state.on).toBe(false);

    pick(target, 'infrared');
    // The open set the route from the label; the choice is put back and stored with the camera.
    await vi.waitFor(() => expect(camera.state.saves).toContainEqual({ profile: 'infrared' }));
    await vi.waitFor(() => expect(route(kernel)).toBe('infrared'));

    camera.close();
    await camera.open();
    expect(route(kernel)).toBe('infrared');
    // Only the route: nothing else is held with the camera.
    expect(camera.state.stored).toEqual({ profile: 'infrared' });
  });

  it('stores nothing for a route without the bright tip', async () => {
    const { camera, target } = await setup({ 'capture.consent': true });
    pick(target, 'hand');
    await vi.waitFor(() => expect(camera.state.on).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(camera.state.saves).toEqual([]);
  });
});

// The reflection goes with the route, as on the Threshold and the mirror's "Use mouse or touch"
// (Sections 7.8 and 10.1): a camera route shows it, mouse or touch lets the camera go.
describe('Wand tuning: the route and the reflection', () => {
  const mirror = (kernel: KernelHost) => kernel.settings.get('capture.mirror', null);
  const tracker = (kernel: KernelHost) => kernel.settings.get('tracker.active', null);

  it('lets the reflection go when mouse or touch is chosen', async () => {
    const { kernel, app, target } = await setup({ 'capture.consent': true, 'capture.mirror': true, 'tracker.active': 'tracker.bright-tip' });
    await vi.waitFor(() => expect(app.camera?.state).toBe('on'));
    pick(target, 'pointer');
    await vi.waitFor(() => expect(tracker(kernel)).toBe('tracker.pointer'));
    expect(mirror(kernel)).toBe(false);
  });

  it('turns to the mouse from a camera problem without asking for the camera again', async () => {
    const { kernel, app, target } = await setup({ 'capture.consent': true, 'capture.mirror': true, 'tracker.active': 'tracker.bright-tip' });
    await vi.waitFor(() => expect(app.camera?.state).toBe('on'));
    emit(kernel, 'capture.camera', 'camera.status', { state: 'blocked', generation: 99, permission: 'denied', requesters: ['tracker.bright-tip', 'effect.stage'] });
    flushSync();
    const button = [...target.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Use the mouse instead');
    if (!button) throw new Error('no "Use the mouse instead" button');
    button.click();
    await vi.waitFor(() => expect(tracker(kernel)).toBe('tracker.pointer'));
    expect(mirror(kernel)).toBe(false);
  });

  it('brings the reflection back when a camera route follows a mouse first run', async () => {
    const { kernel, target } = await setup({ 'capture.consent': false, 'capture.mirror': false, 'tracker.active': 'tracker.pointer' });
    pick(target, 'wand');
    await vi.waitFor(() => expect(tracker(kernel)).toBe('tracker.bright-tip'));
    expect(mirror(kernel)).toBe(true);
    expect(kernel.settings.get('capture.consent', null)).toBe(true);
  });
});

// Access (Section 10.6): the camera problem goes once its cause does, and the button that had focus
// with it; focus must land in the drawer, not fall to the page.
describe('Wand tuning: the keyboard’s place', () => {
  const button = (target: HTMLElement, text: string) => {
    const b = [...target.querySelectorAll('button')].find((x) => x.textContent?.trim() === text);
    if (!b) throw new Error(`no "${text}" button`);
    return b;
  };

  it('moves focus to the Mouse or touch route after "Use the mouse instead"', async () => {
    const { kernel, app, target } = await setup({ 'capture.consent': true, 'capture.mirror': true, 'tracker.active': 'tracker.bright-tip' });
    await vi.waitFor(() => expect(app.camera?.state).toBe('on'));
    emit(kernel, 'capture.camera', 'camera.status', { state: 'blocked', generation: 99, permission: 'denied', requesters: ['tracker.bright-tip'] });
    flushSync();
    const mouse = button(target, 'Use the mouse instead');
    mouse.focus();
    mouse.click();
    await vi.waitFor(() => expect(document.activeElement).toBe(target.querySelector('input[name="tracker-route"][value="pointer"]')));
    expect((document.activeElement as HTMLInputElement).checked).toBe(true);
    expect(mouse.isConnected).toBe(false);
  });

  it('moves focus to the route in use once "Use the camera" has allowed it', async () => {
    const { kernel, target } = await setup({ 'capture.consent': false, 'tracker.active': 'tracker.bright-tip' });
    // Capture, without consent, keeps the camera off.
    emit(kernel, 'capture.camera', 'camera.status', { state: 'off', generation: 99, permission: 'prompt' });
    flushSync();
    const use = button(target, 'Use the camera');
    use.focus();
    use.click();
    await vi.waitFor(() => expect(kernel.settings.get('capture.consent', null)).toBe(true));
    await vi.waitFor(() => expect(document.activeElement).toBe(target.querySelector('input[name="tracker-route"][value="wand"]')));
  });
});
