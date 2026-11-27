// @ts-check
// Spellglass as a desktop app: the Electron main process. Plain ESM, so nothing is compiled.
//
// It serves the production web build (dist/, from `npm run build`) at app://spellglass/ through a
// privileged protocol (protocol.mjs), opens one window on it, and holds the page to what the web app
// does in Chrome, minus the network (policy.mjs): no request leaves the app's origin, the camera is the
// only permission that matters, nothing navigates away and no page opens a window by itself. The page
// knows it is the desktop app from location.protocol (src/main.ts).
//
// Switches, for development and the tests in tests/desktop (harmless to anyone else):
//   --spellglass-user-data=<dir>       keep settings, progress and keepsakes in <dir> instead of the
//                                      usual folder (%APPDATA%\Spellglass, ~/Library/Application
//                                      Support/Spellglass)
//   --spellglass-fake-camera[=<clip>]  Chrome's fake camera, with every media prompt answered and the
//                                      computer's own camera setting left out; <clip> is a .y4m video
//                                      to play as the camera
// Environment:
//   SPELLGLASS_DEVTOOLS=1              allow the developer tools (F12) in a packaged build. A run from
//                                      the project (npm run desktop) always allows them.

import { app, BrowserWindow, Menu, protocol, screen, session, shell, systemPreferences } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowPermission, allowPermissionCheck, appPage, isAllowedRequest, navigationVerdict, systemCameraVerdict, windowOpenVerdict } from './policy.mjs';
import { ownUnpackFolder, removeLeftCopies } from './portable.mjs';
import { APP_URL, SCHEME, SCHEME_PRIVILEGES, createFileHandler } from './protocol.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The web build sits beside this folder: in the project, and inside the packaged app.asar alike. */
const DIST = path.join(here, '..', 'dist');
const TITLE = 'Spellglass';
/** The app's night blue (the manifest's background_color in vite.config.ts), shown before the page draws. */
const BACKGROUND = '#0F1424';
const devTools = !app.isPackaged || process.env.SPELLGLASS_DEVTOOLS === '1';
/** A packaged build made for the tests that drive it (electron-builder.config.mjs, SPELLGLASS_TEST_BUILD=1). */
const testBuild = app.isPackaged && readPackage().spellglassTestBuild === true;
/** How long after the start the portable app clears copies left by earlier launches (portable.mjs). */
const CLEANUP_DELAY_MS = 10_000;

