// The portable .exe's left copies (desktop/portable.mjs): which folders beside its own copy go, and
// that one a Spellglass runs from stays exactly as it is. desktop.spec.ts checks it with the real .exe.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { lstat, readdir, rename, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEFT_FOLDER, MIN_AGE_MS, UNPACK_FOLDER, ownUnpackFolder, removeLeftCopies } from '../../desktop/portable.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A temp folder standing in for %TEMP%. */
function tempRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'spellglass-portable-test-'));
  roots.push(r);
  return r;
}

const HOUR = 60 * 60_000;

/** A copy as the launcher leaves it: name\app\<exe> and a little more, last changed `ageMs` ago. */
function copy(root: string, name: string, { exe = 'Spellglass.exe', ageMs = HOUR } = {}): string {
  const folder = join(root, name);
  mkdirSync(join(folder, 'app', 'resources'), { recursive: true });
  writeFileSync(join(folder, 'app', exe), 'MZ');
  writeFileSync(join(folder, 'app', 'resources', 'app.asar'), 'asar');
  writeFileSync(join(folder, 'splash.bmp'), 'BM');
  const when = new Date(Date.now() - ageMs);
  for (const dir of [join(folder, 'app', 'resources'), join(folder, 'app'), folder]) utimesSync(dir, when, when);
  return folder;
}

const realFs = { readdir: (d: string) => readdir(d), lstat: (f: string) => lstat(f), unlink: (f: string) => unlink(f), rename: (a: string, b: string) => rename(a, b), rm: (d: string, o: { recursive: true; force: true; maxRetries?: number }) => rm(d, o) };

describe('where the portable copy runs from', () => {
  const env = { PORTABLE_EXECUTABLE_DIR: 'C:\\Users\\Player\\Downloads' };

  it('is the launcher\'s folder in %TEMP% for the portable .exe', () => {
    expect(ownUnpackFolder('C:\\Users\\Player\\AppData\\Local\\Temp\\nsl8E7C.tmp\\app\\Spellglass.exe', env, 'win32')).toBe('C:\\Users\\Player\\AppData\\Local\\Temp\\nsl8E7C.tmp');
  });

  it('is nothing for the installed app, a run from the project, or another layout', () => {
    expect(ownUnpackFolder('C:\\Users\\Player\\AppData\\Local\\Temp\\nsl8E7C.tmp\\app\\Spellglass.exe', {}, 'win32')).toBeNull();
    expect(ownUnpackFolder('C:\\Users\\Player\\AppData\\Local\\Programs\\Spellglass\\Spellglass.exe', env, 'win32')).toBeNull();
    expect(ownUnpackFolder('C:\\Users\\Player\\AppData\\Local\\Temp\\nsl8E7C.tmp\\app\\electron.exe', env, 'win32')).toBeNull();
    expect(ownUnpackFolder('C:\\Users\\Player\\AppData\\Local\\Temp\\nsl8E7C.tmp\\other\\Spellglass.exe', env, 'win32')).toBeNull();
    expect(ownUnpackFolder('C:\\Users\\Player\\AppData\\Local\\Temp\\Spellglass\\app\\Spellglass.exe', env, 'win32')).toBeNull();
    expect(ownUnpackFolder('/Applications/Spellglass.app/Contents/MacOS/Spellglass', env, 'darwin')).toBeNull();
  });

  it('knows the launcher\'s folder names', () => {
    for (const name of ['nsl8E7C.tmp', 'nsqC1FF.tmp', 'nsv3B0E.tmp', 'nsa1.tmp']) expect(UNPACK_FOLDER.test(name)).toBe(true);
    for (const name of ['ns8E7C.tmp', 'nsl8E7C1.tmp', 'nsl8E7C.tmpx', 'Spellglass.tmp', 'nslXYZ.tmp']) expect(UNPACK_FOLDER.test(name)).toBe(false);
    expect(LEFT_FOLDER.test('spellglass-left-nsl8E7C.tmp')).toBe(true);
  });
});

