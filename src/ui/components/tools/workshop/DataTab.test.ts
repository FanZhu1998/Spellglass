// @vitest-environment jsdom
// Your data's storage lines (Section 9.4): worded for the browser on the web, for the computer in the
// desktop app, where no browser keeps anything.
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Module, StorageStatus } from '../../../../contracts';
import { createKernel, emit, memoryPersistence, type KernelHost } from '../../../../kernel';
import { AppState } from '../../../app-state.svelte';
import DataTab from './DataTab.svelte';
import { Imports } from './imports.svelte';

// The browser build of Svelte, where mount() is available (see WandTuning.test.ts).
vi.mock('svelte', () => import('../../../../../node_modules/svelte/src/index-client.js' as string));

/** Storage, as far as its status goes: 'storage.status' publishes `status`, as the module does. */
function fakeStorage(status: StorageStatus): Module {
  return {
    manifest: { id: 'storage.idb', kind: 'storage', version: '1.0.0', contract: '^1.1', provides: [] },
    async init(kernel) {
      kernel.handle('storage.status', () => {
        emit(kernel, 'storage.idb', 'storage.status', status);
        return status;
      });
      kernel.handle('storage.persist', () => ({ durable: true }));
    },
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

async function setup(status: StorageStatus, desktop: boolean) {
  const kernel: KernelHost = createKernel({ persistence: memoryPersistence(), features: [] });
  kernel.register(fakeStorage(status));
  await kernel.init();
  await kernel.start();
  const app = new AppState(kernel, { mirror: document.createElement('div'), startModules: async () => {}, desktop });
  const target = document.body.appendChild(document.createElement('div'));
  shown = mount(DataTab, { target, props: { app, imports: new Imports(), announce: () => undefined } });
  flushSync();
  await vi.waitFor(() => expect(target.textContent).toMatch(/Space used/));
  await vi.waitFor(() => expect(target.textContent).not.toMatch(/Checking/));
  return { target, text: () => target.textContent?.replace(/\s+/g, ' ') ?? '' };
}

const GB = 1024 ** 3;

describe('Your data: storage', () => {
  it('in the desktop app, names the computer and Spellglass, never a browser that keeps the data', async () => {
    const { text } = await setup({ persistent: true, durable: true, usage: 11 * 1024, quota: 145 * GB }, true);
    expect(text()).toMatch(/Safe when space runs low/);
    expect(text()).toMatch(/Yes: it is never cleared to free space\./);
    expect(text()).toMatch(/of the 145 GB Spellglass may use on this computer/);
    expect(text()).toMatch(/to another computer or to Spellglass in a browser/);
    // That is the one browser in the tab: where the data can go.
    expect(text().match(/browser/gi)).toHaveLength(1);
  });

  it('in the desktop app, offers to make sure of it in its own words when it is not yet', async () => {
    const { target, text } = await setup({ persistent: true, durable: false, usage: 2048 }, true);
    expect(text()).toMatch(/Not promised: it may be cleared if space runs very low\./);
    expect(text()).toMatch(/Makes sure Spellglass’s data is kept even when space runs low\./);
    const keep = [...target.querySelectorAll('button')].find((b) => b.textContent === 'Keep my data')!;
    keep.click();
    await vi.waitFor(() => expect(text()).toMatch(/Your data will be kept, even when space runs low\./));
  });

  it('in a browser, keeps the browser\'s words', async () => {
    const { text } = await setup({ persistent: true, durable: true, usage: 11 * 1024, quota: 145 * GB }, false);
    expect(text()).toMatch(/Kept by the browser/);
    expect(text()).toMatch(/this browser allows/);
    expect(text()).toMatch(/to another browser or computer/);
  });
});
