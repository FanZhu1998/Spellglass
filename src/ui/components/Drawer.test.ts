// @vitest-environment jsdom
import { createRawSnippet, flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Drawer from './Drawer.svelte';

// Vitest loads 'svelte' with Node's conditions, which pick the server build, where mount() is not
// available: the browser build instead (as in WandTuning.test.ts).
vi.mock('svelte', () => import('../../../node_modules/svelte/src/index-client.js' as string));

let shown: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (shown) unmount(shown);
  shown = null;
  document.body.innerHTML = '';
});

function tab(from: Element, shift = false): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: shift, bubbles: true, cancelable: true });
  from.dispatchEvent(e);
  return e;
}

describe('Drawer (Sections 10.3 and 10.6)', () => {
  it('is a modal dialog that keeps Tab inside it', async () => {
    document.body.insertAdjacentHTML('beforeend', '<button id="behind">Open spellbook</button>');
    const children = createRawSnippet(() => ({ render: () => '<div><button id="one">One</button><button id="two">Two</button></div>' }));
    const target = document.body.appendChild(document.createElement('div'));
    shown = mount(Drawer, { target, props: { title: 'Workshop', onclose: () => {}, children }, intro: false });
    flushSync();
    await Promise.resolve();

    const dialog = target.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // Focus starts on the title, and Shift+Tab from there goes round to the last control.
    expect(document.activeElement?.textContent).toBe('Workshop');
    expect(tab(document.activeElement!, true).defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('two');
    // Tab from the last control goes round to the first, Close, and never to the button behind.
    expect(tab(document.activeElement!).defaultPrevented).toBe(true);
    expect(document.activeElement?.textContent).toBe('Close');
  });
});
