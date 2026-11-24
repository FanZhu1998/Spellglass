// @ts-check
// Copies of Spellglass that the portable Windows .exe left behind (desktop/main.mjs runs this a little
// after the window opens).
//
// The portable .exe (electron-builder's portable target, electron-builder.config.mjs) is a launcher: at
// every start it unpacks the app into a folder of its own, %TEMP%\nsXXXX.tmp\app (about 330 MB), runs
// it, and removes the folder once Spellglass closes. A launcher that is stopped first leaves its copy
// behind for good: ended in Task Manager, a shutdown or sign-out while Spellglass is open, a crash
// during the few seconds of unpacking. So each start of the portable app removes copies that:
//   - sit beside its own copy, in a folder named as the launcher names them (nsXXXX.tmp), with
//     app\Spellglass.exe inside (real folders and a real file, not links to somewhere else);
//   - were last changed at least MIN_AGE_MS ago, so a launcher that is unpacking now is left alone;
//   - are not in use: Spellglass.exe is deleted first, and Windows refuses that while any Spellglass
//     runs from the folder, which then stays exactly as it is. (A rename is no such test: Windows
//     renames a folder whose program is running.) Once the .exe is gone, the folder is renamed
//     spellglass-left-nsXXXX.tmp and removed; should that fail, a later start removes it.
// Nothing else is touched. The player's own data lives elsewhere (%APPDATA%\Spellglass).
//
// Nothing here imports Electron, so the Node tests can run it (tests/desktop/portable.test.ts).

import { lstat, readdir, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';

/** NSIS names its temporary folder with GetTempFileName: "ns", a letter, up to four hex digits, ".tmp". */
export const UNPACK_FOLDER = /^ns[a-z][0-9a-f]{1,4}\.tmp$/i;
/** A copy whose Spellglass.exe is already deleted, on its way out. */
export const LEFT_FOLDER = /^spellglass-left-ns[a-z][0-9a-f]{1,4}\.tmp$/i;
export const EXE_NAME = 'Spellglass.exe';
/** Unpacking takes seconds; a copy untouched for this long belongs to no launcher that is unpacking. */
export const MIN_AGE_MS = 10 * 60_000;

/**
 * The folder the portable launcher unpacked this copy into (…\Temp\nsXXXX.tmp), or null when this is
 * not the portable app: another platform, the installed app, or a run from the project.
 * @param {string} execPath process.execPath
 * @param {Record<string, string | undefined>} env the launcher sets PORTABLE_EXECUTABLE_DIR
 * @param {string} [platform]
 */
export function ownUnpackFolder(execPath, env, platform = process.platform) {
  if (platform !== 'win32' || !env.PORTABLE_EXECUTABLE_DIR) return null;
  const win = path.win32;
  const appDir = win.dirname(execPath);
  const unpack = win.dirname(appDir);
  if (win.basename(execPath).toLowerCase() !== EXE_NAME.toLowerCase()) return null;
  if (win.basename(appDir).toLowerCase() !== 'app' || !UNPACK_FOLDER.test(win.basename(unpack))) return null;
  return unpack;
}

/**
 * @typedef {{ isDirectory(): boolean, isFile(): boolean, isSymbolicLink(): boolean, mtimeMs: number }} Info
 * @typedef {{
 *   readdir(dir: string): Promise<string[]>,
 *   lstat(file: string): Promise<Info>,
 *   unlink(file: string): Promise<void>,
 *   rename(from: string, to: string): Promise<void>,
 *   rm(dir: string, opts: { recursive: true, force: true, maxRetries?: number }): Promise<void>,
 * }} FsLike
 */

/** @type {FsLike} */
const nodeFs = { readdir: (d) => readdir(d), lstat: (f) => lstat(f), unlink: (f) => unlink(f), rename: (a, b) => rename(a, b), rm: (d, o) => rm(d, o) };

/** @param {FsLike} fs @param {string} file @returns {Promise<Info | null>} */
async function info(fs, file) {
  try {
    return await fs.lstat(file);
  } catch {
    return null;
  }
}

/** A real folder, not a link to one. @param {Info | null} i */
const realFolder = (i) => !!i && i.isDirectory() && !i.isSymbolicLink();

/** @param {FsLike} fs @param {string} folder */
async function removeFolder(fs, folder) {
  try {
    await fs.rm(folder, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the copies other launchers left beside `own` (see above). Never throws.
 * @param {string} own this copy's folder, from ownUnpackFolder()
 * @param {{ now?: number, minAgeMs?: number, fs?: FsLike }} [opts]
 * @returns {Promise<{ removed: string[], inUse: string[] }>} the folders removed, and those left because a Spellglass runs from them
 */
export async function removeLeftCopies(own, opts = {}) {
  const fs = opts.fs ?? nodeFs;
  const now = opts.now ?? Date.now();
  const minAge = opts.minAgeMs ?? MIN_AGE_MS;
  const temp = path.dirname(own);
  const ownName = path.basename(own).toLowerCase();
  /** @type {string[]} */
  const removed = [];
  /** @type {string[]} */
  const inUse = [];
  let names;
  try {
    // In a fixed order, so a pass always goes the same way.
    names = (await fs.readdir(temp)).slice().sort();
  } catch {
    return { removed, inUse };
  }
  for (const name of names) {
    const folder = path.join(temp, name);
    if (LEFT_FOLDER.test(name)) {
      if (realFolder(await info(fs, folder)) && (await removeFolder(fs, folder))) removed.push(folder);
      continue;
    }
    if (!UNPACK_FOLDER.test(name) || name.toLowerCase() === ownName) continue;
    const appDir = path.join(folder, 'app');
    const exe = path.join(appDir, EXE_NAME);
    const top = await info(fs, folder);
    const inner = await info(fs, appDir);
    const program = await info(fs, exe);
    if (!realFolder(top) || !realFolder(inner) || !program?.isFile() || program.isSymbolicLink()) continue;
    // A folder's time changes as entries are made in it: both stand still once unpacking is done.
    if (now - Math.max(/** @type {Info} */ (top).mtimeMs, /** @type {Info} */ (inner).mtimeMs) < minAge) continue;
    try {
      await fs.unlink(exe);
    } catch (err) {
      // EBUSY or EPERM: a Spellglass runs from it, and the folder stays as it is.
      if (/** @type {{ code?: string }} */ (err).code !== 'ENOENT') inUse.push(folder);
      continue;
    }
    // Nothing runs from it now. Marked first, so a removal cut short is finished at a later start.
    let doomed = folder;
    try {
      const marked = path.join(temp, `spellglass-left-${name}`);
      await fs.rename(folder, marked);
      doomed = marked;
    } catch {
      /* removed under its own name instead */
    }
    if (await removeFolder(fs, doomed)) removed.push(folder);
  }
  return { removed, inUse };
}
