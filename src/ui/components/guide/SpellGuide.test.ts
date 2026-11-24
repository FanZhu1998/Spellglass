// @vitest-environment jsdom
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Spell, Spellbook, SpellbookEntry, SpellbookPack } from '../../../contracts';
import { createKernel, emit, memoryPersistence, type KernelHost, type SettingsPersistence } from '../../../kernel';
import { AppState, type Screen } from '../../app-state.svelte';
import App from '../../App.svelte';

// The browser build of Svelte, where mount() is available (see screens/WandTuning.test.ts).
vi.mock('svelte', () => import('../../../../node_modules/svelte/src/index-client.js' as string));

beforeAll(() => {
  // jsdom has neither: the frame's width, the guide's list and Wand tuning's live view use them.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement['getContext'];
  // Nor the Web Animations API, which Svelte's transitions use when a drawer or a screen comes and
  // goes after the first render: every animation here ends at once.
  Element.prototype.animate ??= function () {
    const animation = { onfinish: null as (() => void) | null, cancel() {}, currentTime: 0, playState: 'finished' };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  };
});

// ------------------------------------------------------------------------------ a spellbook

function spell(id: string, incantation: string, extra: Partial<Spell> = {}): Spell {
  return { id, incantation, gesture: { flick: 'up' }, effect: { steps: [] }, ...extra };
}

function entry(s: Spell, extra: Partial<SpellbookEntry> = {}): SpellbookEntry {
  return {
    spell: s, packId: 'core-charms', packTitle: 'Core charms', available: true, status: 'open', enabled: true,
    overridden: false, gestureSource: 'pack', gestureKey: 'k', mirrored: false, templates: [], lasts: null,
    skippedSteps: [], accepted: 0, ...extra,
  };
}

const ARC: [number, number][] = [[0.1, 0.8], [0.3, 0.2], [0.7, 0.2], [0.9, 0.8]];
const corePack: SpellbookPack = { id: 'core-charms', kind: 'spellpack', title: 'Core charms', version: '1.0.0', enabled: true, user: false, unmet: [] };

/** Tier 1 open (Lumos, Nox, Wingardium Leviosa); Alohomora and Accio locked behind it. */
function spellbook(over: Partial<Record<string, Partial<SpellbookEntry>>> = {}): Spellbook {
  const spells = [
    entry(spell('lumos', 'Lumos', { gesture_text: 'Flick straight up.', effect: { steps: [{ use: 'light.orb', hold: true }] } }), { lasts: 'until-ended' }),
    entry(spell('nox', 'Nox', { gesture: { flick: 'down' }, gesture_text: 'Flick straight down.', needs_active: ['lumos'] })),
    entry(spell('wingardium-leviosa', 'Wingardium Leviosa', { gesture: { path: ARC }, gesture_text: 'Arc over, then drop.' }), { templates: [ARC] }),
    entry(spell('alohomora', 'Alohomora', { gesture: { path: ARC }, tier: 2 }), { status: 'locked', enabled: false, templates: [ARC] }),
    entry(spell('accio', 'Accio', { gesture: { path: ARC }, tier: 2 }), { status: 'locked', enabled: false, templates: [ARC] }),
  ].map((e) => ({ ...e, ...over[e.spell.id] }));
  return { revision: 1, packs: [corePack], spells, theme: null, unlockedTier: 1, learnAfter: 3 };
}

// ------------------------------------------------------------------------------ harness

let shown: ReturnType<typeof mount> | null = null;

afterEach(() => {
  if (shown) unmount(shown);
  shown = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
});

interface Seen {
  type: string;
  payload: { spellId?: string | null; slow?: boolean };
}

