// Starting the desktop app for the Electron tests: from the project (desktop/main.mjs on dist/), the
// test build in release/test/ (which Playwright can drive), or the release build in release/ (which it
// cannot: those tests start it as a player would), each with a user data folder of its own.
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_GPU } from '../e2e/helpers';

/** The project folder, without a trailing separator: on Windows a trailing backslash would escape the
 *  closing quote of its argument and run it into the next one. */
export const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const OUTPUT = join(ROOT, 'tests', 'desktop', '.output');

/** The unpacked app electron-builder leaves in `release` for this platform, or null when there is none. */
function unpackedApp(release: string): string | null {
  const mac = (dir: string) => join(release, dir, 'Spellglass.app', 'Contents', 'MacOS', 'Spellglass');
  const candidates =
    process.platform === 'win32'
      ? [join(release, 'win-unpacked', 'Spellglass.exe')]
      : process.platform === 'darwin'
        ? [mac('mac-universal'), mac('mac-arm64'), mac('mac')]
        : [join(release, 'linux-unpacked', 'spellglass')];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** The test build (npm run desktop:win -- --test-build, or desktop:mac): the packaged app with the
 *  --inspect switch Playwright drives it through. */
export function testBuildApp(): string | null {
  return unpackedApp(join(ROOT, 'release', 'test'));
}

/** The release build (npm run desktop:win, or desktop:mac): what goes into the files players get. */
export function releaseApp(): string | null {
  return unpackedApp(join(ROOT, 'release'));
}

/** The portable Windows .exe in release/ (Spellglass-<version>.exe), or null when there is none. */
export function portableExe(): string | null {
  const release = join(ROOT, 'release');
  if (process.platform !== 'win32' || !existsSync(release)) return null;
  const name = readdirSync(release).find((f) => /^Spellglass-\d[\w.-]*\.exe$/.test(f));
  return name ? join(release, name) : null;
}

/** The Spellglass windows open now (Windows only): the process id and where it runs from. */
export function spellglassWindows(): { Id: number; Path: string }[] {
  // Always a JSON array, and exit 0 when none is running (a failed Get-Process would exit 1).
  const script =
    "ConvertTo-Json -Compress -InputObject @(Get-Process -Name Spellglass -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -eq 'Spellglass' } | Select-Object Id, Path); exit 0";
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim();
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Ask a window's process to close, as its close button would (Windows only). */
export function closeWindowOf(pid: number): void {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[void](Get-Process -Id ${pid}).CloseMainWindow()`]);
}

/** Electron must not inherit ELECTRON_RUN_AS_NODE (some editors set it): it would start as plain Node. */
export function electronEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE') env[key] = value;
  return env;
}

export interface LaunchOptions {
  /** The user data folder: settings, progress and keepsakes. Reuse one to relaunch the same player. */
  userData: string;
  /** The packaged app's executable; else the project is run through desktop/main.mjs. */
  executablePath?: string;
  /** Chrome's fake camera, playing this .y4m clip (true: its test pattern). */
  fakeCamera?: string | true;
  /** More switches, for Chromium (a net log, fake devices without the fake prompt). */
  extraArgs?: string[];
}

/** The arguments the app is started with (also for a second instance started by hand). */
export function appArgs(opts: LaunchOptions): string[] {
  const camera = opts.fakeCamera === true ? ['--spellglass-fake-camera'] : opts.fakeCamera ? [`--spellglass-fake-camera=${opts.fakeCamera}`] : [];
  return [...(opts.executablePath ? [] : [ROOT]), `--spellglass-user-data=${opts.userData}`, ...NO_GPU, ...camera, ...(opts.extraArgs ?? [])];
}

export async function launch(opts: LaunchOptions): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ executablePath: opts.executablePath, args: appArgs(opts), env: electronEnv(), cwd: ROOT, timeout: 60_000 });
  const page = await app.firstWindow();
  await page.waitForFunction(() => !!(window as any).__spellglass, null, { timeout: 30_000 });
  return { app, page };
}

/** Apply settings through the kernel and record pipeline events, as the e2e helpers' boot() does. */
export async function prepare(page: Page, settings: Record<string, unknown> = {}): Promise<void> {
  await page.evaluate(async (s) => {
    const { kernel } = (window as any).__spellglass;
    for (const [key, value] of Object.entries(s)) await kernel.request('settings.set', { key, value });
    (window as any).__seen = [];
    for (const t of ['spell.cast', 'spell.fizzle', 'stroke.end', 'recognition.result', 'tracker.status', 'camera.status', 'voice.status']) {
      kernel.subscribe(t, (e: { payload: unknown }) => (window as any).__seen.push({ type: t, p: e.payload }));
    }
  }, settings);
}

/** A copy of the app started as a double-click starts it, not driven by Playwright, with what it wrote. */
export interface Started {
  child: ChildProcess;
  /** Everything it wrote to stdout and stderr so far. */
  output: () => string;
  exited: (ms: number) => Promise<number | null>;
}

/** Start an executable with arguments, collecting its output. */
export function start(executable: string, args: string[]): Started {
  const child = spawn(executable, args, { env: electronEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout?.on('data', (d) => (text += d));
  child.stderr?.on('data', (d) => (text += d));
  const done = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return {
    child,
    output: () => text,
    exited: (ms) =>
      new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the app did not finish')), ms);
        void done.then((code) => {
          clearTimeout(timer);
          resolve(code);
        });
      }),
  };
}

/** The page has started its storage: the app is up, as far as anything outside it can tell. */
export function pageStarted(userData: string): boolean {
  const idb = join(userData, 'IndexedDB');
  return existsSync(idb) && readdirSync(idb).some((n) => n.startsWith('app_spellglass_'));
}

/** Close a started app as its window's close button would, and wait for it to finish. */
export async function closeStarted(app: Started): Promise<number | null> {
  if (process.platform === 'win32' && app.child.pid) closeWindowOf(app.child.pid);
  else app.child.kill('SIGTERM');
  return app.exited(60_000);
}

/** Every kind of network event Chromium logged (--log-net-log=<file>), as "SOURCE / EVENT". */
export function netLogEvents(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  let log: { constants: { logEventTypes: Record<string, number>; logSourceType: Record<string, number> }; events: { type: number; source: { type: number } }[] };
  try {
    log = JSON.parse(text);
  } catch {
    // A log the app could not finish (it was ended): close the event list by hand.
    log = JSON.parse(`${text.trim().replace(/,$/, '')}]}`);
  }
  const events = Object.fromEntries(Object.entries(log.constants.logEventTypes).map(([k, v]) => [v, k]));
  const sources = Object.fromEntries(Object.entries(log.constants.logSourceType).map(([k, v]) => [v, k]));
  return log.events.map((e) => `${sources[e.source.type]} / ${events[e.type]}`);
}

/** The events that mean the network was used: a lookup, a socket, a request, or proxy detection (WPAD). */
export const NETWORK_USE = /HOST_RESOLVER|DNS_TRANSACTION|SOCKET|CONNECT_JOB|URL_REQUEST|HTTP_STREAM|PAC_FILE|WPAD|PROXY_SCRIPT|WEB_SOCKET/;

/** What the main process refused so far (desktop/main.mjs keeps the list). */
export async function refused(app: ElectronApplication): Promise<{ requests: string[]; permissions: string[]; windows: string[]; navigations: string[] }> {
  return app.evaluate(() => {
    const r = (globalThis as any).__spellglassDesktop.refused;
    return { requests: [...r.requests], permissions: [...r.permissions], windows: [...r.windows], navigations: [...r.navigations] };
  });
}

const made: string[] = [];

/** A fresh folder under the system temp folder (where Chrome's capture process may read a clip). */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

export function removeTempDirs(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
