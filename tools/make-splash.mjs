// Draws desktop/splash.bmp, the picture the portable Windows app shows while it unpacks itself after a
// double-click (electron-builder.config.mjs, portable.splashImage), using the installed Chrome, as
// make-icons.mjs does. The launcher takes only a .bmp. Run: node tools/make-splash.mjs
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const WIDTH = 480;
const HEIGHT = 300;

const dataUrl = (file, type) => `data:${type};base64,${readFileSync(`${root}/${file}`).toString('base64')}`;
const svg = dataUrl('public/icons/icon.svg', 'image/svg+xml');
const title = dataUrl('node_modules/@fontsource/cinzel-decorative/files/cinzel-decorative-latin-700-normal.woff2', 'font/woff2');
const italic = dataUrl('node_modules/@fontsource/im-fell-english/files/im-fell-english-latin-400-italic.woff2', 'font/woff2');

/** A 24-bit, bottom-up Windows bitmap from RGBA pixels. */
function bmp(width, height, rgba) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const out = Buffer.alloc(54 + row * height);
  out.write('BM', 0, 'ascii');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(row * height, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const at = 54 + (height - 1 - y) * row;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      out[at + x * 3] = rgba[i + 2];
      out[at + x * 3 + 1] = rgba[i + 1];
      out[at + x * 3 + 2] = rgba[i];
    }
  }
  return out;
}

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.setContent(`<style>
  @font-face { font-family: Title; src: url(${title}); font-weight: 700; }
  @font-face { font-family: Fell; src: url(${italic}); font-style: italic; }
</style><body style="margin:0;background:#0f1424"><span style="font:700 10px Title">.</span><span style="font:italic 10px Fell">.</span></body>`);
const pixels = await page.evaluate(
  async ({ svg, width, height }) => {
    await document.fonts.ready;
    await document.fonts.load('700 36px Title');
    await document.fonts.load('italic 17px Fell');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const g = canvas.getContext('2d');
    // The night, a little lighter where the candle would be, and a thin gilt edge.
    const sky = g.createRadialGradient(width / 2, height * 0.36, 10, width / 2, height * 0.4, width * 0.62);
    sky.addColorStop(0, '#1d2538');
    sky.addColorStop(1, '#0f1424');
    g.fillStyle = sky;
    g.fillRect(0, 0, width, height);
    g.strokeStyle = '#8a6a2c';
    g.lineWidth = 2;
    g.strokeRect(1, 1, width - 2, height - 2);
    const icon = new Image();
    icon.src = svg;
    await icon.decode();
    const size = 156;
    g.drawImage(icon, (width - size) / 2, 26, size, size);
    g.textAlign = 'center';
    g.fillStyle = '#e9cf8a';
    g.font = '700 36px Title';
    g.fillText('Spellglass', width / 2, 226);
    g.fillStyle = '#aba597';
    g.font = 'italic 17px Fell';
    g.fillText('Opening the mirror…', width / 2, 258);
    return Array.from(g.getImageData(0, 0, width, height).data);
  },
  { svg, width: WIDTH, height: HEIGHT },
);
await browser.close();
writeFileSync(`${root}/desktop/splash.bmp`, bmp(WIDTH, HEIGHT, pixels));
console.log(`desktop/splash.bmp written (${WIDTH}x${HEIGHT})`);