async function setup(screen: Screen = 'mirror', persistence: SettingsPersistence = memoryPersistence()) {
  const kernel: KernelHost = createKernel({ persistence, features: [] });
  await kernel.init();
  await kernel.start();
  const app = new AppState(kernel, { mirror: document.createElement('div'), startModules: async () => {} });
  emit(kernel, 'kernel.packs', 'spellbook.changed', spellbook());
  const seen: Seen[] = [];
  for (const type of ['practice.guide', 'practice.focus']) kernel.subscribe(type, (e) => seen.push({ type, payload: e.payload as Seen['payload'] }));
  app.go(screen);
  const target = document.body.appendChild(document.createElement('div'));
  shown = mount(App, { target, props: { app }, intro: false });
  flushSync();
  return { kernel, app, target, seen };
}

const guideOf = (root: HTMLElement) => root.querySelector<HTMLElement>('aside#spell-guide');
const cardOf = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>(`.guide-card[data-spell-id="${id}"]`);
const pickOf = (root: HTMLElement, id: string) => cardOf(root, id)!.querySelector<HTMLButtonElement>('button.guide-name')!;
const toggleOf = (root: HTMLElement) => [...root.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Spell guide')!;
/** Settings go through a kernel request: let it land, then render. */
const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  flushSync();
};

/** Out of reach of a screen reader: under an inert element (Svelte sets the property, which jsdom does
 *  not reflect to the attribute) or under aria-hidden. */
function silenced(el: Element): boolean {
  for (let e: Element | null = el; e; e = e.parentElement) {
    if ((e as HTMLElement).inert === true || e.hasAttribute('inert') || e.getAttribute('aria-hidden') === 'true') return true;
  }
  return false;
}

function cast(kernel: KernelHost, id: string, spellId: string, extra: Record<string, unknown> = {}): void {
  emit(kernel, 'spell-engine', 'spell.cast', { id, spellId, t: kernel.now(), via: 'gesture', quality: 0.9, power: 0.6, aim: { x: 0.5, y: 0.4 }, ...extra });
  flushSync();
}

function fizzle(kernel: KernelHost, id: string, reason: string, spellId?: string): void {
  emit(kernel, 'spell-engine', 'spell.fizzle', { id, t: kernel.now(), reason: reason as 'low-score', quality: 0.3, ...(spellId ? { nearest: { spellId, score: 0.5 } } : {}) });
  flushSync();
}

// ------------------------------------------------------------------------------ tests

