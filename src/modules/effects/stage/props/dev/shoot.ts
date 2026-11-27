// Screenshots of the props harness in the installed Chrome, for checking the art by eye.
//   npx vite --port 5182 --strictPort            (in another terminal)
//   npx tsx src/modules/effects/stage/props/dev/shoot.ts <output folder> [options]
// Options (all optional):
//   --stills a,b      stills to take (default: every still the harness knows)
//   --strips a,b      film strips to take (default: none; 'all' for every strip)
//   --sizes WxH,...   viewports (default 1280x720,1920x1080)
//   --dpr N           device pixel ratio (default 1)
//   --crops           also write a close-up of each prop for every still at the largest size
//   --query k=v&...   extra query for the page (room=bright, caster=4:3, reduced=1)
// Writes <still>-<width>.png, <still>-<width>-<prop>.png and strip-<name>.png. Throwaway tooling.

import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const out = args[0] && !args[0].startsWith('--') ? args[0] : '.';
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string): boolean => args.includes(`--${name}`);

const sizes = (opt('sizes') ?? '1280x720,1920x1080').split(',').map((s) => s.split('x').map(Number) as [number, number]);
const dpr = Number(opt('dpr') ?? 1);
const query = opt('query');
const url = `http://localhost:5182/src/modules/effects/stage/props/dev/index.html?shot=1${query ? `&${query}` : ''}`;

interface Crop { id: string; x: number; y: number; w: number; h: number }
interface Harness {
  ready: boolean;
  still(name: string): void;
  strip(name: string, scale?: number, cols?: number): string;
  stills(): string[];
  strips(): string[];
  crops(): Crop[];
}
type Win = { harness: Harness };

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const largest = Math.max(...sizes.map(([w]) => w));
  for (const [width, height] of sizes) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
    page.on('pageerror', (e) => console.error('page error:', e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().includes('404')) console.error('console:', m.text());
    });
    await page.goto(url);
    await page.waitForFunction(() => (window as unknown as Partial<Win>).harness?.ready === true);
    const allStills = await page.evaluate(() => (window as unknown as Win).harness.stills());
    const allStrips = await page.evaluate(() => (window as unknown as Win).harness.strips());
    const stillList = opt('stills') ? (opt('stills') as string).split(',') : allStills;
    const stripArg = opt('strips');
    const stripList = stripArg === 'all' ? allStrips : stripArg ? stripArg.split(',') : [];
    const tag = `${width}${dpr !== 1 ? `@${dpr}x` : ''}`;
    for (const still of stillList) {
      if (still === 'none') continue;
      await page.evaluate((s) => (window as unknown as Win).harness.still(s), still);
      await page.screenshot({ path: join(out, `${still}-${tag}.png`) });
      if (flag('crops') && width === largest) {
        const crops = await page.evaluate(() => (window as unknown as Win).harness.crops());
        for (const c of crops) {
          const w = Math.min(c.w, width - c.x);
          const h = Math.min(c.h, height - c.y);
          await page.screenshot({ path: join(out, `${still}-${tag}-${c.id}.png`), clip: { x: c.x, y: c.y, width: w, height: h } });
        }
      }
    }
    if (width === largest) {
      for (const s of stripList) {
        const data = await page.evaluate((name) => (window as unknown as Win).harness.strip(name, 1, 4), s);
        writeFileSync(join(out, `strip-${s}-${tag}.png`), Buffer.from(data.split(',')[1], 'base64'));
      }
    }
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(`wrote screenshots to ${out}`);
