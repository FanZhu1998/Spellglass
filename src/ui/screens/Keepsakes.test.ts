// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Keepsake, Module } from '../../contracts';
import { createKernel, memoryPersistence, type KernelHost } from '../../kernel';
import { AppState } from '../app-state.svelte';
import Keepsakes from './Keepsakes.svelte';

// The browser build of Svelte, where mount() is available (see WandTuning.test.ts).
vi.mock('svelte', () => import('../../../node_modules/svelte/src/index-client.js' as string));

beforeAll(() => {
  // jsdom lays nothing out; a confirmation scrolls itself into view.
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

function keepsake(id: string, savedAt: number): Keepsake {
  return {
    dataVersion: 1,
    id,
    cast: { id, spellId: 'lumos', t: savedAt, via: 'gesture', quality: 0.9, power: 0.5, aim: { x: 0.5, y: 0.3 } },
    spellName: 'Lumos',
    points: [[0.5, 0.6], [0.5, 0.3]],
    durationMs: 300,
    aspect: 16 / 9,
    savedAt,
  };
}

/** Storage, as far as keepsakes go: a list, and deleting from it. */
function fakeStorage(items: Keepsake[]): Module {
  return {
    manifest: { id: 'storage', kind: 'storage', version: '1.0.0', contract: '^1.1', provides: [] },
    async init(kernel) {
      kernel.handle('keepsakes.list', () => [...items]);
      kernel.handle('keepsakes.delete', ({ id }: { id: string }) => {
        items.splice(items.findIndex((k) => k.id === id), 1);
      });
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

async function setup(items: Keepsake[], options: { appUrl?: string; desktop?: boolean } = {}) {
  const kernel: KernelHost = createKernel({ persistence: memoryPersistence(), features: [] });
  kernel.register(fakeStorage(items));
  await kernel.init();
  await kernel.start();
  const app = new AppState(kernel, { mirror: document.createElement('div'), startModules: async () => {}, ...options });
  const target = document.body.appendChild(document.createElement('div'));
  shown = mount(Keepsakes, { target, props: { app }, intro: false });
  flushSync();
  await vi.waitFor(() => expect(target.querySelectorAll('li.keepsake').length).toBe(items.length));
  return target;
}

const button = (root: HTMLElement, text: string) => {
  const b = [...root.querySelectorAll<HTMLButtonElement>('.delete button')].find((x) => x.textContent?.trim() === text);
  if (!b) throw new Error(`no ${text} button`);
  return b;
};

// Access (Section 10.6): answering the confirmation removes the focused button; focus must land somewhere.
describe('Keepsakes: deleting a cast keeps focus in the drawer', () => {
  it('moves focus to "Keep it", and back to Delete when the cast is kept', async () => {
    const target = await setup([keepsake('c-new', 2000), keepsake('c-old', 1000)]);
    // The newest cast opens by itself.
    button(target, 'Delete').click();
    flushSync();
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Keep it'));
    expect(document.activeElement?.closest('[role="group"]')?.textContent).toMatch(/Delete this cast/);

    button(target, 'Keep it').click();
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('keepsake-c-new-delete'));
  });

  it('hands focus to the next cast once one is deleted, and to the title once none is left', async () => {
    const target = await setup([keepsake('c-new', 2000), keepsake('c-old', 1000)]);
    button(target, 'Delete').click();
    flushSync();
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Keep it'));
    target.querySelector<HTMLButtonElement>('.delete .btn-danger')!.click();
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('keepsake-c-old-button'));
    expect(target.querySelectorAll('li.keepsake')).toHaveLength(1);

    // Open the last one and delete it too.
    target.querySelector<HTMLButtonElement>('#keepsake-c-old-button')!.click();
    flushSync();
    button(target, 'Delete').click();
    flushSync();
    await vi.waitFor(() => expect(document.activeElement?.textContent).toBe('Keep it'));
    target.querySelector<HTMLButtonElement>('.delete .btn-danger')!.click();
    await vi.waitFor(() => expect(document.activeElement?.tagName).toBe('H2'));
    expect(document.activeElement?.textContent).toBe('Keepsakes');
  });
});

// The desktop app runs from app://spellglass/, which opens nowhere else: built without a web address
// (SPELLGLASS_WEB_URL), it offers no replay links and no QR code, and says so where the link would be.
describe('Keepsakes: without a web address to share', () => {
  const texts = (root: HTMLElement) => [...root.querySelectorAll('button')].map((b) => b.textContent?.trim());

  it('leaves out the replay link and the QR code, and keeps cards, clips and replays', async () => {
    const target = await setup([keepsake('c-1', 1000)], { appUrl: '', desktop: true });
    // The newest cast opens by itself.
    await vi.waitFor(() => expect(texts(target)).toContain('Watch again'));
    expect(texts(target)).not.toContain('Share this cast');
    expect(texts(target)).toEqual(expect.arrayContaining(['Save a card', 'Record a clip']));
    expect(target.textContent).toContain('This copy of Spellglass has no web address for replay links.');
    expect(target.querySelector('.app-link')).toBeNull();
  });

  it('shares on the web address it was built with', async () => {
    const target = await setup([keepsake('c-1', 1000)], { appUrl: 'https://spellglass.example/', desktop: true });
    await vi.waitFor(() => expect(texts(target)).toContain('Share this cast'));
    expect(target.querySelector('.app-link .url')?.textContent).toBe('https://spellglass.example/');
    expect(target.textContent).not.toContain('no web address');
  });
});
