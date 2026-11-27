// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Kernel, Module } from '../../contracts';
import { createKernel, emit, memoryPersistence, type KernelHost } from '../../kernel';
import { AppState } from '../app-state.svelte';
import Threshold from './Threshold.svelte';

// The route chooser: what choosing a route sets. (WandTuning.test.ts has the camera's side of it.)

// Vitest loads 'svelte' with Node's conditions, which pick the server build, where mount() is not
// available; these tests run in jsdom, so every importer gets the browser build instead.
vi.mock('svelte', () => import('../../../node_modules/svelte/src/index-client.js' as string));

beforeAll(() => {
  // jsdom has no layout: the chooser scrolls its live status into view, and watches its last route.
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

/** A camera that opens when asked, and trackers that do nothing. */
function fakeCapture(): Module {
  let k: Kernel;
  let generation = 0;
  return {
    manifest: { id: 'capture.camera', kind: 'capture', version: '1.0.0', contract: '^1.1', provides: [] },
    async init(kernel) {
      k = kernel;
      kernel.handle('camera.start', () => {
        generation++;
        emit(k, 'capture.camera', 'camera.status', { state: 'on', generation, permission: 'granted' });
        return { deviceId: 'usb-1', label: 'USB Camera', width: 1280, height: 720, fps: 30, exposure: null, generation };
      });
      kernel.handle('camera.stop', () => undefined);
      kernel.handle('camera.profile.save', () => ({}));
    },
    async start() {},
    async stop() {},
  };
}

function tracker(id: string): Module {
  return {
    manifest: { id, kind: 'tracker', version: '1.0.0', contract: '^1.1', provides: [] },
    async init() {},
    async start() {},
    async stop() {},
  };
}

let shown: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (shown) unmount(shown);
  shown = null;
  document.body.innerHTML = '';
});

async function setup(settings: Record<string, unknown>): Promise<{ kernel: KernelHost; target: HTMLElement }> {
  const kernel: KernelHost = createKernel({ persistence: memoryPersistence(), features: [] });
  kernel.register(fakeCapture());
  for (const id of ['tracker.pointer', 'tracker.bright-tip', 'tracker.hand']) kernel.register(tracker(id));
  await kernel.init();
  for (const [key, value] of Object.entries(settings)) kernel.settings.set(key, value);
  await kernel.start();
  const app = new AppState(kernel, { mirror: document.createElement('div'), startModules: async () => {} });
  const target = document.body.appendChild(document.createElement('div'));
  shown = mount(Threshold, { target, props: { app }, intro: false });
  flushSync();
  return { kernel, target };
}

async function choose(target: HTMLElement, route: string): Promise<void> {
  const button = target.querySelector<HTMLButtonElement>(`[data-route="${route}"]`);
  if (!button) throw new Error(`no ${route} route`);
  button.click();
  flushSync();
  // choose() runs its settings one after another; let them all land.
  await vi.waitFor(() => expect(button.getAttribute('aria-pressed')).toBe('true'));
  await new Promise((r) => setTimeout(r, 20));
}

describe("the Threshold: the hand tracker's mode goes with the route", () => {
  it("keeps a returning player's point past the knuckles, and turns wand mode back to the fingertip", async () => {
    const { kernel, target } = await setup({ 'app.onboarded': true, 'capture.consent': true, 'tracker.active': 'tracker.hand', 'hand.mode': 'grip' });
    const mode = () => kernel.settings.get('hand.mode', '');
    const active = () => kernel.settings.get('tracker.active', '');
    // The route in use is shown chosen; choosing it again changes nothing.
    expect(target.querySelector('[data-route="hand"]')!.getAttribute('aria-pressed')).toBe('true');
    await choose(target, 'hand');
    expect(mode()).toBe('grip');
    await choose(target, 'glint');
    expect(active()).toBe('tracker.bright-tip');
    expect(kernel.settings.get('brightTip.profile', '')).toBe('visible');
    await choose(target, 'hand');
    expect(active()).toBe('tracker.hand');
    expect(mode()).toBe('grip');
    await choose(target, 'wand');
    expect(active()).toBe('tracker.hand');
    expect(mode()).toBe('wand');
    await choose(target, 'hand');
    expect(mode()).toBe('finger');
  });
});
