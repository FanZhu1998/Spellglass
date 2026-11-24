// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import DistanceGuide from './DistanceGuide.svelte';

// The browser build of Svelte, where mount() is available (see WandTuning.test.ts).
vi.mock('svelte', () => import('../../../../node_modules/svelte/src/index-client.js' as string));

let shown: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (shown) unmount(shown);
  shown = null;
  document.body.innerHTML = '';
});

function show(props: Record<string, unknown>): HTMLElement {
  const target = document.body.appendChild(document.createElement('div'));
  shown = mount(DistanceGuide, { target, props });
  flushSync();
  return target;
}

describe('the distance guide (Section 4; seated play, Section 10.6)', () => {
  it('tells a standing caster where to stand, and where seated play is', () => {
    const t = show({ width: 1280, height: 720, fps: 30 });
    expect(t.textContent).toMatch(/Stand 0\.6 to 1\.2 m from the camera\./);
    expect(t.textContent).toMatch(/Stand toward the near end/);
    expect(t.textContent).toMatch(/Turn on Seated play in the Workshop, under Access/);
  });

  it('tells a seated caster where to sit', () => {
    const t = show({ width: 1280, height: 720, fps: 30, seated: true });
    expect(t.textContent).toMatch(/Sit 0\.6 to 1\.2 m from the camera\./);
    expect(t.textContent).toMatch(/Sit toward the near end/);
    expect(t.textContent).not.toMatch(/Stand/);
    expect(t.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toBe('Sit 0.6 to 1.2 metres from the camera.');
  });
});
