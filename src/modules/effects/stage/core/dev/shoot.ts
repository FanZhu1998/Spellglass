// Screenshots of the stage harness, for looking at the casting moment and every primitive.
//   npx vite --port 5181 --strictPort          (in another shell)
//   npx tsx src/modules/effects/stage/core/dev/shoot.ts <out-dir> [scenario ...] [--zoom=x,y,w,h]
// --zoom shoots at twice the device scale and keeps only that rectangle (CSS px inside the 1280x720
// mirror), for looking closely at a detail. Drives the installed Chrome (channel 'chrome').
// Throwaway tooling: not part of the app or its tests.

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:5181/src/modules/effects/stage/core/dev/index.html';
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const zoomArg = process.argv.find((a) => a.startsWith('--zoom='));
const zoom = zoomArg ? zoomArg.slice(7).split(',').map(Number) : null;
const out = args[0] ?? 'stage-shots';
const only = new Set(args.slice(1));
mkdirSync(out, { recursive: true });

/** The mirror's top-left corner on the page (#frame at 24 px plus its 14 px padding). */
const MIRROR_AT = 24 + 14;

async function shot(page: import('@playwright/test').Page, path: string): Promise<void> {
  if (zoom && zoom.length === 4) {
    const [x, y, width, height] = zoom;
    await page.screenshot({ path, clip: { x: MIRROR_AT + x, y: MIRROR_AT + y, width, height } });
  } else {
    await page.locator('#frame').screenshot({ path });
  }
}