/** The app's package.json (inside app.asar when packaged). @returns {Record<string, unknown>} */
function readPackage() {
  try {
    return JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

/** What the main process refused, for the tests (they read it with electronApp.evaluate). */
const refused = {
  requests: /** @type {string[]} */ ([]),
  permissions: /** @type {string[]} */ ([]),
  windows: /** @type {string[]} */ ([]),
  navigations: /** @type {string[]} */ ([]),
};
Object.defineProperty(globalThis, '__spellglassDesktop', { value: Object.freeze({ refused }), configurable: true });

/** Keep the latest entries only. @param {string[]} list @param {string} item */
function remember(list, item) {
  list.push(item);
  if (list.length > 200) list.splice(0, list.length - 200);
}

const noted = new Set();
/** One line per refused origin, so anyone watching the console sees why nothing left. @param {string} what @param {string} url */
function note(what, url) {
  let key = url;
  try {
    const u = new URL(url);
    key = u.host ? `${u.protocol}//${u.host}` : u.protocol;
  } catch {
    /* keep the text */
  }
  if (noted.has(`${what} ${key}`)) return;
  noted.add(`${what} ${key}`);
  console.warn(`[spellglass] refused ${what}: ${key}`);
}

// ------------------------------------------------------------------------------- before ready

app.setName(TITLE);
const userData = app.commandLine.getSwitchValue('spellglass-user-data');
app.setPath('userData', userData ? path.resolve(userData) : path.join(app.getPath('appData'), TITLE));

// Section 11.2 at the network's edge: no proxy. Without this, Chromium looks for one at every start
// (Windows' "Automatically detect settings"): WPAD over DHCP, a DNS lookup for "wpad", and a fetch of
// http://wpad/wpad.dat should a machine on the network answer. The app has nothing to send anywhere.
app.commandLine.appendSwitch('no-proxy-server');

// A release build takes no debugging switches. Electron's fuses (electron-builder.config.mjs) already
// make it ignore --inspect and the like; this drops Chromium's remote debugging, which would let any
// program drive the page. A run from the project (npm run desktop) and the test build keep both.
if (app.isPackaged && !testBuild) {
  for (const name of ['remote-debugging-port', 'remote-debugging-pipe']) {
    if (app.commandLine.hasSwitch(name)) app.commandLine.removeSwitch(name);
  }
}

const fakeCamera = app.commandLine.hasSwitch('spellglass-fake-camera');
if (fakeCamera) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  const clip = app.commandLine.getSwitchValue('spellglass-fake-camera');
  if (clip) app.commandLine.appendSwitch('use-file-for-fake-video-capture', path.resolve(clip));
}

protocol.registerSchemesAsPrivileged([SCHEME_PRIVILEGES]);

// A second launch (a double-click while Spellglass is open) brings the open window forward instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
  app.on('web-contents-created', (_event, contents) => {
    // No <webview>, and no window a page opens by itself (guard() refines this for app windows).
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (windowOpenVerdict(url) === 'external') void shell.openExternal(url);
      return { action: 'deny' };
    });
  });
  app.on('window-all-closed', () => {
    // macOS apps stay in the Dock with no window open; elsewhere closing the window quits.
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (app.isReady() && BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  app.whenReady().then(ready, (err) => {
    console.error('[spellglass] could not start', err);
    app.exit(1);
  });
}

// ------------------------------------------------------------------------------- ready

function ready() {
  if (!existsSync(path.join(DIST, 'index.html'))) {
    console.error(`[spellglass] ${path.join(DIST, 'index.html')} is missing. Run npm run build first.`);
  }
  protocol.handle(SCHEME, createFileHandler(DIST));
  secure(session.defaultSession);
  setMenu();
  createMainWindow();
  clearLeftCopies();
}

/** The portable .exe only: remove the copies earlier launches could not (portable.mjs). */
function clearLeftCopies() {
  const own = ownUnpackFolder(process.execPath, process.env);
  if (!own) return;
  setTimeout(() => {
    removeLeftCopies(own).then(
      ({ removed, inUse }) => {
        if (removed.length) console.info(`[spellglass] removed ${removed.length} copies left by earlier starts`);
        if (inUse.length) console.info(`[spellglass] left ${inUse.length} copies that are running`);
      },
      () => undefined,
    );
  }, CLEANUP_DELAY_MS);
}

/**
 * The computer's own camera setting, on top of policy.mjs (systemCameraVerdict): 'deny' when the
 * player turned the camera off for Spellglass (macOS) or for desktop apps (Windows), 'ask' when macOS
 * has not asked yet. The fake camera of the tests needs no camera, and Linux has no such setting.
 * @returns {'allow' | 'deny' | 'ask'}
 */
function systemCamera() {
  if (fakeCamera || typeof systemPreferences.getMediaAccessStatus !== 'function') return 'allow';
  try {
    return systemCameraVerdict(systemPreferences.getMediaAccessStatus('camera'), process.platform);
  } catch {
    return 'allow';
  }
}

/** @param {Electron.Session} ses */
function secure(ses) {
  // Section 11.2: only the app's own origin. Covers every page and worker, whatever its own policy says.
  ses.webRequest.onBeforeRequest((details, callback) => {
    const ok = isAllowedRequest(details.url);
    if (!ok) {
      remember(refused.requests, details.url);
      note('a request', details.url);
    }
    callback({ cancel: !ok });
  });
  ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
    const url = /** @type {any} */ (details).requestingUrl ?? '';
    if (!allowPermission(permission, /** @type {any} */ (details))) {
      remember(refused.permissions, permission);
      note(`the ${permission} permission`, url);
      callback(false);
      return;
    }
    if (permission !== 'media') {
      callback(true);
      return;
    }
    // The camera. On a Mac that has not asked yet, its prompt comes first, so the page opens the camera
    // only once the player has answered; a refusal reaches the page as NotAllowedError, which the app
    // words as a block in the computer's privacy settings.
    const verdict = systemCamera();
    if (verdict === 'allow') callback(true);
    else if (verdict === 'ask') systemPreferences.askForMediaAccess('camera').then(callback, () => callback(false));
    else {
      remember(refused.permissions, 'media (camera off in the computer\'s settings)');
      note('the camera, which the computer\'s privacy settings block', url);
      callback(false);
    }
  });
  ses.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if (!allowPermissionCheck(permission, requestingOrigin, /** @type {any} */ (details))) return false;
    return permission !== 'media' || systemCamera() !== 'deny';
  });
  // No USB, HID, serial or Bluetooth devices.
  ses.setDevicePermissionHandler(() => false);
  // A card, a clip or an export goes to the Downloads folder, as in a browser (the app says so).
  ses.on('will-download', (_event, item) => {
    item.setSavePath(freePath(app.getPath('downloads'), item.getFilename()));
  });
}

