// The desktop app (desktop/main.mjs; README, "Desktop app"): build the web app, then open or package it.
//
//   npm run desktop        build dist/, then open it in Electron, as the packaged app would
//   npm run desktop:win    build dist/, then package for Windows into release/:
//                            Spellglass-<version>.exe        portable: the one file to double-click
//                            Spellglass-Setup-<version>.exe  an installer, for those who prefer one
//                            win-unpacked/                    the app before it is wrapped (the tests use it)
//   npm run desktop:mac    the same for macOS, on a Mac: Spellglass-<version>-mac.dmg and .zip, and
//                          mac-universal/Spellglass.app (Apple silicon and Intel in one)
//
// Options after `--`: --no-build packages dist/ as it is; --test-build (desktop:win, desktop:mac) makes
// the test build instead, only the unpacked app for this computer, in release/test/ (win-unpacked, or
// mac-arm64 / mac): it keeps the --inspect switch that the Electron tests drive the packaged app
// through, which a release build ignores, so it is for tests/desktop only, never for players. Anything
// else is passed on to Electron (npm run desktop) or to electron-builder (desktop:win, desktop:mac).
//
// The desktop build is always made with the base path "/" (the app is served from app://spellglass/),
// whatever BASE_PATH says. SPELLGLASS_WEB_URL, when set, gives the QR code and replay links a web
// address (vite.config.ts). The variable ELECTRON_RUN_AS_NODE, which some editors set and which would
// start Electron as plain Node, is removed for the children.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// No trailing separator: on Windows a trailing backslash would escape the closing quote of the argument.
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const [command, ...args] = process.argv.slice(2);
const build = !args.includes('--no-build');
const testBuild = args.includes('--test-build');
const passOn = args.filter((a) => a !== '--no-build' && a !== '--test-build');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
// Only --test-build makes a test build, never a variable left in the environment.
delete env.SPELLGLASS_TEST_BUILD;

function fail(message) {
  console.error(`desktop: ${message}`);
  process.exit(1);
}

function finish(result) {
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** `npm run <script>` with the npm that started this script, so no shell is needed. */
function npmRun(script, extraEnv) {
  const npm = process.env.npm_execpath;
  const childEnv = { ...env, ...extraEnv };
  finish(
    npm && /\.[cm]?js$/.test(npm)
      ? spawnSync(process.execPath, [npm, 'run', script], { cwd: ROOT, stdio: 'inherit', env: childEnv })
      : spawnSync(`npm run ${script}`, { cwd: ROOT, stdio: 'inherit', env: childEnv, shell: true }),
  );
}

function buildWeb() {
  if (!build) {
    if (!existsSync(join(ROOT, 'dist', 'index.html'))) fail('dist/ is empty. Run without --no-build.');
    return;
  }
  if (!existsSync(join(ROOT, 'public', 'models', 'hand_landmarker.task'))) {
    console.warn('desktop: the hand model is not in public/models, so "My hand or finger" will not work in this build. Run npm run models first.');
  }
  npmRun('build', { BASE_PATH: '/' });
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function listRelease() {
  const dir = join(ROOT, 'release');
  if (testBuild) {
    console.log('\nThe test build is in release/test/ (for tests/desktop only; it is not for players).');
    return;
  }
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((name) => /\.(exe|dmg|zip)$/i.test(name));
  if (!files.length) return;
  console.log('\nBuilt in release/:');
  for (const name of files) console.log(`  ${name}  ${mb(statSync(join(dir, name)).size)}`);
}

function packageFor(platform) {
  buildWeb();
  const cli = require.resolve('electron-builder/cli.js');
  const flags = platform === 'win' ? ['--win'] : ['--mac'];
  // The test build: the unpacked app only, for this computer's processor (electron-builder.config.mjs).
  if (testBuild) flags.push('--dir', `--${process.arch}`);
  finish(
    spawnSync(process.execPath, [cli, ...flags, '--config', 'electron-builder.config.mjs', '--publish', 'never', ...passOn], {
      cwd: ROOT,
      stdio: 'inherit',
      env: testBuild ? { ...env, SPELLGLASS_TEST_BUILD: '1' } : env,
    }),
  );
  listRelease();
}

switch (command) {
  case 'run': {
    buildWeb();
    // In Node, the electron package's main export is the path of its binary (downloaded on first use).
    const electron = require('electron');
    finish(spawnSync(electron, [ROOT, ...passOn], { cwd: ROOT, stdio: 'inherit', env }));
    break;
  }
  case 'win':
    packageFor('win');
    break;
  case 'mac':
    if (process.platform !== 'darwin') {
      fail('the Mac app can only be packaged on a Mac (it is signed with Apple\'s tools). The workflow in .github/workflows/desktop.yml builds it on macos-latest.');
    }
    packageFor('mac');
    break;
  default:
    fail('say what to do: run, win or mac (npm run desktop, desktop:win, desktop:mac).');
}
