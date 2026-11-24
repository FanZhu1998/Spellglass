// Handing things to the player (Section 11.1: "The app uses the system share sheet where the browser
// supports sharing files, and a download otherwise").
//
// User activation. navigator.share() needs the activation of the click that asked for it, and uses it
// up. kernel.request runs a handler synchronously up to its first await, so these functions call
// navigator.share() before awaiting anything: 'share.file' and 'share.url' can be called straight from
// a click, with the file already made.

import type { ShareResult } from '../../contracts';

export interface ShareNavigator {
  share?(data: ShareData): Promise<void>;
  canShare?(data?: ShareData): boolean;
  clipboard?: { writeText?(text: string): Promise<void> };
}

export interface DeliverEnv {
  navigator?: ShareNavigator | null;
  document?: Document | null;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  File?: typeof File;
  setTimeout: (fn: () => void, ms: number) => unknown;
}

/** The browser's, looked up at call time (never at import time). */
export function browserDeliverEnv(): DeliverEnv {
  const g = globalThis as {
    navigator?: ShareNavigator;
    document?: Document;
    URL?: { createObjectURL?: (b: Blob) => string; revokeObjectURL?: (u: string) => void };
    File?: typeof File;
  };
  return {
    navigator: g.navigator ?? null,
    document: g.document ?? null,
    createObjectURL: g.URL?.createObjectURL ? (b) => g.URL!.createObjectURL!(b) : undefined,
    revokeObjectURL: g.URL?.revokeObjectURL ? (u) => g.URL!.revokeObjectURL!(u) : undefined,
    File: typeof g.File === 'function' ? g.File : undefined,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
}

/** Object URLs for downloads stay valid this long: some browsers start the download after the click
 *  handler has returned, so revoking at once can cancel it (the delay FileSaver.js uses). */
export const REVOKE_AFTER_MS = 40_000;

const TYPES: Record<string, string> = { png: 'image/png', mp4: 'video/mp4', webm: 'video/webm', json: 'application/json', txt: 'text/plain' };

/** The file's type: the blob's own, else from the file name's extension. */
export function typeFor(blob: Blob, filename: string): string {
  if (blob.type) return blob.type.split(';')[0];
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}

const isAbort = (err: unknown) => (err as { name?: unknown } | null)?.name === 'AbortError';

/**
 * 'share.file': the system share sheet when the browser can share this very file (navigator.canShare
 * with the File; a video often cannot be shared where an image can), else a download. Choosing not to
 * share resolves 'cancelled'. If the sheet fails for another reason (the click's activation expired,
 * say), the file is downloaded instead.
 */
export function shareFile(p: { blob: Blob; filename: string; title?: string; text?: string }, env: DeliverEnv): Promise<ShareResult> {
  const nav = env.navigator;
  if (env.File && nav && typeof nav.share === 'function' && typeof nav.canShare === 'function') {
    const file = new env.File([p.blob], p.filename, { type: typeFor(p.blob, p.filename) });
    const data: ShareData = { files: [file], ...(p.title ? { title: p.title } : {}), ...(p.text ? { text: p.text } : {}) };
    let allowed = false;
    try {
      allowed = nav.canShare(data);
    } catch {
      allowed = false;
    }
    if (allowed) {
      let sharing: Promise<void>;
      try {
        sharing = nav.share(data);
      } catch (err) {
        sharing = Promise.reject(err);
      }
      return sharing.then(
        (): ShareResult => ({ outcome: 'shared' }),
        (err): ShareResult => (isAbort(err) ? { outcome: 'cancelled' } : download(p.blob, p.filename, env)),
      );
    }
  }
  try {
    return Promise.resolve(download(p.blob, p.filename, env));
  } catch (err) {
    return Promise.reject(err);
  }
}

/** Save through an <a download>. Throws when there is no document to click in. */
export function download(blob: Blob, filename: string, env: DeliverEnv): ShareResult {
  const doc = env.document;
  if (!doc || typeof doc.createElement !== 'function' || !env.createObjectURL) throw new Error('This browser cannot save files.');
  const url = env.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  // Firefox only follows a download link that is in the document.
  (doc.body ?? doc.documentElement)?.appendChild(a);
  a.click();
  a.remove();
  const revoke = env.revokeObjectURL;
  if (revoke) env.setTimeout(() => revoke(url), REVOKE_AFTER_MS);
  return { outcome: 'downloaded' };
}

/**
 * 'share.url': the system share sheet when there is one, else the clipboard, else 'cancelled' (the
 * caller then shows the link to copy by hand). Choosing not to share resolves 'cancelled'.
 */
export function shareUrl(p: { url: string; title?: string; text?: string }, env: DeliverEnv): Promise<ShareResult> {
  const nav = env.navigator;
  const data: ShareData = { url: p.url, ...(p.title ? { title: p.title } : {}), ...(p.text ? { text: p.text } : {}) };
  if (nav && typeof nav.share === 'function') {
    let allowed = true;
    if (typeof nav.canShare === 'function') {
      try {
        allowed = nav.canShare(data);
      } catch {
        allowed = false;
      }
    }
    if (allowed) {
      let sharing: Promise<void>;
      try {
        sharing = nav.share(data);
      } catch (err) {
        sharing = Promise.reject(err);
      }
      return sharing.then(
        (): ShareResult => ({ outcome: 'shared' }),
        (err) => (isAbort(err) ? { outcome: 'cancelled' as const } : copyText(p.url, env)),
      );
    }
  }
  return copyText(p.url, env);
}

async function copyText(text: string, env: DeliverEnv): Promise<ShareResult> {
  const clip = env.navigator?.clipboard;
  if (!clip || typeof clip.writeText !== 'function') return { outcome: 'cancelled' };
  try {
    await clip.writeText(text);
    return { outcome: 'copied' };
  } catch {
    return { outcome: 'cancelled' };
  }
}
