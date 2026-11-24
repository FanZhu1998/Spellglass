// What the desktop app's page may do (desktop/policy.mjs): requests, permissions, navigation and new
// windows. The Electron tests (desktop.spec.ts) check the same rules through the running app.
import { describe, expect, it } from 'vitest';
import { allowPermission, allowPermissionCheck, appPage, isAllowedRequest, isWebLink, navigationVerdict, systemCameraVerdict, windowOpenVerdict } from '../../desktop/policy.mjs';

const PAGE = 'app://spellglass/';

describe('requests (Section 11.2: only the app origin)', () => {
  it('lets the app reach its own files, data: and blob: URLs', () => {
    for (const url of [PAGE, 'app://spellglass/packs/index.json', 'app://spellglass/models/hand_landmarker.task', 'data:text/plain,hi', 'blob:app://spellglass/0c8f', 'devtools://devtools/bundled/inspector.html']) {
      expect(isAllowedRequest(url)).toBe(true);
    }
  });

  it('refuses everything that would leave the computer, and other local files', () => {
    for (const url of [
      'https://odml.pa.googleapis.com/v1/log',
      'http://localhost:4173/',
      'http://wpad/wpad.dat',
      'wss://example.com/socket',
      'ws://127.0.0.1:9222/',
      'file:///C:/Windows/win.ini',
      'ftp://example.com/',
      'app://other/',
      'chrome://gpu',
      '',
    ]) {
      expect(isAllowedRequest(url)).toBe(false);
    }
  });
});

describe('permissions', () => {
  it('grants the camera to the app, and nothing to anyone else', () => {
    expect(allowPermission('media', { requestingUrl: PAGE, mediaTypes: ['video'] })).toBe(true);
    expect(allowPermission('media', { requestingUrl: 'https://example.com/', mediaTypes: ['video'] })).toBe(false);
    expect(allowPermission('media', { mediaTypes: ['video'] })).toBe(false);
  });

  it('never grants the microphone: the desktop app has no voice', () => {
    expect(allowPermission('media', { requestingUrl: PAGE, mediaTypes: ['audio'] })).toBe(false);
    expect(allowPermission('media', { requestingUrl: PAGE, mediaTypes: ['video', 'audio'] })).toBe(false);
    expect(allowPermissionCheck('media', 'app://spellglass', { mediaType: 'audio' })).toBe(false);
  });

  it('refuses screen capture and everything else that reads or reaches out', () => {
    expect(allowPermission('media', { requestingUrl: PAGE, mediaTypes: [] })).toBe(false);
    expect(allowPermission('media', { requestingUrl: PAGE, mediaTypes: ['screen'] })).toBe(false);
    for (const p of ['geolocation', 'notifications', 'midi', 'midiSysex', 'display-capture', 'clipboard-read', 'openExternal', 'pointerLock', 'unknown', 'hid', 'serial', 'usb']) {
      expect(allowPermission(p, { requestingUrl: PAGE })).toBe(false);
    }
  });

  it('allows the quiet ones Chrome grants without asking: clipboard writes, durable storage, full screen', () => {
    expect(allowPermission('clipboard-sanitized-write', { requestingUrl: PAGE })).toBe(true);
    expect(allowPermission('persistent-storage', { requestingUrl: PAGE })).toBe(true);
    expect(allowPermission('fullscreen', { requestingUrl: PAGE })).toBe(true);
    expect(allowPermission('persistent-storage', { requestingUrl: 'https://example.com/' })).toBe(false);
    expect(allowPermission('fullscreen', { requestingUrl: 'https://example.com/' })).toBe(false);
  });

  it('answers checks the same way, by origin', () => {
    expect(allowPermissionCheck('media', 'app://spellglass', { mediaType: 'video' })).toBe(true);
    expect(allowPermissionCheck('media', '', { securityOrigin: 'app://spellglass', mediaType: 'video' })).toBe(true);
    expect(allowPermissionCheck('media', 'app://spellglass', { mediaType: 'unknown' })).toBe(false);
    expect(allowPermissionCheck('media', 'app://spellglass')).toBe(false);
    expect(allowPermissionCheck('media', 'https://example.com', { mediaType: 'video' })).toBe(false);
    expect(allowPermissionCheck('fullscreen', 'app://spellglass')).toBe(true);
    expect(allowPermissionCheck('geolocation', 'app://spellglass')).toBe(false);
    expect(allowPermissionCheck('notifications', 'app://spellglass')).toBe(false);
  });

  it("follows the computer's own camera setting, and lets macOS ask first", () => {
    expect(systemCameraVerdict('granted', 'darwin')).toBe('allow');
    expect(systemCameraVerdict('not-determined', 'darwin')).toBe('ask');
    expect(systemCameraVerdict('denied', 'darwin')).toBe('deny');
    expect(systemCameraVerdict('restricted', 'darwin')).toBe('deny');
    // Windows never asks: its answer is the switch for desktop apps.
    expect(systemCameraVerdict('denied', 'win32')).toBe('deny');
    expect(systemCameraVerdict('granted', 'win32')).toBe('allow');
    expect(systemCameraVerdict('not-determined', 'win32')).toBe('allow');
    expect(systemCameraVerdict('unknown', 'win32')).toBe('allow');
    expect(systemCameraVerdict(undefined, 'linux')).toBe('allow');
  });
});

