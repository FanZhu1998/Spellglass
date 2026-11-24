import { defineConfig } from '@playwright/test';

// The desktop app in Electron (desktop/main.mjs), through Playwright's Electron driver: against the
// production build in dist/ (npm run test:desktop builds it first), and against the packaged app in
// release/ when there is one (npm run desktop:win, or desktop:mac on a Mac). Each test starts the app
// itself, so there is no browser or web server here.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  outputDir: '.output/results',
});
