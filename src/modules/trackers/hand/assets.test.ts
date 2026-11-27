import { describe, expect, it } from 'vitest';
import { AssetError, checkAsset, download, downloadAll, hasZipEnd, MISSING_MESSAGE, UNREACHABLE_MESSAGE, type Progress } from './assets';

const WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...new Array(200).fill(7)]);
/** Shaped like hand_landmarker.task: two bytes, a ZIP entry, and the end-of-central-directory record. */
const MODEL = new Uint8Array([0, 0, 0x50, 0x4b, 0x03, 0x04, ...new Array(300).fill(9), 0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
const LOADER = new TextEncoder().encode(`// loader\n${'var a = 1;\n'.repeat(200)}export default 1;`);
const PAGE = new TextEncoder().encode(`<!doctype html><html>${' '.repeat(2000)}</html>`);

/** A response that delivers its body in chunks, like a download. */
function chunked(bytes: Uint8Array, init: ResponseInit & { chunk?: number } = {}): Response {
  const size = init.chunk ?? 64;
  let at = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
  return new Response(body, init);
}

function server(files: Record<string, () => Response | Promise<Response>>) {
  const asked: string[] = [];
  const fetchFn = async (url: string) => {
    asked.push(url);
    const make = files[url];
    if (!make) return new Response('not found', { status: 404 });
    return make();
  };
  return { fetchFn, asked };
}

describe('checkAsset', () => {
  it('knows each file by its first bytes', () => {
    expect(checkAsset('wasm', WASM, 'application/wasm')).toBeNull();
    expect(checkAsset('model', MODEL, 'application/octet-stream')).toBeNull();
    expect(checkAsset('loader', LOADER, 'text/javascript')).toBeNull();
    expect(checkAsset('wasm', MODEL, null)).toMatch(/not what it should be/);
    expect(checkAsset('model', WASM, null)).toMatch(/not what it should be/);
    expect(checkAsset('loader', PAGE, 'application/javascript')).toMatch(/web page/);
    expect(checkAsset('loader', new Uint8Array(10), null)).toMatch(/too small/);
    expect(checkAsset('wasm', WASM, 'text/html; charset=utf-8')).toMatch(/web page/);
  });

  it('recognizes a ZIP by its end record, so a prefix is fine and a cut-short download is not', () => {
    expect(hasZipEnd(MODEL)).toBe(true);
    expect(hasZipEnd(MODEL.slice(0, MODEL.length - 10))).toBe(false);
    expect(hasZipEnd(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBe(false);
    expect(hasZipEnd(new Uint8Array(0))).toBe(false);
  });
});

describe('download', () => {
  it('reads the body as it arrives and reports bytes against Content-Length', async () => {
    const seen: [number, number][] = [];
    const { fetchFn } = server({ '/m.task': () => chunked(MODEL, { headers: { 'content-length': String(MODEL.length) } }) });
    const bytes = await download(fetchFn, { kind: 'model', url: '/m.task' }, (l, t) => seen.push([l, t]));
    expect(bytes).toEqual(MODEL);
    expect(seen.length).toBeGreaterThan(3);
    expect(seen[0]).toEqual([64, MODEL.length]);
    expect(seen.at(-1)).toEqual([MODEL.length, MODEL.length]);
  });

  it('copes with a compressed answer whose Content-Length is smaller than the body', async () => {
    const seen: [number, number][] = [];
    const { fetchFn } = server({ '/w.wasm': () => chunked(WASM, { headers: { 'content-length': '50' } }) });
    await download(fetchFn, { kind: 'wasm', url: '/w.wasm' }, (l, t) => seen.push([l, t]));
    for (const [l, t] of seen) expect(l).toBeLessThanOrEqual(t);
  });

  it('turns a missing file, a web page or a wrong file into the "not installed" message', async () => {
    const { fetchFn } = server({
      '/page.task': () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }),
      '/wrong.wasm': () => new Response(MODEL),
    });
    for (const url of ['/gone.task', '/page.task', '/wrong.wasm']) {
      const err = await download(fetchFn, { kind: url.endsWith('wasm') ? 'wasm' : 'model', url }, () => {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AssetError);
      expect(err).toMatchObject({ reason: 'missing', message: MISSING_MESSAGE });
    }
  });

  it('says the download failed when the network or the server did', async () => {
    const offline = async () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(download(offline, { kind: 'model', url: '/m.task' }, () => {})).rejects.toMatchObject({ reason: 'unreachable', message: UNREACHABLE_MESSAGE });
    const { fetchFn } = server({ '/m.task': () => new Response('busy', { status: 503 }) });
    await expect(download(fetchFn, { kind: 'model', url: '/m.task' }, () => {})).rejects.toMatchObject({ reason: 'unreachable' });
  });
});

describe('downloadAll', () => {
  it('fetches every file at once and reports combined progress', async () => {
    const { fetchFn, asked } = server({
      '/l.js': () => chunked(LOADER, { headers: { 'content-length': String(LOADER.length) } }),
      '/w.wasm': () => chunked(WASM, { headers: { 'content-length': String(WASM.length) } }),
      '/m.task': () => chunked(MODEL, { headers: { 'content-length': String(MODEL.length) } }),
    });
    const progress: Progress[] = [];
    const files = await downloadAll(fetchFn, [{ kind: 'loader', url: '/l.js' }, { kind: 'wasm', url: '/w.wasm' }, { kind: 'model', url: '/m.task' }], (p) => progress.push(p));
    expect(asked).toEqual(['/l.js', '/w.wasm', '/m.task']);
    expect(files).toEqual([LOADER, WASM, MODEL]);
    const last = progress.at(-1)!;
    expect(last.loaded).toBe(LOADER.length + WASM.length + MODEL.length);
    expect(last.total).toBe(last.loaded);
    // Never runs backwards.
    for (let i = 1; i < progress.length; i++) expect(progress[i].loaded / progress[i].total).toBeGreaterThanOrEqual(progress[i - 1].loaded / progress[i - 1].total - 1e-9);
  });

  it('reports "not installed" first when one file is missing and another failed to download', async () => {
    const fetchFn = async (url: string) => {
      if (url === '/w.wasm') throw new TypeError('Failed to fetch');
      if (url === '/m.task') return new Response('', { status: 404 });
      return new Response(LOADER);
    };
    await expect(downloadAll(fetchFn, [{ kind: 'loader', url: '/l.js' }, { kind: 'wasm', url: '/w.wasm' }, { kind: 'model', url: '/m.task' }], () => {}))
      .rejects.toMatchObject({ reason: 'missing' });
  });
});
