// npm run models: puts the optional hand-tracking files where the hand tracker loads them (Section 7.3).
//
//   public/models/hand_landmarker.task        MediaPipe's hand landmarker, float16, version 1 (about 7.5 MB),
//                                             downloaded from Google's model bucket.
//   public/models/wasm/vision_wasm_module_internal.{js,wasm}
//                                             the MediaPipe runtime from node_modules/@mediapipe/tasks-vision,
//                                             module variant only: the hand tracker runs it in a module worker
//                                             (src/modules/trackers/hand/worker.ts), and the classic variant
//                                             would be another 14 MB nobody loads.
//
// Both paths are git-ignored and left out of the service worker's precache (vite.config.ts), so the first
// download stays small; the app fetches them only when the hand tracker starts. At runtime they come from
// the app's own origin, as the content security policy requires (Section 11.2).
//
// Runs anywhere Node 22 or later runs (the deploy workflow calls it before building). A model that is
// already present with the right size is kept; --force downloads it again. Exits with 1 and a plain
// message when something is missing.

import { closeSync, copyFileSync, createWriteStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const OUT = join(ROOT, 'public', 'models');
const MODEL_FILE = join(OUT, 'hand_landmarker.task');
const WASM_SRC = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const WASM_OUT = join(OUT, 'wasm');
const WASM_FILES = ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm'];
const force = process.argv.includes('--force');

/** A .task file is a ZIP archive. hand_landmarker.task carries two bytes before its first entry, so this
 *  looks where ZIP readers look: for the end-of-central-directory record ("PK\5\6") in the last 65,557
 *  bytes. The same test runs in the browser before the model is used (src/modules/trackers/hand/assets.ts). */
const ZIP_END = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const ZIP_TAIL = 22 + 0xffff;

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isZip(file) {
  let fd;
  try {
    const size = statSync(file).size;
    if (size < 22) return false;
    const n = Math.min(size, ZIP_TAIL);
    const buf = Buffer.alloc(n);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, n, size - n);
    // The record is 22 bytes long, so its signature starts at least 22 bytes before the end.
    return buf.lastIndexOf(ZIP_END, n - 22) !== -1;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sizeOf(file) {
  try {
    return statSync(file).size;
  } catch {
    return -1;
  }
}

/** The model's size on the server, or null when the server cannot be reached. */
async function remoteSize() {
  try {
    const res = await fetch(MODEL_URL, { method: 'HEAD', redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const n = Number(res.headers.get('content-length'));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (err) {
    console.warn(`  could not ask the model server for the size (${err instanceof Error ? err.message : err})`);
    return null;
  }
}

async function fetchModel() {
  const local = sizeOf(MODEL_FILE);
  const localOk = local > 1_000_000 && isZip(MODEL_FILE);
  const expected = await remoteSize();
  if (!force && localOk && (expected === null || expected === local)) {
    console.log(`  hand model present (${mb(local)})${expected === null ? ', size not checked' : ''}`);
    return;
  }
  if (expected === null && !localOk) {
    // Try the download anyway: HEAD may be refused where GET works.
    console.log('  downloading the hand model without a size to check against');
  } else {
    console.log(`  downloading the hand model (${mb(expected ?? 0)})`);
  }
  const res = await fetch(MODEL_URL, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`The hand model could not be downloaded (HTTP ${res.status}).`);
  const part = `${MODEL_FILE}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    const got = sizeOf(part);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > 0 && got !== declared) throw new Error(`The download was cut short (${got} of ${declared} bytes).`);
    if (expected !== null && got !== expected) throw new Error(`The downloaded model has an unexpected size (${got} bytes, expected ${expected}).`);
    if (!isZip(part)) throw new Error('The downloaded file is not a MediaPipe model.');
    renameSync(part, MODEL_FILE);
    console.log(`  hand model saved (${mb(got)})`);
  } finally {
    rmSync(part, { force: true });
  }
}

function copyRuntime() {
  if (!existsSync(WASM_SRC)) throw new Error('node_modules/@mediapipe/tasks-vision is missing. Run npm ci first.');
  mkdirSync(WASM_OUT, { recursive: true });
  for (const name of WASM_FILES) {
    const from = join(WASM_SRC, name);
    const to = join(WASM_OUT, name);
    if (!existsSync(from)) throw new Error(`${name} is missing from @mediapipe/tasks-vision. Run npm ci again.`);
    const same = sizeOf(to) === sizeOf(from) && readFileSync(to).equals(readFileSync(from));
    if (same && !force) {
      console.log(`  ${name} up to date (${mb(sizeOf(to))})`);
      continue;
    }
    copyFileSync(from, to);
    console.log(`  ${name} copied (${mb(sizeOf(to))})`);
  }
  // Only the variant the app loads: drop any other MediaPipe runtime left by an older version of this script.
  for (const name of readdirSync(WASM_OUT)) {
    if (/^vision_wasm.*\.(js|wasm)$/.test(name) && !WASM_FILES.includes(name)) {
      rmSync(join(WASM_OUT, name));
      console.log(`  ${name} removed (not used)`);
    }
  }
}

async function main() {
  console.log('Hand tracking files for public/models:');
  mkdirSync(OUT, { recursive: true });
  copyRuntime();
  await fetchModel();
  console.log('Done. The hand tracker loads these when it starts.');
}

main().catch((err) => {
  console.error(`npm run models failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