describe('clearing the copies earlier launches left behind', () => {
  it('removes old copies of Spellglass beside its own, and nothing else', async () => {
    const root = tempRoot();
    const own = copy(root, 'nsa0001.tmp');
    const stale = copy(root, 'nsb0002.tmp');
    const fresh = copy(root, 'nsc0003.tmp', { ageMs: 30_000 });
    const foreign = copy(root, 'nsd0004.tmp', { exe: 'Other.exe' });
    const plugins = join(root, 'nse0005.tmp');
    mkdirSync(plugins);
    writeFileSync(join(plugins, 'System.dll'), 'MZ');
    const unrelated = copy(root, 'Spellglass-cache.tmp');

    const result = await removeLeftCopies(own);
    expect(result).toEqual({ removed: [stale], inUse: [] });
    expect(existsSync(stale)).toBe(false);
    for (const kept of [own, fresh, foreign, plugins, unrelated]) expect(existsSync(kept)).toBe(true);
    expect(existsSync(join(own, 'app', 'Spellglass.exe'))).toBe(true);
    expect(readdirSync(root).filter((n) => n.startsWith('spellglass-left-'))).toEqual([]);
  });

  it('waits until a copy has been still for ten minutes, so a launcher that is unpacking is left alone', async () => {
    const root = tempRoot();
    const own = copy(root, 'nsa0001.tmp');
    const unpacking = copy(root, 'nsb0002.tmp', { ageMs: MIN_AGE_MS - 60_000 });
    expect((await removeLeftCopies(own)).removed).toEqual([]);
    expect(existsSync(unpacking)).toBe(true);
    expect((await removeLeftCopies(own, { now: Date.now() + 2 * 60_000 })).removed).toEqual([unpacking]);
  });

  it('leaves a copy that a Spellglass runs from exactly as it is', async () => {
    const root = tempRoot();
    const own = copy(root, 'nsa0001.tmp');
    const running = copy(root, 'nsb0002.tmp');
    const before = readdirSync(join(running, 'app'));
    // Windows refuses to delete a program that is running (EPERM), and that is the test.
    const fs = {
      ...realFs,
      unlink: async (f: string) => {
        if (f.startsWith(running)) throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
        return unlink(f);
      },
    };
    expect(await removeLeftCopies(own, { fs })).toEqual({ removed: [], inUse: [running] });
    expect(readdirSync(join(running, 'app'))).toEqual(before);
    expect(existsSync(join(running, 'splash.bmp'))).toBe(true);
  });

  it('never follows a link out of the temp folder', async () => {
    const root = tempRoot();
    const elsewhere = tempRoot();
    const own = copy(root, 'nsa0001.tmp');
    const target = copy(elsewhere, 'precious');
    symlinkSync(target, join(root, 'nsb0002.tmp'), 'junction');
    expect((await removeLeftCopies(own)).removed).toEqual([]);
    expect(existsSync(join(target, 'app', 'Spellglass.exe'))).toBe(true);
  });

  it('finishes at a later start a removal that was cut short', async () => {
    const root = tempRoot();
    const own = copy(root, 'nsa0001.tmp');
    const stale = copy(root, 'nsb0002.tmp');
    let failRm = true;
    const fs = {
      ...realFs,
      rm: async (d: string, o: { recursive: true; force: true; maxRetries?: number }) => {
        if (failRm) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        return rm(d, o);
      },
    };
    expect((await removeLeftCopies(own, { fs })).removed).toEqual([]);
    // Spellglass.exe is gone and the folder is marked, so nothing can run from it any more.
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(root)).toContain('spellglass-left-nsb0002.tmp');
    failRm = false;
    expect((await removeLeftCopies(own, { fs })).removed).toEqual([join(root, 'spellglass-left-nsb0002.tmp')]);
    expect(readdirSync(root).sort()).toEqual(['nsa0001.tmp']);
  });

  it('removes a copy under its own name when it cannot be marked first', async () => {
    const root = tempRoot();
    const own = copy(root, 'nsa0001.tmp');
    const stale = copy(root, 'nsb0002.tmp');
    const fs = {
      ...realFs,
      rename: async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      },
    };
    expect((await removeLeftCopies(own, { fs })).removed).toEqual([stale]);
    expect(existsSync(stale)).toBe(false);
  });

  it('never throws, even when the temp folder cannot be read', async () => {
    const root = tempRoot();
    await expect(removeLeftCopies(join(root, 'missing', 'nsa0001.tmp'))).resolves.toEqual({ removed: [], inUse: [] });
  });
});
