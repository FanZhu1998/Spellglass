// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createKernel, emit, memoryPersistence, type KernelHost } from '../kernel';
import { AppState, type Screen } from './app-state.svelte';
import App from './App.svelte';

// The browser build of Svelte, where mount() is available (see screens/WandTuning.test.ts).
vi.mock('svelte', () => import('../../node_modules/svelte/src/index-client.js' as string));

beforeAll(() => {
  // jsdom has neither: the frame's width and Wand tuning's live view use them.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
});

let shown: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (shown) unmount(shown);
  shown = null;
  document.body.innerHTML = '';
});

async function setup(screen: Screen) {
  const kernel: KernelHost = createKernel({ persistence: memoryPersistence(), features: [] });
  await kernel.init();
  await kernel.start();
  const app = new AppState(kernel, { mirror: document.createElement('div'), startModules: async () => {} });
  app.go(screen);
  const target = document.body.appendChild(document.createElement('div'));
  shown = mount(App, { target, props: { app }, intro: false });
  flushSync();
  return { kernel, app, target };
}

/** Out of reach of a screen reader: under an inert element (Svelte sets the property, which jsdom
 *  does not reflect to the attribute) or under aria-hidden. */
function silenced(el: Element): boolean {
  for (let e: Element | null = el; e; e = e.parentElement) {
    if ((e as HTMLElement).inert === true || e.hasAttribute('inert') || e.getAttribute('aria-hidden') === 'true') return true;
  }
  return false;
}

/** The text of each live region a screen reader hears. */
function heard(root: HTMLElement): string[] {
  const live = [...root.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]')].filter(
    (el) => el.getAttribute('aria-live') !== 'off' && !silenced(el) && !el.parentElement?.closest('[aria-live]:not([aria-live="off"]), [role="status"]'),
  );
  return live.map((el) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '').filter(Boolean);
}

function cast(kernel: KernelHost, id: string, via: 'gesture' | 'voice' = 'gesture'): void {
  emit(kernel, 'spell-engine', 'spell.cast', { id, spellId: 'lumos', incantation: 'Lumos', t: kernel.now(), via, quality: 0.9, power: 0.6, aim: { x: 0.5, y: 0.4 } });
  flushSync();
}

// Casting goes on under a drawer on a camera or voice route, while the room behind it is inert
// (Section 10.6): the result must still be said, and said once.
describe('the shell: what the glass says while a drawer is open', () => {
  it('says a cast made while Wand tuning is open', async () => {
    const { kernel, target } = await setup('tuning');
    expect(silenced(target.querySelector('main.stage-area')!)).toBe(true);
    cast(kernel, 'c1');
    const words = heard(target).filter((t) => /Lumos/.test(t));
    expect(words).toHaveLength(1);
    expect(words[0]).toMatch(/^Lumos, .+\.$/);
  });

  it('says a fizzle and a new tier of spells behind the Workshop', async () => {
    const { kernel, target } = await setup('workshop');
    emit(kernel, 'spell-engine', 'spell.fizzle', { id: 'f1', t: kernel.now(), reason: 'low-score', hint: 'Pause, trace, pause.', quality: 0.2 });
    emit(kernel, 'spell-engine', 'progress.changed', { spellId: 'lumos', accepted: 3, learned: true, unlockedTier: 2, unlockedSpells: ['alohomora', 'accio'] });
    flushSync();
    const words = heard(target);
    expect(words.some((t) => /Pause, trace, pause\./.test(t))).toBe(true);
    expect(words).toContain('A new page opens. New spells to learn: alohomora and accio.');
  });

  it('says a cast once on the mirror, where the room is live', async () => {
    const { kernel, target } = await setup('mirror');
    cast(kernel, 'c1', 'voice');
    expect(heard(target).filter((t) => /Lumos/.test(t))).toEqual([expect.stringMatching(/^Lumos, .+, by voice\.$/)]);
    // The banner on the glass still shows it.
    expect(target.querySelector('.banner')?.textContent).toMatch(/Lumos/);
  });
});
