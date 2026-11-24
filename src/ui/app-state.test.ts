// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { CameraProfile, CameraReady, Kernel, Module, PlayArea } from '../contracts';
import { createKernel, emit, memoryPersistence, type KernelHost } from '../kernel';
import { AppState } from './app-state.svelte';
import { SEATED_AREA, WHOLE_VIEW } from './components/tools/play-area';

async function shell(): Promise<AppState> {
  const kernel = createKernel({ persistence: memoryPersistence(), features: [] });
  await kernel.init();
  return new AppState(kernel, { mirror: document.createElement('div'), startModules: async () => {} });
}

describe('the room behind a dialog (Section 10.6)', () => {
  it('is inert while the Spellbook or a drawer is open over it', async () => {
    const app = await shell();
    for (const screen of ['mirror', 'practice', 'replay', 'threshold'] as const) {
      app.go(screen);
      expect(app.roomInert, screen).toBe(false);
    }
    for (const screen of ['spellbook', 'tuning', 'keepsakes', 'workshop'] as const) {
      app.go(screen);
      expect(app.roomInert, screen).toBe(true);
    }
  });

  // Drawing a gesture, recording and watching a replay all need the mirror.
  it('takes input again while the drawer is folded down to its bar', async () => {
    const app = await shell();
    app.go('workshop');
    app.foldedDrawer = 'workshop';
    expect(app.roomInert).toBe(false);
    app.foldedDrawer = null;
    expect(app.roomInert).toBe(true);
  });

  it('never lets one drawer’s fold free the room behind another', async () => {
    const app = await shell();
    app.go('workshop');
    app.foldedDrawer = 'workshop';
    // The folded Workshop's Mirror bar is live: "Open spellbook" there opens the book over the room
    // while the Workshop is still flying out, folded.
    app.go('spellbook');
    expect(app.roomInert).toBe(true);
    app.go('keepsakes');
    expect(app.roomInert).toBe(true);
  });
});

// ------------------------------------------------------------------------------ seated play

/**
 * Capture, as far as the play area goes: each camera's stored profile, whose play area is written
 * back to the setting every time that camera opens, before camera.ready; 'camera.profile.save'
 * patches the profile of the camera that is on, and is refused while none is.
 */
function fakeCapture() {
  const state = {
    on: false,
    device: 'usb-1',
    generation: 0,
    profiles: new Map<string, Partial<CameraProfile>>(),
    saves: [] as Partial<CameraProfile>[],
    refuseNext: false,
  };
  let k: Kernel;
  async function open(): Promise<void> {
    if (state.on) return;
    state.on = true;
    state.generation++;
    const stored = state.profiles.get(state.device)?.playArea;
    if (stored) await k.request('settings.set', { key: 'playArea', value: stored });
    emit(k, 'capture.camera', 'camera.status', { state: 'on', generation: state.generation, permission: 'granted', deviceId: state.device });
    emit(k, 'capture.camera', 'camera.ready', { deviceId: state.device, label: 'USB Camera', width: 1280, height: 720, fps: 30, generation: state.generation } as unknown as CameraReady);
  }
  function close(): void {
    if (!state.on) return;
    state.on = false;
    emit(k, 'capture.camera', 'camera.stopped', { reason: 'released', generation: state.generation });
    emit(k, 'capture.camera', 'camera.status', { state: 'off', generation: state.generation, permission: 'granted' });
  }
  const module: Module = {
    manifest: { id: 'capture.camera', kind: 'capture', version: '1.0.0', contract: '^1.1', provides: [] },
    async init(kernel) {
      k = kernel;
      kernel.handle('camera.profile.save', (p: Partial<CameraProfile>) => {
        if (!state.on || state.refuseNext) {
          state.refuseNext = false;
          throw { name: 'InvalidStateError', message: 'The camera is not on.' };
        }
        state.saves.push(p);
        const next = { ...state.profiles.get(state.device), ...p };
        state.profiles.set(state.device, next);
        return next;
      });
    },
    async start() {},
    async stop() {},
  };
  return { module, state, open, close };
}

