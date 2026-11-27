// @ts-check
// What the desktop app's page may do beyond drawing itself: which requests may go ahead, which
// permissions it is granted, where its window may navigate and what opens elsewhere. Pure functions,
// so the Node tests check them (tests/desktop/policy.test.ts); desktop/main.mjs applies them.
//
// The rule is the blueprint's (Section 11.2): the app talks only to its own origin. In the browser the
// content security policy keeps it so; here the main process also refuses every request that is not
// to app://spellglass/, from any page or worker, whatever its policy says.

import { isAppUrl } from './protocol.mjs';

/** @param {string} url */
function schemeOf(url) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return m ? `${m[1].toLowerCase()}:` : '';
}

/**
 * Whether a request may go ahead: the app's own files, data: and blob: URLs (which never leave the
 * device) and, while they are open, the developer tools' own pages. Everything else, http, https,
 * ws, wss, file and the rest, is refused.
 * @param {string} url
 */
export function isAllowedRequest(url) {
  if (isAppUrl(url)) return true;
  const scheme = schemeOf(url);
  return scheme === 'data:' || scheme === 'blob:' || scheme === 'devtools:';
}

/** @param {string} url */
export function isWebLink(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Granted besides the camera, none of which reads anything: writing to the clipboard (a replay link's
 * "Link copied", when the app has a web address to share), keeping the saved data when the disk runs
 * low (navigator.storage.persist(), so progress is never evicted), and full screen for an element of
 * the page (F11 already makes the whole window full screen). Chrome grants all three without asking.
 */
const QUIET_PERMISSIONS = new Set(['clipboard-sanitized-write', 'persistent-storage', 'fullscreen']);

/**
 * A permission request: the camera (media of type video only: the desktop app has no voice, so never
 * the microphone, and never the screen), and the quiet ones above. Only the app's own pages are
 * granted anything; the microphone, notifications, location, MIDI, screen capture and the rest are
 * refused. The computer's own camera setting comes on top of this (desktop/main.mjs).
 * @param {string} permission
 * @param {{ requestingUrl?: string, mediaTypes?: string[] }} details
 */
export function allowPermission(permission, details) {
  if (!isAppUrl(details?.requestingUrl ?? '')) return false;
  if (permission === 'media') {
    const types = details.mediaTypes ?? [];
    return types.length > 0 && types.every((t) => t === 'video');
  }
  return QUIET_PERMISSIONS.has(permission);
}

/**
 * A permission check (navigator.permissions.query, device labels): the same answer as a request,
 * for the app's own origin only: the camera yes, the microphone and the screen no.
 * @param {string} permission
 * @param {string} requestingOrigin
 * @param {{ mediaType?: string, securityOrigin?: string, requestingUrl?: string }} [details]
 */
export function allowPermissionCheck(permission, requestingOrigin, details = {}) {
  const origin = requestingOrigin || details.securityOrigin || details.requestingUrl || '';
  if (!isAppUrl(origin)) return false;
  if (permission === 'media') return details.mediaType === 'video';
  return QUIET_PERMISSIONS.has(permission);
}

/** The page a URL of the app names, as a path: '/' for the app itself (also as /index.html). @param {string} url */
export function appPage(url) {
  const path = new URL(url).pathname || '/';
  return path === '/index.html' ? '/' : path;
}

/**
 * Where a navigation may go. A window of the app stays on the page it was opened for (`page`, a path
 * as appPage() gives it): the app at '/', the tip finder at its own path. Going to that page again is
 * allowed (a reload, another query or hash), any other address of the app is not, so a mistyped or
 * missing one can never leave a bare "Not found" in the window. A frame (page null) may show any of
 * the app's pages. An http(s) link opens in the system browser instead ('external'); anything else
 * goes nowhere ('deny').
 * @param {string} url
 * @param {string | null} [page]
 * @returns {'allow' | 'external' | 'deny'}
 */
export function navigationVerdict(url, page = null) {
  if (isAppUrl(url)) return page === null || appPage(url) === page ? 'allow' : 'deny';
  if (isWebLink(url)) return 'external';
  return 'deny';
}

/**
 * window.open and target="_blank": the page never opens a window itself. One of the app's own pages
 * (the tip finder) opens in an app window the main process makes ('app-window'), an http(s) link in
 * the system browser ('external'), anything else nowhere ('deny').
 * @param {string} url
 * @returns {'app-window' | 'external' | 'deny'}
 */
export function windowOpenVerdict(url) {
  if (isAppUrl(url)) return 'app-window';
  if (isWebLink(url)) return 'external';
  return 'deny';
}

/**
 * Whether the computer lets Spellglass use the camera, from Electron's
 * systemPreferences.getMediaAccessStatus('camera'): 'allow', 'deny', or 'ask' when macOS has not asked
 * the player yet (then askForMediaAccess shows its prompt before the page opens the camera, rather than
 * racing it). Windows never asks: its answer is the Settings > Privacy & security > Camera switch for
 * desktop apps. A refusal here reaches the page as NotAllowedError, which the app words as a block in
 * the computer's privacy settings, rather than as a camera that failed to start.
 * @param {string | undefined} status
 * @param {string} platform
 * @returns {'allow' | 'deny' | 'ask'}
 */
export function systemCameraVerdict(status, platform) {
  if (status === 'denied' || status === 'restricted') return 'deny';
  if (status === 'not-determined' && platform === 'darwin') return 'ask';
  return 'allow';
}