describe('navigation and new windows', () => {
  it('names each page by its path', () => {
    expect(appPage('app://spellglass/')).toBe('/');
    expect(appPage('app://spellglass/index.html#cast=abc')).toBe('/');
    expect(appPage('app://spellglass/?x=1')).toBe('/');
    expect(appPage('app://spellglass/tools/tip-finder.html')).toBe('/tools/tip-finder.html');
    expect(appPage('app://spellglass/../../package.json')).toBe('/package.json');
  });

  it('keeps each window on its own page, and hands web links to the system browser', () => {
    expect(navigationVerdict('app://spellglass/', '/')).toBe('allow');
    expect(navigationVerdict('app://spellglass/#cast=abc', '/')).toBe('allow');
    expect(navigationVerdict('app://spellglass/index.html?x=1', '/')).toBe('allow');
    // Any other address of the app would leave a bare "Not found" (or another page) in the window.
    expect(navigationVerdict('app://spellglass/../../package.json', '/')).toBe('deny');
    expect(navigationVerdict('app://spellglass/no-such-page', '/')).toBe('deny');
    expect(navigationVerdict('app://spellglass/tools/tip-finder.html', '/')).toBe('deny');
    expect(navigationVerdict('app://spellglass/tools/tip-finder.html', '/tools/tip-finder.html')).toBe('allow');
    expect(navigationVerdict('app://spellglass/', '/tools/tip-finder.html')).toBe('deny');
    // A frame may show any page of the app.
    expect(navigationVerdict('app://spellglass/tools/tip-finder.html')).toBe('allow');
    expect(navigationVerdict('https://example.com/', '/')).toBe('external');
    expect(navigationVerdict('http://example.com/', '/')).toBe('external');
    expect(navigationVerdict('file:///C:/Windows/', '/')).toBe('deny');
    expect(navigationVerdict('javascript:alert(1)', '/')).toBe('deny');
    expect(navigationVerdict('app://other/', '/')).toBe('deny');
    expect(navigationVerdict('app://other/')).toBe('deny');
  });

  it('opens the app\'s own pages in an app window, web links outside, nothing else', () => {
    expect(windowOpenVerdict('app://spellglass/tools/tip-finder.html')).toBe('app-window');
    expect(windowOpenVerdict('https://example.com/')).toBe('external');
    expect(windowOpenVerdict('about:blank')).toBe('deny');
    expect(windowOpenVerdict('blob:app://spellglass/123')).toBe('deny');
    expect(windowOpenVerdict('mailto:someone@example.com')).toBe('deny');
    expect(isWebLink('https://example.com/')).toBe(true);
    expect(isWebLink('ftp://example.com/')).toBe(false);
  });
});