/** [name, query string, body run in the page with `d` = window.__dev (frozen clock)]. */
const SCENARIOS: [string, string, string][] = [
  ['tip-hover', '', `d.hover(0.6); d.step(40);`],
  ['tip-armed', '', `d.hover(1); d.step(90);`],
  ['ink-wet', '', `d.trace('aguamenti', 0.7);`],
  ['ink-wet-circle', '', `d.trace('protego', 0.85);`],
  ['settle-mid', '', `d.trace('alohomora'); d.cast('alohomora'); d.step(110);`],
  ['inscribe-mid', '', `d.trace('wingardium-leviosa'); d.cast('wingardium-leviosa'); d.step(640);`],
  ['inscribe-done', '', `d.trace('wingardium-leviosa'); d.cast('wingardium-leviosa'); d.step(1100);`],
  ['lumos', '', `d.trace('lumos'); d.cast('lumos'); d.step(1400);`],
  ['lumos-maxima', '', `d.trace('lumos'); d.cast('lumos', { variant: 'Lumos Maxima', scale: 1.6 }); d.step(1400);`],
  ['nox', '', `d.trace('lumos'); const c = d.cast('lumos'); d.step(1500); d.trace('nox'); const n = d.cast('nox'); d.end(c, 'nox', n.id); d.step(700);`],
  ['fizzle-early', '', `d.trace('incendio'); d.fizzle(); d.step(260);`],
  ['fizzle-drip', '', `d.trace('incendio'); d.fizzle(); d.step(950);`],
  ['pending', '', `d.trace('protego'); d.pending(); d.step(450);`],
  ['protego', '', `d.trace('protego'); d.cast('protego'); d.step(1600);`],
  ['stupefy-bolt', '', `d.trace('stupefy', 1, { cx: 0.35, cy: 0.45, size: 0.3 }); d.cast('stupefy', { aim: { x: 0.86, y: 0.76 } }); d.step(330);`],
  ['stupefy-flash', '', `d.trace('stupefy', 1, { cx: 0.35, cy: 0.45, size: 0.3 }); d.cast('stupefy', { aim: { x: 0.86, y: 0.76 } }); d.step(470);`],
  ['expelliarmus', '', `d.trace('expelliarmus', 1, { cx: 0.35, cy: 0.45, size: 0.3 }); d.cast('expelliarmus', { aim: { x: 0.86, y: 0.76 } }); d.step(380);`],
  ['crucio', '', `d.trace('crucio', 1, { cx: 0.35, cy: 0.42, size: 0.3 }); d.cast('crucio', { aim: { x: 0.86, y: 0.76 } }); d.step(340);`],
  ['avada', '', `d.trace('avada-kedavra', 1, { cx: 0.35, cy: 0.42, size: 0.3 }); d.cast('avada-kedavra', { aim: { x: 0.86, y: 0.76 } }); d.step(450);`],
  ['patronus-1', '', `d.trace('expecto-patronum'); d.cast('expecto-patronum'); d.step(1200);`],
  ['patronus-2', '', `d.trace('expecto-patronum'); d.cast('expecto-patronum'); d.step(3300);`],
  ['patronus-3', '', `d.trace('expecto-patronum'); d.cast('expecto-patronum'); d.step(5200);`],
  ['aguamenti', '', `d.trace('aguamenti', 1, { cx: 0.62, cy: 0.42, size: 0.3 }); d.cast('aguamenti', { aim: { x: 0.14, y: 0.86 } }); d.step(1000);`],
  ['incendio', '', `d.trace('incendio'); d.cast('incendio'); d.step(520);`],
  ['accio', '', `d.trace('accio', 1, { cx: 0.5, cy: 0.4, size: 0.3 }); d.cast('accio', { aim: { x: 0.27, y: 0.88 } }); d.step(640);`],
  ['revelio', '', `d.trace('protego'); d.cast('protego'); d.step(1700); d.trace('revelio'); d.cast('revelio'); d.step(2600);`],
  ['reducto', '', `d.trace('reducto', 1, { cx: 0.4, cy: 0.42, size: 0.32 }); d.cast('reducto', { aim: { x: 0.57, y: 0.86 } }); d.step(470);`],
  ['arresto', '', `d.trace('arresto-momentum'); d.cast('arresto-momentum'); d.step(700);`],
  ['finite', '', `d.trace('lumos'); d.cast('lumos'); d.step(1300); d.trace('finite-incantatem'); d.cast('finite-incantatem'); d.step(330);`],
  ['obliviate', '', `d.trace('lumos'); d.cast('lumos'); d.step(300); d.trace('obliviate'); d.cast('obliviate'); d.step(700);`],
  ['riddikulus', '', `d.trace('riddikulus'); d.cast('riddikulus'); d.step(500);`],
  ['voice', '', `d.cast('lumos', { voice: true, aim: { x: 0.62, y: 0.4 } }); d.step(180);`],
  ['practice', '', `d.practice('alohomora'); d.step(1300);`],
  ['practice-attempt', '', `d.practice('alohomora'); d.step(500); d.trace('alohomora', 1, { cx: 0.53, cy: 0.46, size: 0.4 }); d.attempt('alohomora'); d.step(150);`],
  ['practice-flick', '', `d.practice('stupefy'); d.step(700);`],
  ['high-contrast', '?contrast=1', `d.trace('aguamenti', 0.8);`],
  ['reduced-motion', '?reduced=1', `d.trace('aguamenti'); d.cast('aguamenti', { aim: { x: 0.14, y: 0.86 } }); d.step(120);`],
  ['no-camera', '?camera=off', `d.trace('protego'); d.cast('protego'); d.step(1500);`],
  // The core and the props together. glide(x, y, ms) moves the held tip there over ms.
  ['leviosa-steer', '', `d.trace('wingardium-leviosa', 1, { cx: 0.3, cy: 0.5, size: 0.3 }); d.cast('wingardium-leviosa', { target: 'feather' }); d.step(500); d.glide(0.42, 0.42, 900); d.step(200);`],
  ['locomotor-steer', '', `d.trace('locomotor', 1, { cx: 0.45, cy: 0.55, size: 0.3 }); d.cast('locomotor', { target: 'box' }); d.step(400); d.glide(0.6, 0.7, 900); d.step(200);`],
  ['alohomora', '', `d.trace('alohomora', 1, { cx: 0.42, cy: 0.5, size: 0.34 }); d.cast('alohomora', { target: 'box' }); d.step(1100);`],
  ['reparo', '', `d.trace('reparo', 1, { cx: 0.57, cy: 0.5, size: 0.3 }); d.cast('reparo', { target: 'teacup' }); d.step(1100);`],
  ['reducto-reparo', '', `d.trace('reducto', 1, { cx: 0.4, cy: 0.42, size: 0.32 }); d.cast('reducto', { target: 'plant' }); d.step(1400); d.trace('reparo', 1, { cx: 0.6, cy: 0.5, size: 0.3 }); d.cast('reparo', { target: 'plant' }); d.step(900);`],
  ['engorgio', '', `d.trace('engorgio', 1, { cx: 0.6, cy: 0.5, size: 0.3 }); d.cast('engorgio', { target: 'teacup' }); d.step(1600);`],
  ['reducio', '', `d.trace('reducio', 1, { cx: 0.6, cy: 0.5, size: 0.3 }); d.cast('reducio', { target: 'plant' }); d.step(1600);`],
  ['petrificus', '', `d.trace('petrificus-totalus', 1, { cx: 0.6, cy: 0.45, size: 0.3 }); d.cast('petrificus-totalus', { target: 'dummy' }); d.step(1400);`],
  ['impedimenta', '', `d.trace('impedimenta', 1, { cx: 0.6, cy: 0.45, size: 0.3 }); d.cast('impedimenta', { target: 'dummy' }); d.step(900);`],
  ['imperio', '', `d.trace('imperio', 1, { cx: 0.6, cy: 0.45, size: 0.3 }); d.cast('imperio', { target: 'dummy' }); d.step(400); d.glide(0.75, 0.35, 700); d.step(100);`],
  ['incendio-aguamenti', '', `d.trace('incendio', 1, { cx: 0.3, cy: 0.45, size: 0.3 }); const f = d.cast('incendio', { target: 'candle' }); d.step(1400); d.trace('aguamenti', 1, { cx: 0.6, cy: 0.42, size: 0.3 }); const w = d.cast('aguamenti', { target: 'candle' }); d.end(f, 'aguamenti', w.id); d.step(1300);`],
  ['finite-props', '', `d.trace('incendio', 1, { cx: 0.3, cy: 0.45, size: 0.3 }); d.cast('incendio', { target: 'candle' }); d.step(900); d.trace('engorgio', 1, { cx: 0.6, cy: 0.5, size: 0.3 }); d.cast('engorgio', { target: 'teacup' }); d.step(1200); d.trace('finite-incantatem'); d.cast('finite-incantatem'); d.step(900);`],
  ['accio-hover', '', `d.trace('accio', 1, { cx: 0.5, cy: 0.4, size: 0.3 }); d.cast('accio', { target: 'plant', aim: { x: 0.55, y: 0.5 } }); d.step(1400);`],
  ['letterbox', '?cam=43', `d.trace('protego', 0.8); d.step(30);`],
  ['letterbox-cast', '?cam=43', `d.trace('incendio', 1, { cx: 0.3, cy: 0.45, size: 0.3 }); d.cast('incendio', { target: 'candle' }); d.step(900);`],
  ['slowly', '', `d.practice('wingardium-leviosa'); d.slowly('wingardium-leviosa'); d.step(1500);`],
  ['muffliato', '', `d.trace('muffliato'); d.cast('muffliato'); d.step(900);`],
  ['lumos-follow', '', `d.trace('lumos', 1, { cx: 0.35, cy: 0.5, size: 0.3 }); d.cast('lumos'); d.step(600); d.glide(0.7, 0.3, 700); d.step(60);`],
  ['reset', '', `d.trace('incendio', 1, { cx: 0.3, cy: 0.45, size: 0.3 }); d.cast('incendio', { target: 'candle' }); d.step(800); d.reset(); d.step(400);`],
  ['voice-protego', '', `d.cast('protego', { voice: true, aim: { x: 0.5, y: 0.45 } }); d.step(160);`],
  ['reduced-fizzle', '?reduced=1', `d.trace('incendio'); d.fizzle(); d.step(300);`],
  ['hc-settle', '?contrast=1', `d.trace('alohomora'); d.cast('alohomora', { target: 'box' }); d.step(400);`],
  ['reduced-patronus', '?reduced=1', `d.trace('expecto-patronum'); d.cast('expecto-patronum'); d.step(1500);`],
];

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1340, height: 780 }, deviceScaleFactor: zoom ? 2 : 1 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text());
  });
  for (const [name, query, body] of SCENARIOS) {
    if (only.size && !only.has(name)) continue;
    await page.goto(BASE + query);
    await page.waitForFunction(() => (window as unknown as { __dev?: { ready: boolean } }).__dev?.ready === true, null, { timeout: 15000 });
    await page.evaluate(`(async () => { const d = window.__dev; d.freeze(); d.step(32); ${body} })()`);
    await page.waitForTimeout(60);
    await shot(page, `${out}/${name}.png`);
    // What the stage is doing at this moment, beside the picture.
    const state = await page.evaluate(`(() => {
      const d = window.__dev, k = d.kernel;
      const steer = k.last('stage.steering')?.payload?.castId ?? null;
      const props = (k.last('scene.props')?.payload?.props ?? []).filter((p) => Object.keys(p.state).length).map((p) => p.id + JSON.stringify(p.state));
      const active = d.core.director().ongoing().map((a) => a.use);
      return JSON.stringify({ steer, props, active, particles: d.core.particles.count });
    })()`);
    console.log('shot', name, state);
  }
  // Clips run on real time: record the mirror (with and without the camera) and show the recording.
  if (!only.size || only.has('clip')) {
    const tall = await browser.newPage({ viewport: { width: 1340, height: 1200 }, deviceScaleFactor: 1 });
    tall.on('pageerror', (e) => console.log('[pageerror]', e.message));
    for (const includeCamera of [true, false]) {
      await tall.goto(BASE);
      await tall.waitForFunction(() => (window as unknown as { __dev?: { ready: boolean } }).__dev?.ready === true, null, { timeout: 15000 });
      const info = await tall.evaluate(`(async () => {
        const d = window.__dev;
        d.trace('protego'); d.cast('protego');
        const r = await d.clip(${includeCamera});
        return JSON.stringify({ ...r, surface: d.surface() });
      })()`);
      await tall.waitForTimeout(1200);
      await tall.screenshot({ path: `${out}/clip-${includeCamera ? 'camera' : 'plain'}.png`, clip: { x: 0, y: 780, width: 700, height: 400 } });
      await tall.evaluate(`window.__dev.clipStop()`);
      console.log('shot clip', includeCamera ? 'camera' : 'plain', info);
    }
    await tall.close();
  }
  // Resizing republishes stage.surface and resizes the canvases; a hidden page stops drawing but
  // keeps effect timing (a slow backup tick), and starts drawing again when it comes back.
  if (!only.size || only.has('lifecycle')) {
    await page.goto(BASE);
    await page.waitForFunction(() => (window as unknown as { __dev?: { ready: boolean } }).__dev?.ready === true, null, { timeout: 15000 });
    const report = await page.evaluate(`(async () => {
      const d = window.__dev, k = d.kernel;
      const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const before = d.surface();
      const n0 = k.last('stage.surface').t;
      document.getElementById('frame').style.width = '960px';
      await frames(); await new Promise((r) => setTimeout(r, 150)); await frames();
      const after = d.surface();
      const canvas = document.querySelector('.stage-light');
      const resized = { surface: after, canvas: [canvas.width, canvas.height], republished: k.last('stage.surface').t > n0 };
      // Hide the page: no animation frames, but a cast's effect.start still comes on time.
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      d.live();
      const starts = [];
      const off = k.subscribe('effect.start', (e) => starts.push(e.payload.use));
      d.cast('protego', { voice: true });
      await new Promise((r) => setTimeout(r, 900));
      const hidden = { raf: d.core.raf, starts: [...starts] };
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
      await frames();
      off();
      return JSON.stringify({ before, resized, hidden, rafBack: d.core.raf !== 0 });
    })()`);
    console.log('lifecycle', report);
  }
  // The bright tip's short exposure: the reflection is lifted so the room still shows.
  if (!only.size || only.has('exposure')) {
    await page.goto(BASE);
    await page.waitForFunction(() => (window as unknown as { __dev?: { ready: boolean } }).__dev?.ready === true, null, { timeout: 15000 });
    await page.evaluate(`window.__dev.exposure('manual', 20)`);
    await page.waitForTimeout(400);
    const filter = await page.evaluate(`document.querySelector('.stage-video').style.filter`);
    await shot(page, `${out}/exposure-manual.png`);
    console.log('shot exposure', filter);
  }
  // A replay runs on real time.
  if (!only.size || only.has('replay')) {
    await page.goto(BASE);
    await page.waitForFunction(() => (window as unknown as { __dev?: { ready: boolean } }).__dev?.ready === true, null, { timeout: 15000 });
    await page.evaluate(`void window.__dev.replay('protego')`);
    await page.waitForTimeout(800);
    await shot(page, `${out}/replay-trace.png`);
    await page.waitForTimeout(1500);
    await shot(page, `${out}/replay-cast.png`);
    console.log('shot replay');
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
