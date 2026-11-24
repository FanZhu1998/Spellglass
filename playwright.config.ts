import { defineConfig } from '@playwright/test';
import { NO_GPU } from './tests/e2e/helpers';

// End-to-end tests drive the installed Chrome (Section 2, A1: Chrome or Edge first) against the
// production build. Chrome's fake media devices stand in for the camera; a test can point
// --use-file-for-fake-video-capture at a generated .y4m clip of a bright dot tracing a spell.
const PORT = 4173;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: 'tests/e2e/.output/results',
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    permissions: ['camera', 'microphone'],
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', ...NO_GPU],
    },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 240_000,
  },
});