const BOX: PlayArea = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
const settle = () => new Promise((r) => setTimeout(r, 0));

async function seatedShell() {
  const kernel: KernelHost = createKernel({ persistence: memoryPersistence(), features: [] });
  const camera = fakeCapture();
  kernel.register(camera.module);
  await kernel.init();
  await kernel.start();
  const app = new AppState(kernel, { mirror: document.createElement('div'), startModules: async () => {} });
  // "Save for this camera" in Wand tuning stored a box of the player's own.
  camera.state.profiles.set('usb-1', { playArea: { ...BOX } });
  const area = () => kernel.settings.get('playArea', null);
  const reopen = async () => {
    camera.close();
    await camera.open();
    await settle();
  };
  return { app, camera, area, reopen };
}

// The play area is kept with each camera and comes back whenever it opens (Section 7.1), so a choice
// made with no camera on would last only until the next open.
describe('seated play and the camera (Section 10.6)', () => {
  it('is kept for the camera that opens next when it is turned on with none on', async () => {
    const { app, camera, area, reopen } = await seatedShell();
    expect(await app.setSeated(true)).toEqual(SEATED_AREA);
    expect(camera.state.saves).toEqual([]);

    await camera.open();
    await settle();
    expect(area()).toEqual(SEATED_AREA);
    expect(camera.state.saves).toEqual([{ playArea: SEATED_AREA }]);
    await reopen();
    expect(area()).toEqual(SEATED_AREA);

    // Off gives back the box this camera had before.
    expect(await app.setSeated(false)).toEqual(BOX);
    await settle();
    await reopen();
    expect(area()).toEqual(BOX);
  });

  it('leaves each camera its own box when it is turned on and off with none on', async () => {
    const { app, camera, area } = await seatedShell();
    await app.setSeated(true);
    expect(await app.setSeated(false)).toEqual(WHOLE_VIEW);
    await camera.open();
    await settle();
    expect(camera.state.saves).toEqual([]);
    expect(area()).toEqual(BOX);
  });

  it('gives back the box it took the place of when it is turned off, and keeps it with the camera', async () => {
    const { app, camera, area, reopen } = await seatedShell();
    await camera.open();
    expect(area()).toEqual(BOX);
    await app.setSeated(true);
    await settle();
    await app.setSeated(false);
    await settle();
    expect(camera.state.saves).toEqual([{ playArea: SEATED_AREA }, { playArea: BOX }]);
    await reopen();
    expect(area()).toEqual(BOX);
  });

  it('gives the whole view back, not another camera’s box, once the camera has changed', async () => {
    const { app, camera, area } = await seatedShell();
    await camera.open();
    await app.setSeated(true);
    await settle();
    camera.close();
    camera.state.device = 'usb-2';
    await camera.open();
    expect(area()).toEqual(SEATED_AREA);
    expect(await app.setSeated(false)).toEqual(WHOLE_VIEW);
  });

  it('lets a box set by hand meanwhile take the place of the one waiting for a camera', async () => {
    const { app, camera, area } = await seatedShell();
    await app.setSeated(true);
    await app.set('playArea', { x: 0.3, y: 0.3, w: 0.4, h: 0.4 });
    await camera.open();
    await settle();
    expect(camera.state.saves).toEqual([]);
    expect(area()).toEqual(BOX);
  });

  it('stores it when the camera opens again if the camera closed before the save', async () => {
    const { app, camera, area, reopen } = await seatedShell();
    await camera.open();
    camera.state.refuseNext = true;
    await app.setSeated(true);
    await settle();
    expect(camera.state.saves).toEqual([]);
    await reopen();
    expect(area()).toEqual(SEATED_AREA);
    expect(camera.state.saves).toEqual([{ playArea: SEATED_AREA }]);
  });
});
