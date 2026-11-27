// The shelf inside the real stage core: drives the core's own dev harness (core/dev/index.html, which
// wires StageCore to createShelf() under the app's CSP) through window.__dev, served from this
// package's port. Casts real spells from the bundled packs at the props, so targeting, step delays,
// particles, held-step release and the reveal all come from the core.
//   npx vite --port 5182 --strictPort
//   npx tsx src/modules/effects/stage/props/dev/core-shots.ts <output folder> [scenario ...]
// Throwaway tooling: not part of the app or its tests.

import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:5182/src/modules/effects/stage/core/dev/index.html';
const out = process.argv[2] ?? 'core-shots';
const only = new Set(process.argv.slice(3));
mkdirSync(out, { recursive: true });

// Where each prop rests (contracts/scene.ts SHELF_LAYOUT), as aims.
const AT = {
  candle: '{ x: 0.12, y: 0.86 }', feather: '{ x: 0.27, y: 0.9 }', box: '{ x: 0.42, y: 0.87 }',
  teacup: '{ x: 0.57, y: 0.89 }', plant: '{ x: 0.72, y: 0.85 }', dummy: '{ x: 0.88, y: 0.8 }',
};
const near = (id: keyof typeof AT, spell: string) =>
  `d.trace('${spell}', 1, { cx: 0.45, cy: 0.42, size: 0.3 }); const c_${spell.replace(/-/g, '_')} = d.cast('${spell}', { aim: ${AT[id]} });`;

/** [name, body run in the page with `d` = window.__dev on a frozen clock]. */
const SCENARIOS: [string, string][] = [
  ['rest', `d.step(300);`],
  ['incendio', `${near('candle', 'incendio')} d.step(1400);`],
  ['aguamenti', `${near('candle', 'incendio')} d.step(1400); ${near('candle', 'aguamenti')} d.end(c_incendio, 'aguamenti', c_aguamenti.id); d.step(1300);`],
  ['alohomora', `${near('box', 'alohomora')} d.step(1300);`],
  ['reparo', `${near('teacup', 'reparo')} d.step(560);`],
  ['reducto', `${near('plant', 'reducto')} d.step(1100);`],
  ['reducto-reparo', `${near('plant', 'reducto')} d.step(1500); ${near('plant', 'reparo')} d.step(420);`],
  ['leviosa', `${near('feather', 'wingardium-leviosa')} d.holdTipAt(0.4, 0.45); d.step(1600);`],
  ['accio', `${near('teacup', 'accio')} d.holdTipAt(0.55, 0.4); d.step(1300);`],
  ['locomotor', `${near('box', 'locomotor')} d.holdTipAt(0.25, 0.6); d.step(1500);`],
  ['engorgio', `${near('plant', 'engorgio')} d.step(1300);`],
  ['reducio', `${near('box', 'reducio')} d.step(1300);`],
  ['stupefy', `${near('dummy', 'stupefy')} d.step(560);`],
  ['expelliarmus', `${near('dummy', 'expelliarmus')} d.step(640);`],
  ['expelliarmus-dropped', `${near('dummy', 'expelliarmus')} d.step(1600);`],
  ['petrificus', `${near('dummy', 'petrificus-totalus')} d.step(1500);`],
  ['impedimenta', `${near('dummy', 'impedimenta')} d.step(900);`],
  ['riddikulus', `${near('dummy', 'riddikulus')} d.step(700);`],
  ['imperio', `${near('dummy', 'imperio')} d.holdTipAt(0.97, 0.3); d.step(1200);`],
  ['crucio', `${near('dummy', 'crucio')} d.step(420);`],
  ['avada', `${near('dummy', 'avada-kedavra')} d.step(1500);`],
  ['revelio', `d.trace('revelio'); d.cast('revelio'); d.step(1600);`],
  ['finite', `${near('candle', 'incendio')} d.step(800); ${near('feather', 'wingardium-leviosa')} d.holdTipAt(0.4, 0.45); d.step(900); ${near('dummy', 'riddikulus')} d.step(600); d.trace('finite-incantatem'); d.cast('finite-incantatem'); d.step(1500);`],
];

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1340, height: 780 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[${m.type()}]`, m.text());
  });
  for (const [name, body] of SCENARIOS) {
    if (only.size && !only.has(name)) continue;
    await page.goto(BASE);
    await page.waitForFunction(() => (window as unknown as { __dev?: { ready: boolean } }).__dev?.ready === true, null, { timeout: 15000 });
    await page.evaluate(`(async () => { const d = window.__dev; d.freeze(); d.step(32); ${body} })()`);
    await page.waitForTimeout(60);
    await page.locator('#frame').screenshot({ path: `${out}/${name}.png` });
    console.log('shot', name);
  }
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
