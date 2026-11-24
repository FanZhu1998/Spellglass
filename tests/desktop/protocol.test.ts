// The desktop app's protocol (desktop/protocol.mjs): which file a request names, with what type, and
// what is refused. Runs in Node; the Electron tests (desktop.spec.ts) fetch through the real handler.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_URL, SCHEME_PRIVILEGES, createFileHandler, isAppUrl, mimeType, resolveAppPath } from '../../desktop/protocol.mjs';

const ROOT = join(tmpdir(), 'spellglass-dist');

describe('resolveAppPath', () => {
  it('maps the app address to files under the root, "/" to index.html', () => {
    expect(resolveAppPath(ROOT, 'app://spellglass/')).toBe(join(ROOT, 'index.html'));
    expect(resolveAppPath(ROOT, 'app://spellglass')).toBe(join(ROOT, 'index.html'));
    expect(resolveAppPath(ROOT, 'app://spellglass/packs/index.json')).toBe(join(ROOT, 'packs', 'index.json'));
    expect(resolveAppPath(ROOT, 'app://spellglass/tools/')).toBe(join(ROOT, 'tools', 'index.html'));
    expect(resolveAppPath(ROOT, 'app://spellglass/assets/a%20b.js?v=1#x')).toBe(join(ROOT, 'assets', 'a b.js'));
  });

  it('refuses other schemes and hosts', () => {
    for (const url of ['https://spellglass/index.html', 'file:///C:/dist/index.html', 'app://other/index.html', 'app://spellglass:8080/index.html', 'not a url']) {
      expect(resolveAppPath(ROOT, url)).toBeNull();
    }
  });

  it('never leaves the root, however the path is written', () => {
    const climbs = [
      'app://spellglass/..%2f..%2fpackage.json',
      'app://spellglass/%2e%2e/%2e%2e/package.json',
      'app://spellglass/assets/..%5c..%5cpackage.json',
      'app://spellglass/%2e%2e%5cpackage.json',
      'app://spellglass/C:%5cWindows%5cwin.ini',
      'app://spellglass/C:/Windows/win.ini',
      'app://spellglass/index.html%00.png',
      'app://spellglass/index.html::$DATA',
      'app://spellglass/%E0%A4%A',
    ];
    for (const url of climbs) {
      const file = resolveAppPath(ROOT, url);
      if (file !== null) expect(file.startsWith(ROOT + sep)).toBe(true);
    }
    // The ones a URL parser does not already fold away are refused outright.
    expect(resolveAppPath(ROOT, 'app://spellglass/..%2f..%2fpackage.json')).toBeNull();
    expect(resolveAppPath(ROOT, 'app://spellglass/assets/..%5c..%5cpackage.json')).toBeNull();
    expect(resolveAppPath(ROOT, 'app://spellglass/C:%5cWindows%5cwin.ini')).toBeNull();
    expect(resolveAppPath(ROOT, 'app://spellglass/index.html%00.png')).toBeNull();
    expect(resolveAppPath(ROOT, 'app://spellglass/%E0%A4%A')).toBeNull();
  });
});

describe('the scheme', () => {
  it('is a standard, secure scheme that can fetch and stream, without service workers', () => {
    expect(APP_URL).toBe('app://spellglass/');
    expect(SCHEME_PRIVILEGES).toEqual({
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
    });
  });

  it('knows its own addresses', () => {
    expect(isAppUrl('app://spellglass/')).toBe(true);
    expect(isAppUrl('app://spellglass')).toBe(true);
    expect(isAppUrl('app://spellglass/tools/tip-finder.html')).toBe(true);
    expect(isAppUrl('app://elsewhere/')).toBe(false);
    expect(isAppUrl('https://spellglass/')).toBe(false);
    expect(isAppUrl('')).toBe(false);
  });

  it('gives each kind of file its type', () => {
    expect(mimeType('a/index.html')).toBe('text/html; charset=utf-8');
    expect(mimeType('a/main.js')).toBe('text/javascript; charset=utf-8');
    expect(mimeType('a/worker.MJS')).toBe('text/javascript; charset=utf-8');
    expect(mimeType('a/pack.json')).toBe('application/json; charset=utf-8');
    expect(mimeType('a/vision.wasm')).toBe('application/wasm');
    expect(mimeType('a/hand_landmarker.task')).toBe('application/octet-stream');
    expect(mimeType('a/font.woff2')).toBe('font/woff2');
    expect(mimeType('a/icon.svg')).toBe('image/svg+xml');
    expect(mimeType('a/icon.png')).toBe('image/png');
    expect(mimeType('a/manifest.webmanifest')).toBe('application/manifest+json; charset=utf-8');
    expect(mimeType('a/unknown.bin')).toBe('application/octet-stream');
  });
});

describe('the file handler', () => {
  // dist/ inside a folder of its own, with a file beside it that the page must never reach.
  let parent = '';
  let root = '';
  beforeAll(() => {
    parent = mkdtempSync(join(tmpdir(), 'spellglass-protocol-'));
    root = join(parent, 'dist');
    mkdirSync(join(root, 'models', 'wasm'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Spellglass</title>');
    writeFileSync(join(root, 'models', 'wasm', 'vision.wasm'), Buffer.from([0, 0x61, 0x73, 0x6d]));
    writeFileSync(join(parent, 'secret.txt'), 'not for the page');
  });
  afterAll(() => {
    rmSync(parent, { recursive: true, force: true });
  });

  const get = (url: string, method = 'GET') => createFileHandler(root)(new Request(url, { method }));

  it('serves files with their type and no caching surprises', async () => {
    const page = await get('app://spellglass/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await page.text()).toContain('<title>Spellglass</title>');
    const wasm = await get('app://spellglass/models/wasm/vision.wasm');
    expect(wasm.headers.get('content-type')).toBe('application/wasm');
    expect(new Uint8Array(await wasm.arrayBuffer())).toEqual(new Uint8Array([0, 0x61, 0x73, 0x6d]));
  });

  it('answers 404 for what is missing or outside, 405 for writes', async () => {
    expect((await get('app://spellglass/nothing.js')).status).toBe(404);
    expect((await get('app://spellglass/models')).status).toBe(404);
    expect((await get('app://spellglass/..%2fsecret.txt')).status).toBe(404);
    expect((await get('app://spellglass/%2e%2e/secret.txt')).status).toBe(404);
    expect((await get('app://other/index.html')).status).toBe(404);
    expect((await get('app://spellglass/index.html', 'POST')).status).toBe(405);
    const head = await get('app://spellglass/index.html', 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });
});
