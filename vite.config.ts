/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

const isTest = !!process.env.VITEST;

/**
 * BASE_PATH sets where the app is served from. GitHub Pages serves a repository at
 * /<repository>/, so the deploy workflow builds with BASE_PATH=/Spellglass/.
 */
const base = process.env.BASE_PATH ?? '/';

/** Set by tools/run-perf.mjs (npm run test:perf): run only the time-budget tests. */
const perf = process.env.SPELLGLASS_PERF === '1';

/**
 * SPELLGLASS_WEB_URL is the address of Spellglass on the web (the GitHub Pages site), for a build that
 * is not served from it. The desktop app runs from app://spellglass/, which no phone or friend can
 * open, so its QR code and replay links point here instead; without it the desktop app leaves them
 * out. The web build always uses its own address.
 */
const webUrl = webAddress(process.env.SPELLGLASS_WEB_URL);

function webAddress(raw: string | undefined): string {
  const text = raw?.trim() ?? '';
  if (!text) return '';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`SPELLGLASS_WEB_URL is not a web address: ${text}`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`SPELLGLASS_WEB_URL must be an https address (cameras need one): ${text}`);
  }
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url.href;
}

export default defineConfig({
  base,
  define: {
    'import.meta.env.SPELLGLASS_WEB_URL': JSON.stringify(webUrl),
  },
  plugins: [
    svelte(),
    !isTest &&
      VitePWA({
        registerType: 'prompt',
        injectRegister: false,
        includeAssets: ['icons/*.png', 'icons/*.svg'],
        manifest: {
          name: 'Spellglass',
          short_name: 'Spellglass',
          description: 'Trace a spell in the air with your wand and watch the mirror answer. An unofficial fan project.',
          theme_color: '#0F1424',
          background_color: '#0F1424',
          display: 'standalone',
          orientation: 'landscape',
          start_url: '.',
          scope: '.',
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          ],
        },
        workbox: {
          // The hand model and its WASM runtime are fetched on demand and cached at runtime,
          // so the first download stays small (Section 2 target: 3 MB or less).
          globPatterns: ['**/*.{js,css,html,svg,png,woff2,json,webmanifest}'],
          globIgnores: ['**/models/**', '**/*.wasm', '**/*.task'],
          navigateFallback: 'index.html',
          // The tip-finder page is its own document; never answer it with the app shell.
          navigateFallbackDenylist: [new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}tools/`)],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
          runtimeCaching: [
            {
              urlPattern: ({ url }) => /\/models\//.test(url.pathname) || url.pathname.endsWith('.wasm'),
              handler: 'CacheFirst',
              options: { cacheName: 'spellglass-models', expiration: { maxEntries: 8 } },
            },
          ],
        },
        devOptions: { enabled: false },
      }),
  ].filter(Boolean),
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        tipFinder: fileURLToPath(new URL('./tools/tip-finder.html', import.meta.url)),
      },
    },
  },
  // `npm test` runs every file in parallel. Time budgets (*.perf.test.ts, Section 13 "Performance")
  // only mean something on a quiet machine, so they run apart, one file at a time: npm run test:perf.
  test: perf
    ? {
        include: ['src/**/*.perf.test.ts', 'tools/**/*.perf.test.ts'],
        environment: 'node',
        fileParallelism: false,
        testTimeout: 60000,
      }
    : {
        include: ['src/**/*.test.ts', 'tests/**/*.test.ts', 'tools/**/*.test.ts'],
        exclude: ['tests/e2e/**', 'node_modules/**', '**/*.perf.test.ts'],
        environment: 'node',
        testTimeout: 20000,
      },
});
