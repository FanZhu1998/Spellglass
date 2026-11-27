// Downloading the hand model and its WASM runtime, with progress, inside the worker (Section 7.3: "The
// model is several megabytes, so it loads only when this tracker is chosen").
//
// The three files come from the app's own origin, where 'npm run models' (tools/fetch-models.mjs) puts
// them: the MediaPipe loader script and its WASM binary (the module variant, for a module worker) and
// hand_landmarker.task. They are fetched together, so the status area can show one progress figure
// (TrackerStatus.progress) for about 23 MB, and each is checked before use: a static host answers a
// missing file with 404, but a development server or a service worker may answer it with the app's own
// index.html, which would otherwise surface as a baffling WebAssembly or ZIP error. Every such case
// becomes the plain message "Hand model not installed. Run npm run models."

export type AssetKind = 'loader' | 'wasm' | 'model';

export interface AssetRequest {
  kind: AssetKind;
  url: string;
}

/** Sizes of the files in @mediapipe/tasks-vision 1.2.3 and hand_landmarker float16/1, used for progress
 *  when a server sends no Content-Length. Only progress depends on them. */
export const ESTIMATED_BYTES: Record<AssetKind, number> = {
  loader: 336_662,
  wasm: 14_665_738,
  model: 7_819_105,
};

export const MISSING_MESSAGE = 'Hand model not installed. Run npm run models.';
export const UNREACHABLE_MESSAGE = 'The hand model could not be downloaded. Check the connection, then try again.';

export class AssetError extends Error {
  constructor(readonly reason: 'missing' | 'unreachable', readonly detail: string) {
    super(reason === 'missing' ? MISSING_MESSAGE : UNREACHABLE_MESSAGE);
    this.name = 'AssetError';
  }
}

/** WebAssembly binaries start with "\0asm". */
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
/** A .task file is a ZIP archive. hand_landmarker.task carries two bytes before its first entry, so the
 *  test is the one ZIP readers use: the end-of-central-directory record ("PK\5\6") within the last
 *  65,557 bytes (22 bytes of record plus the longest comment). It also catches a download cut short. */
const ZIP_END = [0x50, 0x4b, 0x05, 0x06];
const ZIP_TAIL = 22 + 0xffff;

/** Whether `bytes` holds a ZIP end-of-central-directory record where one must be. */
export function hasZipEnd(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - ZIP_TAIL; i--) {
    if (bytes[i] === ZIP_END[0] && bytes[i + 1] === ZIP_END[1] && bytes[i + 2] === ZIP_END[2] && bytes[i + 3] === ZIP_END[3]) return true;
  }
  return false;
}

/** Why a downloaded file is not the one expected, or null when it looks right. */
export function checkAsset(kind: AssetKind, bytes: Uint8Array, contentType: string | null): string | null {
  if (contentType && /text\/html/i.test(contentType)) return 'the server answered with a web page';
  if (kind === 'wasm') {
    return bytes.length >= 8 && WASM_MAGIC.every((b, i) => bytes[i] === b) ? null : 'the file is not what it should be';
  }
  if (kind === 'model') {
    return hasZipEnd(bytes) ? null : 'the file is not what it should be';
  }
  // The loader is a script: an HTML page or an empty answer is not it.
  if (bytes.length < 1000) return 'the file is too small';
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09 || bytes[i] === 0xef || bytes[i] === 0xbb || bytes[i] === 0xbf)) i++;
  if (bytes[i] === 0x3c /* '<' */) return 'the server answered with a web page';
  return null;
}

export interface Progress {
  loaded: number;
  total: number;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Fetch one file, reporting bytes as they arrive. Throws AssetError. */
export async function download(fetchFn: FetchLike, req: AssetRequest, onBytes: (loaded: number, total: number) => void): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchFn(req.url, { credentials: 'same-origin' });
  } catch (err) {
    throw new AssetError('unreachable', `${req.kind}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    // 4xx: not there (or not allowed); 5xx and anything else: the server had trouble.
    throw new AssetError(res.status >= 400 && res.status < 500 ? 'missing' : 'unreachable', `${req.kind}: HTTP ${res.status}`);
  }
  const contentType = res.headers.get('content-type');
  if (contentType && /text\/html/i.test(contentType)) throw new AssetError('missing', `${req.kind}: the server answered with a web page`);
  const declared = Number(res.headers.get('content-length'));
  // Content-Length counts compressed bytes when the server compresses, so it is only a hint.
  let total = Number.isFinite(declared) && declared > 0 ? declared : ESTIMATED_BYTES[req.kind];
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  try {
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        chunks.push(value);
        loaded += value.length;
        if (loaded > total) total = loaded;
        onBytes(loaded, total);
      }
    } else {
      const buf = new Uint8Array(await res.arrayBuffer());
      chunks.push(buf);
      loaded = buf.length;
    }
  } catch (err) {
    throw new AssetError('unreachable', `${req.kind}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const bytes = concat(chunks, loaded);
  onBytes(bytes.length, bytes.length);
  const problem = checkAsset(req.kind, bytes, contentType);
  if (problem) throw new AssetError('missing', `${req.kind}: ${problem}`);
  return bytes;
}

/**
 * Fetch every file at once; `onProgress` sees the combined bytes (throttled to steps of about 1%).
 * Resolves with the files in request order, or rejects with the first AssetError ('missing' wins over
 * 'unreachable', since it says what to do).
 */
export async function downloadAll(fetchFn: FetchLike, reqs: readonly AssetRequest[], onProgress: (p: Progress) => void): Promise<Uint8Array[]> {
  const loaded = reqs.map(() => 0);
  const totals = reqs.map((r) => ESTIMATED_BYTES[r.kind]);
  let reported = -1;
  const report = (force = false) => {
    const l = loaded.reduce((a, b) => a + b, 0);
    const t = Math.max(1, totals.reduce((a, b) => a + b, 0));
    const step = Math.floor((l / t) * 100);
    if (!force && step === reported) return;
    reported = step;
    onProgress({ loaded: l, total: t });
  };
  report(true);
  const results = await Promise.allSettled(
    reqs.map((req, i) =>
      download(fetchFn, req, (l, t) => {
        loaded[i] = l;
        totals[i] = t;
        report();
      }),
    ),
  );
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => r.reason as unknown);
  if (failures.length) {
    const asset = failures.filter((f): f is AssetError => f instanceof AssetError);
    throw asset.find((f) => f.reason === 'missing') ?? asset[0] ?? failures[0];
  }
  report(true);
  return results.map((r) => (r as PromiseFulfilledResult<Uint8Array>).value);
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
