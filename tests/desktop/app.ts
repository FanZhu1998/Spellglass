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

/**
 * The GPU switches the app is started with. On Windows, --disable-gpu, as the browser tests have it
 * (tests/e2e/helpers.ts): Chromium draws in software, and WebGL still works. A Mac has no software GL
 * for Chromium: with --disable-gpu its GPU process gives up at the start ("Initialization of all EGL
 * display types failed"), which leaves no WebGL (MediaPipe needs it, on its CPU delegate too) and the
 * camera at 5 frames a second instead of 20 (Chromium hands its frames over in GPU memory there). So on
 * a Mac the tests use the GPU the machine has, as players do.
 */
export const GPU_SWITCHES = process.platform === 'darwin' ? [] : NO_GPU;

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
  /** The GPU switches instead of GPU_SWITCHES (the CI report compares them). */
  gpuSwitches?: string[];
}

/** The arguments the app is started with (also for a second instance started by hand). */
export function appArgs(opts: LaunchOptions): string[] {
  const camera = opts.fakeCamera === true ? ['--spellglass-fake-camera'] : opts.fakeCamera ? [`--spellglass-fake-camera=${opts.fakeCamera}`] : [];
  return [...(opts.executablePath ? [] : [ROOT]), `--spellglass-user-data=${opts.userData}`, ...(opts.gpuSwitches ?? GPU_SWITCHES), ...camera, ...(opts.extraArgs ?? [])];
}

/** An app the tests drive, with the last lines it and its page wrote (for diagnose()). */
export interface Launched {
  app: ElectronApplication;
  page: Page;
  /** The main process's output (Chromium's own messages included) and the page's console, oldest first. */
  output: () => string[];
}

export async function launch(opts: LaunchOptions): Promise<Launched> {
  const app = await electron.launch({ executablePath: opts.executablePath, args: appArgs(opts), env: electronEnv(), cwd: ROOT, timeout: 60_000 });
  const lines: string[] = [];
  const keep = (from: string, text: string) => {
    for (const line of text.split(/\r?\n/)) if (line.trim()) lines.push(`${from}: ${line.trim().slice(0, 300)}`);
    if (lines.length > 400) lines.splice(0, lines.length - 400);
  };
  app.process().stdout?.on('data', (d) => keep('main', String(d)));
  app.process().stderr?.on('data', (d) => keep('main', String(d)));
  const page = await app.firstWindow();
  page.on('console', (m) => keep('page', `${m.type()} ${m.text()}`));
  page.on('pageerror', (e) => keep('page', `uncaught ${e.message}`));
  await page.waitForFunction(() => !!(window as any).__spellglass, null, { timeout: 30_000 });
  return { app, page, output: () => [...lines] };
}

/** A Chromium log line without its process, time and folders ("ERROR gl_display.cc:648 ..."), so repeats count as one. */
function plainLine(line: string): string {
  return line.replace(/\[\d+:\d+\/[\d.]+:(\w+):(?:[^\]/]*\/)*([^\]/]+)\]\s*/, '$1 $2 ');
}

/**
 * What the app was doing, for a test that failed, in a few lines (CI shows the first 4 KB of a
 * failure): whether the page is shown and drawing, what the camera and the trackers said (from the
 * events prepare() records), the modules, the window, what Chromium says of the GPU, and the distinct
 * lines of output, each with how often it came. Never throws.
 */
export async function diagnose(launched: Launched): Promise<string> {
  const { app, page } = launched;
  const pageLines = await page
    .evaluate(async () => {
      // Animation frames in one second (none when Chromium stopped drawing the page).
      const frames = await new Promise<number>((resolve) => {
        let n = 0;
        const t0 = performance.now();
        const step = () => {
          n++;
          if (performance.now() - t0 < 1000) requestAnimationFrame(step);
          else resolve(n);
        };
        requestAnimationFrame(step);
        setTimeout(() => resolve(n), 2000);
      });
      const seen = ((window as any).__seen ?? []) as { type: string; p: any }[];
      const counts: Record<string, number> = {};
      for (const e of seen) counts[e.type] = (counts[e.type] ?? 0) + 1;
      // Each change of state once, in order, the last few.
      const changes = (type: string, say: (p: any) => string) =>
        seen.filter((e) => e.type === type).map((e) => say(e.p)).filter((s, i, all) => s !== all[i - 1]).slice(-8).join(' > ') || 'none';
      const { kernel } = (window as any).__spellglass ?? {};
      return [
        `page: ${document.visibilityState}, ${document.hasFocus() ? 'focused' : 'not focused'}, ${frames} frames/s; events: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`,
        `camera: ${changes('camera.status', (p) => [p.state, p.width && `${p.width}x${p.height}`, p.fps && `${p.fps} fps`, p.message].filter(Boolean).join(' '))}`,
        `trackers: ${changes('tracker.status', (p) => [p.tracker, p.state, p.message && `(${p.message})`].filter(Boolean).join(' '))}`,
        `modules: ${kernel?.modules?.().map((m: any) => `${m.manifest.id} ${m.state}`).join(', ')}`,
      ];
    })
    .catch((err: unknown) => [`page: unreadable (${String(err).slice(0, 200)})`]);
  const mainLines = await app
    .evaluate(({ app: a, BrowserWindow, screen }) => {
      const gpu = Object.entries(a.getGPUFeatureStatus() as unknown as Record<string, string>).filter(([, v]) => !v.startsWith('enabled'));
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL() === 'app://spellglass/');
      const lines = [`gpu: ${gpu.map(([k, v]) => `${k} ${v}`).join(', ') || 'all enabled'}`];
      if (!w) return [...lines, 'window: none'];
      const b = w.getBounds();
      const area = screen.getDisplayMatching(b).workArea;
      const flags = [w.isVisible() ? 'visible' : 'hidden', w.isFocused() ? 'focused' : 'not focused', w.isMinimized() && 'minimized', w.isFullScreen() && 'full screen'];
      return [...lines, `window: ${flags.filter(Boolean).join(', ')}, ${b.width}x${b.height} at ${b.x},${b.y}; work area ${area.width}x${area.height}`];
    })
    .catch((err: unknown) => [`main: unreadable (${String(err).slice(0, 200)})`]);
  const counted = new Map<string, number>();
  for (const line of launched.output()) {
    const plain = plainLine(line).slice(0, 140);
    counted.set(plain, (counted.get(plain) ?? 0) + 1);
  }
  const distinct = [...counted].map(([line, n]) => (n > 1 ? `${line} (x${n})` : line));
  const output = distinct.length > 14 ? [...distinct.slice(0, 5), `... ${distinct.length - 14} more ...`, ...distinct.slice(-9)] : distinct;
  return [...pageLines, ...mainLines, 'output:', ...output.map((l) => `  ${l}`)].join('\n');
}

/** Run `step`; should it fail, its error carries diagnose()'s account of the app, and `more` (a test's own record). */
export async function explained<T>(launched: Launched, step: () => Promise<T>, more?: () => Promise<string>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const own = more ? await more().catch((e: unknown) => `unreadable: ${String(e)}`) : '';
    throw new Error(`${message}\n\nWhat the app was doing:\n${own ? `${own}\n` : ''}${await diagnose(launched)}`, { cause: err });
  }
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
