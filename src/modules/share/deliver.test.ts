import { afterEach, describe, expect, it, vi } from 'vitest';
import { ask, createKernel, memoryPersistence } from '../../kernel';
import { REVOKE_AFTER_MS, shareFile, shareUrl, typeFor, type DeliverEnv, type ShareNavigator } from './deliver';
import { createShareModule } from './index';

const abort = () => Object.assign(new Error('The user cancelled.'), { name: 'AbortError' });
const denied = () => Object.assign(new Error('Must be handling a user gesture.'), { name: 'NotAllowedError' });

/** A document that records the download links it is asked to click. */
function fakeEnv(nav: ShareNavigator | null) {
  const clicked: { href: string; download: string }[] = [];
  const revoked: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const document = {
    createElement: () => {
      const a = { href: '', download: '', rel: '', style: {} as Record<string, string>, click: () => clicked.push({ href: a.href, download: a.download }), remove: () => undefined };
      return a;
    },
    body: { appendChild: () => undefined },
  } as unknown as Document;
  const env: DeliverEnv = {
    navigator: nav,
    document,
    createObjectURL: () => 'blob:card',
    revokeObjectURL: (u) => revoked.push(u),
    File,
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
  };
  return { env, clicked, revoked, timers };
}

const png = () => new Blob(['png'], { type: 'image/png' });

describe('share.file', () => {
  it('uses the share sheet for a file it can share, calling it before anything is awaited', async () => {
    const shared: ShareData[] = [];
    const nav: ShareNavigator = {
      canShare: (d) => !!d?.files?.length,
      share: async (d) => {
        shared.push(d);
      },
    };
    const { env } = fakeEnv(nav);
    const result = shareFile({ blob: png(), filename: 'card.png', title: 'Protego', text: 'Cast shared' }, env);
    // Called synchronously, so the click's user activation is still there.
    expect(shared).toHaveLength(1);
    expect(await result).toEqual({ outcome: 'shared' });
    const file = shared[0].files![0];
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('card.png');
    expect(file.type).toBe('image/png');
    expect(shared[0]).toMatchObject({ title: 'Protego', text: 'Cast shared' });
  });

  it('resolves cancelled when the player closes the sheet, and downloads when the sheet fails', async () => {
    expect(await shareFile({ blob: png(), filename: 'card.png' }, fakeEnv({ canShare: () => true, share: async () => { throw abort(); } }).env)).toEqual({ outcome: 'cancelled' });
    const failing = fakeEnv({ canShare: () => true, share: async () => { throw denied(); } });
    expect(await shareFile({ blob: png(), filename: 'card.png' }, failing.env)).toEqual({ outcome: 'downloaded' });
    expect(failing.clicked).toEqual([{ href: 'blob:card', download: 'card.png' }]);
  });

  it('downloads a file the browser cannot share, and revokes the address later', async () => {
    const { env, clicked, revoked, timers } = fakeEnv({ canShare: () => false, share: async () => undefined });
    expect(await shareFile({ blob: new Blob(['v']), filename: 'clip.webm' }, env)).toEqual({ outcome: 'downloaded' });
    expect(clicked).toEqual([{ href: 'blob:card', download: 'clip.webm' }]);
    expect(revoked).toEqual([]);
    expect(timers.map((t) => t.ms)).toEqual([REVOKE_AFTER_MS]);
    timers[0].fn();
    expect(revoked).toEqual(['blob:card']);
  });

  it('downloads where there is no share sheet, and fails plainly without a document', async () => {
    expect(await shareFile({ blob: png(), filename: 'card.png' }, fakeEnv(null).env)).toEqual({ outcome: 'downloaded' });
    await expect(shareFile({ blob: png(), filename: 'card.png' }, { navigator: null, setTimeout })).rejects.toThrow('This browser cannot save files.');
  });

  it('types a file from its name when the blob has no type', () => {
    expect(typeFor(new Blob(['x']), 'clip.MP4')).toBe('video/mp4');
    expect(typeFor(new Blob(['x'], { type: 'video/webm;codecs=vp9' }), 'clip.webm')).toBe('video/webm');
    expect(typeFor(new Blob(['x']), 'data')).toBe('application/octet-stream');
  });
});

describe('share.url', () => {
  it('shares, copies or gives up, in that order', async () => {
    const copied: string[] = [];
    const clipboard = { writeText: async (t: string) => void copied.push(t) };
    expect(await shareUrl({ url: 'https://x/#cast=a' }, fakeEnv({ share: async () => undefined }).env)).toEqual({ outcome: 'shared' });
    expect(await shareUrl({ url: 'https://x/#cast=a' }, fakeEnv({ share: async () => { throw abort(); }, clipboard }).env)).toEqual({ outcome: 'cancelled' });
    expect(await shareUrl({ url: 'https://x/#cast=b' }, fakeEnv({ share: async () => { throw denied(); }, clipboard }).env)).toEqual({ outcome: 'copied' });
    expect(await shareUrl({ url: 'https://x/#cast=c' }, fakeEnv({ clipboard }).env)).toEqual({ outcome: 'copied' });
    expect(copied).toEqual(['https://x/#cast=b', 'https://x/#cast=c']);
    expect(await shareUrl({ url: 'https://x/' }, fakeEnv({}).env)).toEqual({ outcome: 'cancelled' });
    expect(await shareUrl({ url: 'https://x/' }, fakeEnv({ clipboard: { writeText: async () => { throw denied(); } } }).env)).toEqual({ outcome: 'cancelled' });
  });
});

describe('through the kernel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reaches navigator.share in the same task as the request, keeping user activation', async () => {
    let calledDuringRequest = false;
    let inRequest = false;
    vi.stubGlobal('navigator', {
      canShare: () => true,
      share: async () => {
        calledDuringRequest = inRequest;
      },
    });
    const kernel = createKernel({ persistence: memoryPersistence(), features: [] });
    kernel.register(createShareModule({ appUrl: 'https://example.test/' }));
    await kernel.init();
    inRequest = true;
    const pending = ask(kernel, 'share.file', { blob: png(), filename: 'card.png' });
    inRequest = false;
    expect(await pending).toEqual({ outcome: 'shared' });
    expect(calledDuringRequest).toBe(true);
    const err = await ask(kernel, 'share.file', { blob: 'not a blob' as unknown as Blob, filename: 'x' }).catch((e: { code: string }) => e);
    expect(err).toMatchObject({ code: 'invalid-payload' });
  });
});