describe('the spell guide beside the mirror', () => {
  it('is open on the Mirror at first, a named complementary landmark that lists the spells to cast now', async () => {
    const { target } = await setup();
    const guide = guideOf(target);
    expect(guide).not.toBeNull();
    expect(guide!.tagName).toBe('ASIDE');
    expect(target.querySelector(`#${guide!.getAttribute('aria-labelledby')}`)?.textContent).toBe('Spell guide');
    expect(silenced(guide!)).toBe(false);
    expect(guide!.closest('[role="dialog"]')).toBeNull();
    const names = [...guide!.querySelectorAll('.guide-name')].map((b) => b.textContent?.replace(', show on the glass', '').trim());
    expect(names).toEqual(['Lumos', 'Nox', 'Wingardium Leviosa']);
    expect(guide!.textContent).toContain('2 more spells open as you learn these.');
    expect(guide!.textContent).toContain('Needs Lumos lit first.');
    expect(cardOf(target, 'lumos')!.textContent).toContain('0 of 3');
    // The progress a screen reader hears with the card's name: the dots beside it are not read.
    const described = pickOf(target, 'lumos').getAttribute('aria-describedby')!.split(' ');
    expect(described.map((id) => target.querySelector(`#${id}`)?.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Flick straight up.', '0 of 3 casts to learn it']);
    const toggle = toggleOf(target);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('spell-guide');
  });

  it('is no live region: the shell’s announcer says each result, the guide only shows it', async () => {
    const { kernel, target } = await setup();
    const before = document.activeElement;
    cast(kernel, 'c1', 'lumos');
    const guide = guideOf(target)!;
    expect(guide.querySelectorAll('[aria-live], [role="status"], [role="alert"], [role="log"]')).toHaveLength(0);
    expect(guide.closest('[aria-live]')).toBeNull();
    // It never takes focus by itself.
    expect(document.activeElement).toBe(before);
  });

  it('hides and shows from the Mirror bar, and keeps the choice', async () => {
    const store = memoryPersistence();
    const { kernel, target } = await setup('mirror', store);
    toggleOf(target).click();
    await settle();
    expect(guideOf(target)).toBeNull();
    expect(toggleOf(target).getAttribute('aria-expanded')).toBe('false');
    expect(kernel.settings.get('shell.spellGuide', null)).toBe(false);
    expect(store.load()?.values['shell.spellGuide']).toBe(false);
    toggleOf(target).click();
    await settle();
    expect(guideOf(target)).not.toBeNull();
  });

  it('gives focus to the bar’s Spell guide when Close guide takes the guide away', async () => {
    const { target } = await setup();
    const close = [...guideOf(target)!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Close guide')!;
    close.focus();
    close.click();
    await settle();
    await settle();
    expect(guideOf(target)).toBeNull();
    expect(document.activeElement).toBe(toggleOf(target));
  });

  it('stays in place under a drawer, inert with the room, and gives way to Practice', async () => {
    const { app, target } = await setup();
    app.go('tuning');
    flushSync();
    expect(guideOf(target)).not.toBeNull();
    expect(silenced(guideOf(target)!)).toBe(true);
    app.go('mirror');
    flushSync();
    expect(silenced(guideOf(target)!)).toBe(false);
    app.startPractice('lumos');
    flushSync();
    expect(guideOf(target)).toBeNull();
  });

  it('lists every available spell when every spell is open', async () => {
    const { kernel, target } = await setup();
    emit(kernel, 'kernel.packs', 'spellbook.changed', spellbook({ alohomora: { status: 'open', enabled: true }, accio: { status: 'open', enabled: true } }));
    flushSync();
    expect(cardOf(target, 'alohomora')).not.toBeNull();
    expect(cardOf(target, 'accio')).not.toBeNull();
    expect(guideOf(target)!.textContent).not.toContain('more spell');
  });
});

describe('the spell guide answers casts', () => {
  it('lights the card of a cast, which shows its new progress', async () => {
    const { kernel, target } = await setup();
    cast(kernel, 'c1', 'lumos');
    expect(cardOf(target, 'lumos')!.dataset.mark).toBe('cast');
    expect(cardOf(target, 'lumos')!.querySelector('.guide-tag')?.textContent).toBe('Cast');
    // The pack service publishes the spellbook with the new count.
    emit(kernel, 'kernel.packs', 'spellbook.changed', spellbook({ lumos: { accepted: 1 } }));
    flushSync();
    expect(cardOf(target, 'lumos')!.textContent).toContain('1 of 3');
  });

  it('marks the card a fizzle came close to, or a right shape a rule stopped, for a moment', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { kernel, target } = await setup();
    fizzle(kernel, 'f1', 'low-score', 'wingardium-leviosa');
    expect(cardOf(target, 'wingardium-leviosa')!.dataset.mark).toBe('close');
    expect(cardOf(target, 'wingardium-leviosa')!.querySelector('.guide-tag')?.textContent).toBe('Close');
    fizzle(kernel, 'f2', 'needs-active', 'nox');
    expect(cardOf(target, 'wingardium-leviosa')!.dataset.mark).toBeUndefined();
    expect(cardOf(target, 'nox')!.querySelector('.guide-tag')?.textContent).toBe('Right shape');
    vi.advanceTimersByTime(4000);
    flushSync();
    expect(target.querySelector('.guide-card[data-mark]')).toBeNull();
  });

  it('tags the spells a new tier opened while the shell celebrates them', async () => {
    const { kernel, target } = await setup();
    emit(kernel, 'kernel.packs', 'spellbook.changed', spellbook({ alohomora: { status: 'open', enabled: true }, accio: { status: 'open', enabled: true } }));
    emit(kernel, 'kernel.packs', 'progress.changed', { spellId: 'stupefy', accepted: 3, learned: true, unlockedTier: 2, unlockedSpells: ['alohomora', 'accio'] });
    flushSync();
    expect(cardOf(target, 'alohomora')!.querySelector('.guide-tag')?.textContent).toBe('New');
    expect(cardOf(target, 'lumos')!.querySelector('.guide-tag')).toBeNull();
  });

  it('marks only results that come while it is open', async () => {
    const { kernel, app, target } = await setup();
    await app.setSpellGuide(false);
    flushSync();
    cast(kernel, 'c1', 'lumos');
    await app.setSpellGuide(true);
    flushSync();
    expect(guideOf(target)).not.toBeNull();
    expect(cardOf(target, 'lumos')!.dataset.mark).toBeUndefined();
  });

  it('marks nothing for a replay, a locked spell or a stroke close to none', async () => {
    const { kernel, target } = await setup();
    cast(kernel, 'r1', 'lumos', { replay: true });
    fizzle(kernel, 'f1', 'unavailable', 'alohomora');
    fizzle(kernel, 'f2', 'low-score');
    expect(target.querySelector('.guide-card[data-mark]')).toBeNull();
  });
});

describe('the spell guide draws a gesture on the glass', () => {
  it('draws the chosen spell’s gesture without turning casting into practice', async () => {
    const { app, target, seen } = await setup();
    pickOf(target, 'wingardium-leviosa').click();
    flushSync();
    expect(seen).toEqual([{ type: 'practice.guide', payload: { spellId: 'wingardium-leviosa', slow: false } }]);
    expect(pickOf(target, 'wingardium-leviosa').getAttribute('aria-pressed')).toBe('true');
    expect(cardOf(target, 'wingardium-leviosa')!.querySelector('.guide-tag')?.textContent).toBe('On the glass');
    // The Mirror bar's Practice and the Spellbook now open at it.
    expect(app.selectedSpellId).toBe('wingardium-leviosa');

    // Another card replaces it; choosing the one shown takes it away.
    pickOf(target, 'nox').click();
    flushSync();
    pickOf(target, 'nox').click();
    flushSync();
    expect(seen.slice(1)).toEqual([
      { type: 'practice.guide', payload: { spellId: 'nox', slow: false } },
      { type: 'practice.focus', payload: { spellId: null } },
    ]);
    expect(pickOf(target, 'nox').getAttribute('aria-pressed')).toBe('false');
    // Never a focus with a spell: that is what makes the engine grade practice.
    expect(seen.some((e) => e.type === 'practice.focus' && e.payload.spellId)).toBe(false);
  });

  it('takes the drawing away once its spell is cast, or the guide is closed', async () => {
    const { kernel, app, target, seen } = await setup();
    pickOf(target, 'lumos').click();
    flushSync();
    cast(kernel, 'c1', 'nox');
    expect(app.glassGuideId).toBe('lumos');
    cast(kernel, 'c2', 'lumos');
    expect(app.glassGuideId).toBeNull();
    expect(seen.at(-1)).toEqual({ type: 'practice.focus', payload: { spellId: null } });

    pickOf(target, 'nox').click();
    flushSync();
    await app.setSpellGuide(false);
    flushSync();
    expect(app.glassGuideId).toBeNull();
    expect(seen.at(-1)).toEqual({ type: 'practice.focus', payload: { spellId: null } });
  });

  it('lets Practice take the glass over, and leaves the glass alone once Practice has it', async () => {
    const { app, target, seen } = await setup();
    pickOf(target, 'lumos').click();
    flushSync();
    app.startPractice('nox');
    flushSync();
    expect(app.glassGuideId).toBeNull();
    const sent = seen.length;
    // Closing the guide now must not clear Practice's guide.
    await app.setSpellGuide(false);
    app.clearGlassGuide();
    expect(seen.length).toBe(sent);
  });
});