/** `name` in `dir`, or "name (1).ext" and so on when that file exists. @param {string} dir @param {string} name */
function freePath(dir, name) {
  const safe = path.basename(name) || 'download';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let i = 1; existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

function setMenu() {
  if (process.platform !== 'darwin') {
    // No menu bar: F11 is full screen (guard()), Alt+F4 closes.
    Menu.setApplicationMenu(null);
    return;
  }
  // macOS: what every Mac app has. The Edit menu is what makes copy and paste work in text fields.
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const view = [{ role: 'togglefullscreen' }];
  if (devTools) view.push({ type: 'separator' }, { role: 'toggleDevTools' });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { label: 'View', submenu: view }, { role: 'windowMenu' }]),
  );
}

/** @type {Electron.WebPreferences} */
const WEB_PREFERENCES = {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false,
  // Spell checking would download dictionaries; nothing in Spellglass needs it.
  spellcheck: false,
  devTools,
};

/** @type {BrowserWindow | null} */
let main = null;

function mainWindow() {
  return main && !main.isDestroyed() ? main : null;
}

function createMainWindow() {
  const area = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1440, area.width),
    height: Math.min(900, area.height),
    minWidth: Math.min(900, area.width),
    minHeight: Math.min(600, area.height),
    title: TITLE,
    backgroundColor: BACKGROUND,
    // On macOS the bundle's icon is used; elsewhere this is the window's (an unpackaged run has no other).
    icon: process.platform === 'darwin' ? undefined : path.join(DIST, 'icons', 'icon-512.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: WEB_PREFERENCES,
  });
  main = win;
  guard(win, appPage(APP_URL));
  win.once('ready-to-show', () => win.show());
  // Should the page never draw, the window shows anyway rather than leave a double-click with nothing.
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, 8000);
  // Closing the main window closes Spellglass, the tip finder with it.
  win.on('closed', () => {
    main = null;
    for (const other of BrowserWindow.getAllWindows()) if (!other.isDestroyed()) other.close();
  });
  void win.loadURL(APP_URL);
  return win;
}

/** One of the app's own pages (the tip finder) in a window of its own, opened by the main process. @param {string} url */
function openAppWindow(url) {
  const open = BrowserWindow.getAllWindows().find((w) => w !== main && w.webContents.getURL() === url);
  if (open) {
    open.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    title: TITLE,
    backgroundColor: BACKGROUND,
    icon: process.platform === 'darwin' ? undefined : path.join(DIST, 'icons', 'icon-512.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: WEB_PREFERENCES,
  });
  guard(win, appPage(url));
  win.once('ready-to-show', () => win.show());
  void win.loadURL(url);
}

/**
 * Keys, navigation, new windows and crashes for one of the app's windows, which stays on `page` (a
 * path, as policy.mjs's appPage() gives it).
 * @param {BrowserWindow} win
 * @param {string} page
 */
function guard(win, page) {
  const contents = win.webContents;
  // There is no reload key: a page that crashes is loaded again, though not over and over.
  let reloadedAt = 0;
  contents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit' || win.isDestroyed() || Date.now() - reloadedAt < 60_000) return;
    reloadedAt = Date.now();
    console.error(`[spellglass] the page stopped (${details.reason}); loading it again`);
    contents.reload();
  });
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const plain = !input.control && !input.alt && !input.meta && !input.shift;
    if (input.key === 'F11' && plain) {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    } else if (devTools && (input.key === 'F12' || ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i'))) {
      contents.toggleDevTools();
      event.preventDefault();
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    const verdict = windowOpenVerdict(url);
    if (verdict === 'app-window') openAppWindow(url);
    else if (verdict === 'external') void shell.openExternal(url);
    else {
      remember(refused.windows, url);
      note('a window', url);
    }
    return { action: 'deny' };
  });
  /** @param {Electron.Event} event @param {string} url @param {boolean} userInitiated @param {string | null} where */
  const navigating = (event, url, userInitiated, where) => {
    const verdict = navigationVerdict(url, where);
    if (verdict === 'allow') return;
    event.preventDefault();
    if (verdict === 'external' && userInitiated) void shell.openExternal(url);
    else {
      remember(refused.navigations, url);
      note('a navigation', url);
    }
  };
  contents.on('will-navigate', (event, url) => navigating(event, url, true, page));
  contents.on('will-redirect', (event, url) => navigating(event, url, false, page));
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) navigating(event, event.url, false, null);
  });
}
