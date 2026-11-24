// The desktop app end to end, in Electron: the window, the spellbook, casting, the closed network,
// progress across launches, the bright tip on a fake camera, and the packaged app when it is built: the
// test build (driven by Playwright), the release build (started as a player starts it), and on Windows
// the portable .exe.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { writeY4m } from '../../tools/fake-camera/make-y4m';
import { MOUSE, NO_GPU, casts, draw, seen, waitForCasts } from '../e2e/helpers';
import {
  NETWORK_USE, OUTPUT, ROOT, appArgs, closeStarted, closeWindowOf, electronEnv, launch, netLogEvents, pageStarted, portableExe, prepare, refused,
  releaseApp, removeTempDirs, spellglassWindows, start, tempDir, testBuildApp,
} from './app';

test.describe.configure({ mode: 'serial' });
test.afterAll(removeTempDirs);

const LUMOS: [number, number][] = [[0.5, 0.62], [0.5, 0.3]];

async function closeApp(app: ElectronApplication): Promise<void> {
  await app.close().catch(() => {});
}

/** Every page error, for the end of a test. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

test('opens one window on app://spellglass/, with the 27 spells, and keeps a second launch out', async () => {
  const userData = tempDir('spellglass-desktop-');
  const { app, page } = await launch({ userData });
  try {
    const errors = watchErrors(page);
    expect(app.windows()).toHaveLength(1);
    expect(page.url()).toBe('app://spellglass/');
    await expect(page).toHaveTitle('Spellglass');
    // A new player meets the Threshold first, as in the browser.
    await expect(page.getByRole('heading', { name: 'Step up to the glass' })).toBeVisible();
    await page.waitForFunction(() => (window as any).__spellglass.app.spellbook?.spells.length === 27);

    const win = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return { title: w.getTitle(), visible: w.isVisible(), size: w.getSize(), min: w.getMinimumSize(), background: w.getBackgroundColor() };
    });
    expect(win.title).toBe('Spellglass');
    expect(win.visible).toBe(true);
    expect(win.background.toUpperCase()).toBe('#0F1424');
    expect(win.min[0]).toBeGreaterThan(0);
    expect(win.size[0]).toBeGreaterThanOrEqual(win.min[0]);

    const page_ = await page.evaluate(async () => {
      let workers = 'none';
      try {
        workers = String((await navigator.serviceWorker?.getRegistrations())?.length ?? 'none');
      } catch {
        workers = 'refused';
      }
      return { secure: isSecureContext, origin: location.origin, subtle: typeof crypto.subtle?.digest, workers, controller: !!navigator.serviceWorker?.controller };
    });
    // A secure context with an origin of its own, and no service worker (the desktop app carries its files).
    expect(page_).toMatchObject({ secure: true, origin: 'app://spellglass', subtle: 'function', controller: false });
    expect(['0', 'none', 'refused']).toContain(page_.workers);

    // A second launch with the same user data brings this window forward and leaves at once.
    const executable = createRequire(import.meta.url)('electron') as string;
    const second = spawn(executable, appArgs({ userData }), { env: electronEnv(), stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the second instance did not leave')), 30_000);
      second.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(0);
    expect(app.windows()).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('casts Lumos with the mouse, and no request leaves the app origin (Section 11.2)', async () => {
  const { app, page } = await launch({ userData: tempDir('spellglass-desktop-') });
  try {
    const errors = watchErrors(page);
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    // Load again with the listener in place, so every request of a whole start is seen.
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__spellglass);
    await prepare(page, MOUSE);
    await draw(page, LUMOS, 260);
    await waitForCasts(page, ['lumos']);
    await expect(page.locator('.banner-slot')).toContainText('Lumos');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(OUTPUT, 'desktop-lumos.png') });

    expect(requests.length).toBeGreaterThan(5);
    expect(requests.filter((u) => !/^(app:\/\/spellglass\/|data:|blob:)/.test(u))).toEqual([]);
    expect((await refused(app)).requests).toEqual([]);
    expect(await casts(page)).toEqual(['lumos']);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('uses no network at all, from its first moment: no lookup, no socket, no proxy detection', async () => {
  const dir = tempDir('spellglass-desktop-net-');
  const netLog = join(dir, 'net-log.json');
  const { app, page } = await launch({ userData: join(dir, 'user-data'), extraArgs: [`--log-net-log=${netLog}`] });
  try {
    await prepare(page, MOUSE);
    await draw(page, LUMOS, 260);
    await waitForCasts(page, ['lumos']);
    await page.waitForTimeout(2000);
  } finally {
    await closeApp(app);
  }
  // Chromium's own record of the network (without --no-proxy-server: WPAD over DHCP, a lookup of
  // "wpad" and a UDP socket at every start).
  const events = netLogEvents(netLog);
  expect(events.length).toBeGreaterThan(0);
  expect(events.filter((e) => NETWORK_USE.test(e))).toEqual([]);
});

test('keeps the page to its own origin: requests, navigation, windows and permissions', async () => {
  // Fake devices but the real prompts, so every media request reaches the main process's handler.
  const { app, page } = await launch({ userData: tempDir('spellglass-desktop-'), extraArgs: ['--use-fake-device-for-media-stream'] });
  try {
    // The main process refuses a request off the origin even when no page policy stands in the way.
    const load = await app.evaluate(async ({ BrowserWindow }) => {
      const w = new BrowserWindow({ show: false });
      try {
        await w.loadURL('https://example.com/');
        return 'loaded';
      } catch (err) {
        return String((err as { code?: string }).code ?? err);
      } finally {
        w.destroy();
      }
    });
    expect(load).toContain('ERR_BLOCKED_BY_CLIENT');
    expect((await refused(app)).requests).toContain('https://example.com/');

    // Web links would go to the system browser: caught here instead of opening one.
    const external = await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as any).__opened = opened;
      try {
        shell.openExternal = async (url: string) => {
          opened.push(url);
        };
      } catch {
        return false;
      }
      return (shell.openExternal as unknown as { toString(): string }).toString().includes('opened.push');
    });
    if (external) {
      expect(await page.evaluate(() => window.open('https://example.com/a', '_blank'))).toBeNull();
      await expect.poll(() => app.evaluate(() => (globalThis as any).__opened as string[])).toEqual(['https://example.com/a']);
    }

    // window.open never makes a window of the page's own; nothing else navigates the window away, and
    // no address of the app but its own page can be loaded into it (a missing one would leave a bare
    // "Not found" with no way back).
    expect(await page.evaluate(() => window.open('about:blank'))).toBeNull();
    for (const target of ['app://elsewhere/', 'file:///C:/Windows/win.ini', 'app://spellglass/../../package.json', 'app://spellglass/no-such-page', '/tools/tip-finder.html']) {
      await page.evaluate((url) => {
        location.href = url;
      }, target);
      await page.waitForTimeout(500);
      expect(page.url()).toBe('app://spellglass/');
    }
    // The page is untouched. Checked through the DOM: after a navigation the main process cancels,
    // Playwright keeps waiting for it to finish (Electron reports no end to it), so a locator that
    // waits for navigations would never resolve, although the page is loaded and unchanged.
    await expect.poll(() => page.evaluate(() => ({ ready: document.readyState, heading: document.querySelector('h2')?.textContent?.trim() }))).toEqual({ ready: 'complete', heading: 'Step up to the glass' });
    if (external) {
      await page.evaluate(() => {
        location.href = 'https://example.com/b';
      });
      await expect.poll(() => app.evaluate(() => (globalThis as any).__opened as string[])).toContain('https://example.com/b');
      expect(page.url()).toBe('app://spellglass/');
    }
    const r = await refused(app);
    expect(r.windows).toContain('about:blank');
    // (Chromium refuses file:// from this page before the guard hears of it.)
    expect(r.navigations).toEqual(expect.arrayContaining(['app://elsewhere/', 'app://spellglass/package.json', 'app://spellglass/no-such-page', 'app://spellglass/tools/tip-finder.html']));
    expect(app.windows()).toHaveLength(1);

    // The tip finder, one of the app's own pages, opens in a window of its own, and stays on its page.
    const finder = app.waitForEvent('window');
    await page.evaluate(() => window.open('/tools/tip-finder.html', '_blank', 'noopener'));
    const tool = await finder;
    await tool.waitForLoadState('domcontentloaded');
    expect(tool.url()).toBe('app://spellglass/tools/tip-finder.html');
    await expect(tool).toHaveTitle(/Tip finder/);
    await tool.evaluate(() => {
      location.href = '/';
    });
    await tool.waitForTimeout(500);
    expect(tool.url()).toBe('app://spellglass/tools/tip-finder.html');
    await tool.close();

    // The camera, yes, as far as the computer's own setting allows; the microphone never (the desktop
    // app has no voice); location and notifications, no.
    const system = await app.evaluate(({ systemPreferences }) =>
      typeof systemPreferences.getMediaAccessStatus === 'function' ? systemPreferences.getMediaAccessStatus('camera') : 'granted',
    );
    const cameraOff = system === 'denied' || system === 'restricted';
    // A Mac that has never been asked would show its prompt here, with no one to answer it.
    const openCamera = !(process.platform === 'darwin' && system === 'not-determined');
    const permissions = await page.evaluate(async (tryCamera) => {
      const state = async (name: string) => (await navigator.permissions.query({ name: name as PermissionName })).state;
      const open = (constraints: MediaStreamConstraints) =>
        navigator.mediaDevices.getUserMedia(constraints).then(
          (s) => {
            s.getTracks().forEach((t) => t.stop());
            return 'opened';
          },
          (e: DOMException) => e.name,
        );
      return {
        camera: await state('camera'),
        microphone: await state('microphone'),
        openMicrophone: await open({ audio: true }),
        openBoth: await open({ audio: true, video: true }),
        openCamera: tryCamera ? await open({ video: true }) : 'not tried',
        geolocation: await state('geolocation'),
        notifications: await Notification.requestPermission(),
      };
    }, openCamera);
    expect(permissions).toEqual({
      camera: cameraOff ? 'denied' : 'granted',
      microphone: 'denied',
      openMicrophone: 'NotAllowedError',
      openBoth: 'NotAllowedError',
      openCamera: openCamera ? (cameraOff ? 'NotAllowedError' : 'opened') : 'not tried',
      geolocation: 'denied',
      notifications: 'denied',
    });
    expect((await refused(app)).permissions).toContain('media');

    // Each file with its type; 404 for what is missing or outside dist/.
    const files = await page.evaluate(async () => {
      const type = async (url: string) => {
        const res = await fetch(url);
        return `${res.status} ${res.headers.get('content-type')}`;
      };
      const script = (document.querySelector('script[type="module"]') as HTMLScriptElement).src;
      // A font the stylesheet names.
      let font: string | undefined;
      for (const sheet of [...document.styleSheets]) {
        for (const rule of [...sheet.cssRules]) {
          const m = rule instanceof CSSFontFaceRule ? /url\("?([^")]+\.woff2)"?\)/.exec(rule.style.getPropertyValue('src')) : null;
          if (m && !font) font = new URL(m[1], sheet.href ?? location.href).href;
        }
      }
      return {
        script: await type(script),
        json: await type('/packs/index.json'),
        svg: await type('/icons/icon.svg'),
        font: font ? await type(font) : 'no font loaded',
        missing: (await fetch('/no-such-file.js')).status,
        climb: (await fetch('/..%2f..%2fpackage.json')).status,
        dots: (await fetch('app://spellglass/%2e%2e/%2e%2e/package.json')).status,
      };
    });
    expect(files).toEqual({
      script: '200 text/javascript; charset=utf-8',
      json: '200 application/json; charset=utf-8',
      svg: '200 image/svg+xml',
      font: '200 font/woff2',
      missing: 404,
      climb: 404,
      dots: 404,
    });
    const models = await page.evaluate(async () => {
      const res = await fetch('/models/hand_landmarker.task', { method: 'HEAD' });
      const wasm = await fetch('/models/wasm/vision_wasm_module_internal.wasm', { method: 'HEAD' });
      return { task: `${res.status} ${res.headers.get('content-type')}`, wasm: `${wasm.status} ${wasm.headers.get('content-type')}` };
    });
    // The hand model is there when `npm run models` ran before the build.
    if (models.task.startsWith('200')) {
      expect(models).toEqual({ task: '200 application/octet-stream', wasm: '200 application/wasm' });
    }

    const fullScreen = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen());
    // An element of the page may go full screen (the request needs a click, as in a browser), and
    // the request settles rather than hanging.
    const html = await app.evaluate(async ({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      const run = (code: string) => contents.executeJavaScript(code, true);
      const settle = (promise: string) => `Promise.race([${promise}, new Promise((r) => setTimeout(() => r('still waiting'), 5000))])`;
      const entered = await run(settle(`document.documentElement.requestFullscreen().then(() => 'entered', (e) => 'refused: ' + e.message)`));
      const element = await run('document.fullscreenElement === document.documentElement');
      const left = await run(settle(`document.exitFullscreen().then(() => 'left', (e) => 'stuck: ' + e.message)`));
      return { entered, element, left };
    });
    expect(html).toEqual({ entered: 'entered', element: true, left: 'left' });
    await expect.poll(fullScreen).toBe(false);

    // F11 toggles full screen. (Sent as the system would send it: Playwright's own key presses skip
    // the main process.)
    const f11 = () =>
      app.evaluate(({ BrowserWindow }) => {
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        contents.sendInputEvent({ type: 'keyDown', keyCode: 'F11' });
        contents.sendInputEvent({ type: 'keyUp', keyCode: 'F11' });
      });
    await f11();
    await expect.poll(fullScreen).toBe(true);
    await f11();
    await expect.poll(fullScreen).toBe(false);
  } finally {
    await closeApp(app);
  }
});

test('a page that crashes is loaded again', async () => {
  const { app } = await launch({ userData: tempDir('spellglass-desktop-') });
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer());
    // There is no reload key or menu: the main process loads the page again by itself.
    await expect
      .poll(
        () =>
          app.evaluate(async ({ BrowserWindow }) => {
            const contents = BrowserWindow.getAllWindows()[0].webContents;
            if (contents.isCrashed() || contents.isLoading()) return false;
            return contents.executeJavaScript('!!window.__spellglass?.app.spellbook').catch(() => false);
          }),
        { timeout: 30_000 },
      )
      .toBe(true);
  } finally {
    await closeApp(app);
  }
});

test('voice is plainly absent, the Workshop speaks of the computer, and what needs a web address is left out', async () => {
  const { app, page } = await launch({ userData: tempDir('spellglass-desktop-') });
  try {
    const errors = watchErrors(page);
    await prepare(page, MOUSE);
    const voice = await page.evaluate(() => {
      const { kernel } = (window as any).__spellglass;
      return { api: typeof (window as any).SpeechRecognition, prefixed: typeof (window as any).webkitSpeechRecognition, module: kernel.modules().find((m: any) => m.manifest.kind === 'voice')?.state };
    });
    expect(voice).toEqual({ api: 'undefined', prefixed: 'undefined', module: 'unavailable' });

    await page.evaluate(() => (window as any).__spellglass.app.go('workshop'));
    const voiceSection = page.locator('section[aria-labelledby="ws-voice-title"]');
    await expect(voiceSection.getByText('Voice recognition is not available in the desktop app. To cast by voice, play Spellglass in Chrome or Edge.')).toBeVisible();
    await expect(voiceSection).toContainText('it never uses the microphone');
    await expect(voiceSection.getByRole('checkbox')).toHaveCount(0);
    // The casting modes that listen cannot be chosen; Gesture can.
    for (const name of ['Assisted', 'Strict', 'Voice only']) await expect(page.getByRole('radio', { name: new RegExp(`^${name}`) })).toBeDisabled();
    await expect(page.getByRole('radio', { name: /^Gesture/ })).toBeEnabled();
    // Asking for voice anyway changes nothing and breaks nothing.
    await page.evaluate(() => (window as any).__spellglass.kernel.request('settings.set', { key: 'voice.enabled', value: true }));
    await page.waitForTimeout(500);

    // Your data: kept on this computer, and made safe from being cleared at the start (src/main.ts).
    await page.getByRole('tab', { name: 'Your data' }).click();
    const storage = page.locator('section[aria-labelledby="ws-storage-title"]');
    await expect(storage).toContainText('Safe when space runs low');
    await expect(storage).toContainText('Yes: it is never cleared to free space.');
    await expect(storage).toContainText(/Spellglass may use on this computer/);
    await expect(storage).not.toContainText(/browser/i);
    await page.getByRole('tab', { name: 'Diagnostics' }).click();
    await expect(page.getByText('Needs speech recognition, which the desktop app does not have.')).toBeVisible();

    await page.evaluate(() => (window as any).__spellglass.app.go('mirror'));
    await expect(page.getByRole('button', { name: /Open spellbook/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'QR code for this app' })).toHaveCount(0);

    await draw(page, LUMOS, 260);
    await waitForCasts(page, ['lumos']);
    await page.evaluate(() => (window as any).__spellglass.app.go('keepsakes'));
    await expect(page.getByRole('button', { name: 'Watch again' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save a card' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Share this cast' })).toHaveCount(0);
    await expect(page.getByText('This copy of Spellglass has no web address for replay links.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Share Spellglass' })).toHaveCount(0);

    // A card goes to the Downloads folder without a dialog, as the app's words say.
    const downloads = tempDir('spellglass-downloads-');
    await app.evaluate(({ app: a }, dir) => a.setPath('downloads', dir), downloads);
    await page.getByRole('button', { name: 'Save a card' }).click();
    await expect(page.getByRole('dialog', { name: 'Keepsakes' }).getByText(/Card saved to your downloads as .+\.png/)).toBeVisible();
    await expect.poll(() => readdirSync(downloads).filter((f) => f.endsWith('.png'))).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('progress survives closing the window and opening the app again', async () => {
  const userData = tempDir('spellglass-desktop-progress-');
  const first = await launch({ userData });
  try {
    const { page } = first;
    // The first run, as a new player takes it.
    await page.getByRole('button', { name: /Mouse or touch/ }).click();
    await page.getByRole('button', { name: 'Start casting' }).click();
    await expect(page.getByRole('button', { name: /Open spellbook/ })).toBeVisible();
    await prepare(page);
    await draw(page, LUMOS, 260);
    await waitForCasts(page, ['lumos']);
    const guide = page.getByRole('complementary', { name: 'Spell guide' });
    const lumos = guide.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^Lumos/ }) });
    await expect(lumos).toContainText('1 of 3');
    // Let the save land before the window goes.
    await page.waitForTimeout(1500);
  } finally {
    if (process.platform === 'darwin') {
      await closeApp(first.app);
    } else {
      // Closing the window quits the app (macOS keeps apps open without a window).
      const closed = first.app.waitForEvent('close');
      await first.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
      await closed;
    }
  }

  const again = await launch({ userData });
  try {
    const { page } = again;
    // Straight to the Mirror: the Threshold is done, Lumos is one cast along, the keepsake is kept.
    await expect(page.getByRole('button', { name: /Open spellbook/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Step up to the glass' })).toHaveCount(0);
    const guide = page.getByRole('complementary', { name: 'Spell guide' });
    await expect(guide.getByRole('listitem').filter({ has: page.getByRole('button', { name: /^Lumos/ }) })).toContainText('1 of 3');
    const kept = await page.evaluate(async () => {
      const { kernel, app } = (window as any).__spellglass;
      const list = await kernel.request('keepsakes.list', { limit: 10 });
      return { tracker: app.settings['tracker.active'], keepsakes: list.map((k: any) => k.cast.spellId) };
    });
    expect(kept).toEqual({ tracker: 'tracker.pointer', keepsakes: ['lumos'] });
  } finally {
    await closeApp(again.app);
  }
});

test('the bright tip follows a fake camera and casts (routes A and C)', async () => {
  test.setTimeout(180_000);
  const dir = tempDir('spellglass-desktop-clip-');
  const clip = join(dir, 'clip.y4m');
  writeY4m(clip, { width: 640, height: 360 });
  const { app, page } = await launch({ userData: tempDir('spellglass-desktop-'), fakeCamera: clip });
  try {
    const errors = watchErrors(page);
    await prepare(page, { 'spells.unlockAll': true, 'app.onboarded': true, 'capture.consent': true, 'capture.mirror': true, 'tracker.active': 'tracker.bright-tip' });
    await page.waitForFunction(
      () => ((window as any).__seen as { type: string; p: any }[]).some((e) => e.type === 'camera.status' && e.p.state === 'on'),
      null,
      { timeout: 30_000 },
    );
    // The clip traces Lumos, Wingardium Leviosa, Protego and Stupefy, and Chrome loops it.
    await waitForCasts(page, ['lumos', 'stupefy'], 120_000);
    const status = (await seen(page, 'tracker.status')).filter((e) => e.p.tracker === 'tracker.bright-tip').pop();
    expect(status?.p.state).not.toBe('error');
    expect((await refused(app)).requests).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('the hand tracker loads its model from the app and runs (route B)', async () => {
  test.setTimeout(150_000);
  test.skip(!existsSync(join(ROOT, 'dist', 'models', 'hand_landmarker.task')), 'No hand model in dist/models: run npm run models, then build.');
  const { app, page } = await launch({ userData: tempDir('spellglass-desktop-'), fakeCamera: true });
  try {
    const errors = watchErrors(page);
    const requests: string[] = [];
    page.on('request', (r) => requests.push(r.url()));
    await prepare(page, { 'app.onboarded': true, 'capture.consent': true, 'tracker.active': 'tracker.hand' });
    // Chrome's fake camera shows no hand, so the tracker searches: the model and its WebAssembly run.
    await page.waitForFunction(
      () => ((window as any).__seen as { type: string; p: any }[]).some((e) => e.type === 'tracker.status' && e.p.tracker === 'tracker.hand' && (e.p.state === 'searching' || e.p.state === 'tracking')),
      null,
      { timeout: 90_000 },
    );
    const states = (await seen(page, 'tracker.status')).filter((e) => e.p.tracker === 'tracker.hand').map((e) => e.p.state);
    expect(states).not.toContain('error');
    // Closing the task is when MediaPipe's usage logger would post to Google: the worker refuses it.
    await page.evaluate(() => (window as any).__spellglass.kernel.request('settings.set', { key: 'tracker.active', value: 'tracker.pointer' }));
    await page.waitForTimeout(2000);
    expect(requests.filter((u) => !/^(app:\/\/spellglass\/|data:|blob:)/.test(u))).toEqual([]);
    expect((await refused(app)).requests).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('the packaged app opens, loads the spellbook and casts (test build)', async () => {
  const executablePath = testBuildApp();
  test.skip(!executablePath, 'No test build in release/test/: run npm run desktop:win -- --test-build (or desktop:mac -- --test-build on a Mac) first.');
  const { app, page } = await launch({ userData: tempDir('spellglass-packaged-'), executablePath: executablePath! });
  try {
    const errors = watchErrors(page);
    const info = await app.evaluate(({ app: a, BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      // Packaged builds have no developer tools unless SPELLGLASS_DEVTOOLS=1.
      w.webContents.openDevTools();
      return { packaged: a.isPackaged, name: a.getName(), version: a.getVersion(), devTools: w.webContents.isDevToolsOpened(), title: w.getTitle() };
    });
    expect(info).toMatchObject({ packaged: true, name: 'Spellglass', title: 'Spellglass' });
    expect(info.devTools).toBe(process.env.SPELLGLASS_DEVTOOLS === '1');
    expect(page.url()).toBe('app://spellglass/');
    await page.waitForFunction(() => (window as any).__spellglass.app.spellbook?.spells.length === 27);
    await page.screenshot({ path: join(OUTPUT, 'packaged-threshold.png') });
    await prepare(page, MOUSE);
    await draw(page, LUMOS, 260);
    await waitForCasts(page, ['lumos']);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(OUTPUT, 'packaged-lumos.png') });
    expect((await refused(app)).requests).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await closeApp(app);
  }
});

test('the release build ignores the debugging switches, and uses no network from its first moment', async () => {
  test.setTimeout(120_000);
  const executable = releaseApp();
  test.skip(!executable, 'No release build in release/: run npm run desktop:win (or desktop:mac on a Mac) first.');
  const dir = tempDir('spellglass-release-');
  const userData = join(dir, 'user-data');
  const netLog = join(dir, 'net-log.json');
  // As a double-click starts it, plus the switches that would open it to other programs: Node's
  // inspector (the fuse makes Electron ignore it) and Chromium's remote debugging (main.mjs drops it).
  const app = start(executable!, [`--spellglass-user-data=${userData}`, ...NO_GPU, '--inspect=0', '--remote-debugging-port=0', `--log-net-log=${netLog}`]);
  try {
    await expect.poll(() => pageStarted(userData), { timeout: 60_000 }).toBe(true);
    await new Promise((r) => setTimeout(r, 3000));
    expect(app.child.exitCode).toBeNull();
    expect(app.output()).not.toMatch(/Debugger listening|DevTools listening/);
    const code = await closeStarted(app);
    if (process.platform === 'win32') expect(code).toBe(0);
  } finally {
    if (app.child.exitCode === null && app.child.signalCode === null) app.child.kill();
  }
  expect(netLogEvents(netLog).filter((e) => NETWORK_USE.test(e))).toEqual([]);
});

test('the portable .exe: a second double-click hands over, and copies left behind are cleared (Windows)', async () => {
  test.setTimeout(420_000);
  const exe = portableExe();
  test.skip(!exe, 'No portable .exe in release/: run npm run desktop:win first (Windows only).');
  const userArg = (name: string) => `--spellglass-user-data=${tempDir(`spellglass-portable-${name}-`)}`;
  const argA = userArg('a');
  const exited = (child: ChildProcess, ms: number) =>
    new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the launcher did not finish')), ms);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  const parts = ['Spellglass.exe', 'resources/app.asar', 'v8_context_snapshot.bin', 'locales/en-US.pak', 'resources.pak'];
  const launchers: ChildProcess[] = [];
  const fakes: string[] = [];
  try {
    // As a double-click starts it: the launcher unpacks the app into a temporary folder and runs it.
    const first = spawn(exe!, [argA], { env: electronEnv(), stdio: 'ignore' });
    launchers.push(first);
    await expect.poll(() => spellglassWindows().length, { timeout: 120_000, intervals: [500] }).toBe(1);
    const firstOpenedAt = Date.now();
    const [open] = spellglassWindows();
    const folder = dirname(open.Path);
    const unpacked = dirname(folder);
    const temp = dirname(unpacked);
    expect(parts.filter((p) => !existsSync(join(folder, p)))).toEqual([]);

    // The second double-click unpacks a copy of its own, which hands over to the open window and
    // leaves; the open copy keeps every file it runs from.
    const second = spawn(exe!, [argA], { env: electronEnv(), stdio: 'ignore' });
    launchers.push(second);
    expect(await exited(second, 120_000)).toBe(0);
    expect(spellglassWindows().map((w) => w.Id)).toEqual([open.Id]);
    expect(parts.filter((p) => !existsSync(join(folder, p)))).toEqual([]);

    // Copies left behind (a launcher ended in Task Manager, a shutdown while Spellglass was open) are
    // removed by the next start, but never one a Spellglass runs from, nor one still being unpacked,
    // nor anything that is not Spellglass's. The open copy is made to look as old as a left one. The
    // fakes sort after every real folder, so once the stale one is gone the open one was looked at.
    // First the open copy's own look (10 s after it starts) is let pass, so the next start does it.
    await new Promise((r) => setTimeout(r, Math.max(0, firstOpenedAt + 20_000 - Date.now())));
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    const fake = (name: string, exeName: string, old: boolean) => {
      const dir = join(temp, name);
      if (existsSync(dir)) throw new Error(`${dir} is already there`);
      fakes.push(dir);
      mkdirSync(join(dir, 'app', 'resources'), { recursive: true });
      writeFileSync(join(dir, 'app', exeName), 'MZ');
      writeFileSync(join(dir, 'app', 'resources', 'app.asar'), 'not really');
      if (old) for (const d of [join(dir, 'app'), dir]) utimesSync(d, hourAgo, hourAgo);
      return dir;
    };
    const foreign = fake('nszfffd.tmp', 'Other.exe', true);
    const unpacking = fake('nszfffe.tmp', 'Spellglass.exe', false);
    const stale = fake('nszffff.tmp', 'Spellglass.exe', true);
    for (const d of [folder, unpacked]) utimesSync(d, hourAgo, hourAgo);

    // A start for another player (a user data folder of its own) is a second Spellglass, which
    // looks for left copies a few seconds after it opens.
    const third = spawn(exe!, [userArg('c')], { env: electronEnv(), stdio: 'ignore' });
    launchers.push(third);
    await expect.poll(() => existsSync(stale), { timeout: 120_000, intervals: [1000] }).toBe(false);
    expect(readdirSync(temp).filter((n) => n.startsWith('spellglass-left-'))).toEqual([]);
    expect(parts.filter((p) => !existsSync(join(folder, p)))).toEqual([]);
    expect(existsSync(join(unpacking, 'app', 'Spellglass.exe'))).toBe(true);
    expect(existsSync(join(foreign, 'app', 'Other.exe'))).toBe(true);
    const windows = spellglassWindows();
    expect(windows).toHaveLength(2);
    const other = windows.find((w) => w.Id !== open.Id)!;
    closeWindowOf(other.Id);
    expect(await exited(third, 60_000)).toBe(0);
    expect(spellglassWindows().map((w) => w.Id)).toEqual([open.Id]);

    // Closing the window ends the launcher too, and it takes its temporary folder away.
    closeWindowOf(open.Id);
    expect(await exited(first, 60_000)).toBe(0);
    await expect.poll(() => existsSync(folder), { timeout: 15_000 }).toBe(false);
  } finally {
    for (const child of launchers) {
      if (child.exitCode === null && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    for (const dir of fakes) rmSync(dir, { recursive: true, force: true });
  }
});
