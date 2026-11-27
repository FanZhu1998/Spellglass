// End to end through the real app in Chrome: tracker → segmenter → recognizer → engine → stage.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test } from '@playwright/test';
import { writeY4m } from '../../tools/fake-camera/make-y4m';
import { MOUSE, NO_GPU, boot, casts, circle, draw, mirrorAspect, seen, waitForCasts } from './helpers';

test.describe.configure({ mode: 'serial' });

test('casts with the mouse: flicks and a circle', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page, MOUSE);
  await draw(page, [[0.5, 0.62], [0.5, 0.3]], 260);
  await waitForCasts(page, ['lumos']);
  await page.waitForTimeout(500);
  await draw(page, [[0.32, 0.45], [0.68, 0.45]], 260);
  await waitForCasts(page, ['stupefy']);
  await page.waitForTimeout(500);
  await draw(page, circle(await mirrorAspect(page)), 1100);
  await waitForCasts(page, ['protego']);
  expect(await casts(page)).toEqual(['lumos', 'stupefy', 'protego']);
  // The result is shown under the mirror's top edge (and spoken by the shell's announcer, outside it).
  await expect(page.locator('.banner-slot')).toContainText('Protego');
  expect(errors).toEqual([]);
});

test('a scribble fizzles with a hint and casts nothing', async ({ page }) => {
  await boot(page, MOUSE);
  await draw(page, [[0.3, 0.3], [0.6, 0.6], [0.35, 0.65], [0.65, 0.32], [0.4, 0.5]], 900);
  await page.waitForFunction(() => ((window as any).__seen as { type: string }[]).some((e) => e.type === 'spell.fizzle'), null, { timeout: 8000 });
  expect(await casts(page)).toEqual([]);
});

test('a replay link round-trips and plays as a replay', async ({ page }) => {
  await boot(page, MOUSE);
  await draw(page, [[0.5, 0.62], [0.5, 0.3]], 260);
  await waitForCasts(page, ['lumos']);
  const castId = (await seen(page, 'spell.cast'))[0].p.id as string;
  const link = await page.evaluate(async (id) => (window as any).__spellglass.kernel.request('share.link', { castId: id }), castId);
  expect(link.url).toContain('#cast=');
  expect(link.hash.length).toBeLessThanOrEqual(210);
  const data = await page.evaluate(async (hash) => (window as any).__spellglass.kernel.request('share.parse', { hash }), link.hash);
  expect(data.spellId).toBe('lumos');
  expect(data.points).toHaveLength(64);
  await page.evaluate(async (d) => (window as any).__spellglass.kernel.request('share.replay', { data: d }), data);
  const replayed = (await seen(page, 'spell.cast')).filter((e) => e.p.replay);
  expect(replayed.map((e) => e.p.spellId)).toEqual(['lumos']);
});

test('no request leaves the origin (Section 11.2)', async ({ page, baseURL }) => {
  const foreign: string[] = [];
  page.on('request', (r) => {
    const url = r.url();
    if (!url.startsWith(baseURL!) && !url.startsWith('data:') && !url.startsWith('blob:')) foreign.push(url);
  });
  await boot(page, MOUSE);
  await draw(page, [[0.5, 0.62], [0.5, 0.3]], 260);
  await waitForCasts(page, ['lumos']);
  await page.waitForTimeout(1000);
  expect(foreign).toEqual([]);
});

test('works offline after the first visit (Section 2)', async ({ page, context }) => {
  await boot(page, MOUSE);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // The service worker takes control on the next load; then the network goes away.
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
  await context.setOffline(true);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__spellglass);
  const spells = await page.evaluate(() => (window as any).__spellglass.app.spellbook?.spells.length ?? 0);
  expect(spells).toBe(27);
  await context.setOffline(false);
});

test('the bright tip follows a fake camera and casts (routes A and C)', async ({ baseURL }) => {
  test.setTimeout(150_000);
  // Chrome's capture process can read clips under the system temp folder (not every subfolder).
  const dir = mkdtempSync(join(tmpdir(), 'spellglass-e2e-'));
  const clip = join(dir, 'clip.y4m').replace(/\\/g, '/');
  writeY4m(clip, { width: 640, height: 360 });
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, ...NO_GPU],
  });
  try {
    const context = await browser.newContext({ baseURL, permissions: ['camera'], viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await boot(page, { 'spells.unlockAll': true, 'app.onboarded': true, 'capture.consent': true, 'capture.mirror': true, 'tracker.active': 'tracker.bright-tip' });
    await page.waitForFunction(
      () => ((window as any).__seen as { type: string; p: any }[]).some((e) => e.type === 'camera.status' && e.p.state === 'on'),
      null,
      { timeout: 20000 },
    );
    // The clip traces Lumos, Wingardium Leviosa, Protego and Stupefy, and Chrome loops it.
    await waitForCasts(page, ['lumos', 'stupefy'], 90_000);
    const status = (await seen(page, 'tracker.status')).filter((e) => e.p.tracker === 'tracker.bright-tip').pop();
    expect(status?.p.state).not.toBe('error');
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
