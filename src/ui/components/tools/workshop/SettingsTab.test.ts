// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CameraProfile, CameraReady, Module } from '../../../../contracts';
import { createKernel, emit, memoryPersistence, type KernelHost } from '../../../../kernel';
import { AppState } from '../../../app-state.svelte';
import { SEATED_AREA, WHOLE_VIEW } from '../play-area';
import SettingsTab from './SettingsTab.svelte';

// The browser build of Svelte, where mount() is available (see WandTuning.test.ts).
vi.mock('svelte', () => import('../../../../../node_modules/svelte/src/index-client.js' as string));

/** Capture, as far as a saved profile goes: what each 'camera.profile.save' asked to keep. */
function fakeCapture(saves: Partial<CameraProfile>[]): Module {
  return {
    manifest: { id: 'capture.camera', kind: 'capture', version: '1.0.0', contract: '^1.1', provides: [] },
    async init(kernel) {
      kernel.handle('camera.profile.save', (p: Partial<CameraProfile>) => {
        saves.push(p);
        return p;
      });
    },
    async start() {},
    async stop() {},
  };
}

const voiceModule: Module = {
  manifest: { id: 'voice.web-speech', kind: 'voice', version: '1.0.0', contract: '^1.1', provides: [] },
  async init() {},
  async start() {},
  async stop() {},
};

let shown: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (shown) unmount(shown);
  shown = null;
  document.body.innerHTML = '';
});

async function setup(settings: Record<string, unknown> = {}, { desktop = false } = {}) {
  const kernel: KernelHost = createKernel({ persistence: memoryPersistence(), features: [] });
  const saves: Partial<CameraProfile>[] = [];
  kernel.register(fakeCapture(saves));
  kernel.register(voiceModule);
  await kernel.init();
  for (const [key, value] of Object.entries(settings)) kernel.settings.set(key, value);
  await kernel.start();
  const app = new AppState(kernel, { mirror: document.createElement('div'), startModules: async () => {}, desktop });
  const target = document.body.appendChild(document.createElement('div'));
  const said: string[] = [];
  shown = mount(SettingsTab, { target, props: { app, announce: (text: string) => said.push(text) } });
  flushSync();
  return { kernel, app, target, saves, said };
}

function seatedSwitch(target: HTMLElement): HTMLInputElement {
  const label = [...target.querySelectorAll('label.switch')].find((l) => l.textContent?.includes('Seated play'));
  const input = label?.querySelector('input');
  if (!input) throw new Error('no Seated play switch');
  return input;
}

describe('Settings: seated play (Section 10.6)', () => {
  it('is offered under Access, and fits the play area to a seated reach', async () => {
    const { kernel, target } = await setup();
    const access = target.querySelector('section[aria-labelledby="ws-access-title"]')!;
    expect(access.contains(seatedSwitch(target))).toBe(true);
    expect(seatedSwitch(target).checked).toBe(false);

    seatedSwitch(target).click();
    await vi.waitFor(() => expect(kernel.settings.get('playArea', null)).toEqual(SEATED_AREA));
    flushSync();
    expect(seatedSwitch(target).checked).toBe(true);

    seatedSwitch(target).click();
    await vi.waitFor(() => expect(kernel.settings.get('playArea', null)).toEqual(WHOLE_VIEW));
  });

  // The play area comes back from the camera's profile whenever that camera opens.
  it('keeps the seated play area with the camera in use', async () => {
    const { kernel, app, target, saves } = await setup();
    emit(kernel, 'capture.camera', 'camera.status', { state: 'on', generation: 1, permission: 'granted' });
    expect(app.camera?.state).toBe('on');
    seatedSwitch(target).click();
    await vi.waitFor(() => expect(saves).toEqual([{ playArea: { ...SEATED_AREA } }]));
  });

  it('says so when the play area is one set by hand in Wand tuning', async () => {
    const { target } = await setup({ playArea: { x: 0.1, y: 0.2, w: 0.5, h: 0.5 } });
    expect(seatedSwitch(target).checked).toBe(false);
    expect(target.querySelector('#ws-seated-help')?.textContent).toMatch(/set in Wand tuning/);
  });

  it('gives that box back when it is turned off, and says so', async () => {
    const own = { x: 0.1, y: 0.2, w: 0.5, h: 0.5 };
    const { kernel, target, said } = await setup({ playArea: own });
    seatedSwitch(target).click();
    await vi.waitFor(() => expect(kernel.settings.get('playArea', null)).toEqual(SEATED_AREA));
    flushSync();
    seatedSwitch(target).click();
    await vi.waitFor(() => expect(kernel.settings.get('playArea', null)).toEqual(own));
    await vi.waitFor(() => expect(said.at(-1)).toBe('Seated play is off: the play area you had before is back.'));
  });

  // Each open writes the camera's stored play area back before camera.ready.
  it('stays on through the next camera open when it is turned on with no camera on', async () => {
    const { kernel, target, saves } = await setup();
    seatedSwitch(target).click();
    await vi.waitFor(() => expect(kernel.settings.get('playArea', null)).toEqual(SEATED_AREA));
    expect(saves).toEqual([]);

    await kernel.request('settings.set', { key: 'playArea', value: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } });
    emit(kernel, 'capture.camera', 'camera.status', { state: 'on', generation: 1, permission: 'granted', deviceId: 'usb-1' });
    emit(kernel, 'capture.camera', 'camera.ready', { deviceId: 'usb-1', label: 'USB Camera', width: 1280, height: 720, fps: 30, generation: 1 } as unknown as CameraReady);
    await vi.waitFor(() => expect(kernel.settings.get('playArea', null)).toEqual(SEATED_AREA));
    await vi.waitFor(() => expect(saves).toEqual([{ playArea: SEATED_AREA }]));
    flushSync();
    expect(seatedSwitch(target).checked).toBe(true);
  });
});

