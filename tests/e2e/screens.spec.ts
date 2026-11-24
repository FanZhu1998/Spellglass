// The first-run flow and the spellbook-to-practice flow through the real interface (Section 10.4).
import { chromium, expect, test } from '@playwright/test';
import { NO_GPU, draw, seen } from './helpers';

test.describe.configure({ mode: 'serial' });

test('first run: choose mouse or touch, start casting, no camera asked for', async ({ page }) => {
  const requested: string[] = [];
  await page.addInitScript(() => {
    const original = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (original) {
      navigator.mediaDevices.getUserMedia = (c) => {
        (window as any).__cameraAsked = true;
        return original(c);
      };
    }
  });
  page.on('console', (m) => { if (m.type() === 'error') requested.push(m.text()); });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Step up to the glass' })).toBeVisible();
  const start = page.getByRole('button', { name: 'Start casting' });
  await expect(start).toBeDisabled();
  await page.getByRole('button', { name: /Mouse or touch/ }).click();
  await expect(start).toBeEnabled();
  await start.click();
  await expect(page.getByRole('button', { name: /Open spellbook/ })).toBeVisible();
  const state = await page.evaluate(() => {
    const { app } = (window as any).__spellglass;
    return { onboarded: app.settings['app.onboarded'], tracker: app.settings['tracker.active'], consent: app.settings['capture.consent'], asked: !!(window as any).__cameraAsked };
  });
  expect(state).toEqual({ onboarded: true, tracker: 'tracker.pointer', consent: false, asked: false });
  expect(requested).toEqual([]);
});

test('spellbook: open, read a page, practise Lumos and get a graded attempt', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /Mouse or touch/ }).click();
  await page.getByRole('button', { name: 'Start casting' }).click();
  await page.getByRole('button', { name: /Open spellbook/ }).click();
  await expect(page.getByRole('heading', { name: 'Spellbook' })).toBeVisible();
  await page.getByRole('option', { name: /^Lumos/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Lumos', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Practice this spell' }).click();
  await expect(page.getByText(/Lumos, attempt/)).toBeVisible();
  // Record events from here on, then flick up.
  await page.evaluate(() => {
    (window as any).__seen = [];
    (window as any).__spellglass.kernel.subscribe('practice.attempt', (e: { payload: unknown }) => (window as any).__seen.push({ type: 'practice.attempt', p: e.payload }));
  });
  await draw(page, [[0.5, 0.62], [0.5, 0.3]], 260);
  await page.waitForFunction(() => ((window as any).__seen as unknown[]).length > 0, null, { timeout: 8000 });
  const [attempt] = await seen(page, 'practice.attempt');
  expect(attempt.p).toMatchObject({ spellId: 'lumos', attempt: 1, success: true });
  await expect(page.getByText(/Outstanding|Exceeds Expectations|Acceptable/).first()).toBeVisible();
});

test('camera refused: the Section 10.5 words, Try again, and the mouse fallback (Section 7.9)', async ({ baseURL }) => {
  // A browser that answers the camera prompt with "Block": no auto-accept flag, and no granted
  // permissions (inside the runner, newContext would otherwise inherit the config's camera grant).
  const browser = await chromium.launch({ channel: 'chrome', args: ['--use-fake-device-for-media-stream', ...NO_GPU] });
  try {
    const page = await (await browser.newContext({ baseURL, permissions: [] })).newPage();
    await page.goto('/');
    await page.getByRole('button', { name: /The tip of my wand/ }).click();
    const blocked = page.getByText('Camera is blocked. Allow camera access in the address bar, then choose Try again.');
    await expect(blocked).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: /Try again/ })).toBeVisible();
    await page.getByRole('button', { name: 'Use mouse or touch' }).click();
    await expect(blocked).toBeHidden();
    await page.getByRole('button', { name: 'Start casting' }).click();
    await expect(page.getByRole('button', { name: /Open spellbook/ })).toBeVisible();
    const tracker = await page.evaluate(() => (window as any).__spellglass.app.settings['tracker.active']);
    expect(tracker).toBe('tracker.pointer');
  } finally {
    await browser.close();
  }
});
