// npm run perf:casting: Section 13 "Performance" (no main-thread task over 50 ms while casting),
// before a release, on the reference laptop with a real GPU. Serve the production build first:
//   npm run build && npm run preview      (then, in another shell)
//   npm run perf:casting                  (BASE=http://localhost:4173/ by default)
// Two passes: the mouse route casting a few spells, then the bright tip following a fake-camera clip
// (generated into the system temp folder, where Chrome can read it). It prints the long tasks seen
// while casting; the ones during start-up are reported apart. Headless Chrome without a GPU is far
// slower than a player's browser, so judge the numbers on real hardware.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { writeY4m } from '../fake-camera/make-y4m';

const BASE = process.env.BASE ?? 'http://localhost:4173/';
const SETTLE_MS = Number(process.env.SETTLE ?? 1500);

interface Long { start: number; ms: number }
interface Cast { t: number; id: string }

function observe(): void {
  const w = window as unknown as { __long: Long[] };
  w.__long = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__long.push({ start: e.startTime, ms: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* no long-task timing in this browser */
  }
}

async function prepare(page: Page, settings: Record<string, unknown>): Promise<void> {
  await page.goto(BASE);
  await page.waitForFunction(() => !!(window as any).__spellglass);
  await page.evaluate(async (s) => {
    const w = window as any;
    const { kernel, app } = w.__spellglass;
    for (const [key, value] of Object.entries(s)) await kernel.request('settings.set', { key, value });
    w.__casts = [];
    kernel.subscribe('spell.cast', (e: any) => w.__casts.push({ t: performance.now(), id: e.payload.spellId }));
    kernel.subscribe('spell.fizzle', (e: any) => w.__casts.push({ t: performance.now(), id: 'fizzle:' + e.payload.reason }));
    app.go('mirror');
  }, settings);
  await page.waitForTimeout(SETTLE_MS);
  // Long tasks from start-up (pack checks, first paint, the audio start-up) are not "while casting".
  await page.evaluate(() => {
    const w = window as any;
    w.__bootLong = w.__long.splice(0);
  });
}

function report(name: string, r: { long: Long[]; boot: Long[]; casts: Cast[] }): void {
  const over = r.long.filter((e) => e.ms > 50);
  const max = r.long.reduce((m, e) => Math.max(m, e.ms), 0);
  console.log(`\n== ${name}`);
  console.log(`decisions: ${r.casts.map((c) => c.id).join(', ') || 'none'}`);
  console.log(`start-up long tasks: ${r.boot.length} (longest ${r.boot.reduce((m, e) => Math.max(m, e.ms), 0).toFixed(0)} ms)`);
  console.log(`long tasks while casting: ${r.long.length}, over 50 ms: ${over.length}, longest ${max.toFixed(0)} ms`);
  for (const e of over.slice(0, 10)) {
    const near = r.casts.filter((c) => Math.abs(c.t - e.start) < 1500).map((c) => c.id);
    console.log(`  ${e.ms.toFixed(0)} ms at ${(e.start / 1000).toFixed(2)} s${near.length ? ` near ${near.join(', ')}` : ''}`);
  }
}

const collect = (page: Page) => page.evaluate(() => {
  const w = window as any;
  return { long: w.__long as Long[], boot: w.__bootLong as Long[], casts: w.__casts as Cast[] };
});

// Pass 1: the mouse.
{
  const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(observe);
  await prepare(page, { 'capture.mirror': false, 'tracker.active': 'tracker.pointer', 'spells.unlockAll': true, 'app.onboarded': true });
  const box = (await page.locator('.mirror-surface').boundingBox())!;
  const at = (fx: number, fy: number): [number, number] => [box.x + fx * box.width, box.y + fy * box.height];
  const aspect = box.width / box.height;
  const draw = async (points: [number, number][], ms: number) => {
    await page.mouse.move(...at(...points[0]));
    await page.mouse.down();
    const steps = Math.min(32, Math.max(12, Math.round(ms / 16)));
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const seg = Math.min(points.length - 2, Math.floor(f * (points.length - 1)));
      const local = f * (points.length - 1) - seg;
      const [ax, ay] = points[seg];
      const [bx, by] = points[seg + 1];
      await page.mouse.move(...at(ax + (bx - ax) * local, ay + (by - ay) * local));
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(2500);
  };
  const loop = (cx: number, cy: number, r: number, from: number, n = 33) =>
    Array.from({ length: n }, (_, i) => {
      const a = from + (i / (n - 1)) * Math.PI * 2;
      return [cx + (r * Math.cos(a)) / aspect, cy + r * Math.sin(a)] as [number, number];
    });
  await draw([[0.5, 0.62], [0.5, 0.3]], 260); // Lumos
  await draw([[0.32, 0.45], [0.68, 0.45]], 260); // Stupefy
  await draw(loop(0.5, 0.45, 0.17, -Math.PI / 2), 1100); // Protego
  await draw([[0.5, 0.3], [0.5, 0.62]], 260); // Nox
  await draw([[0.3, 0.35], [0.7, 0.35], [0.3, 0.62], [0.7, 0.62]], 900); // a scribble: whatever it is, it decides
  report('mouse route', await collect(page));
  await browser.close();
}

// Pass 2: the bright tip on a fake camera.
{
  const dir = mkdtempSync(join(tmpdir(), 'spellglass-perf-'));
  const clip = join(dir, 'clip.y4m').replace(/\\/g, '/');
  writeY4m(clip, { width: 640, height: 360 });
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${clip}`, '--autoplay-policy=no-user-gesture-required'],
  });
  try {
    const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.addInitScript(observe);
    await prepare(page, { 'spells.unlockAll': true, 'app.onboarded': true, 'capture.consent': true, 'capture.mirror': true, 'tracker.active': 'tracker.bright-tip' });
    await page.waitForFunction(() => ((window as any).__casts as Cast[]).filter((c) => !c.id.startsWith('fizzle')).length >= 4, null, { timeout: 120000 }).catch(() => {});
    report('bright tip, fake camera', await collect(page));
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
