// Regenerates the PWA icons from public/icons/icon.svg using the installed Chrome. Run: node tools/make-icons.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const svg = readFileSync(`${root}/public/icons/icon.svg`, 'utf8');
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
async function shot(size, file, maskable) {
  await page.setViewportSize({ width: size, height: size });
  // Maskable icons need full-bleed background and content inside the central 80% safe zone.
  const inner = maskable
    ? `<div style="width:${size}px;height:${size}px;background:#0F1424;display:grid;place-items:center"><div style="width:${size * 0.8}px;height:${size * 0.8}px">${svg.replace('rx="104"', 'rx="0"')}</div></div>`
    : svg;
  await page.setContent(`<html><body style="margin:0;background:transparent">${inner}</body></html>`);
  await page.evaluate((s) => document.querySelectorAll('svg').forEach((el) => { el.setAttribute('width', '100%'); el.setAttribute('height', '100%'); el.style.display = 'block'; if (!el.parentElement.style.width) { el.style.width = s + 'px'; el.style.height = s + 'px'; } }), size);
  await page.screenshot({ path: `${root}/public/icons/${file}`, omitBackground: !maskable, clip: { x: 0, y: 0, width: size, height: size } });
}
await shot(192, 'icon-192.png', false);
await shot(512, 'icon-512.png', false);
await shot(512, 'icon-maskable-512.png', true);
await browser.close();
console.log('icons written');
