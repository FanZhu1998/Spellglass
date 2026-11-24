// The spell guide through the real interface: open beside the mirror from the first cast on, so a new
// player need not know the spells by heart, answering casts, and hidden for good when asked.
import { expect, test, type Page } from '@playwright/test';
import { draw } from './helpers';

test.describe.configure({ mode: 'serial' });

/** The first run, as a new player takes it, to the Mirror; then record what the engine decides. */
async function toMirror(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: /Mouse or touch/ }).click();
  await page.getByRole('button', { name: 'Start casting' }).click();
  await expect(page.getByRole('button', { name: /Open spellbook/ })).toBeVisible();
  await page.evaluate(() => {
    const { kernel } = (window as any).__spellglass;
    (window as any).__seen = [];
    for (const t of ['spell.cast', 'spell.fizzle', 'practice.attempt']) {
      kernel.subscribe(t, (e: { payload: unknown }) => (window as any).__seen.push({ type: t, p: e.payload }));
    }
  });
}

const guideOf = (page: Page) => page.getByRole('complementary', { name: 'Spell guide' });
const toggleOf = (page: Page) => page.getByRole('button', { name: 'Spell guide', exact: true });
const cardOf = (page: Page, name: RegExp) => guideOf(page).getByRole('listitem').filter({ has: page.getByRole('button', { name }) });

async function castsSeen(page: Page): Promise<{ spellId: string; practice?: boolean }[]> {
  return page.evaluate(() => ((window as any).__seen as { type: string; p: any }[]).filter((e) => e.type === 'spell.cast').map((e) => e.p));
}

test('the guide is open on the Mirror at first and lists Lumos', async ({ page }) => {
  await toMirror(page);
  await expect(guideOf(page)).toBeVisible();
  await expect(toggleOf(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(cardOf(page, /^Lumos/)).toContainText('Flick straight up.');
  await expect(cardOf(page, /^Lumos/)).toContainText('0 of 3');
  // Only what can be cast now: the later tiers are counted, not listed.
  await expect(guideOf(page).getByRole('button', { name: /^Alohomora/ })).toHaveCount(0);
  await expect(guideOf(page)).toContainText(/\d+ more spells open as you learn these\./);
  // Beside the mirror, never over the glass.
  const guide = await guideOf(page).boundingBox();
  const glass = await page.locator('.mirror-surface').boundingBox();
  expect(guide && glass && guide.x + guide.width <= glass.x).toBe(true);
});

test('casting Lumos with the guide open works and lights its card', async ({ page }) => {
  await toMirror(page);
  await draw(page, [[0.5, 0.62], [0.5, 0.3]], 260);
  await expect(cardOf(page, /^Lumos/)).toHaveAttribute('data-mark', 'cast');
  await expect(cardOf(page, /^Lumos/)).toContainText('Cast');
  await expect(cardOf(page, /^Lumos/)).toContainText('1 of 3');
  const casts = await castsSeen(page);
  expect(casts.map((c) => c.spellId)).toEqual(['lumos']);
  expect(casts[0].practice).toBeUndefined();
  // The banner on the glass still says it.
  await expect(page.locator('.banner-slot')).toContainText('Lumos');
});

test('a gesture shown on the glass leaves casting as casting', async ({ page }) => {
  await toMirror(page);
  const leviosa = guideOf(page).getByRole('button', { name: /^Wingardium Leviosa/ });
  await leviosa.click();
  await expect(leviosa).toHaveAttribute('aria-pressed', 'true');
  await draw(page, [[0.5, 0.62], [0.5, 0.3]], 260);
  await expect(cardOf(page, /^Lumos/)).toHaveAttribute('data-mark', 'cast');
  const seen = await page.evaluate(() => (window as any).__seen as { type: string; p: any }[]);
  expect(seen.filter((e) => e.type === 'practice.attempt')).toEqual([]);
  expect(seen.filter((e) => e.type === 'spell.cast').map((e) => [e.p.spellId, e.p.practice ?? false])).toEqual([['lumos', false]]);
  // Still drawn: only a cast of its own spell takes it away.
  await expect(leviosa).toHaveAttribute('aria-pressed', 'true');
  await leviosa.click();
  await expect(leviosa).toHaveAttribute('aria-pressed', 'false');
});

test('hiding the guide lasts across a reload', async ({ page }) => {
  await toMirror(page);
  await toggleOf(page).click();
  await expect(guideOf(page)).toHaveCount(0);
  await expect(toggleOf(page)).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(page.getByRole('button', { name: /Open spellbook/ })).toBeVisible();
  await expect(toggleOf(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(guideOf(page)).toHaveCount(0);
  await toggleOf(page).click();
  await expect(guideOf(page)).toBeVisible();
});
