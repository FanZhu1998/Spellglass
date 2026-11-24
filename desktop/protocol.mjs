// @ts-check
// The desktop app's own address, app://spellglass/, and the files behind it (desktop/main.mjs).
//
// The production web build (dist/) is served through a privileged custom protocol rather than file://,
// so the page is a secure context with an origin of its own: module scripts, fetch of the packs,
// workers, WebAssembly, IndexedDB, crypto.subtle and getUserMedia all behave as they do on https.
//
// Nothing here imports Electron, so the Node tests can run it (tests/desktop/protocol.test.ts).

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const SCHEME = 'app';
export const HOST = 'spellglass';
/** Where the page lives. Every request the app makes goes here (blueprint Section 11.2). */
export const APP_URL = `${SCHEME}://${HOST}/`;

/**
 * The privileges the scheme is registered with, before the app is ready. `standard` gives it real
 * origins (and with them storage), `secure` makes it a secure context, `supportFetchAPI` lets the
 * page fetch its packs, `corsEnabled` lets workers and module scripts load, `stream` lets media
 * stream, and `codeCache` keeps compiled scripts between launches. Service workers stay off: the
 * desktop app is offline by construction.
 * @type {Electron.CustomScheme}
 */
export const SCHEME_PRIVILEGES = {
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
};

/** Content types by extension. Module scripts and workers need a JavaScript type, and WebAssembly
 *  compiles while streaming only as application/wasm. */
export const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
});

/** @param {string} file */
export function mimeType(file) {
  return /** @type {Record<string, string>} */ (MIME_TYPES)[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/** Whether a URL is on the app's own origin. (Node's URL gives a custom scheme the origin "null", so
 *  the scheme and host are compared instead.)
 *  @param {string} url */
export function isAppUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === `${SCHEME}:` && u.host === HOST;
  } catch {
    return false;
  }
}

/**
 * The file under `root` that a request URL names, or null when the URL is not one the app serves:
 * another scheme or host, a path that climbs out of `root` (also when encoded: %2e%2e, %2f, %5c), a
 * colon (Windows drive letters and alternate streams) or a NUL. "/" and paths ending in "/" name
 * their index.html.
 * @param {string} root absolute path of the folder served
 * @param {string} url
 * @returns {string | null}
 */
export function resolveAppPath(root, url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${SCHEME}:` || u.host !== HOST) return null;
  let rel;
  try {
    // Node parses app://spellglass (no slash) with an empty path; Chromium always sends the slash.
    rel = decodeURIComponent(u.pathname || '/');
  } catch {
    return null;
  }
  if (/[\\:\0]/.test(rel)) return null;
  const segments = rel.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '.' || s === '..')) return null;
  if (rel.endsWith('/')) segments.push('index.html');
  const base = path.resolve(root);
  const file = path.join(base, ...segments);
  const inside = path.relative(base, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  return file;
}

/** @param {number} status @param {string} text */
function plain(status, text) {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' } });
}

/**
 * The protocol handler: GET and HEAD of files under `root`, with their content type; 404 for
 * anything else under the app's address, 405 for other methods.
 * @param {string} root
 * @param {{ readFile?: (file: string) => Promise<Uint8Array<ArrayBuffer>>, stat?: (file: string) => Promise<{ isFile(): boolean }> }} [fsLike]
 * @returns {(request: Request) => Promise<Response>}
 */
export function createFileHandler(root, fsLike = {}) {
  const read = fsLike.readFile ?? readFile;
  const info = fsLike.stat ?? stat;
  return async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'Method not allowed');
    const file = resolveAppPath(root, request.url);
    if (!file) return plain(404, 'Not found');
    try {
      if (!(await info(file)).isFile()) return plain(404, 'Not found');
      const body = request.method === 'HEAD' ? null : await read(file);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': mimeType(file), 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' },
      });
    } catch {
      return plain(404, 'Not found');
    }
  };
}