describe('Settings: where speech goes (Sections 7.6 and 11.2)', () => {
  const voiceText = (target: HTMLElement) => target.querySelector('section[aria-labelledby="ws-voice-title"]')?.textContent?.replace(/\s+/g, ' ') ?? '';

  it('promises on-device speech only while recognition is on the device', async () => {
    const { kernel, target } = await setup({ 'voice.enabled': true });
    emit(kernel, 'voice.web-speech', 'voice.status', { state: 'listening', local: true });
    flushSync();
    expect(voiceText(target)).toMatch(/never leaves this computer/);
  });

  it('says that speech is sent to the online service while that is in use', async () => {
    const { kernel, target } = await setup({ 'voice.enabled': true, 'voice.allowCloud': true });
    emit(kernel, 'voice.web-speech', 'voice.status', { state: 'listening', local: false, cloud: 'available' });
    flushSync();
    const text = voiceText(target);
    expect(text).not.toMatch(/never leaves this computer|recognized on this device/);
    expect(text).toMatch(/sent to the browser's online speech service to be turned into text/);
    expect(text).toMatch(/Audio then leaves this device/);
  });
});

describe('Settings in the desktop app, which has no voice', () => {
  const voiceSection = (target: HTMLElement) => target.querySelector('section[aria-labelledby="ws-voice-title"]')!;
  const modeInput = (target: HTMLElement, id: string) => target.querySelector<HTMLInputElement>(`input[name="casting-mode"][value="${id}"]`)!;

  it('says voice is not available, with no switch and nothing about a browser or its prompt', async () => {
    const { target } = await setup({}, { desktop: true });
    const section = voiceSection(target);
    const text = section.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toMatch(/Voice recognition is not available in the desktop app/);
    expect(text).toMatch(/never uses the microphone/);
    expect(text).not.toMatch(/browser asks|recognized on this device|Listen for incantations/);
    expect(section.querySelector('input')).toBeNull();
    // Nothing in the whole tab speaks of a browser.
    expect(target.textContent?.match(/browser/gi) ?? []).toEqual([]);
  });

  it('shuts the casting modes that listen, and keeps Gesture', async () => {
    const { target } = await setup({}, { desktop: true });
    expect(modeInput(target, 'gesture').disabled).toBe(false);
    for (const id of ['assisted', 'strict', 'voice']) {
      expect(modeInput(target, id).disabled).toBe(true);
      expect(modeInput(target, id).closest('label')?.textContent).toMatch(/Needs voice/);
    }
    expect(modeInput(target, 'gesture').closest('label')?.textContent).not.toMatch(/Needs voice/);
  });

  it('says a mode that listens, chosen before or imported, plays by gesture', async () => {
    const { kernel, target } = await setup({ 'engine.mode': 'voice' }, { desktop: true });
    const mode = target.querySelector('section[aria-labelledby="ws-mode-title"]')!;
    expect(mode.textContent).toMatch(/Voice only needs voice, which the desktop app does not offer. Spells are cast by gesture instead./);
    expect([...mode.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('Turn voice on');
    // Gesture can be chosen from there, and the note goes.
    modeInput(target, 'gesture').click();
    await vi.waitFor(() => expect(kernel.settings.get('engine.mode', null)).toBe('gesture'));
    flushSync();
    expect(mode.textContent).not.toMatch(/needs voice, which/);
  });

  it('keeps the voice switch in a browser', async () => {
    const { target } = await setup();
    expect(voiceSection(target).textContent).toMatch(/Listen for incantations/);
    expect(modeInput(target, 'voice').disabled).toBe(false);
  });
});
